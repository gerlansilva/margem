use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::model::{Column, Doc, Page};

/// Teto do contexto de uma pergunta, em caracteres (~4 por token). A página
/// inteira fica, para a citação literal continuar verificável; o que muda é
/// quantas páginas entram.
pub const MAX_CHAT_CHARS: usize = 18_000;
pub const MAX_CHAT_PAGES: usize = 8;
/// Extração de fichamento precisa ver o documento todo para achar números.
pub const MAX_EXTRACT_CHARS: usize = 400_000;

pub const SYSTEM_CHAT: &str = r#"Você é um assistente de leitura acadêmica. Responde sobre documentos fornecidos.

Regras:
- Responda em português do Brasil, em prosa clara e concisa.
- Cada documento tem um rótulo (D1, D2, ...). Toda afirmação sobre um documento termina com o rótulo e a página: [D1 p.7]. Várias: [D1 p.7][D2 p.3].
- Ao citar números, definições ou resultados, copie o trecho literalmente entre aspas e cite: "texto exato" [D1 p.7].
- Use somente os documentos fornecidos. Se eles não responderem, diga isso. Nunca invente páginas ou conteúdo.
- Ao comparar documentos, diga em que concordam e em que divergem, citando cada um.
- Algumas perguntas vêm acompanhadas de recortes de figuras, gráficos ou tabelas, cada um rotulado com o documento e a página. Use o que estiver visível neles e cite a página do mesmo jeito.
"#;

pub const SYSTEM_EXTRACT: &str = r#"Você extrai dados de documentos acadêmicos para um quadro de fichamento.

O documento vem em Markdown, com páginas marcadas por <<<D1 p.3>>>.

Para CADA coluna pedida, devolva:
- "column_id": o id da coluna recebida;
- "value": o dado pedido, curto e objetivo (texto, número ou lista separada por ponto e vírgula);
- "quote": o trecho LITERAL do documento que sustenta o valor, com no mínimo 4 palavras e no máximo 300 caracteres;
- "page": o número da página onde o trecho aparece.

Se o documento não trouxer o dado, devolva value null, quote null e page null. Nunca preencha por dedução.
Responda SOMENTE com JSON válido, neste formato:
{"cells":[{"column_id":"x1","value":"...","quote":"...","page":3}]}
"#;

pub fn normalize(text: &str) -> String {
    // Remove hífens e o espaço ao redor: "cost- effective", "cost - effective" e
    // "cost-effective" viram a mesma coisa, o que é o que interessa para conferir quotes.
    let mut joined = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '-' || ch == '\u{00ad}' {
            while joined.ends_with(' ') {
                joined.pop();
            }
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            continue;
        }
        joined.push(ch);
        i += 1;
    }
    let mut out = String::with_capacity(joined.len());
    let mut space = false;
    for ch in joined.to_lowercase().chars() {
        if ch.is_whitespace() {
            if !space {
                out.push(' ');
                space = true;
            }
        } else {
            out.push(ch);
            space = false;
        }
    }
    out.trim().to_string()
}

const STOP: &[&str] = &[
    "para", "como", "qual", "quais", "onde", "quando", "porque", "sobre", "entre", "esse", "essa",
    "isso", "este", "esta", "aqui", "mais", "menos", "muito", "pode", "pela", "pelo", "pelos",
    "pelas", "com", "sem", "dos", "das", "uma", "que", "the", "and", "with", "from", "this",
    "that", "were", "was", "are", "for", "por", "nos", "nas",
];

pub fn terms(text: &str) -> HashSet<String> {
    normalize(text)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 4 && !STOP.contains(w))
        .map(|w| w.to_string())
        .collect()
}

pub struct DocContext<'a> {
    pub label: String,
    pub doc: &'a Doc,
    pub pages: &'a [Page],
}

