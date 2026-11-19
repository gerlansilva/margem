//! Orquestração assíncrona da busca: o trabalho em segundo plano que indexa
//! (lexical, depois embeddings) e a consulta híbrida. Sem Tauri: os eventos
//! saem por um callback, então tudo é testável com um servidor local.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::db::Db;
use crate::embed::{self, EmbedConfig, EmbedError};
use crate::search::{self, SearchResult};

pub type Emit<'a> = &'a (dyn Fn(Value) + Send + Sync);

/// Quanto esperar pelo embedding da consulta antes de cair para a busca lexical.
const QUERY_EMBED_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Default)]
pub struct IndexManager {
    busy: AtomicBool,
    rerun: AtomicBool,
    cancel: AtomicBool,
    error: Mutex<Option<String>>,
}

impl IndexManager {
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    pub fn last_error(&self) -> Option<String> {
        self.error.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set_error(&self, e: Option<String>) {
        *self.error.lock().unwrap_or_else(|e| e.into_inner()) = e;
    }

    /// Interrompe o lote de embeddings em andamento (o trabalho recomeça se alguém chamar `run_loop`).
    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    fn try_begin(&self) -> bool {
        self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct IndexStatus {
    pub docs_total: i64,
    pub docs_indexed: i64,
    pub chunks: i64,
    /// Busca semântica ativa: configurada e já com ao menos um trecho vetorizado.
    pub embeddings: bool,
    /// Modelo de embeddings configurado (ou null).
    pub model: Option<String>,
    pub busy: bool,
    /// Trechos já vetorizados com o modelo atual.
    pub embedded: i64,
    /// Último erro do servidor de embeddings (ou null).
    pub error: Option<String>,
}

pub fn index_status(db: &Db, mgr: &IndexManager, cfg: Option<&EmbedConfig>) -> Result<IndexStatus, String> {
    let c = db.index_counts()?;
    let embedded = match cfg {
        Some(cfg) => db.embedded_count(&cfg.model)?,
        None => 0,
    };
    Ok(IndexStatus {
        docs_total: c.docs_total,
        docs_indexed: c.docs_indexed,
        chunks: c.chunks,
        embeddings: cfg.is_some() && embedded > 0,
        model: cfg.map(|c| c.model.clone()),
        busy: mgr.is_busy(),
        embedded,
        error: mgr.last_error(),
    })
}

fn progress(phase: &str, done: i64, total: i64, busy: bool, error: Option<&str>) -> Value {
    json!({"phase": phase, "done": done, "total": total, "busy": busy, "error": error})
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("tarefa interrompida: {e}"))
}

async fn run_once(mgr: &IndexManager, db: &Arc<Db>, http: &reqwest::Client, cfg: Option<EmbedConfig>, emit: Emit<'_>) {
    // 1) índice lexical dos documentos que ainda não estão nele
    let pending = {
        let d = db.clone();
        blocking(move || d.docs_needing_index()).await.and_then(|r| r)
    };
    match pending {
        Ok(ids) => {
            let total = ids.len() as i64;
            for (i, id) in ids.into_iter().enumerate() {
                let d = db.clone();
                match blocking(move || d.reindex_doc(&id)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) | Err(e) => eprintln!("índice: falha ao indexar um documento: {e}"),
                }
                emit(progress("lexical", i as i64 + 1, total, true, None));
            }
        }
        Err(e) => eprintln!("índice: falha ao listar documentos: {e}"),
    }

    // 2) embeddings, só se o usuário configurou um servidor
    let Some(cfg) = cfg else {
        mgr.set_error(None);
        return;
    };
    mgr.set_error(None);
    let mut cursor = 0i64;
    loop {
        if mgr.cancel.load(Ordering::SeqCst) {
            break;
        }
        let model = cfg.model.clone();
        let d = db.clone();
        let batch = blocking(move || d.pending_chunks(&model, cursor, embed::BATCH_CHUNKS, embed::BATCH_CHARS)).await.and_then(|r| r);
        let batch = match batch {
            Ok(b) => b,
            Err(e) => {
                eprintln!("índice: falha ao listar trechos: {e}");
                break;
            }
        };
        if batch.is_empty() {
            break;
        }
        cursor = batch.last().map_or(cursor, |(id, _)| *id);
        let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        match embed::embed_batch(http, &cfg, &texts, Some(&mgr.cancel)).await {
            Ok(vecs) => {
                let items: Vec<(i64, Vec<f32>)> = batch.iter().map(|(id, _)| *id).zip(vecs).collect();
                let (d, model) = (db.clone(), cfg.model.clone());
                if let Err(e) = blocking(move || d.store_embeddings(&model, &items)).await.and_then(|r| r) {
                    mgr.set_error(Some(e.clone()));
                    emit(progress("embeddings", 0, 0, true, Some(&e)));
                    break;
                }
                let (d, model) = (db.clone(), cfg.model.clone());
                let counts = blocking(move || (d.index_counts().ok(), d.embedded_count(&model).ok())).await.unwrap_or((None, None));
                if let (Some(c), Some(done)) = counts {
                    emit(progress("embeddings", done, c.chunks, true, None));
                }
            }
            Err(EmbedError::Cancelled) => break,
            Err(EmbedError::Failed(msg)) => {
                mgr.set_error(Some(msg.clone()));
                emit(progress("embeddings", 0, 0, true, Some(&msg)));
                break;
            }
        }
    }
}

/// Executa o trabalho de indexação. Se já houver um rodando, só pede uma nova
/// rodada (o trabalho em curso a faz quando terminar) e volta na hora.
pub async fn run_loop(
    mgr: &IndexManager,
    db: &Arc<Db>,
    http: &reqwest::Client,
    get_cfg: &(dyn Fn() -> Option<EmbedConfig> + Send + Sync),
    emit: Emit<'_>,
) {
    if !mgr.try_begin() {
        mgr.rerun.store(true, Ordering::SeqCst);
        return;
    }
    loop {
        mgr.rerun.store(false, Ordering::SeqCst);
        mgr.cancel.store(false, Ordering::SeqCst);
        let cfg = get_cfg();
        run_once(mgr, db, http, cfg, emit).await;
        let counts = db.index_counts().unwrap_or_default();
        let err = mgr.last_error();
        emit(progress("idle", counts.docs_indexed, counts.docs_total, false, err.as_deref()));
        mgr.busy.store(false, Ordering::SeqCst);
        if mgr.rerun.load(Ordering::SeqCst) && mgr.try_begin() {
            continue;
        }
        break;
    }
}

/// Busca no acervo: lexical sempre; híbrida (RRF) quando há embeddings do modelo
/// atual e o servidor responde a tempo. Falha no servidor de embeddings nunca
/// falha a busca: cai para o resultado lexical.
pub async fn run_search(
    db: &Arc<Db>,
    http: &reqwest::Client,
    cfg: Option<&EmbedConfig>,
    query: &str,
    doc_ids: Option<Vec<String>>,
    limit: usize,
) -> Result<SearchResult, String> {
    let limit = limit.clamp(1, 100);
    let pool = (limit * 3).clamp(30, 150);
    let titles = {
        let d = db.clone();
        blocking(move || d.doc_titles()).await??
    };
    let lex = match search::build_fts_query(query) {
        Some(fts) => {
            let (d, ids) = (db.clone(), doc_ids.clone());
            blocking(move || d.search_lexical(&fts, ids.as_deref(), pool)).await??
        }
        None => vec![],
    };
    let plain = search::query_plain_text(query);
    if let Some(cfg) = cfg.filter(|_| !plain.is_empty()) {
        let (d, model) = (db.clone(), cfg.model.clone());
        let have = blocking(move || d.embedded_count(&model)).await.and_then(|r| r).unwrap_or(0);
        if have > 0 {
            let embedded = tokio::time::timeout(
                QUERY_EMBED_TIMEOUT,
                embed::embed_batch_with(http, cfg, std::slice::from_ref(&plain), None, Duration::from_millis(400), 1),
            )
            .await;
            match embedded {
                Ok(Ok(mut v)) => {
                    let mut q = v.pop().unwrap_or_default();
                    if search::normalize_vec(&mut q) {
                        let (d, model, ids) = (db.clone(), cfg.model.clone(), doc_ids.clone());
                        let rows = blocking(move || d.top_pages_by_vector(&q, &model, ids.as_deref(), pool)).await??;
                        if !rows.is_empty() {
                            return Ok(SearchResult { mode: "hybrid".into(), hits: search::fuse(&lex, &rows, &titles, limit) });
                        }
                    }
                }
                Ok(Err(EmbedError::Failed(e))) => eprintln!("busca semântica indisponível: {e}"),
                Ok(Err(EmbedError::Cancelled)) => {}
                Err(_) => eprintln!("busca semântica indisponível: tempo esgotado"),
            }
        }
    }
    Ok(SearchResult { mode: "lexical".into(), hits: search::lexical_hits(&lex, &titles, limit) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Block, Line, Page};
    use crate::testsrv::{block_on, client, serve_body, Reply, Server};
    use std::sync::atomic::AtomicUsize;

    fn page(n: i64, text: &str) -> Page {
        Page {
            n,
            md: text.into(),
            text: text.into(),
            blocks: vec![Block { text: text.into(), x: 0.0, y: 0.0, w: 1.0, h: 1.0, size: 10.0 }],
            lines: vec![Line { i: 0, text: text.into(), rect: [0.0; 4] }],
            figures: vec![],
        }
    }

    fn arc_db(docs: &[(&str, Vec<Page>)]) -> Arc<Db> {
        let db = Db::open_in_memory().unwrap();
        for (id, pages) in docs {
            db.insert_doc(id, &format!("Doc {id}"), "/x", "2026-01-01T00:00:00Z").unwrap();
            db.save_pages(id, pages).unwrap();
        }
        Arc::new(db)
    }

    /// Vetor de 8 dimensões por "bag of words" com sinônimos: "carro" e "automóvel" caem na mesma dimensão.
    fn fake_vec(text: &str) -> Vec<f64> {
        let mut v = vec![0.0f64; 8];
        for w in text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
            let dim = match w {
                "carro" | "automóvel" | "automovel" | "veículo" => 0,
                "estatística" | "estatistica" => 1,
                "escola" | "ensino" => 2,
                _ => 3 + (w.len() % 5),
            };
            v[dim] += 1.0;
        }
        v
    }

    fn embed_server(fail_after: Option<usize>) -> (Server, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let c2 = calls.clone();
        let srv = serve_body(move |n, target, body| {
            c2.fetch_add(1, Ordering::SeqCst);
            assert!(target.starts_with("/v1/embeddings"), "{target}");
            if fail_after.is_some_and(|k| n >= k) {
                return Reply::json(401, &json!({"error": {"message": "Incorrect API key"}}));
            }
            let b: Value = serde_json::from_str(body).unwrap();
            let data: Vec<Value> = b["input"].as_array().unwrap().iter().enumerate().map(|(i, t)| json!({"index": i, "embedding": fake_vec(t.as_str().unwrap())})).collect();
            Reply::json(200, &json!({"object": "list", "data": data, "model": b["model"]}))
        });
        (srv, calls)
    }

    fn cfg(srv: &Server, model: &str) -> EmbedConfig {
        EmbedConfig { base_url: format!("{}/v1", srv.base), model: model.into(), key: Some("chave-teste".into()) }
    }

    fn collect() -> (Arc<Mutex<Vec<Value>>>, impl Fn(Value) + Send + Sync) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let e2 = events.clone();
        (events, move |v| e2.lock().unwrap().push(v))
    }

