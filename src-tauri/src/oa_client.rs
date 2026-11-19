//! Cliente do OpenAlex (https://api.openalex.org, sem chave): cache em SQLite
//! com TTL de 7 dias (e uso do cache vencido se a rede falhar), nova tentativa
//! com backoff em 429/5xx respeitando Retry-After, e os fluxos de vínculo,
//! relacionados, referências e citações.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::db::Db;
use crate::model::{Doc, Page};
use crate::net;
use crate::openalex::{self as oa, Work};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CANDIDATES: usize = 5;
const MAX_QUERY_CHARS: usize = 250;
const DOI_PAGES: usize = 3;
const DOI_TRIES: usize = 3;
/// O OpenAlex só pagina até 10.000 resultados.
const MAX_RESULTS_WINDOW: usize = 10_000;

#[derive(Debug, PartialEq)]
pub enum OaError {
    Offline,
    Timeout,
    NotFound,
    RateLimited,
    Server(u16),
    Rejected(u16),
    BadResponse,
    Invalid(String),
}

impl OaError {
    pub fn message(&self) -> String {
        match self {
            OaError::Offline => "Sem conexão com o OpenAlex. Verifique sua internet, o proxy ou o firewall.".into(),
            OaError::Timeout => "O OpenAlex demorou demais para responder. Tente de novo.".into(),
            OaError::NotFound => "Trabalho não encontrado no OpenAlex.".into(),
            OaError::RateLimited => "O OpenAlex limitou as consultas (429). Aguarde um pouco e tente de novo.".into(),
            OaError::Server(s) => format!("O OpenAlex está instável ({s}). Tente de novo em instantes."),
            OaError::Rejected(s) => format!("O OpenAlex recusou a consulta ({s})."),
            OaError::BadResponse => "O OpenAlex devolveu uma resposta inesperada.".into(),
            OaError::Invalid(m) => m.clone(),
        }
    }

    /// Falhas que justificam servir uma resposta velha do cache.
    fn is_transient(&self) -> bool {
        matches!(self, OaError::Offline | OaError::Timeout | OaError::RateLimited | OaError::Server(_))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Lookup {
    /// "link" | "doi" | "title" | "manual"
    pub source: String,
    pub work: Option<Work>,
    pub candidates: Vec<Work>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Related {
    pub works: Vec<Work>,
    pub total: usize,
    pub page: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RelKind {
    Related,
    References,
    CitedBy,
}

impl RelKind {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "related" => Ok(Self::Related),
            "references" => Ok(Self::References),
            "cited_by" => Ok(Self::CitedBy),
            _ => Err("Tipo de relação inválido (use related, references ou cited_by).".into()),
        }
    }
}

pub struct OaClient<'a> {
    pub http: &'a reqwest::Client,
    pub db: &'a Db,
    pub base: String,
    pub user_agent: String,
    pub mailto: Option<String>,
    /// Unidade do backoff (1 s em produção; milissegundos nos testes).
    pub retry_unit: Duration,
}

impl<'a> OaClient<'a> {
    pub fn new(http: &'a reqwest::Client, db: &'a Db, app_version: &str, mailto: Option<String>) -> Self {
        let mailto = mailto.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
        let user_agent = match &mailto {
            Some(m) => format!("Margem/{app_version} (mailto:{m})"),
            None => format!("Margem/{app_version}"),
        };
        OaClient { http, db, base: oa::API_BASE.to_string(), user_agent, mailto, retry_unit: Duration::from_secs(1) }
    }

    fn delay(&self, attempt: u32, retry_after: Option<&str>) -> Duration {
        if let Some(secs) = retry_after.and_then(|v| v.trim().parse::<u64>().ok()) {
            return self.retry_unit * secs.clamp(1, 30) as u32;
        }
        self.retry_unit * (1u32 << attempt.min(4))
    }