pub fn build_context(docs: &[DocContext<'_>], question: &str) -> String {
    let q = terms(question);
    let extract = q.is_empty();

    let mut out = String::new();
    for d in docs {
        out.push_str(&format!("<<<{}: {}>>>\n", d.label, d.doc.name));
        let budget = if extract {
            MAX_EXTRACT_CHARS
        } else {
            MAX_CHAT_CHARS / docs.len().max(1)
        };
        for p in select_pages(d.pages, &q, budget) {
            out.push_str(&format!("<<<{} p.{}>>>\n{}\n\n", d.label, p.n, p.md));
        }
    }
    out
}

/// Escolhe as páginas que vão para o modelo. Página 1 entra sempre (título e
/// resumo), o resto por sobreposição de termos com a pergunta, com vizinho de
/// continuação quando cabe no orçamento.
fn select_pages<'a>(pages: &'a [Page], q: &HashSet<String>, budget: usize) -> Vec<&'a Page> {
    if q.is_empty() {
        let mut chosen = Vec::new();
        let mut used = 0;
        for p in pages {
            if used + p.md.len() > budget && !chosen.is_empty() {
                break;
            }
            used += p.md.len();
            chosen.push(p);
        }
        return chosen;
    }

    // Peso por raridade: termo que aparece em poucas páginas vale mais que
    // "artigo", que está em todas. Sem isso, uma pergunta sobre as referências
    // perdia para as páginas 2-5 só porque repetem a palavra "artigo".
    let page_terms: Vec<(&Page, HashSet<String>)> =
        pages.iter().map(|p| (p, terms(&p.md))).collect();
    let total = pages.len().max(1) as f64;
    let mut df: HashMap<&str, usize> = HashMap::new();
    for term in q {
        let count = page_terms
            .iter()
            .filter(|(_, set)| set.contains(term))
            .count();
        df.insert(term.as_str(), count);
    }
    let mut scored: Vec<(&Page, f64)> = page_terms
        .iter()
        .map(|(p, set)| {
            let score = q
                .iter()
                .filter(|term| set.contains(*term))
                .map(|term| {
                    let n = *df.get(term.as_str()).unwrap_or(&1) as f64;
                    1.0 + (total / n.max(1.0)).ln()
                })
                .sum();
            (*p, score)
        })
        .collect();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.n.cmp(&b.0.n))
    });

    // Pergunta genérica ("resuma o artigo"): nada casa, então vale o começo.
    if scored.first().map(|(_, score)| *score).unwrap_or(0.0) == 0.0 {
        let mut chosen = Vec::new();
        let mut used = 0;
        for p in pages.iter().take(4) {
            if used + p.md.len() <= budget || chosen.is_empty() {
                chosen.push(p);
                used += p.md.len();
            }
        }
        return chosen;
    }

    let mut chosen: Vec<&Page> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    let mut used = 0;
    if let Some(first) = pages.first() {
        chosen.push(first);
        seen.insert(first.n);
        used += first.md.len();
    }
    let mut primary = 0;
    for (page, score) in &scored {
        if chosen.len() >= MAX_CHAT_PAGES || *score == 0.0 {
            break;
        }
        if seen.contains(&page.n) || used + page.md.len() > budget {
            continue;
        }
        chosen.push(page);
        seen.insert(page.n);
        used += page.md.len();
        primary += 1;
        // A página seguinte continua o assunto, mas só para os dois melhores.
        if primary <= 2 {
            if let Some(next) = pages.iter().find(|p| p.n == page.n + 1) {
                if !seen.contains(&next.n) && used + next.md.len() <= budget {
                    chosen.push(next);
                    seen.insert(next.n);
                    used += next.md.len();
                }
            }
        }
    }
    chosen.sort_by_key(|p| p.n);
    chosen
}

/// Só aceita a quote se ela existir literalmente na página (ou em outra página do documento).
pub fn verify_quote(quote: Option<String>, page: Option<i64>, pages: &[Page]) -> (Option<String>, Option<i64>) {
    let Some(quote) = quote else { return (None, None) };
    let q = normalize(&quote);
    if q.split_whitespace().count() < 3 {
        return (None, None);
    }
    let q = if q.chars().count() > 300 { q.chars().take(300).collect() } else { q };
    if let Some(n) = page {
        if let Some(p) = pages.iter().find(|p| p.n == n) {
            if normalize(&p.text).contains(&q) {
                return (Some(quote.trim().to_string()), Some(n));
            }
        }
    }
    for p in pages {
        if normalize(&p.text).contains(&q) {
            return (Some(quote.trim().to_string()), Some(p.n));
        }
    }
    (None, None)
}

