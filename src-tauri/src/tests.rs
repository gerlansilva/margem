//! Testes de integração da lógica pura: usam só ai/evidence/db/fichamento/export/net,
//! com páginas realistas (acentos, hifenização, ligaturas, duas colunas).
//! Rodam com `cargo test --lib`.

use crate::ai::{self, DocContext};
use crate::db::Db;
use crate::export;
use crate::fichamento;
use crate::model::{Block, Column, Doc, Line, Msg, Page};
use crate::net::{self, SseItem, SseParser};

/// Página no formato que o extrator do frontend produz: `lines` com retângulos,
/// `text` com as linhas unidas por quebra e `md` com cabeçalho.
fn page_from_lines(n: i64, raw: &[&str]) -> Page {
    let lines: Vec<Line> = raw
        .iter()
        .enumerate()
        .map(|(i, t)| Line { i: i as i64, text: (*t).to_string(), rect: [72.0, 760.0 - 14.0 * i as f64, 520.0, 772.0 - 14.0 * i as f64] })
        .collect();
    let text = raw.join("\n");
    Page {
        n,
        md: text.clone(),
        text: text.clone(),
        blocks: vec![Block { text, x: 72.0, y: 700.0, w: 448.0, h: 70.0, size: 11.0 }],
        lines,
        figures: vec![],
    }
}

fn artigo() -> (Doc, Vec<Page>) {
    let doc = Doc {
        id: "d1".into(),
        name: "Lopes (2012) — Educação Estatística no Brasil".into(),
        page_count: 3,
        path: "/dados/uploads/d1.pdf".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
    };
    let pages = vec![
        page_from_lines(1, &[
            "Educação Estatística no Brasil: um panorama",
            "RESUMO. Este artigo apresenta um levantamento das pesquisas em Educação",
            "Estatística no Brasil, com ênfase na formação de pro-",
            "fessores que ensinam probabilidade e estatística.",
        ]),
        page_from_lines(2, &[
            "METODOLOGIA",
            "Neste levantamento, foram coligidas 258 pesquisas - 31 teses de doutorado e 227 dissertações de",
            "mestrado -, produzidas em 56 universidades brasileiras. A amostra de professores",
            "foi composta por 120 participantes de 15 estados, selecionados por conveniência.",
        ]),
        page_from_lines(3, &[
            "RESULTADOS",
            "A análise estatisticamente signiﬁcativa (p < 0,01) mostrou que a formac\u{0327}a\u{0303}o",
            "continuada aumentou a conﬁança dos professores ao ensinar variabilidade.",
            "O coeficiente de correlação de Pearson foi de 0,82.",
        ]),
    ];
    (doc, pages)
}

fn col(id: &str, name: &str, instruction: &str) -> Column {
    Column { id: id.into(), name: name.into(), instruction: instruction.into(), kind: "text".into() }
}

fn raw(json: &str) -> Vec<ai::RawCell> {
    ai::parse_cells(json).expect("json do teste é válido")
}

#[test]
fn chat_de_ponta_a_ponta_escolhe_a_pagina_e_valida_citacoes() {
    let (doc, pages) = artigo();
    let ctx = [DocContext { label: "D1".into(), doc: &doc, pages: &pages }];
    let built = ai::build_context(&ctx, "Quantos participantes tinha a amostra de professores?");
    assert!(built.text.contains("<<<D1 p.2>>>"));
    let body = ai::chat_body(
        "deepseek-flash",
        &built.text,
        &[Msg { role: "user".into(), content: "Quantos participantes tinha a amostra de professores?".into() }],
        Some("amostra de professores"),
        &[],
    );
    let prompt = body["messages"][1]["content"].as_str().unwrap();
    assert!(prompt.contains("120 participantes"));
    assert!(body["messages"][2]["content"].as_str().unwrap().contains("destacou este trecho"));

    // Resposta típica do modelo, com uma citação inventada (p.9) e uma de documento inexistente.
    let resposta = "A amostra teve \"120 participantes de 15 estados\" [D1 p.2]. Outro dado [D1 p.9][D2 p.1].";
    let checks = ai::check_citations(resposta, &built.sent_pages);
    let validas: Vec<bool> = checks.iter().map(|c| c["valid"].as_bool().unwrap()).collect();
    assert_eq!(validas, vec![true, false, false]);
}

