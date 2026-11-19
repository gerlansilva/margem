//! Busca no acervo: índice local SQLite FTS5 (uma linha por página, tokenizer
//! `unicode61` sem acentos, ranking BM25) e, opcionalmente, vetores por trecho
//! (~800 caracteres) para a busca híbrida. Tudo aqui é síncrono e testável sem
//! Tauri; a rede dos embeddings fica em `embed.rs`.
//!
//! O texto indexado passa por `prepare_text` (NFKC: ligaduras "ﬁ" viram "fi";
//! hifenização de fim de linha desfeita; espaços colapsados). O snippet e a
//! `quote` devolvidos saem desse mesmo texto, que `resolve_evidence` consegue
//! localizar porque normaliza do mesmo jeito.

use std::collections::{HashMap, HashSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, Transaction};
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::db::Db;

pub const CHUNK_CHARS: usize = 800;
pub const CHUNK_OVERLAP: usize = 120;
/// Subir este número reindexa tudo na próxima abertura (mudou tokenizer/preparo do texto).
pub const INDEX_VERSION: i64 = 1;
/// k do Reciprocal Rank Fusion (valor clássico).
pub const RRF_K: f64 = 60.0;
const SNIPPET_TOKENS: i64 = 32;
const MAX_QUOTE_CHARS: usize = 160;
const MAX_TERMS: usize = 32;
const MAX_WORD_CHARS: usize = 64;
const MAX_DOC_FILTER: usize = 500;

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
           text, tokenize='unicode61 remove_diacritics 2'
         );
         CREATE TABLE IF NOT EXISTS fts_pages(
           id INTEGER PRIMARY KEY,
           doc_id TEXT NOT NULL,
           page INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS fts_pages_doc ON fts_pages(doc_id);
         CREATE TABLE IF NOT EXISTS chunks(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           doc_id TEXT NOT NULL,
           page INTEGER NOT NULL,
           idx INTEGER NOT NULL,
           text TEXT NOT NULL,
           model TEXT,
           vec BLOB
         );
         CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id, page);
         CREATE TABLE IF NOT EXISTS index_state(
           doc_id TEXT PRIMARY KEY,
           version INTEGER NOT NULL,
           indexed_at TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("Falha ao preparar o índice de busca: {e}"))
}

// ------------------------------------------------------------ preparo do texto

/// Texto como é indexado: NFKC, sem hífen macio nem caracteres invisíveis,
/// "estatís-\ntica" vira "estatística" e qualquer espaço/quebra vira um espaço.
pub fn prepare_text(raw: &str) -> String {
    let chars: Vec<char> = raw.nfkc().collect();
    let len = chars.len();
    let mut out = String::with_capacity(raw.len());
    let mut pending_space = false;
    let mut i = 0;
    while i < len {
        let c = chars[i];
        i += 1;
        if matches!(c, '\u{ad}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{feff}') {
            continue;
        }
        if c == '-' && i >= 2 && chars[i - 2].is_alphabetic() {
            // hífen no fim da linha, com a palavra continuando em minúscula na seguinte
            let mut j = i;
            while j < len && matches!(chars[j], ' ' | '\t' | '\r') {
                j += 1;
            }
            if j < len && chars[j] == '\n' {
                let mut k = j + 1;
                while k < len && matches!(chars[k], ' ' | '\t' | '\r') {
                    k += 1;
                }
                if k < len && chars[k].is_lowercase() {
                    i = k;
                    continue;
                }
            }
        }
        if c.is_whitespace() || c.is_control() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    out
}

/// Divide em trechos de ~`size` caracteres, cortando em espaços, com `overlap`
/// de sobreposição. Conta caracteres Unicode, nunca bytes.
pub fn chunk_text(text: &str, size: usize, overlap: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    if len == 0 {
        return vec![];
    }
    let size = size.max(8);
    if len <= size {
        return vec![text.trim().to_string()];
    }
    let overlap = overlap.min(size / 2);
    let mut out = Vec::new();
    let mut start = 0usize;
    loop {
        let hard_end = (start + size).min(len);
        let mut end = hard_end;
        if hard_end < len {
            let min_end = start + size / 2;
            let mut e = hard_end;
            while e > min_end && chars[e] != ' ' {
                e -= 1;
            }
            if chars[e] == ' ' {
                end = e;
            }
        }
        let piece: String = chars[start..end].iter().collect();
        let piece = piece.trim();
        if !piece.is_empty() {
            out.push(piece.to_string());
        }
        if end >= len {
            break;
        }
        let mut next = end.saturating_sub(overlap);
        if next <= start {
            next = end;
        } else {
            while next < end && chars[next] != ' ' {
                next += 1;
            }
        }
        while next < len && chars[next] == ' ' {
            next += 1;
        }
        start = next;
    }
    out
}

// ------------------------------------------------------------------ consulta

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || ('\u{300}'..='\u{36f}').contains(&c)
}

fn split_words(s: &str) -> Vec<String> {
    s.split(|c: char| !is_word_char(c))
        .filter(|w| !w.is_empty())
        .map(|w| w.chars().take(MAX_WORD_CHARS).collect())
        .collect()
}

enum Tok {
    Term { words: Vec<String>, prefix: bool },
    Or,
}