pub fn chat_body(
    model: &str,
    context: &str,
    history: &[crate::model::Msg],
    selection: Option<&str>,
    images: &[(String, String)],
) -> Value {
    let mut messages: Vec<Value> = vec![json!({"role":"system","content":SYSTEM_CHAT})];
    // A pergunta atual é a última da lista; as anteriores viram histórico.
    let last = history.len().saturating_sub(1);
    let question = history
        .get(last)
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let extra = selection
        .map(|s| format!("\n\nO leitor destacou este trecho e quer falar sobre ele:\n\"{}\"\n", s.trim()))
        .unwrap_or_default();
    // Documentos primeiro, conversa depois, pergunta no fim: é a ordem que o
    // modelo espera e a que deixa o bloco de documentos estável no começo.
    let prompt = format!("DOCUMENTOS:\n{context}");
    if images.is_empty() {
        messages.push(json!({"role": "user", "content": prompt}));
    } else {
        let mut parts = vec![json!({"type": "text", "text": prompt})];
        for (label, url) in images {
            parts.push(json!({"type": "text", "text": label}));
            parts.push(json!({"type": "image_url", "image_url": {"url": url}}));
        }
        messages.push(json!({"role": "user", "content": parts}));
    }
    // Só as últimas trocas: resposta longa antiga não precisa voltar inteira.
    let prior = &history[..last];
    let start = prior.len().saturating_sub(6);
    for m in &prior[start..] {
        messages.push(json!({"role": m.role, "content": m.content}));
    }
    messages.push(json!({
        "role": "user",
        "content": format!("{extra}PERGUNTA: {question}")
    }));

    json!({
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 4000,
        "stream": true,
        "thinking": {"type": "disabled"}
    })
}

pub fn extract_body(model: &str, context: &str, columns: &[Column]) -> Value {
    let cols: Vec<Value> = columns
        .iter()
        .map(|c| json!({"column_id": c.id, "name": c.name, "instruction": c.instruction, "type": c.kind}))
        .collect();
    json!({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_EXTRACT},
            {"role": "user", "content": format!(
                "DOCUMENTOS:\n{context}\n\nCOLUNAS (json):\n{}",
                serde_json::to_string(&cols).unwrap_or_default()
            )}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
        "max_tokens": 8000,
        "thinking": {"type": "disabled"}
    })
}

fn flexible_text<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(s)) => Some(s),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    })
}

fn flexible_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    })
}

#[derive(Deserialize)]
pub struct RawCell {
    pub column_id: Option<String>,
    #[serde(default, deserialize_with = "flexible_text")]
    pub value: Option<String>,
    #[serde(default, deserialize_with = "flexible_text")]
    pub quote: Option<String>,
    #[serde(default, deserialize_with = "flexible_i64")]
    pub page: Option<i64>,
}