#[test]
fn extracao_de_ponta_a_ponta_com_modelo_bem_comportado() {
    let (doc, pages) = artigo();
    let db = Db::open_in_memory().unwrap();
    db.insert_doc(&doc.id, &doc.name, &doc.path, &doc.created_at).unwrap();
    db.save_pages(&doc.id, &pages).unwrap();
    let cols = vec![
        col("c1", "Amostra", "Número de participantes"),
        col("c2", "Universidades", "Quantas universidades"),
        col("c3", "Software", "Programa estatístico usado"),
    ];
    let resposta = r#"{"cells":[
      {"column_id":"c1","value":"120 participantes","quote":"A amostra de professores foi composta por 120 participantes de 15 estados","page":2},
      {"column_id":"c2","value":56,"quote":"produzidas em 56 universidades brasileiras","page":"2"},
      {"column_id":"c3","value":null,"quote":null,"page":null}
    ]}"#;
    fichamento::apply_cells(&db, &doc.id, &db.pages(&doc.id).unwrap(), &cols, raw(resposta)).unwrap();

    let cells = db.cells(Some(&doc.id)).unwrap();
    assert_eq!(cells.len(), 3);
    let c1 = cells.iter().find(|c| c.column_id == "c1").unwrap();
    assert_eq!(c1.status, "filled");
    assert_eq!(c1.page, Some(2));
    assert_eq!(c1.evidence.len(), 1);
    let evid = db.get_evidence(&c1.evidence[0]).unwrap().unwrap();
    assert_eq!(evid.page, 2);
    assert!(!evid.rects.is_empty());
    let c2 = cells.iter().find(|c| c.column_id == "c2").unwrap();
    assert_eq!(c2.value.as_deref(), Some("56"));
    assert_eq!(cells.iter().find(|c| c.column_id == "c3").unwrap().status, "not_found");
}

#[test]
fn extracao_descarta_valor_com_citacao_inventada_e_coluna_desconhecida() {
    let (doc, pages) = artigo();
    let db = Db::open_in_memory().unwrap();
    db.insert_doc(&doc.id, &doc.name, &doc.path, &doc.created_at).unwrap();
    let cols = vec![col("c1", "Amostra", "n")];
    let resposta = r#"{"cells":[
      {"column_id":"c1","value":"900 participantes","quote":"a amostra teve 900 participantes de 40 estados","page":2},
      {"column_id":"fantasma","value":"x","quote":"nada","page":1}
    ]}"#;
    fichamento::apply_cells(&db, &doc.id, &pages, &cols, raw(resposta)).unwrap();
    let cells = db.cells(Some(&doc.id)).unwrap();
    assert_eq!(cells.len(), 1);
    assert_eq!(cells[0].status, "not_found");
    assert!(cells[0].value.is_none() && cells[0].quote.is_none());
}

#[test]
fn extracao_corrige_pagina_errada_e_aceita_ligatura_acento_e_hifen() {
    let (doc, pages) = artigo();
    let db = Db::open_in_memory().unwrap();
    db.insert_doc(&doc.id, &doc.name, &doc.path, &doc.created_at).unwrap();
    let cols = vec![
        col("c1", "Ênfase", "ênfase do artigo"),
        col("c2", "Efeito", "efeito da formação"),
        col("c3", "Correlação", "r de Pearson"),
    ];
    let resposta = r#"{"cells":[
      {"column_id":"c1","value":"formação de professores","quote":"com ênfase na formação de professores que ensinam probabilidade","page":3},
      {"column_id":"c2","value":"aumentou a confiança","quote":"a formação continuada aumentou a confiança dos professores","page":3},
      {"column_id":"c3","value":"0,82","quote":"coeficiente de correlação de Pearson foi de 0,82","page":3}
    ]}"#;
    fichamento::apply_cells(&db, &doc.id, &pages, &cols, raw(resposta)).unwrap();
    let cells = db.cells(Some(&doc.id)).unwrap();
    let get = |id: &str| cells.iter().find(|c| c.column_id == id).unwrap();
    assert_eq!(get("c1").page, Some(1), "o modelo errou a página; a verificação achou a certa");
    assert_eq!(get("c1").status, "filled");
    assert_eq!(get("c2").status, "filled", "NFD + ligatura");
    assert_eq!(get("c3").page, Some(3));
}