/// Converte o que o usuário digitou em uma expressão FTS5 que nunca é inválida.
///
/// - `"entre aspas"` vira frase;
/// - cada palavra solta é um termo; todos precisam aparecer (AND implícito);
/// - `OR` em maiúsculas vira OR (ex.: `letramento OR literacia`; no FTS5 o AND
///   tem precedência sobre o OR); `AND` e `NOT` em maiúsculas são ignorados;
/// - `estat*` vira prefixo;
/// - pontuação, parênteses, hífens e o resto da sintaxe do FTS5 são descartados:
///   `covid-19` vira a frase "covid 19".
///
/// `None` quando não sobra nenhum termo.
pub fn build_fts_query(raw: &str) -> Option<String> {
    let text: Vec<char> = raw.nfkc().collect();
    let mut toks: Vec<Tok> = Vec::new();
    let mut i = 0;
    while i < text.len() {
        let c = text[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '"' {
            let mut j = i + 1;
            while j < text.len() && text[j] != '"' {
                j += 1;
            }
            let inner: String = text[i + 1..j].iter().collect();
            let words = split_words(&inner);
            if !words.is_empty() {
                toks.push(Tok::Term { words, prefix: false });
            }
            i = j + 1;
        } else {
            let mut j = i;
            while j < text.len() && !text[j].is_whitespace() && text[j] != '"' {
                j += 1;
            }
            let chunk: String = text[i..j].iter().collect();
            i = j;
            match chunk.as_str() {
                "OR" => toks.push(Tok::Or),
                "AND" | "NOT" => {}
                _ => {
                    let words = split_words(&chunk);
                    if !words.is_empty() {
                        toks.push(Tok::Term { words, prefix: chunk.ends_with('*') });
                    }
                }
            }
        }
    }
    let mut parts: Vec<String> = Vec::new();
    let mut terms = 0;
    let mut pending_or = false;
    for tok in &toks {
        match tok {
            Tok::Or => pending_or = !parts.is_empty(),
            Tok::Term { words, prefix } => {
                if terms >= MAX_TERMS {
                    break;
                }
                if pending_or {
                    parts.push("OR".to_string());
                    pending_or = false;
                }
                let phrase = format!("\"{}\"", words.join(" "));
                parts.push(if *prefix { format!("{phrase} *") } else { phrase });
                terms += 1;
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

/// Texto usado para gerar o embedding da consulta: sem aspas, operadores
/// (AND/OR/NOT) nem `*`. Vazio se não sobra nenhuma letra ou número.
pub fn query_plain_text(raw: &str) -> String {
    let cleaned: String = raw.chars().map(|c| if c == '"' || c == '*' { ' ' } else { c }).collect();
    let kept: Vec<&str> = cleaned.split_whitespace().filter(|w| !matches!(*w, "AND" | "OR" | "NOT")).collect();
    let text = prepare_text(&kept.join(" "));
    if text.chars().any(char::is_alphanumeric) {
        text
    } else {
        String::new()
    }
}

// ------------------------------------------------------------------- vetores

pub fn encode_vec(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

pub fn decode_vec(b: &[u8]) -> Option<Vec<f32>> {
    if b.len() % 4 != 0 {
        return None;
    }
    Some(b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// Normaliza para norma 1. `false` se o vetor é vazio, tem NaN/infinito ou norma zero.
pub fn normalize_vec(v: &mut [f32]) -> bool {
    if v.is_empty() || v.iter().any(|x| !x.is_finite()) {
        return false;
    }
    let norm = v.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>().sqrt();
    if norm < 1e-12 {
        return false;
    }
    for x in v.iter_mut() {
        *x = (*x as f64 / norm) as f32;
    }
    true
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Cosseno entre dois vetores quaisquer (0 se tamanhos diferem ou há norma zero).
/// A busca usa `dot` sobre vetores já normalizados; esta é a definição de referência.
#[cfg(test)]
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut ab, mut aa, mut bb) = (0f64, 0f64, 0f64);
    for (x, y) in a.iter().zip(b) {
        ab += (*x as f64) * (*y as f64);
        aa += (*x as f64) * (*x as f64);
        bb += (*y as f64) * (*y as f64);
    }
    if aa < 1e-24 || bb < 1e-24 {
        return 0.0;
    }
    (ab / (aa.sqrt() * bb.sqrt())) as f32
}

// ----------------------------------------------------------------- resultados

#[derive(Debug, Clone)]
pub struct LexRow {
    pub doc_id: String,
    pub page: i64,
    /// `-bm25`: maior é melhor.
    pub score: f64,
    pub snippet: String,
    /// Intervalos em caracteres Unicode (não UTF-16) dentro de `snippet`.
    pub ranges: Vec<[usize; 2]>,
}

#[derive(Debug, Clone)]
pub struct VecRow {
    pub doc_id: String,
    pub page: i64,
    #[allow(dead_code)] // só os testes e a depuração olham a similaridade crua
    pub score: f32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Hit {
    pub doc_id: String,
    pub doc_title: String,
    pub page: i64,
    pub score: f64,
    pub snippet: String,
    pub ranges: Vec<[usize; 2]>,
    /// Frase curta literal da página, para `resolve_evidence`.
    pub quote: String,
    /// "lexical" | "semantic" | "both"
    pub via: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub mode: String,
    pub hits: Vec<Hit>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct IndexCounts {
    pub docs_total: i64,
    pub docs_indexed: i64,
    pub chunks: i64,
}

/// Separa os marcadores de destaque do snippet do FTS5, devolvendo o texto
/// limpo e os intervalos em caracteres.
pub fn parse_snippet(raw: &str) -> (String, Vec<[usize; 2]>) {
    let mut out = String::with_capacity(raw.len());
    let mut n = 0usize;
    let mut ranges = Vec::new();
    let mut open: Option<usize> = None;
    for c in raw.chars() {
        match c {
            '\u{1}' => open = Some(n),
            '\u{2}' => {
                if let Some(s) = open.take() {
                    if n > s {
                        ranges.push([s, n]);
                    }
                }
            }
            _ => {
                out.push(c);
                n += 1;
            }
        }
    }
    (out, ranges)
}

/// Frase curta e literal para localizar o trecho no PDF: o snippet sem as
/// reticências das pontas, limitado a ~160 caracteres em fronteira de palavra.
pub fn quote_from_snippet(snippet: &str) -> String {
    let s = snippet.trim().trim_matches('…').trim();
    if s.chars().count() <= MAX_QUOTE_CHARS {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX_QUOTE_CHARS).collect();
    match cut.rfind(' ') {
        Some(p) if p > MAX_QUOTE_CHARS / 2 => cut[..p].trim().to_string(),
        _ => cut,
    }
}

/// Trecho inicial de um chunk (para resultados que só a busca semântica achou).
fn lead_of(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    let base = match cut.rfind(' ') {
        Some(p) if p > max / 2 => cut[..p].to_string(),
        _ => cut,
    };
    format!("{}…", base.trim_end())
}

/// Funde as duas listas (já ordenadas, melhor primeiro) por Reciprocal Rank Fusion.
pub fn fuse(lex: &[LexRow], vecs: &[VecRow], titles: &HashMap<String, String>, limit: usize) -> Vec<Hit> {
    struct Acc {
        score: f64,
        lex: Option<usize>,
        vec: Option<usize>,
    }
    let mut order: Vec<(String, i64)> = Vec::new();
    let mut acc: HashMap<(String, i64), Acc> = HashMap::new();
    for (rank, r) in lex.iter().enumerate() {
        let key = (r.doc_id.clone(), r.page);
        let e = acc.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            Acc { score: 0.0, lex: None, vec: None }
        });
        e.score += 1.0 / (RRF_K + rank as f64 + 1.0);
        e.lex.get_or_insert(rank);
    }
    for (rank, r) in vecs.iter().enumerate() {
        let key = (r.doc_id.clone(), r.page);
        let e = acc.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            Acc { score: 0.0, lex: None, vec: None }
        });
        e.score += 1.0 / (RRF_K + rank as f64 + 1.0);
        e.vec.get_or_insert(rank);
    }
    let mut keys = order;
    // desempate estável: quem veio antes nas listas fica na frente
    keys.sort_by(|a, b| acc[b].score.partial_cmp(&acc[a].score).unwrap_or(std::cmp::Ordering::Equal));
    keys.into_iter()
        .take(limit)
        .map(|key| {
            let a = &acc[&key];
            let (snippet, ranges, via) = match (a.lex, a.vec) {
                (Some(l), v) => (
                    lex[l].snippet.clone(),
                    lex[l].ranges.clone(),
                    if v.is_some() { "both" } else { "lexical" },
                ),
                (None, Some(v)) => (lead_of(&vecs[v].text, 220), vec![], "semantic"),
                (None, None) => (String::new(), vec![], "lexical"),
            };
            Hit {
                doc_title: titles.get(&key.0).cloned().unwrap_or_default(),
                doc_id: key.0,
                page: key.1,
                score: a.score,
                quote: quote_from_snippet(&snippet),
                snippet,
                ranges,
                via: via.to_string(),
            }
        })
        .collect()
}

/// Resultado só lexical, no mesmo formato.
pub fn lexical_hits(lex: &[LexRow], titles: &HashMap<String, String>, limit: usize) -> Vec<Hit> {
    lex.iter()
        .take(limit)
        .map(|r| Hit {
            doc_id: r.doc_id.clone(),
            doc_title: titles.get(&r.doc_id).cloned().unwrap_or_default(),
            page: r.page,
            score: r.score,
            snippet: r.snippet.clone(),
            ranges: r.ranges.clone(),
            quote: quote_from_snippet(&r.snippet),
            via: "lexical".to_string(),
        })
        .collect()
}

// ------------------------------------------------------------------ indexação

pub(crate) fn unindex_tx(tx: &Transaction, doc_id: &str) -> Result<(), String> {
    let e = |e: rusqlite::Error| format!("Falha ao atualizar o índice de busca: {e}");
    tx.execute(
        "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM fts_pages WHERE doc_id=?1)",
        params![doc_id],
    )
    .map_err(e)?;
    tx.execute("DELETE FROM fts_pages WHERE doc_id=?1", params![doc_id]).map_err(e)?;
    tx.execute("DELETE FROM chunks WHERE doc_id=?1", params![doc_id]).map_err(e)?;
    tx.execute("DELETE FROM index_state WHERE doc_id=?1", params![doc_id]).map_err(e)?;
    Ok(())
}

/// Reconstrói o índice de um documento dentro da transação do chamador.
/// Sem páginas, o documento simplesmente sai do índice.
pub(crate) fn index_pages_tx(tx: &Transaction, doc_id: &str, pages: &[(i64, &str)]) -> Result<(), String> {
    let e = |e: rusqlite::Error| format!("Falha ao atualizar o índice de busca: {e}");
    unindex_tx(tx, doc_id)?;
    if pages.is_empty() {
        return Ok(());
    }
    // número de página repetido: vale o último (igual ao INSERT OR REPLACE de `pages`)
    let mut by_page: std::collections::BTreeMap<i64, &str> = std::collections::BTreeMap::new();
    for (n, t) in pages {
        by_page.insert(*n, t);
    }
    for (n, raw) in by_page {
        let text = prepare_text(raw);
        if text.is_empty() {
            continue;
        }
        tx.execute("INSERT INTO fts_pages(doc_id,page) VALUES(?,?)", params![doc_id, n]).map_err(e)?;
        let rowid = tx.last_insert_rowid();
        tx.execute("INSERT INTO search_fts(rowid,text) VALUES(?,?)", params![rowid, text]).map_err(e)?;
        for (i, piece) in chunk_text(&text, CHUNK_CHARS, CHUNK_OVERLAP).iter().enumerate() {
            tx.execute(
                "INSERT INTO chunks(doc_id,page,idx,text) VALUES(?,?,?,?)",
                params![doc_id, n, i as i64, piece],
            )
            .map_err(e)?;
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO index_state(doc_id,version,indexed_at) VALUES(?,?,datetime('now'))",
        params![doc_id, INDEX_VERSION],
    )
    .map_err(e)?;
    Ok(())
}

fn sql_err(e: rusqlite::Error) -> String {
    e.to_string()
}

impl Db {
    /// Reindexa um documento a partir das páginas gravadas (leitura e escrita sob
    /// o mesmo cofre: um `save_pages` concorrente nunca é sobrescrito por texto velho).
    pub fn reindex_doc(&self, doc_id: &str) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(sql_err)?;
        let pages: Vec<(i64, String)> = {
            let mut stmt = tx
                .prepare("SELECT n,text FROM pages WHERE doc_id=? ORDER BY n")
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![doc_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(sql_err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)?
        };
        let refs: Vec<(i64, &str)> = pages.iter().map(|(n, t)| (*n, t.as_str())).collect();
        index_pages_tx(&tx, doc_id, &refs)?;
        tx.commit().map_err(sql_err)
    }

    /// Esquece o estado de indexação de todos: o próximo trabalho refaz tudo
    /// (a busca continua usando o índice antigo enquanto isso).
    pub fn invalidate_index(&self) -> Result<(), String> {
        self.lock().execute("DELETE FROM index_state", []).map_err(sql_err)?;
        Ok(())
    }

    /// Documentos com páginas que ainda não estão no índice (ou estão numa versão antiga).
    pub fn docs_needing_index(&self) -> Result<Vec<String>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT d.id FROM documents d
                 WHERE EXISTS(SELECT 1 FROM pages p WHERE p.doc_id=d.id)
                   AND NOT EXISTS(SELECT 1 FROM index_state s WHERE s.doc_id=d.id AND s.version=?)
                 ORDER BY d.created_at DESC, d.id",
            )
            .map_err(sql_err)?;
        let rows = stmt.query_map(params![INDEX_VERSION], |r| r.get::<_, String>(0)).map_err(sql_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)
    }

    pub fn index_counts(&self) -> Result<IndexCounts, String> {
        let conn = self.lock();
        let one = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> Result<i64, String> {
            conn.query_row(sql, p, |r| r.get::<_, i64>(0)).map_err(sql_err)
        };
        Ok(IndexCounts {
            docs_total: one(
                "SELECT COUNT(*) FROM documents d WHERE EXISTS(SELECT 1 FROM pages p WHERE p.doc_id=d.id)",
                &[],
            )?,
            docs_indexed: one(
                "SELECT COUNT(*) FROM documents d WHERE EXISTS(SELECT 1 FROM pages p WHERE p.doc_id=d.id)
                   AND EXISTS(SELECT 1 FROM index_state s WHERE s.doc_id=d.id AND s.version=?1)",
                &[&INDEX_VERSION],
            )?,
            chunks: one("SELECT COUNT(*) FROM chunks", &[])?,
        })
    }

    pub fn doc_titles(&self) -> Result<HashMap<String, String>, String> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT id,name FROM documents").map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql_err)?;
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(sql_err)
    }

    /// Busca lexical: melhor página de cada (documento, página), BM25, com snippet.
    /// `fts_query` vem de `build_fts_query`. `doc_ids` vazio ou ausente = sem filtro.
    pub fn search_lexical(&self, fts_query: &str, doc_ids: Option<&[String]>, limit: usize) -> Result<Vec<LexRow>, String> {
        let mut sql = String::from(
            "SELECT p.doc_id, p.page, bm25(search_fts), snippet(search_fts, 0, char(1), char(2), '…', ?)
             FROM search_fts JOIN fts_pages p ON p.id = search_fts.rowid
             WHERE search_fts MATCH ?",
        );
        let mut args: Vec<SqlValue> = vec![SqlValue::Integer(SNIPPET_TOKENS), SqlValue::Text(fts_query.to_string())];
        if let Some(ids) = doc_ids.filter(|i| !i.is_empty()) {
            let ids = &ids[..ids.len().min(MAX_DOC_FILTER)];
            sql.push_str(&format!(" AND p.doc_id IN ({})", vec!["?"; ids.len()].join(",")));
            args.extend(ids.iter().map(|i| SqlValue::Text(i.clone())));
        }
        sql.push_str(" ORDER BY bm25(search_fts), p.doc_id, p.page LIMIT ?");
        args.push(SqlValue::Integer(limit.clamp(1, 500) as i64));
        let conn = self.lock();
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("Não foi possível buscar no índice: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(args), |r| {
                let raw: String = r.get(3)?;
                let (snippet, ranges) = parse_snippet(&raw);
                Ok(LexRow {
                    doc_id: r.get(0)?,
                    page: r.get(1)?,
                    score: -r.get::<_, f64>(2)?,
                    snippet,
                    ranges,
                })
            })
            .map_err(|e| format!("Não foi possível buscar no índice: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Não foi possível buscar no índice: {e}"))
    }

    // ------------------------------------------------------------- embeddings

    /// Trechos com id maior que `after_id` que ainda precisam de embedding para `model`
    /// (sem vetor ou com vetor de outro modelo). Os ids só crescem (AUTOINCREMENT), então
    /// quem chama pode avançar o cursor sem reler o que já passou.
    pub fn pending_chunks(&self, model: &str, after_id: i64, max_chunks: usize, max_chars: usize) -> Result<Vec<(i64, String)>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT id,text FROM chunks WHERE id>?2 AND (vec IS NULL OR model IS NOT ?1) ORDER BY id LIMIT ?3")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![model, after_id, max_chunks as i64], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        let mut chars = 0usize;
        for row in rows {
            let (id, text) = row.map_err(sql_err)?;
            chars += text.chars().count();
            if !out.is_empty() && chars > max_chars {
                break;
            }
            out.push((id, text));
        }
        Ok(out)
    }

    /// Grava vetores (normalizados) para os trechos. Vetor inválido vira BLOB vazio
    /// (conta como feito, mas nunca entra na busca). Devolve quantos trechos ainda existiam.
    pub fn store_embeddings(&self, model: &str, items: &[(i64, Vec<f32>)]) -> Result<usize, String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(sql_err)?;
        let mut stored = 0;
        {
            let mut stmt = tx
                .prepare("UPDATE chunks SET model=?1, vec=?2 WHERE id=?3")
                .map_err(sql_err)?;
            for (id, v) in items {
                let mut v = v.clone();
                let blob = if normalize_vec(&mut v) { encode_vec(&v) } else { Vec::new() };
                stored += stmt.execute(params![model, blob, id]).map_err(sql_err)?;
            }
        }
        tx.commit().map_err(sql_err)?;
        Ok(stored)
    }

    pub fn clear_embeddings(&self) -> Result<(), String> {
        self.lock().execute("UPDATE chunks SET model=NULL, vec=NULL", []).map_err(sql_err)?;
        Ok(())
    }

    pub fn embedded_count(&self, model: &str) -> Result<i64, String> {
        self.lock()
            .query_row(
                "SELECT COUNT(*) FROM chunks WHERE model=?1 AND vec IS NOT NULL AND length(vec)>0",
                params![model],
                |r| r.get(0),
            )
            .map_err(sql_err)
    }

    /// Melhores páginas por similaridade de cosseno (melhor trecho de cada página).
    /// `query` deve estar normalizado. Lê em lotes, soltando o cofre entre eles.
    pub fn top_pages_by_vector(
        &self,
        query: &[f32],
        model: &str,
        doc_ids: Option<&[String]>,
        top_k: usize,
    ) -> Result<Vec<VecRow>, String> {
        if query.is_empty() {
            return Ok(vec![]);
        }
        let allowed: Option<HashSet<&str>> = doc_ids.filter(|i| !i.is_empty()).map(|ids| ids.iter().map(String::as_str).collect());
        let want_len = query.len() * 4;
        // (doc, página) -> (melhor cosseno, id do trecho)
        let mut best: HashMap<(String, i64), (f32, i64)> = HashMap::new();
        let mut last_id = 0i64;
        loop {
            let batch: Vec<(i64, String, i64, Vec<u8>)> = {
                let conn = self.lock();
                let mut stmt = conn
                    .prepare(
                        "SELECT id,doc_id,page,vec FROM chunks
                         WHERE id>?1 AND model=?2 AND vec IS NOT NULL AND length(vec)=?3
                         ORDER BY id LIMIT 500",
                    )
                    .map_err(sql_err)?;
                let rows = stmt
                    .query_map(params![last_id, model, want_len as i64], |r| {
                        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Vec<u8>>(3)?))
                    })
                    .map_err(sql_err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)?
            };
            if batch.is_empty() {
                break;
            }
            for (id, doc, page, blob) in &batch {
                last_id = *id;
                if allowed.as_ref().is_some_and(|a| !a.contains(doc.as_str())) {
                    continue;
                }
                let Some(v) = decode_vec(blob) else { continue };
                let score = dot(query, &v);
                let slot = best.entry((doc.clone(), *page)).or_insert((f32::MIN, *id));
                if score > slot.0 {
                    *slot = (score, *id);
                }
            }
        }
        let mut ranked: Vec<((String, i64), (f32, i64))> = best.into_iter().collect();
        ranked.sort_by(|a, b| {
            b.1 .0
                .partial_cmp(&a.1 .0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        ranked.truncate(top_k);
        let conn = self.lock();
        let mut out = Vec::with_capacity(ranked.len());
        for ((doc_id, page), (score, chunk_id)) in ranked {
            let text: String = conn
                .query_row("SELECT text FROM chunks WHERE id=?", params![chunk_id], |r| r.get(0))
                .unwrap_or_default();
            out.push(VecRow { doc_id, page, score, text });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Block, Line, Page};

    fn page(n: i64, text: &str) -> Page {
        Page {
            n,
            md: text.to_string(),
            text: text.to_string(),
            blocks: vec![Block { text: text.into(), x: 0.0, y: 0.0, w: 1.0, h: 1.0, size: 10.0 }],
            lines: vec![Line { i: 0, text: text.into(), rect: [0.0, 0.0, 1.0, 1.0] }],
            figures: vec![],
        }
    }

    fn db_with(docs: &[(&str, &str, Vec<Page>)]) -> Db {
        let db = Db::open_in_memory().unwrap();
        for (id, name, pages) in docs {
            db.insert_doc(id, name, "/x.pdf", "2026-01-01T00:00:00Z").unwrap();
            db.save_pages(id, pages).unwrap();
        }
        db
    }

    fn titles(db: &Db) -> HashMap<String, String> {
        db.doc_titles().unwrap()
    }

    fn hits(db: &Db, q: &str) -> Vec<LexRow> {
        match build_fts_query(q) {
            Some(f) => db.search_lexical(&f, None, 30).unwrap(),
            None => vec![],
        }
    }

    // ----- FTS5 disponível

    #[test]
    fn fts5_esta_no_sqlite_embutido_e_ignora_acento() {
        let db = db_with(&[("d1", "A", vec![page(1, "O letramento estatístico na educação básica")])]);
        let r = hits(&db, "educacao");
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].doc_id.as_str(), r[0].page), ("d1", 1));
        // e o contrário: consulta acentuada acha texto sem acento
        let db2 = db_with(&[("d1", "A", vec![page(1, "estatistica descritiva sem acento")])]);
        assert_eq!(hits(&db2, "estatística").len(), 1);
        assert_eq!(hits(&db2, "ESTATÍSTICA").len(), 1);
    }

    // ----- preparo do texto

    #[test]
    fn ligaduras_hifenizacao_e_espacos() {
        assert_eq!(prepare_text("o ﬁnal e a ﬂuência"), "o final e a fluência");
        assert_eq!(prepare_text("estatís-\ntica básica"), "estatística básica");
        assert_eq!(prepare_text("estatís-  \n  tica"), "estatística");
        // hífen real seguido de maiúscula ou de linha não fica colado
        assert_eq!(prepare_text("Rio-\nGrande"), "Rio- Grande");
        assert_eq!(prepare_text("a  b\t\nc\u{a0}d"), "a b c d");
        assert_eq!(prepare_text("co\u{ad}operação"), "cooperação");
        assert_eq!(prepare_text("  \n "), "");
        assert_eq!(prepare_text("x\u{200b}y"), "xy");
    }

    #[test]
    fn busca_acha_palavra_com_ligadura_e_hifenizada() {
        let db = db_with(&[("d1", "A", vec![page(1, "avaliação ﬁnal do programa\nA estatís-\ntica é útil")])]);
        assert_eq!(hits(&db, "final").len(), 1);
        assert_eq!(hits(&db, "estatistica").len(), 1);
    }

    #[test]
    fn chunks_respeitam_tamanho_sobreposicao_e_unicode() {
        let word = "ação";
        let text = vec![word; 600].join(" "); // 2999 caracteres
        let chunks = chunk_text(&text, 800, 120);
        assert!(chunks.len() >= 4, "{}", chunks.len());
        for c in &chunks {
            assert!(c.chars().count() <= 800, "{}", c.chars().count());
            assert!(!c.starts_with(' ') && !c.ends_with(' '));
            assert!(c.split(' ').all(|w| w == word), "corte no meio de palavra");
        }
        // sobreposição: o fim de um trecho reaparece no começo do próximo
        let tail: Vec<&str> = chunks[0].split(' ').rev().take(3).collect();
        assert!(chunks[1].contains(&tail.into_iter().rev().collect::<Vec<_>>().join(" ")));
        assert_eq!(chunk_text("curto", 800, 120), vec!["curto"]);
        assert!(chunk_text("", 800, 120).is_empty());
        // palavra gigante sem espaço: ainda termina
        let blob = "a".repeat(5000);
        let c = chunk_text(&blob, 800, 120);
        assert!(c.len() >= 6 && c.iter().all(|x| x.len() <= 800));
        // emoji (fora do BMP) não quebra
        let emo = vec!["😀ção"; 500].join(" ");
        assert!(chunk_text(&emo, 800, 120).iter().all(|x| x.chars().count() <= 800));
    }

    // ----- sanitização da consulta

    #[test]
    fn consulta_vira_fts_valido() {
        assert_eq!(build_fts_query("letramento estatístico").as_deref(), Some("\"letramento\" \"estatístico\""));
        assert_eq!(build_fts_query("\"letramento estatístico\"").as_deref(), Some("\"letramento estatístico\""));
        assert_eq!(build_fts_query("covid-19").as_deref(), Some("\"covid 19\""));
        assert_eq!(build_fts_query("estat*").as_deref(), Some("\"estat\" *"));
        assert_eq!(build_fts_query("a OR b").as_deref(), Some("\"a\" OR \"b\""));
        assert_eq!(build_fts_query("a AND b NOT c").as_deref(), Some("\"a\" \"b\" \"c\""));
        assert_eq!(build_fts_query("OR a OR OR b OR").as_deref(), Some("\"a\" OR \"b\""));
        assert_eq!(build_fts_query("\"aberta sem fechar").as_deref(), Some("\"aberta sem fechar\""));
        assert_eq!(build_fts_query("(a OR (b))").as_deref(), Some("\"a\" OR \"b\""));
        assert_eq!(build_fts_query("ﬁnal").as_deref(), Some("\"final\""));
        assert_eq!(build_fts_query(""), None);
        assert_eq!(build_fts_query("   "), None);
        assert_eq!(build_fts_query("*** ( ) \"\" - ^ : ;"), None);
    }

    #[test]
    fn consultas_hostis_nunca_geram_erro_sql() {
        let db = db_with(&[("d1", "A", vec![page(1, "alfa beta gama delta covid 19 ação")])]);
        let hostis = [
            "\"", "\"\"", "'", "a'b", "alfa OR", "OR OR OR", "NOT", "AND", "NEAR(alfa beta)", "NEAR/3",
            "alfa*beta", "*", "**", "alfa:beta", "text:alfa", "-alfa", "^alfa", "(alfa", "alfa)", "((((", "{alfa}",
            "alfa; DROP TABLE pages;--", "alfa\u{0}beta", "\u{1}\u{2}", "alfa /* x */", "col:\"x\"", "alfa AND OR NOT beta",
            "\"alfa\" \"beta\" \"gama", "%", "_", "\\", "alfa\nbeta", "😀", "a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k",
        ];
        for q in hostis {
            if let Some(f) = build_fts_query(q) {
                db.search_lexical(&f, None, 10).unwrap_or_else(|e| panic!("consulta {q:?} -> {f:?}: {e}"));
            }
        }
        // a tabela de páginas segue intacta
        assert_eq!(db.pages("d1").unwrap().len(), 1);
        assert_eq!(hits(&db, "alfa OR inexistente").len(), 1);
        assert_eq!(hits(&db, "alfa inexistente").len(), 0);
        assert_eq!(hits(&db, "\"beta gama\"").len(), 1);
        assert_eq!(hits(&db, "\"gama beta\"").len(), 0);
        assert_eq!(hits(&db, "covid-19").len(), 1);
        assert_eq!(hits(&db, "alf*").len(), 1);
        assert_eq!(hits(&db, "(alfa OR zzz) beta").len(), 1);
    }

    #[test]
    fn texto_da_consulta_para_embedding() {
        assert_eq!(query_plain_text("\"letramento estatístico\" OR literacia*"), "letramento estatístico literacia");
        assert_eq!(query_plain_text("a AND b NOT c"), "a b c");
        assert_eq!(query_plain_text("\"*\" ( ) OR"), "");
        assert_eq!(query_plain_text("   "), "");
    }

    #[test]
    fn consulta_gigante_e_truncada() {
        let q = (0..500).map(|i| format!("palavra{i}")).collect::<Vec<_>>().join(" ");
        let f = build_fts_query(&q).unwrap();
        assert_eq!(f.matches('"').count(), MAX_TERMS * 2);
        let db = db_with(&[("d1", "A", vec![page(1, "x")])]);
        db.search_lexical(&f, None, 5).unwrap();
        let big = "a".repeat(10_000);
        assert!(build_fts_query(&big).unwrap().len() <= MAX_WORD_CHARS + 2);
    }

    // ----- snippet / ranges / quote

    #[test]
    fn snippet_tem_destaques_em_caracteres_unicode() {
        let db = db_with(&[("d1", "A", vec![page(1, "Muita ação aqui: o letramento estatístico importa na escola")])]);
        let r = hits(&db, "letramento");
        assert_eq!(r.len(), 1);
        let chars: Vec<char> = r[0].snippet.chars().collect();
        assert_eq!(r[0].ranges.len(), 1);
        let [s, e] = r[0].ranges[0];
        assert_eq!(chars[s..e].iter().collect::<String>(), "letramento");
        assert!(!r[0].snippet.contains('\u{1}') && !r[0].snippet.contains('\u{2}'));
    }

    #[test]
    fn destaque_ignora_acento_e_cobre_varios_termos() {
        let db = db_with(&[("d1", "A", vec![page(1, "A Educação Estatística no Brasil cresceu. A educação continua.")])]);
        let r = hits(&db, "educacao estatistica");
        let chars: Vec<char> = r[0].snippet.chars().collect();
        let marked: Vec<String> = r[0].ranges.iter().map(|[s, e]| chars[*s..*e].iter().collect()).collect();
        assert!(marked.iter().any(|m| m == "Educação"), "{marked:?}");
        assert!(marked.iter().any(|m| m == "Estatística"), "{marked:?}");
    }

    #[test]
    fn quote_e_literal_e_o_resolve_evidence_encontra() {
        let linhas = [
            "Resumo",
            "Este trabalho discute o letramento estatís-",
            "tico de professores dos anos iniciais em",
            "formação continuada no interior de São Paulo.",
            "Palavras-chave: educação estatística",
        ];
        let text = linhas.join("\n");
        let lines: Vec<Line> = linhas
            .iter()
            .enumerate()
            .map(|(i, t)| Line { i: i as i64, text: (*t).into(), rect: [72.0, 700.0 - 14.0 * i as f64, 500.0, 712.0 - 14.0 * i as f64] })
            .collect();
        let p = Page { n: 1, md: text.clone(), text, blocks: vec![], lines: lines.clone(), figures: vec![] };
        let db = db_with(&[("d1", "A", vec![p])]);
        let r = hits(&db, "letramento estatistico professores");
        let hit = lexical_hits(&r, &titles(&db), 10).remove(0);
        assert!(hit.quote.chars().count() >= 8 && hit.quote.chars().count() <= MAX_QUOTE_CHARS);
        assert!(!hit.quote.starts_with('…') && !hit.quote.ends_with('…'));
        let ev = crate::evidence::resolve("d1", 1, &hit.quote, &lines).expect("resolve_evidence deveria achar a quote");
        assert!(!ev.rects.is_empty());
    }

    #[test]
    fn quote_longa_e_cortada_em_palavra() {
        let s = format!("…{}…", "palavra ".repeat(60));
        let q = quote_from_snippet(&s);
        assert!(q.chars().count() <= MAX_QUOTE_CHARS && q.ends_with("palavra"));
        assert_eq!(quote_from_snippet("…curto…"), "curto");
    }

    // ----- ranking, filtro, ciclo de vida

    #[test]
    fn bm25_ordena_pela_relevancia() {
        let db = db_with(&[
            ("d1", "A", vec![page(1, "estatística"), page(2, "texto longo sem o assunto procurado, falando de outras coisas como geometria e álgebra, estatística uma vez só")]),
            ("d2", "B", vec![page(1, "estatística estatística estatística")]),
        ]);
        let r = hits(&db, "estatistica");
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].doc_id, "d2");
        assert!(r[0].score >= r[1].score && r[1].score >= r[2].score);
        assert!(r[0].score > 0.0);
    }

    #[test]
    fn filtro_por_documentos_e_limite() {
        let db = db_with(&[
            ("d1", "A", vec![page(1, "tema comum"), page(2, "tema comum")]),
            ("d2", "B", vec![page(1, "tema comum")]),
        ]);
        let f = build_fts_query("tema").unwrap();
        assert_eq!(db.search_lexical(&f, None, 30).unwrap().len(), 3);
        assert_eq!(db.search_lexical(&f, Some(&["d2".to_string()]), 30).unwrap().len(), 1);
        assert_eq!(db.search_lexical(&f, Some(&["d1".to_string(), "nao-existe".to_string()]), 30).unwrap().len(), 2);
        assert_eq!(db.search_lexical(&f, Some(&[]), 30).unwrap().len(), 3, "lista vazia = sem filtro");
        assert_eq!(db.search_lexical(&f, None, 2).unwrap().len(), 2);
        // id com aspas/SQL é só um valor
        assert_eq!(db.search_lexical(&f, Some(&["x' OR '1'='1".to_string()]), 30).unwrap().len(), 0);
    }

    #[test]
    fn salvar_paginas_de_novo_substitui_o_indice() {
        let db = db_with(&[("d1", "A", vec![page(1, "velhíssimo conteúdo"), page(2, "outro velho")])]);
        assert_eq!(hits(&db, "velhissimo").len(), 1);
        db.save_pages("d1", &[page(1, "conteúdo novo")]).unwrap();
        assert_eq!(hits(&db, "velhissimo").len(), 0);
        assert_eq!(hits(&db, "novo").len(), 1);
        let c = db.index_counts().unwrap();
        assert_eq!((c.docs_total, c.docs_indexed, c.chunks), (1, 1, 1));
    }

    #[test]
    fn excluir_documento_remove_do_indice_e_so_dele() {
        let db = db_with(&[("d1", "A", vec![page(1, "assunto raro zebra")]), ("d2", "B", vec![page(1, "assunto raro zebra")])]);
        assert_eq!(hits(&db, "zebra").len(), 2);
        db.delete_doc("d1").unwrap();
        let r = hits(&db, "zebra");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].doc_id, "d2");
        let c = db.index_counts().unwrap();
        assert_eq!((c.docs_total, c.docs_indexed, c.chunks), (1, 1, 1));
        let conn = db.lock();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM fts_pages WHERE doc_id='d1'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn documento_vazio_ou_so_com_espacos() {
        let db = db_with(&[
            ("d1", "Vazio", vec![]),
            ("d2", "Branco", vec![page(1, "   \n  "), page(2, "")]),
            ("d3", "Cheio", vec![page(1, "texto útil")]),
        ]);
        let c = db.index_counts().unwrap();
        // d1 não tem páginas: não conta; d2 tem páginas mas nenhum texto: indexado com 0 trechos
        assert_eq!((c.docs_total, c.docs_indexed, c.chunks), (2, 2, 1));
        assert!(db.docs_needing_index().unwrap().is_empty());
        assert_eq!(hits(&db, "util").len(), 1);
    }

    #[test]
    fn paginas_duplicadas_indexam_a_ultima() {
        let db = db_with(&[("d1", "A", vec![page(1, "primeira versão"), page(1, "segunda versão")])]);
        assert_eq!(hits(&db, "primeira").len(), 0);
        assert_eq!(hits(&db, "segunda").len(), 1);
    }

    // ----- migração

    #[test]
    fn banco_020_sem_indice_e_migrado_e_reindexado_depois() {
        let dir = std::env::temp_dir().join(format!("margem-search-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pdfchat.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
                 CREATE TABLE pages(doc_id TEXT NOT NULL, n INTEGER NOT NULL, md TEXT NOT NULL, text TEXT NOT NULL, blocks TEXT NOT NULL, lines TEXT NOT NULL DEFAULT '[]', figures TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(doc_id, n));
                 INSERT INTO documents VALUES('d1','Antigo','/a.pdf',2,'2025-01-01');
                 INSERT INTO documents VALUES('d2','Sem texto','/b.pdf',0,'2025-01-02');
                 INSERT INTO pages VALUES('d1',1,'md','Pesquisa sobre ensino de probabilidade','[]','[]','[]');
                 INSERT INTO pages VALUES('d1',2,'md','Resultados da avaliação','[]','[]','[]');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        // abrir não indexa (não trava o startup) ...
        assert_eq!(db.index_counts().unwrap().docs_indexed, 0);
        assert_eq!(db.docs_needing_index().unwrap(), vec!["d1".to_string()]);
        assert!(hits(&db, "probabilidade").is_empty());
        // ... o trabalho em segundo plano faz isso
        for id in db.docs_needing_index().unwrap() {
            db.reindex_doc(&id).unwrap();
        }
        let c = db.index_counts().unwrap();
        assert_eq!((c.docs_total, c.docs_indexed, c.chunks), (1, 1, 2));
        assert_eq!(hits(&db, "avaliacao").len(), 1);
        drop(db);
        let db = Db::open(&path).unwrap(); // reabrir mantém o índice
        assert!(db.docs_needing_index().unwrap().is_empty());
        assert_eq!(hits(&db, "probabilidade").len(), 1);
        db.invalidate_index().unwrap();
        assert_eq!(db.docs_needing_index().unwrap().len(), 1);
        assert_eq!(hits(&db, "probabilidade").len(), 1, "índice antigo segue valendo até refazer");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn indexacao_concorrente_com_buscas() {
        let db = std::sync::Arc::new(db_with(&[]));
        let mut handles = Vec::new();
        for t in 0..4 {
            let db = db.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..15 {
                    let id = format!("d{t}-{i}");
                    db.insert_doc(&id, &id, "/x", "t").unwrap();
                    db.save_pages(&id, &[page(1, "conteúdo comum ação"), page(2, &format!("exclusivo{t}x{i}"))]).unwrap();
                    let f = build_fts_query("conteudo").unwrap();
                    db.search_lexical(&f, None, 5).unwrap();
                    if i % 5 == 0 {
                        db.delete_doc(&id).unwrap();
                    }
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let c = db.index_counts().unwrap();
        assert_eq!((c.docs_total, c.docs_indexed), (48, 48));
        assert_eq!(db.search_lexical(&build_fts_query("conteudo").unwrap(), None, 500).unwrap().len(), 48);
    }

    // ----- vetores

    #[test]
    fn blob_f32_ida_e_volta_e_cosseno() {
        let v = vec![1.0f32, -2.5, 0.0, 3.25e-3, f32::MAX];
        assert_eq!(decode_vec(&encode_vec(&v)).unwrap(), v);
        assert!(decode_vec(&[1, 2, 3]).is_none());
        assert_eq!(decode_vec(&[]).unwrap(), Vec::<f32>::new());
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        assert!((cosine(&[1.0, 0.0], &[-3.0, 0.0]) + 1.0).abs() < 1e-6);
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
        let mut a = vec![3.0f32, 4.0];
        assert!(normalize_vec(&mut a));
        assert!((a[0] - 0.6).abs() < 1e-6 && (a[1] - 0.8).abs() < 1e-6);
        assert!(!normalize_vec(&mut [0.0, 0.0]));
        assert!(!normalize_vec(&mut [f32::NAN, 1.0]));
        assert!(!normalize_vec(&mut []));
        let (x, y) = ([0.3f32, -0.7, 0.2], [0.5f32, 0.1, 0.9]);
        let (mut nx, mut ny) = (x.to_vec(), y.to_vec());
        normalize_vec(&mut nx);
        normalize_vec(&mut ny);
        assert!((dot(&nx, &ny) - cosine(&x, &y)).abs() < 1e-6);
    }

    #[test]
    fn embeddings_pendentes_gravacao_busca_e_troca_de_modelo() {
        let db = db_with(&[
            ("d1", "A", vec![page(1, "primeiro texto"), page(2, "segundo texto")]),
            ("d2", "B", vec![page(1, "terceiro texto")]),
        ]);
        let pend = db.pending_chunks("m1", 0, 100, 10_000).unwrap();
        assert_eq!(pend.len(), 3);
        // limite de caracteres por lote (sempre pelo menos um)
        assert_eq!(db.pending_chunks("m1", 0, 100, 1).unwrap().len(), 1);
        // cursor: só os que vêm depois do id dado
        assert_eq!(db.pending_chunks("m1", pend[0].0, 100, 10_000).unwrap().len(), 2);
        assert!(db.pending_chunks("m1", pend[2].0, 100, 10_000).unwrap().is_empty());
        let vecs = [vec![1.0f32, 0.0], vec![0.0, 1.0], vec![0.7, 0.7]];
        let items: Vec<(i64, Vec<f32>)> = pend.iter().zip(vecs).map(|((id, _), v)| (*id, v)).collect();
        assert_eq!(db.store_embeddings("m1", &items).unwrap(), 3);
        assert!(db.pending_chunks("m1", 0, 100, 10_000).unwrap().is_empty());
        assert_eq!(db.embedded_count("m1").unwrap(), 3);

        let mut q = vec![1.0f32, 0.1];
        normalize_vec(&mut q);
        let top = db.top_pages_by_vector(&q, "m1", None, 10).unwrap();
        assert_eq!(top.len(), 3);
        assert_eq!((top[0].doc_id.as_str(), top[0].page), ("d1", 1));
        assert!(top[0].score > top[1].score && top[0].text == "primeiro texto");
        let only_d2 = db.top_pages_by_vector(&q, "m1", Some(&["d2".to_string()]), 10).unwrap();
        assert_eq!(only_d2.len(), 1);
        assert_eq!(db.top_pages_by_vector(&q, "m1", None, 2).unwrap().len(), 2);
        // dimensão diferente da consulta: ignorado, sem erro
        assert!(db.top_pages_by_vector(&[1.0, 0.0, 0.0], "m1", None, 10).unwrap().is_empty());
        // modelo diferente: nada serve, tudo volta a ficar pendente
        assert!(db.top_pages_by_vector(&q, "m2", None, 10).unwrap().is_empty());
        assert_eq!(db.embedded_count("m2").unwrap(), 0);
        assert_eq!(db.pending_chunks("m2", 0, 100, 10_000).unwrap().len(), 3);
        // vetor inválido não trava a fila
        let id = pend[0].0;
        db.store_embeddings("m2", &[(id, vec![0.0, 0.0])]).unwrap();
        assert_eq!(db.pending_chunks("m2", 0, 100, 10_000).unwrap().len(), 2);
        assert_eq!(db.embedded_count("m2").unwrap(), 0);
        db.clear_embeddings().unwrap();
        assert_eq!(db.embedded_count("m1").unwrap(), 0);
        // regravar o documento descarta os vetores dele (texto novo = chunks novos)
        db.store_embeddings("m1", &items).unwrap();
        db.save_pages("d1", &[page(1, "outro")]).unwrap();
        assert_eq!(db.pending_chunks("m1", 0, 100, 10_000).unwrap().len(), 1);
        assert_eq!(db.embedded_count("m1").unwrap(), 1);
        // gravar vetor de trecho que sumiu não falha
        assert_eq!(db.store_embeddings("m1", &[(999_999, vec![1.0])]).unwrap(), 0);
    }

    #[test]
    fn fusao_rrf_combina_listas_e_marca_a_origem() {
        let lex = |d: &str, p: i64, s: &str| LexRow { doc_id: d.into(), page: p, score: 1.0, snippet: s.into(), ranges: vec![[0, 3]] };
        let vec_ = |d: &str, p: i64| VecRow { doc_id: d.into(), page: p, score: 0.9, text: format!("trecho de {d} p{p} com bastante conteúdo") };
        let titles: HashMap<String, String> = [("a".to_string(), "Doc A".to_string()), ("b".to_string(), "Doc B".to_string())].into();
        let l = vec![lex("a", 1, "…alfa…"), lex("b", 2, "beta")];
        let v = vec![vec_("b", 2), vec_("c", 9), vec_("a", 1)];
        let out = fuse(&l, &v, &titles, 10);
        let keys: Vec<(&str, i64)> = out.iter().map(|h| (h.doc_id.as_str(), h.page)).collect();
        // a: 1/61 + 1/63 ; b: 1/62 + 1/61 ; c: 1/62
        assert_eq!(keys, vec![("b", 2), ("a", 1), ("c", 9)]);
        assert_eq!(out[0].via, "both");
        assert_eq!(out[2].via, "semantic");
        assert_eq!(out[2].doc_title, "");
        assert_eq!(out[1].doc_title, "Doc A");
        assert!(out[2].ranges.is_empty() && out[2].snippet.starts_with("trecho de c p9"));
        assert_eq!(out[2].quote, quote_from_snippet(&out[2].snippet));
        assert_eq!(fuse(&l, &v, &titles, 2).len(), 2);
        assert!(fuse(&[], &[], &titles, 5).is_empty());
        // só vetor
        assert_eq!(fuse(&[], &v, &titles, 5).len(), 3);
    }
}