    #[test]
    fn trabalho_lexical_indexa_pendentes_e_emite_eventos() {
        let db = arc_db(&[("d1", vec![page(1, "um texto")]), ("d2", vec![page(1, "outro texto")])]);
        // simula banco antigo: nada indexado
        db.invalidate_index().unwrap();
        assert_eq!(db.docs_needing_index().unwrap().len(), 2);
        let mgr = IndexManager::default();
        let (events, emit) = collect();
        let http = client();
        block_on(run_loop(&mgr, &db, &http, &|| None, &emit));
        assert!(db.docs_needing_index().unwrap().is_empty());
        let ev = events.lock().unwrap();
        let lex: Vec<&Value> = ev.iter().filter(|e| e["phase"] == "lexical").collect();
        assert_eq!(lex.len(), 2);
        assert_eq!((lex[1]["done"].as_i64(), lex[1]["total"].as_i64()), (Some(2), Some(2)));
        let last = ev.last().unwrap();
        assert_eq!((last["phase"].as_str(), last["busy"].as_bool()), (Some("idle"), Some(false)));
        assert_eq!(last["done"], 2);
        assert!(!mgr.is_busy());
        let st = index_status(&db, &mgr, None).unwrap();
        assert_eq!((st.docs_total, st.docs_indexed, st.embeddings, st.busy), (2, 2, false, false));
        assert!(st.model.is_none() && st.error.is_none());
    }