    async fn fetch_text(&self, url: &str) -> Result<String, OaError> {
        let mut attempt = 0u32;
        loop {
            let sent = self
                .http
                .get(url)
                .header(reqwest::header::USER_AGENT, &self.user_agent)
                .header(reqwest::header::ACCEPT, "application/json")
                .timeout(REQUEST_TIMEOUT)
                .send()
                .await;
            let (err, retry_after) = match sent {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if resp.status().is_success() {
                        return match resp.text().await {
                            Ok(t) => Ok(t),
                            Err(e) if e.is_timeout() => Err(OaError::Timeout),
                            Err(_) => Err(OaError::Offline),
                        };
                    }
                    let retry_after = resp
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    match status {
                        404 | 410 => return Err(OaError::NotFound),
                        s if net::is_retryable_status(s) => (
                            if s == 429 { OaError::RateLimited } else { OaError::Server(s) },
                            retry_after,
                        ),
                        s => return Err(OaError::Rejected(s)),
                    }
                }
                Err(e) if e.is_timeout() => (OaError::Timeout, None),
                Err(_) => (OaError::Offline, None),
            };
            if attempt >= net::MAX_RETRIES {
                return Err(err);
            }
            tokio::time::sleep(self.delay(attempt, retry_after.as_deref())).await;
            attempt += 1;
        }
    }

    /// GET com cache. `path` já vem codificado; `params` é codificado aqui.
    pub async fn get_json(&self, path: &str, params: &[(&str, String)]) -> Result<Value, OaError> {
        let key = oa::cache_key(&self.base, path, params);
        let now = oa::unix_now();
        let cached = self.db.oa_cache_get(&key);
        if let Some((body, at)) = &cached {
            if now - at < oa::CACHE_TTL_SECS {
                if let Ok(v) = serde_json::from_str::<Value>(body) {
                    return Ok(v);
                }
            }
        }
        let mut qs = oa::query_string(params);
        if let Some(m) = &self.mailto {
            if !qs.is_empty() {
                qs.push('&');
            }
            qs.push_str(&format!("mailto={}", oa::pct_encode(m, "")));
        }
        let url = format!("{}{}{}{}", self.base.trim_end_matches('/'), path, if qs.is_empty() { "" } else { "?" }, qs);
        let fetched = match self.fetch_text(&url).await {
            Ok(text) => serde_json::from_str::<Value>(&text).map(|v| (text, v)).map_err(|_| OaError::BadResponse),
            Err(e) => Err(e),
        };
        match fetched {
            Ok((text, v)) => {
                self.db.oa_cache_put(&key, &text, now);
                Ok(v)
            }
            Err(e) => {
                if e.is_transient() {
                    if let Some(v) = cached.and_then(|(b, _)| serde_json::from_str::<Value>(&b).ok()) {
                        return Ok(v);
                    }
                }
                Err(e)
            }
        }
    }

    pub async fn work_by_id(&self, id: &str) -> Result<Work, OaError> {
        let id = oa::short_id(id).ok_or_else(|| OaError::Invalid("Identificador de trabalho inválido.".into()))?;
        let v = self.get_json(&format!("/works/{id}"), &[("select", oa::WORK_SELECT.to_string())]).await?;
        oa::parse_work(&v).ok_or(OaError::BadResponse)
    }

    pub async fn work_by_doi(&self, doi: &str) -> Result<Work, OaError> {
        let doi = oa::normalize_doi(doi).ok_or_else(|| OaError::Invalid("DOI inválido.".into()))?;
        let path = format!("/works/doi:{}", oa::pct_encode(&doi, "/:;()@,!*'"));
        let v = self.get_json(&path, &[("select", oa::WORK_SELECT.to_string())]).await?;
        oa::parse_work(&v).ok_or(OaError::BadResponse)
    }