pub fn parse_cells(raw: &str) -> Result<Vec<RawCell>, String> {
    let trimmed = raw.trim();
    let body = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .trim_end_matches("```")
        .trim();
    let value: Value = serde_json::from_str(body).map_err(|e| format!("JSON inválido: {e}"))?;
    let cells = value
        .get("cells")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    serde_json::from_value(cells).map_err(|e| format!("Formato inesperado: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Block, Doc, Page};

    fn doc() -> Doc {
        Doc {
            id: "d1".into(),
            name: "Artigo".into(),
            page_count: 2,
            path: "/tmp/a.pdf".into(),
            created_at: "".into(),
        }
    }

    fn page(n: i64, text: &str) -> Page {
        Page {
            n,
            md: text.into(),
            text: text.into(),
            blocks: vec![Block {
                text: text.into(),
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
                size: 11.0,
            }],
            lines: vec![],
            figures: vec![],
        }
    }

    #[test]
    fn pergunta_atual_vai_no_prompt_e_historico_fica_curto() {
        let mut history = vec![
            crate::model::Msg { role: "user".into(), content: "primeira".into() },
            crate::model::Msg { role: "assistant".into(), content: "resposta".into() },
        ];
        for i in 0..10 {
            history.push(crate::model::Msg { role: "user".into(), content: format!("antiga {i}") });
            history.push(crate::model::Msg { role: "assistant".into(), content: format!("volta {i}") });
        }
        history.push(crate::model::Msg { role: "user".into(), content: "pergunta nova".into() });

        let body = chat_body("m", "CTX", &history, None, &[]);
        let messages = body["messages"].as_array().unwrap();
        let docs = messages[1]["content"].as_str().unwrap();
        assert!(docs.contains("CTX"));
        assert_eq!(messages.len(), 2 + 6 + 1, "só as últimas seis trocas voltam");
        let last = messages.last().unwrap()["content"].as_str().unwrap();
        assert!(last.contains("PERGUNTA: pergunta nova"));
        assert!(!docs.contains("pergunta nova"), "a pergunta não vai junto dos documentos");
    }

    #[test]
    fn pergunta_manda_so_as_paginas_relevantes() {
        let filler = "texto corrido sobre outro assunto, sem relacao com a pergunta. ".repeat(60);
        let mut pages: Vec<Page> = (1..=12).map(|n| page(n, &filler)).collect();
        pages[6] = page(7, "A amostra teve 120 participantes de 15 estados.");
        let doc = Doc { page_count: 12, ..doc() };
        let ctx = [DocContext {
            label: "D1".into(),
            doc: &doc,
            pages: &pages,
        }];
        let out = build_context(&ctx, "quantos participantes a amostra teve?");
        assert!(out.contains("p.7"), "a pagina da resposta precisa entrar");
        assert!(!out.contains("p.12"), "o documento inteiro nao deve ir");
        assert!(out.len() < MAX_CHAT_CHARS + filler.len());
    }

    #[test]
    fn pergunta_generica_cai_nas_primeiras_paginas() {
        let pages: Vec<Page> = (1..=10)
            .map(|n| page(n, &format!("conteudo da pagina {n} sem termos da pergunta")))
            .collect();
        let doc = Doc { page_count: 10, ..doc() };
        let ctx = [DocContext {
            label: "D1".into(),
            doc: &doc,
            pages: &pages,
        }];
        let out = build_context(&ctx, "resuma o artigo");
        assert!(out.contains("p.1") && out.contains("p.4"));
        assert!(!out.contains("p.10"));
    }

    #[test]
    fn aceita_quote_literal_mesmo_com_hifen_quebrado() {
        let pages = vec![page(2, "The cost- effective method was used in all ten sites.")];
        let (quote, n) = verify_quote(
            Some("the cost-effective method was used".into()),
            Some(2),
            &pages,
        );
        assert!(quote.is_some());
        assert_eq!(n, Some(2));
    }

    #[test]
    fn rejeita_quote_inventada() {
        let pages = vec![page(1, "A amostra teve 120 participantes.")];
        let (quote, n) = verify_quote(Some("a amostra teve 900 participantes".into()), Some(1), &pages);
        assert!(quote.is_none());
        assert!(n.is_none());
    }

    #[test]
    fn encontra_a_pagina_certa_quando_o_modelo_erra() {
        let pages = vec![page(1, "Introdução sem dados."), page(3, "O odds ratio foi de 2,4.")];
        let (_, n) = verify_quote(Some("o odds ratio foi de 2,4".into()), Some(1), &pages);
        assert_eq!(n, Some(3));
    }

    #[test]
    fn contexto_marca_documento_e_pagina() {
        let doc = doc();
        let pages = vec![page(1, "Primeira página."), page(2, "Segunda página.")];
        let ctx = [DocContext {
            label: "D1".into(),
            doc: &doc,
            pages: &pages,
        }];
        let text = build_context(&ctx, "qual o método?");
        assert!(text.contains("<<<D1: Artigo>>>"));
        assert!(text.contains("<<<D1 p.2>>>"));
    }

    #[test]
    fn le_json_com_cerca_de_codigo() {
        let raw = "```json\n{\"cells\":[{\"doc_id\":\"d1\",\"column_id\":\"c1\",\"value\":120,\"quote\":\"y z w\",\"page\":\"2\"}]}\n```";
        let cells = parse_cells(raw).unwrap();
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].value.as_deref(), Some("120"));
        assert_eq!(cells[0].page, Some(2));
    }
}