    #[test]
    fn embeddings_em_lotes_status_e_troca_de_modelo() {
        // ~60 trechos: vários lotes de 24
        let big: String = (0..60).map(|i| format!("palavra{i} ")).collect::<String>().repeat(40);
        let pages: Vec<Page> = (1..=8).map(|n| page(n, &format!("{big} pagina{n}"))).collect();
        let db = arc_db(&[("d1", pages)]);
        let chunks = db.index_counts().unwrap().chunks;
        assert!(chunks > embed::BATCH_CHUNKS as i64, "{chunks}");
        let (srv, calls) = embed_server(None);
        let mgr = IndexManager::default();
        let (events, emit) = collect();
        let http = client();
        let c1 = cfg(&srv, "modelo-a");
        let c1b = c1.clone();
        block_on(run_loop(&mgr, &db, &http, &move || Some(c1b.clone()), &emit));
        assert!(calls.load(Ordering::SeqCst) >= 3);
        assert_eq!(db.embedded_count("modelo-a").unwrap(), chunks);
        let st = index_status(&db, &mgr, Some(&c1)).unwrap();
        assert!(st.embeddings && st.embedded == chunks && st.model.as_deref() == Some("modelo-a"));
        let ev = events.lock().unwrap();
        let emb: Vec<&Value> = ev.iter().filter(|e| e["phase"] == "embeddings").collect();
        assert!(emb.len() >= 3);
        assert_eq!(emb.last().unwrap()["done"].as_i64(), Some(chunks));
        assert_eq!(emb.last().unwrap()["total"].as_i64(), Some(chunks));
        // cabeçalho de autorização e corpo no formato OpenAI
        let req = srv.request(0);
        assert!(req.to_lowercase().contains("authorization: bearer chave-teste"), "{req}");
        assert!(req.contains("\"model\":\"modelo-a\""));
        drop(ev);
        // trocar de modelo: tudo volta a ficar pendente e é refeito
        let before = calls.load(Ordering::SeqCst);
        let c2 = cfg(&srv, "modelo-b");
        assert_eq!(index_status(&db, &mgr, Some(&c2)).unwrap().embedded, 0);
        let c2b = c2.clone();
        block_on(run_loop(&mgr, &db, &http, &move || Some(c2b.clone()), &emit));
        assert!(calls.load(Ordering::SeqCst) > before);
        assert_eq!(db.embedded_count("modelo-b").unwrap(), chunks);
        assert_eq!(db.embedded_count("modelo-a").unwrap(), 0, "vetores do modelo antigo foram sobrescritos");
    }