    pub async fn search_works(&self, query: &str, per_page: usize) -> Result<Vec<Work>, OaError> {
        let q: String = query.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_QUERY_CHARS).collect();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let v = self
            .get_json(
                "/works",
                &[("search", q), ("per-page", per_page.to_string()), ("select", oa::WORK_SELECT.to_string())],
            )
            .await?;
        Ok(oa::parse_works(&v))
    }

    /// Busca vários trabalhos por id (até 50 por chamada), na ordem dos ids.
    pub async fn works_by_ids(&self, ids: &[String]) -> Result<Vec<Work>, OaError> {
        let mut out: Vec<Work> = Vec::new();
        for batch in ids.chunks(oa::BATCH_MAX) {
            let v = self
                .get_json(
                    "/works",
                    &[
                        ("filter", format!("openalex:{}", batch.join("|"))),
                        ("per-page", oa::BATCH_MAX.to_string()),
                        ("select", oa::WORK_SELECT.to_string()),
                    ],
                )
                .await?;
            out.extend(oa::parse_works(&v));
        }
        let pos = |w: &Work| ids.iter().position(|i| *i == w.id).unwrap_or(usize::MAX);
        out.sort_by_key(pos);
        out.dedup_by(|a, b| a.id == b.id);
        Ok(out)
    }

    /// Encontra o trabalho do documento: vínculo salvo > DOI nas primeiras páginas
    /// > busca por título (candidatos para o usuário confirmar). `query` força busca manual.
    pub async fn lookup(&self, doc: &Doc, pages: &[Page], query: Option<&str>, linked: Option<&str>) -> Result<Lookup, OaError> {
        if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
            let mut c = self.search_works(q, MAX_CANDIDATES).await?;
            c.truncate(MAX_CANDIDATES);
            return Ok(Lookup { source: "manual".into(), work: None, candidates: c });
        }
        if let Some(id) = linked {
            match self.work_by_id(id).await {
                Ok(w) => return Ok(Lookup { source: "link".into(), work: Some(w), candidates: vec![] }),
                // vínculo para um trabalho que sumiu do OpenAlex: segue para DOI/título
                Err(OaError::NotFound) | Err(OaError::Invalid(_)) | Err(OaError::BadResponse) => {}
                Err(e) => return Err(e),
            }
        }
        for doi in oa::dois_from_pages(pages, DOI_PAGES).into_iter().take(DOI_TRIES) {
            match self.work_by_doi(&doi).await {
                Ok(w) => return Ok(Lookup { source: "doi".into(), work: Some(w), candidates: vec![] }),
                Err(OaError::NotFound) | Err(OaError::BadResponse) => continue,
                Err(e) => return Err(e),
            }
        }
        let titles = oa::guess_titles(&doc.name, &doc.original_title, pages);
        for title in &titles {
            let mut found = self.search_works(title, 8).await?;
            if found.is_empty() {
                continue;
            }
            // mantém a relevância do OpenAlex e traz para a frente quem tem título mais parecido
            found.sort_by(|a, b| {
                oa::title_similarity(&b.title, title)
                    .partial_cmp(&oa::title_similarity(&a.title, title))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            found.truncate(MAX_CANDIDATES);
            return Ok(Lookup { source: "title".into(), work: None, candidates: found });
        }
        Ok(Lookup { source: "title".into(), work: None, candidates: vec![] })
    }

    pub async fn related(&self, work_id: &str, kind: RelKind, page: usize) -> Result<Related, OaError> {
        let id = oa::short_id(work_id).ok_or_else(|| OaError::Invalid("Identificador de trabalho inválido.".into()))?;
        let page = page.max(1);
        if kind == RelKind::CitedBy {
            if page * oa::PER_PAGE > MAX_RESULTS_WINDOW {
                return Err(OaError::Invalid("O OpenAlex só permite navegar pelos primeiros 10.000 resultados.".into()));
            }
            let v = self
                .get_json(
                    "/works",
                    &[
                        ("filter", format!("cites:{id}")),
                        ("sort", "cited_by_count:desc".to_string()),
                        ("per-page", oa::PER_PAGE.to_string()),
                        ("page", page.to_string()),
                        ("select", oa::WORK_SELECT.to_string()),
                    ],
                )
                .await?;
            let works = oa::parse_works(&v);
            let total = oa::parse_total(&v).unwrap_or(works.len());
            return Ok(Related { works, total, page });
        }
        let v = self
            .get_json(
                &format!("/works/{id}"),
                &[("select", "id,related_works,referenced_works".to_string())],
            )
            .await?;
        let field = if kind == RelKind::Related { "related_works" } else { "referenced_works" };
        let ids = oa::parse_id_list(&v, field);
        let total = ids.len();
        let start = (page - 1) * oa::PER_PAGE;
        if start >= total {
            return Ok(Related { works: vec![], total, page });
        }
        let slice = &ids[start..(start + oa::PER_PAGE).min(total)];
        let mut works = self.works_by_ids(slice).await?;
        if kind == RelKind::References {
            // referências: dentro da página, as mais citadas primeiro (a ordem de `related` é relevância)
            works.sort_by_key(|w| std::cmp::Reverse(w.cited_by_count));
        }
        Ok(Related { works, total, page })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Block;
    use crate::testsrv::{block_on, client, serve, Reply};
    use serde_json::json;

    fn work(id: &str, title: &str, cites: i64) -> Value {
        json!({"id": format!("https://openalex.org/{id}"), "title": title, "cited_by_count": cites, "publication_year": 2020,
               "authorships": [{"author": {"display_name": "Ana"}}], "open_access": {"is_oa": false}})
    }

    fn doc(name: &str) -> Doc {
        Doc { id: "d1".into(), name: name.into(), original_title: name.into(), page_count: 1, path: "/x".into(), created_at: "t".into() }
    }

    fn page_with(text: &str, blocks: Vec<Block>) -> Page {
        Page { n: 1, md: text.into(), text: text.into(), blocks, lines: vec![], figures: vec![] }
    }

    fn cli<'a>(http: &'a reqwest::Client, db: &'a Db, base: &str) -> OaClient<'a> {
        let mut c = OaClient::new(http, db, "9.9.9", Some("gerlan@example.org".into()));
        c.base = base.to_string();
        c.retry_unit = Duration::from_millis(2);
        c
    }

    #[test]
    fn user_agent_e_mailto() {
        let db = Db::open_in_memory().unwrap();
        let http = client();
        assert_eq!(OaClient::new(&http, &db, "1.2.3", None).user_agent, "Margem/1.2.3");
        assert_eq!(OaClient::new(&http, &db, "1.2.3", Some("  ".into())).user_agent, "Margem/1.2.3");
        let c = OaClient::new(&http, &db, "1.2.3", Some("a@b.org".into()));
        assert_eq!(c.user_agent, "Margem/1.2.3 (mailto:a@b.org)");
        assert_eq!(c.base, "https://api.openalex.org");
    }

    #[test]
    fn get_json_manda_mailto_user_agent_e_usa_cache() {
        let srv = serve(|_, _| Reply::json(200, &json!({"ok": true})));
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        block_on(async {
            let a = c.get_json("/works", &[("search", "letramento estatístico".into()), ("per-page", "3".into())]).await.unwrap();
            assert_eq!(a["ok"], true);
            // mesma consulta com parâmetros em outra ordem: vem do cache
            let b = c.get_json("/works", &[("per-page", "3".into()), ("search", "letramento estatístico".into())]).await.unwrap();
            assert_eq!(b["ok"], true);
        });
        assert_eq!(srv.count(), 1);
        let req = srv.request(0);
        let low = req.to_lowercase();
        assert!(req.starts_with("GET /works?per-page=3&search=letramento%20estat%C3%ADstico&mailto=gerlan%40example.org"), "{req}");
        assert!(low.contains("user-agent: margem/9.9.9 (mailto:gerlan@example.org)"), "{req}");
    }

    #[test]
    fn cache_vencido_busca_de_novo_e_serve_o_velho_se_a_rede_cair() {
        let srv = serve(|n, _| if n == 0 { Reply::json(200, &json!({"v": 1})) } else { Reply::text(503, "x") });
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        block_on(async {
            assert_eq!(c.get_json("/works/W1", &[]).await.unwrap()["v"], 1);
            // envelhece o cache além do TTL
            let key = oa::cache_key(&c.base, "/works/W1", &[]);
            let (body, _) = db.oa_cache_get(&key).unwrap();
            db.oa_cache_put(&key, &body, oa::unix_now() - oa::CACHE_TTL_SECS - 10);
            // servidor agora falha (503 em todas as tentativas): serve o velho
            assert_eq!(c.get_json("/works/W1", &[]).await.unwrap()["v"], 1);
            // sem cache nenhum: erro claro
            let e = c.get_json("/works/W2", &[]).await.unwrap_err();
            assert_eq!(e, OaError::Server(503));
            assert!(e.message().contains("instável"));
        });
    }

    #[test]
    fn retry_em_429_respeita_retry_after_e_depois_funciona() {
        let srv = serve(|n, _| match n {
            0 => Reply::text(429, "slow down").with_header("Retry-After", "1"),
            1 => Reply::text(500, "oops"),
            _ => Reply::json(200, &json!({"ok": 1})),
        });
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let v = block_on(c.get_json("/works", &[])).unwrap();
        assert_eq!(v["ok"], 1);
        assert_eq!(srv.count(), 3);
    }

    #[test]
    fn erros_definitivos_viram_mensagens_em_portugues() {
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let srv = serve(|_, t| match t {
            t if t.starts_with("/works/W404") => Reply::text(404, "nope"),
            t if t.starts_with("/works/W400") => Reply::text(400, "bad"),
            t if t.starts_with("/works/W429") => Reply::text(429, "x"),
            t if t.starts_with("/works/Wjson") => Reply::text(200, "<html>não é json</html>"),
            _ => Reply::text(200, "{}"),
        });
        let c = cli(&http, &db, &srv.base);
        block_on(async {
            assert_eq!(c.get_json("/works/W404", &[]).await.unwrap_err(), OaError::NotFound);
            assert_eq!(srv.count(), 1, "404 não tenta de novo");
            assert_eq!(c.get_json("/works/W400", &[]).await.unwrap_err(), OaError::Rejected(400));
            assert_eq!(c.get_json("/works/W429", &[]).await.unwrap_err(), OaError::RateLimited);
            assert_eq!(c.get_json("/works/Wjson", &[]).await.unwrap_err(), OaError::BadResponse);
        });
        assert!(OaError::NotFound.message().contains("não encontrado"));
        assert!(OaError::RateLimited.message().contains("429"));
        assert!(OaError::BadResponse.message().contains("inesperada"));
    }

    #[test]
    fn sem_conexao_com_o_openalex() {
        // porta fechada: conexão recusada
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        drop(l);
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &base);
        let e = block_on(c.get_json("/works", &[])).unwrap_err();
        assert_eq!(e, OaError::Offline);
        assert!(e.message().starts_with("Sem conexão com o OpenAlex"));
    }

    #[test]
    fn lookup_usa_vinculo_salvo() {
        let srv = serve(|_, t| {
            assert!(t.starts_with("/works/W5?"), "{t}");
            Reply::json(200, &work("W5", "Trabalho vinculado", 3))
        });
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let r = block_on(c.lookup(&doc("x"), &[], None, Some("W5"))).unwrap();
        assert_eq!(r.source, "link");
        assert_eq!(r.work.unwrap().title, "Trabalho vinculado");
        assert!(r.candidates.is_empty());
    }

    #[test]
    fn lookup_por_doi_das_primeiras_paginas() {
        let srv = serve(|_, t| {
            assert!(t.starts_with("/works/doi:10.1590/s0102-69092012000100002?"), "{t}");
            Reply::json(200, &work("W9", "Achado pelo DOI", 10))
        });
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let p = page_with("Revista X\nDOI: https://doi.org/10.1590/S0102-69092012000100002.\nResumo", vec![]);
        let r = block_on(c.lookup(&doc("scan"), &[p], None, None)).unwrap();
        assert_eq!(r.source, "doi");
        assert_eq!(r.work.unwrap().id, "W9");
    }

    #[test]
    fn doi_que_nao_existe_cai_para_o_proximo_e_depois_para_o_titulo() {
        let srv = serve(|_, t| {
            if t.starts_with("/works/doi:") {
                Reply::text(404, "x")
            } else {
                assert!(t.starts_with("/works?"), "{t}");
                Reply::json(200, &json!({"meta": {"count": 2}, "results": [work("W1", "Outro assunto qualquer sem relação", 100), work("W2", "Letramento estatístico na formação de professores", 5)]}))
            }
        });
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let blocks = vec![Block { text: "Letramento estatístico na formação de professores".into(), x: 72.0, y: 700.0, w: 300.0, h: 20.0, size: 20.0 }];
        let p = page_with("Letramento estatístico na formação de professores\ndoi:10.1000/naoexiste e 10.2000/tambemnao", blocks);
        let r = block_on(c.lookup(&doc("scan0001"), &[p], None, None)).unwrap();
        assert_eq!(r.source, "title");
        assert!(r.work.is_none());
        // o mais parecido sobe para o primeiro lugar
        assert_eq!(r.candidates.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["W2", "W1"]);
        assert_eq!(srv.count(), 3, "2 DOIs + 1 busca");
        assert!(srv.request(2).contains("search=Letramento%20estat%C3%ADstico%20na%20forma%C3%A7%C3%A3o%20de%20professores"));
    }

    #[test]
    fn lookup_manual_ignora_vinculo_e_limita_candidatos() {
        let srv = serve(|_, _| {
            let results: Vec<Value> = (1..=8).map(|i| work(&format!("W{i}"), &format!("Título {i}"), i)).collect();
            Reply::json(200, &json!({"meta": {"count": 8}, "results": results}))
        });
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let r = block_on(c.lookup(&doc("x"), &[], Some("  batanero estatística  "), Some("W5"))).unwrap();
        assert_eq!(r.source, "manual");
        assert_eq!(r.candidates.len(), 5);
        assert!(srv.request(0).contains("search=batanero%20estat%C3%ADstica"));
        assert!(srv.request(0).contains("per-page=5"));
    }

    #[test]
    fn lookup_sem_nada_para_buscar_devolve_vazio_sem_rede() {
        let srv = serve(|_, _| Reply::text(500, "não deveria ser chamado"));
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let r = block_on(c.lookup(&doc("scan"), &[], None, None)).unwrap();
        assert!(r.work.is_none() && r.candidates.is_empty());
        assert_eq!(srv.count(), 0);
        // busca sem resultados
        let srv2 = serve(|_, _| Reply::json(200, &json!({"meta": {"count": 0}, "results": []})));
        let c2 = cli(&http, &db, &srv2.base);
        let r = block_on(c2.lookup(&doc("scan"), &[], Some("zzz inexistente"), None)).unwrap();
        assert!(r.candidates.is_empty());
    }

    #[test]
    fn vinculo_quebrado_cai_para_a_busca_mas_erro_de_rede_propaga() {
        let srv = serve(|_, t| if t.starts_with("/works/W5") { Reply::text(404, "x") } else { Reply::json(200, &json!({"results": [work("W1", "Algum título interessante aqui", 1)]})) });
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let r = block_on(c.lookup(&doc("Algum título interessante aqui"), &[], None, Some("W5"))).unwrap();
        assert_eq!(r.source, "title");
        assert_eq!(r.candidates.len(), 1);
        let srv2 = serve(|_, _| Reply::text(503, "x"));
        let c2 = cli(&http, &db, &srv2.base);
        let e = block_on(c2.lookup(&doc("x"), &[], None, Some("W5"))).unwrap_err();
        assert_eq!(e, OaError::Server(503));
    }

    #[test]
    fn cited_by_usa_filtro_ordem_e_paginacao() {
        let srv = serve(|_, _| Reply::json(200, &json!({"meta": {"count": 61}, "results": [work("W1", "A", 9), work("W2", "B", 3)]})));
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let r = block_on(c.related("https://openalex.org/W77", RelKind::CitedBy, 2)).unwrap();
        assert_eq!((r.total, r.page, r.works.len()), (61, 2, 2));
        let q = srv.request(0);
        assert!(q.contains("filter=cites:W77") && q.contains("sort=cited_by_count:desc") && q.contains("per-page=25") && q.contains("page=2"), "{q}");
        assert!(q.contains("select=id,doi,title"), "{q}");
        let e = block_on(c.related("W77", RelKind::CitedBy, 401)).unwrap_err();
        assert!(e.message().contains("10.000"));
        assert!(block_on(c.related("lixo", RelKind::CitedBy, 1)).is_err());
    }

    #[test]
    fn related_pagina_ids_busca_em_lote_e_mantem_a_ordem() {
        let ids: Vec<String> = (1..=30).map(|i| format!("https://openalex.org/W{i}")).collect();
        let ids2 = ids.clone();
        let srv = serve(move |_, t| {
            if t.starts_with("/works/W7?") {
                Reply::json(200, &json!({"id": "https://openalex.org/W7", "related_works": ids2, "referenced_works": ["https://openalex.org/W100", "https://openalex.org/W101", "https://openalex.org/W102"]}))
            } else {
                // devolve embaralhado e pede só o que veio no filtro
                let f = t.split("filter=openalex:").nth(1).unwrap().split('&').next().unwrap();
                let wanted: Vec<&str> = f.split("%7C").collect();
                let mut results: Vec<Value> = wanted.iter().rev().map(|w| work(w, &format!("Trabalho {w}"), w[1..].parse::<i64>().unwrap())).collect();
                results.push(json!({"title": "sem id"}));
                Reply::json(200, &json!({"meta": {"count": wanted.len()}, "results": results}))
            }
        });
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        block_on(async {
            let p1 = c.related("W7", RelKind::Related, 1).await.unwrap();
            assert_eq!((p1.total, p1.page, p1.works.len()), (30, 1, 25));
            assert_eq!(p1.works[0].id, "W1");
            assert_eq!(p1.works[24].id, "W25");
            let p2 = c.related("W7", RelKind::Related, 2).await.unwrap();
            assert_eq!(p2.works.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["W26", "W27", "W28", "W29", "W30"]);
            let p3 = c.related("W7", RelKind::Related, 3).await.unwrap();
            assert!(p3.works.is_empty() && p3.total == 30);
            // referências: página única, mais citadas primeiro
            let refs = c.related("W7", RelKind::References, 1).await.unwrap();
            assert_eq!(refs.works.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["W102", "W101", "W100"]);
            assert_eq!(refs.total, 3);
        });
    }

    #[test]
    fn works_by_ids_divide_em_lotes_de_50() {
        let srv = serve(|_, t| {
            let f = t.split("filter=openalex:").nth(1).unwrap().split('&').next().unwrap().to_string();
            let results: Vec<Value> = f.split("%7C").map(|w| work(w, "T", 1)).collect();
            Reply::json(200, &json!({"results": results}))
        });
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let ids: Vec<String> = (1..=120).map(|i| format!("W{i}")).collect();
        let got = block_on(c.works_by_ids(&ids)).unwrap();
        assert_eq!(got.len(), 120);
        assert_eq!(srv.count(), 3);
        assert!(srv.request(0).contains("per-page=50"));
    }

    #[test]
    fn related_sem_campos_devolve_vazio() {
        let srv = serve(|_, _| Reply::json(200, &json!({"id": "https://openalex.org/W7"})));
        let db = Db::open_in_memory().unwrap();
        let http = client();
        let c = cli(&http, &db, &srv.base);
        let r = block_on(c.related("W7", RelKind::References, 1)).unwrap();
        assert!(r.works.is_empty() && r.total == 0);
        assert!(RelKind::parse("related").is_ok() && RelKind::parse("cited_by").is_ok() && RelKind::parse("x").is_err());
    }
}