#[test]
fn extracao_com_coluna_repetida_pelo_modelo_mantem_a_resposta_com_valor() {
    let (doc, pages) = artigo();
    let db = Db::open_in_memory().unwrap();
    db.insert_doc(&doc.id, &doc.name, &doc.path, &doc.created_at).unwrap();
    let cols = vec![col("c1", "Amostra", "n")];
    let resposta = r#"{"cells":[
      {"column_id":"c1","value":"120","quote":"composta por 120 participantes de 15 estados","page":2},
      {"column_id":"c1","value":null,"quote":null,"page":null}
    ]}"#;
    fichamento::apply_cells(&db, &doc.id, &pages, &cols, raw(resposta)).unwrap();
    assert_eq!(db.cells(Some(&doc.id)).unwrap()[0].value.as_deref(), Some("120"));
}

#[test]
fn csv_do_fichamento_completo_abre_no_excel() {
    let (doc, pages) = artigo();
    let db = Db::open_in_memory().unwrap();
    db.insert_doc(&doc.id, &doc.name, &doc.path, &doc.created_at).unwrap();
    let cols = vec![col("c1", "Amostra", "n"), col("c2", "Obs", "x")];
    db.replace_columns(&cols).unwrap();
    let resposta = r#"{"cells":[
      {"column_id":"c1","value":"120","quote":"composta por 120 participantes de 15 estados","page":2},
      {"column_id":"c2","value":"=1+1","quote":"selecionados por conveniência","page":2}
    ]}"#;
    fichamento::apply_cells(&db, &doc.id, &pages, &cols, raw(resposta)).unwrap();
    let csv = export::csv_string(&db.list_docs().unwrap(), &db.columns().unwrap(), &db.cells(None).unwrap(), ',');
    assert!(csv.starts_with('\u{feff}'));
    assert!(csv.contains("'=1+1"), "fórmula neutralizada: {csv}");
    assert!(csv.contains("\"Lopes (2012) — Educação Estatística no Brasil\"") || csv.contains("Lopes (2012) — Educação Estatística no Brasil"));
    assert!(csv.contains("[p.2] composta por 120 participantes de 15 estados"));
}

#[test]
fn stream_completo_de_resposta_com_acentos_em_pedacos_irregulares() {
    // Resposta real do formato OpenAI/DeepSeek, cortada em tamanhos arbitrários (inclui 1 byte).
    let tokens = ["A amostra", " teve ", "120 particip", "antes", " [D1 p.2]", ". Conclusão: não há evidência — ok."];
    let mut wire = String::from(": keep-alive\n\n");
    for t in tokens {
        wire.push_str(&format!("data: {}\n\n", serde_json::json!({"choices":[{"delta":{"content":t},"finish_reason":null}]})));
    }
    wire.push_str("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
    let bytes = wire.as_bytes();
    for size in [1usize, 2, 3, 5, 7, 13, 64, bytes.len()] {
        let mut parser = SseParser::new();
        let mut answer = String::new();
        let mut finish = None;
        let mut done = false;
        for chunk in bytes.chunks(size) {
            for item in parser.feed(chunk).unwrap() {
                match item {
                    SseItem::Data(d) => {
                        let delta = net::parse_stream_payload(&d);
                        answer.push_str(&delta.token.unwrap_or_default());
                        if delta.finish_reason.is_some() {
                            finish = delta.finish_reason;
                        }
                    }
                    SseItem::Done => done = true,
                }
            }
        }
        assert_eq!(answer, "A amostra teve 120 participantes [D1 p.2]. Conclusão: não há evidência — ok.", "pedaços de {size}");
        assert_eq!(finish.as_deref(), Some("stop"));
        assert!(done);
        assert_eq!(ai::parse_citations(&answer).len(), 1);
    }
}

#[test]
fn erro_no_meio_do_stream_e_reconhecido() {
    let mut parser = SseParser::new();
    let items = parser
        .feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"Ol\"}}]}\n\ndata: {\"error\":{\"message\":\"Server is busy\"}}\n\n")
        .unwrap();
    let deltas: Vec<_> = items
        .into_iter()
        .filter_map(|i| if let SseItem::Data(d) = i { Some(net::parse_stream_payload(&d)) } else { None })
        .collect();
    assert_eq!(deltas[0].token.as_deref(), Some("Ol"));
    assert_eq!(deltas[1].error.as_deref(), Some("Server is busy"));
}

#[test]
fn json_de_erro_com_status_200_nao_vira_resposta_vazia_silenciosa() {
    let mut parser = SseParser::new();
    assert!(parser.feed(b"{\"error\":{\"message\":\"Insufficient Balance\"}}").unwrap().is_empty());
    assert!(parser.finish().is_empty());
    let msg = net::provider_message(parser.stray()).unwrap();
    assert!(msg.contains("Insufficient Balance"), "{msg}");
}