    #[test]
    fn falha_do_servidor_de_embeddings_para_o_trabalho_e_aparece_no_status() {
        let pages: Vec<Page> = (1..=3).map(|n| page(n, &format!("texto {n}"))).collect();
        let db = arc_db(&[("d1", pages)]);
        let (srv, calls) = embed_server(Some(0));
        let mgr = IndexManager::default();
        let (events, emit) = collect();
        let http = client();
        let c = cfg(&srv, "m");
        let c2 = c.clone();
        block_on(run_loop(&mgr, &db, &http, &move || Some(c2.clone()), &emit));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "401 não é repetido");
        let st = index_status(&db, &mgr, Some(&c)).unwrap();
        assert!(!st.embeddings && !st.busy);
        assert!(st.error.as_deref().unwrap().contains("Chave inválida"), "{:?}", st.error);
        assert!(events.lock().unwrap().iter().any(|e| e["phase"] == "embeddings" && e["error"].is_string()));
        // a indexação lexical não foi afetada
        assert_eq!(db.docs_needing_index().unwrap().len(), 0);
        let r = block_on(run_search(&db, &http, Some(&c), "texto", None, 10)).unwrap();
        assert_eq!(r.mode, "lexical");
        assert_eq!(r.hits.len(), 3);
    }

    #[test]
    fn cancelamento_interrompe_e_nova_rodada_retoma() {
        let big: String = (0..60).map(|i| format!("palavra{i} ")).collect::<String>().repeat(40);
        let pages: Vec<Page> = (1..=6).map(|n| page(n, &format!("{big} pagina{n}"))).collect();
        let db = arc_db(&[("d1", pages)]);
        let (srv, _calls) = embed_server(None);
        let mgr = Arc::new(IndexManager::default());
        let http = client();
        let c = cfg(&srv, "m");
        let chunks = db.index_counts().unwrap().chunks;
        let count = Arc::new(AtomicUsize::new(0));
        let (m2, n2) = (mgr.clone(), count.clone());
        // cancela depois do primeiro lote de progresso
        let emit = move |v: Value| {
            if v["phase"] == "embeddings" && n2.fetch_add(1, Ordering::SeqCst) == 0 {
                m2.request_cancel();
            }
        };
        let c1 = c.clone();
        block_on(run_loop(&mgr, &db, &http, &move || Some(c1.clone()), &emit));
        let done = db.embedded_count("m").unwrap();
        assert!(done > 0 && done < chunks, "{done}/{chunks}");
        assert!(!mgr.is_busy());
        let c2 = c.clone();
        block_on(run_loop(&mgr, &db, &http, &move || Some(c2.clone()), &|_| {}));
        assert_eq!(db.embedded_count("m").unwrap(), chunks);
    }

    #[test]
    fn chamada_durante_a_execucao_pede_nova_rodada_sem_rodar_em_paralelo() {
        let db = arc_db(&[("d1", vec![page(1, "um")])]);
        db.invalidate_index().unwrap();
        let mgr = Arc::new(IndexManager::default());
        let http = client();
        let rounds = Arc::new(AtomicUsize::new(0));
        let (m2, r2, db2, http2) = (mgr.clone(), rounds.clone(), db.clone(), http.clone());
        // durante a primeira rodada: outro pedido chega (retorna na hora) e há documento novo
        let emit = move |v: Value| {
            if v["phase"] == "lexical" && r2.fetch_add(1, Ordering::SeqCst) == 0 {
                db2.insert_doc("d2", "Novo", "/n", "t").unwrap();
                db2.save_pages("d2", &[page(1, "novo texto")]).unwrap();
                db2.invalidate_index().unwrap();
                use futures_util::FutureExt;
                // a segunda chamada devolve na primeira consulta, sem esperar nem rodar em paralelo
                assert!(run_loop(&m2, &db2, &http2, &|| None, &|_| {}).now_or_never().is_some());
            }
        };
        block_on(run_loop(&mgr, &db, &http, &|| None, &emit));
        assert!(db.docs_needing_index().unwrap().is_empty(), "a rodada extra indexou o documento novo");
        assert!(!mgr.is_busy());
    }

    #[test]
    fn busca_hibrida_acha_sinonimo_que_a_lexical_nao_acha() {
        let db = arc_db(&[
            ("d1", vec![page(1, "O automóvel elétrico mudou a cidade"), page(2, "Texto sobre geometria plana")]),
            ("d2", vec![page(1, "O ensino de estatística na escola")]),
        ]);
        let (srv, _) = embed_server(None);
        let http = client();
        let c = cfg(&srv, "m");
        // sem embeddings ainda: lexical
        let r = block_on(run_search(&db, &http, Some(&c), "carro", None, 10)).unwrap();
        assert_eq!((r.mode.as_str(), r.hits.len()), ("lexical", 0));
        let mgr = IndexManager::default();
        let c2 = c.clone();
        block_on(run_loop(&mgr, &db, &http, &move || Some(c2.clone()), &|_| {}));
        let r = block_on(run_search(&db, &http, Some(&c), "carro", None, 10)).unwrap();
        assert_eq!(r.mode, "hybrid");
        assert_eq!((r.hits[0].doc_id.as_str(), r.hits[0].page), ("d1", 1));
        assert_eq!(r.hits[0].via, "semantic");
        assert_eq!(r.hits[0].doc_title, "Doc d1");
        assert!(r.hits[0].ranges.is_empty());
        // consulta que casa nos dois lados: marcado como "both" e com destaque
        let r = block_on(run_search(&db, &http, Some(&c), "estatistica", None, 10)).unwrap();
        assert_eq!(r.hits[0].doc_id, "d2");
        assert_eq!(r.hits[0].via, "both");
        assert!(!r.hits[0].ranges.is_empty());
        // filtro de documentos vale nos dois lados
        let r = block_on(run_search(&db, &http, Some(&c), "carro", Some(vec!["d2".into()]), 10)).unwrap();
        assert!(r.hits.iter().all(|h| h.doc_id == "d2"));
        // sem configuração: lexical puro
        let r = block_on(run_search(&db, &http, None, "estatistica", None, 10)).unwrap();
        assert_eq!(r.mode, "lexical");
        assert_eq!(r.hits[0].via, "lexical");
        // consulta só com operadores: vazio, sem erro
        let r = block_on(run_search(&db, &http, Some(&c), "\"*\" ( ) OR", None, 10)).unwrap();
        assert!(r.hits.is_empty());
    }

    #[test]
    fn servidor_de_embeddings_fora_do_ar_na_hora_da_busca_cai_para_lexical() {
        let db = arc_db(&[("d1", vec![page(1, "estatística básica")])]);
        let (srv, _) = embed_server(None);
        let http = client();
        let c = cfg(&srv, "m");
        let c2 = c.clone();
        block_on(run_loop(&IndexManager::default(), &db, &http, &move || Some(c2.clone()), &|_| {}));
        // endereço morto
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let dead = EmbedConfig { base_url: format!("http://{}/v1", l.local_addr().unwrap()), model: "m".into(), key: None };
        drop(l);
        let r = block_on(run_search(&db, &http, Some(&dead), "estatistica", None, 10)).unwrap();
        assert_eq!(r.mode, "lexical");
        assert_eq!(r.hits.len(), 1);
    }

    #[test]
    fn limite_de_resultados_e_quote_pronta_para_resolve_evidence() {
        let pages: Vec<Page> = (1..=40).map(|n| page(n, &format!("assunto comum numero {n}"))).collect();
        let db = arc_db(&[("d1", pages)]);
        let http = client();
        let r = block_on(run_search(&db, &http, None, "assunto", None, 30)).unwrap();
        assert_eq!(r.hits.len(), 30);
        let r = block_on(run_search(&db, &http, None, "assunto", None, 0)).unwrap();
        assert_eq!(r.hits.len(), 1);
        let r = block_on(run_search(&db, &http, None, "assunto", None, 10_000)).unwrap();
        assert_eq!(r.hits.len(), 40);
        for h in r.hits.iter().take(5) {
            let p = db.pages("d1").unwrap().into_iter().find(|p| p.n == h.page).unwrap();
            assert!(crate::evidence::resolve("d1", h.page, &h.quote, &p.lines).is_some() || h.quote.chars().count() < 8, "{:?}", h.quote);
        }
    }

    #[test]
    fn json_do_resultado_tem_os_campos_do_contrato() {
        let db = arc_db(&[("d1", vec![page(1, "alfa beta")])]);
        let http = client();
        let r = block_on(run_search(&db, &http, None, "alfa", None, 5)).unwrap();
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["mode"], "lexical");
        let mut keys: Vec<&str> = v["hits"][0].as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["doc_id", "doc_title", "page", "quote", "ranges", "score", "snippet", "via"]);
        let st = serde_json::to_value(index_status(&db, &IndexManager::default(), None).unwrap()).unwrap();
        let mut keys: Vec<&str> = st.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["busy", "chunks", "docs_indexed", "docs_total", "embedded", "embeddings", "error", "model"]);
    }
}
