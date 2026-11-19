//! OpenAlex sem rede: interpretação das respostas (Work), DOI, título do
//! documento, montagem/normalização de URLs, cache SQLite (TTL de 7 dias) e
//! vínculos documento ↔ trabalho. A parte HTTP está em `oa_client.rs`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::db::Db;
use crate::model::Page;

pub const API_BASE: &str = "https://api.openalex.org";
pub const PER_PAGE: usize = 25;
pub const BATCH_MAX: usize = 50;
pub const CACHE_TTL_SECS: i64 = 7 * 24 * 3600;
const CACHE_MAX_ROWS: i64 = 2000;
pub const MAX_AUTHORS: usize = 6;
pub const MAX_ABSTRACT_CHARS: usize = 600;

/// Campos pedidos em toda lista de trabalhos (reduz o payload).
pub const WORK_SELECT: &str = "id,doi,title,display_name,publication_year,cited_by_count,authorships,primary_location,best_oa_location,open_access,abstract_inverted_index";

pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Work {
    /// Curto, ex.: "W2741809807".
    pub id: String,
    /// DOI puro em minúsculas ("10.1007/..."), sem prefixo de URL.
    pub doi: Option<String>,
    pub title: String,
    pub authors: Vec<String>,
    pub authors_total: usize,
    pub year: Option<i64>,
    pub venue: Option<String>,
    pub cited_by_count: i64,
    pub is_oa: bool,
    pub oa_url: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    /// Página do DOI quando há DOI; senão https://openalex.org/W...
    pub url: String,
}

// ------------------------------------------------------------------ ids / DOI

/// "W123", "w123", "https://openalex.org/W123" -> "W123". Só aceita o formato do OpenAlex.
pub fn short_id(raw: &str) -> Option<String> {
    let t = raw.trim().trim_end_matches('/');
    let last = t.rsplit('/').next().unwrap_or(t);
    let mut chars = last.chars();
    let first = chars.next()?;
    let digits: String = chars.collect();
    if (first == 'W' || first == 'w') && !digits.is_empty() && digits.len() <= 12 && digits.chars().all(|c| c.is_ascii_digit()) {
        Some(format!("W{digits}"))
    } else {
        None
    }
}

fn percent_decode_lossy(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(v) = h {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn valid_doi_shape(d: &str) -> bool {
    let Some(rest) = d.strip_prefix("10.") else { return false };
    let Some((reg, suffix)) = rest.split_once('/') else { return false };
    let mut parts = reg.split('.');
    let head = parts.next().unwrap_or("");
    (4..=9).contains(&head.len())
        && head.chars().all(|c| c.is_ascii_digit())
        && parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && !suffix.is_empty()
        && d.len() <= 200
}

/// Normaliza um DOI vindo de qualquer formato (URL do doi.org, "doi:", maiúsculas,
/// pontuação final colada, %2F). `None` se não tem a forma 10.NNNN/sufixo.
pub fn normalize_doi(raw: &str) -> Option<String> {
    let mut s = raw.trim().trim_start_matches(['(', '[', '<', '"', '\'', '“', '‘', '«']).trim().to_string();
    loop {
        let lower = s.to_lowercase();
        let mut changed = false;
        for p in ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi.org/", "dx.doi.org/", "doi:", "doi "] {
            if lower.starts_with(p) {
                s = s[p.len()..].trim_start().to_string();
                changed = true;
                break;
            }
        }
        if !changed {
            break;
        }
    }
    if s.contains('%') {
        s = percent_decode_lossy(&s);
    }
    // corta lixo de URL (?utm=..., #frag)
    if let Some(p) = s.find(['?', '#']) {
        s.truncate(p);
    }
    // pontuação final; fecha-parêntese só sai se não tem abre correspondente
    while let Some(last) = s.chars().last() {
        let strip = match last {
            '.' | ',' | ';' | ':' | '\'' | '"' | '”' | '’' | '»' | '>' | '*' => true,
            ')' => s.matches(')').count() > s.matches('(').count(),
            ']' => s.matches(']').count() > s.matches('[').count(),
            '}' => s.matches('}').count() > s.matches('{').count(),
            _ => false,
        };
        if !strip {
            break;
        }
        s.pop();
    }
    let s = s.trim().to_lowercase();
    valid_doi_shape(&s).then_some(s)
}

fn is_doi_suffix_char(c: char) -> bool {
    c.is_ascii_graphic() && !matches!(c, '<' | '>' | '"' | '{' | '}' | '|' | '\\' | '^' | '`' | '?' | '#')
}

/// Acha DOIs num texto (na ordem em que aparecem, sem repetir).
pub fn extract_dois(text: &str) -> Vec<String> {
    let chars: Vec<char> = text
        .nfkc()
        .filter(|c| !matches!(c, '\u{ad}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{feff}'))
        .collect();
    let n = chars.len();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 3 < n {
        let boundary = i == 0
            || !chars[i - 1].is_alphanumeric()
            || (i >= 3 && chars[i - 3..i].iter().collect::<String>().eq_ignore_ascii_case("doi"));
        if chars[i] == '1' && chars[i + 1] == '0' && chars[i + 2] == '.' && boundary {
            let mut j = i + 3;
            let ds = j;
            while j < n && chars[j].is_ascii_digit() {
                j += 1;
            }
            if (4..=9).contains(&(j - ds)) {
                while j + 1 < n && chars[j] == '.' && chars[j + 1].is_ascii_digit() {
                    j += 1;
                    while j < n && chars[j].is_ascii_digit() {
                        j += 1;
                    }
                }
                if j < n && chars[j] == '/' {
                    let mut s: String = chars[i..=j].iter().collect();
                    let mut k = j + 1;
                    loop {
                        while k < n && is_doi_suffix_char(chars[k]) {
                            s.push(chars[k]);
                            k += 1;
                        }
                        // DOI partido em duas linhas: "…s11858-\n014-…"
                        let mut nl = k;
                        if nl < n && chars[nl] == '\r' {
                            nl += 1;
                        }
                        if nl + 1 < n && chars[nl] == '\n' && (s.ends_with('-') || s.ends_with('/')) && is_doi_suffix_char(chars[nl + 1]) {
                            k = nl + 1;
                            continue;
                        }
                        break;
                    }
                    if let Some(d) = normalize_doi(&s) {
                        if !out.contains(&d) {
                            out.push(d);
                        }
                    }
                    i = k.max(i + 1);
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// DOIs das primeiras páginas do documento (página 1 primeiro).
pub fn dois_from_pages(pages: &[Page], max_pages: usize) -> Vec<String> {
    let mut sorted: Vec<&Page> = pages.iter().collect();
    sorted.sort_by_key(|p| p.n);
    let mut out: Vec<String> = Vec::new();
    for p in sorted.into_iter().take(max_pages) {
        for d in extract_dois(&p.text) {
            if !out.contains(&d) {
                out.push(d);
            }
        }
    }
    out
}

// -------------------------------------------------------------------- Work

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn clean_text(s: &str) -> String {
    strip_tags(s).split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn truncate_with_ellipsis(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Reconstrói o resumo a partir de `abstract_inverted_index` ({palavra: [posições]}).
/// Tolera posições esparsas, valores estranhos e índices gigantes.
pub fn reconstruct_abstract(inverted: &Value) -> Option<String> {
    let obj = inverted.as_object()?;
    let mut slots: Vec<(u64, &str)> = Vec::new();
    for (word, positions) in obj {
        for p in positions.as_array()?.iter().filter_map(Value::as_u64) {
            if slots.len() >= 20_000 {
                break;
            }
            slots.push((p, word.as_str()));
        }
    }
    if slots.is_empty() {
        return None;
    }
    slots.sort();
    let text = slots.iter().map(|(_, w)| *w).collect::<Vec<_>>().join(" ");
    let text = clean_text(&text);
    if text.is_empty() {
        None
    } else {
        Some(truncate_with_ellipsis(&text, MAX_ABSTRACT_CHARS))
    }
}

fn nonempty(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Interpreta um objeto Work do OpenAlex. Só `id` é indispensável.
pub fn parse_work(v: &Value) -> Option<Work> {
    let id = short_id(v["id"].as_str()?)?;
    let doi = v["doi"].as_str().and_then(normalize_doi);
    let title = nonempty(&v["title"])
        .or_else(|| nonempty(&v["display_name"]))
        .map(|t| clean_text(&t))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "(Sem título)".to_string());
    let auth = v["authorships"].as_array();
    let authors_total = auth.map_or(0, Vec::len);
    let authors: Vec<String> = auth
        .map(|a| {
            a.iter()
                .filter_map(|x| nonempty(&x["author"]["display_name"]).or_else(|| nonempty(&x["raw_author_name"])))
                .take(MAX_AUTHORS)
                .collect()
        })
        .unwrap_or_default();
    let venue = nonempty(&v["primary_location"]["source"]["display_name"])
        .or_else(|| nonempty(&v["best_oa_location"]["source"]["display_name"]))
        .or_else(|| nonempty(&v["host_venue"]["display_name"]))
        .map(|s| clean_text(&s));
    let best = &v["best_oa_location"];
    let oa_url = nonempty(&best["pdf_url"])
        .or_else(|| nonempty(&best["landing_page_url"]))
        .or_else(|| nonempty(&v["open_access"]["oa_url"]));
    let is_oa = v["open_access"]["is_oa"].as_bool().unwrap_or(oa_url.is_some());
    let url = match &doi {
        Some(d) => format!("https://doi.org/{d}"),
        None => format!("https://openalex.org/{id}"),
    };
    Some(Work {
        id,
        doi,
        title,
        authors,
        authors_total,
        year: v["publication_year"].as_i64(),
        venue,
        cited_by_count: v["cited_by_count"].as_i64().unwrap_or(0),
        is_oa,
        oa_url,
        abstract_text: reconstruct_abstract(&v["abstract_inverted_index"]),
        url,
    })
}

/// `results` de uma listagem; entradas sem id são descartadas.
pub fn parse_works(v: &Value) -> Vec<Work> {
    v["results"].as_array().map(|a| a.iter().filter_map(parse_work).collect()).unwrap_or_default()
}

pub fn parse_total(v: &Value) -> Option<usize> {
    v["meta"]["count"].as_u64().map(|n| n as usize)
}

/// Lista de ids curtos de `related_works` / `referenced_works`.
pub fn parse_id_list(v: &Value, field: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    v[field]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().and_then(short_id))
                .filter(|id| seen.insert(id.clone()))
                .collect()
        })
        .unwrap_or_default()
}

// --------------------------------------------------------------------- URLs

/// Percent-encoding de um componente; `keep` lista símbolos extras que ficam como estão.
pub fn pct_encode(s: &str, keep: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let c = b as char;
        if b.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') || keep.contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Parte `?k=v&...` com os parâmetros em ordem alfabética (base da chave do cache).
pub fn query_string(params: &[(&str, String)]) -> String {
    let mut sorted: Vec<(&str, &String)> = params.iter().map(|(k, v)| (*k, v)).collect();
    sorted.sort();
    sorted
        .iter()
        .map(|(k, v)| format!("{}={}", pct_encode(k, ""), pct_encode(v, ":,")))
        .collect::<Vec<_>>()
        .join("&")
}

/// Chave de cache: URL normalizada (parâmetros ordenados; `mailto` nunca entra).
pub fn cache_key(base: &str, path: &str, params: &[(&str, String)]) -> String {
    let filtered: Vec<(&str, String)> = params.iter().filter(|(k, _)| *k != "mailto").cloned().collect();
    let qs = query_string(&filtered);
    format!("{}{}{}{}", base.trim_end_matches('/'), path, if qs.is_empty() { "" } else { "?" }, qs)
}

// ------------------------------------------------------------------- título

fn words_of(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

fn fold(s: &str) -> String {
    s.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase()
}

/// Semelhança 0..1 entre dois títulos (coeficiente de Dice das palavras sem acento).
pub fn title_similarity(a: &str, b: &str) -> f64 {
    let sa: std::collections::HashSet<String> = words_of(&fold(a)).into_iter().filter(|w| w.len() > 2).collect();
    let sb: std::collections::HashSet<String> = words_of(&fold(b)).into_iter().filter(|w| w.len() > 2).collect();
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let inter = sa.intersection(&sb).count() as f64;
    2.0 * inter / (sa.len() + sb.len()) as f64
}

fn is_junk_line(line: &str) -> bool {
    let l = fold(line);
    let toks = words_of(&l);
    if toks.is_empty() {
        return true;
    }
    if toks.iter().any(|t| t == "doi" || t == "issn" || t == "isbn" || t.starts_with("http") || t.starts_with("www")) || l.contains('@') {
        return true;
    }
    const BAD: &[&str] = &[
        "copyright", "all rights reserved", "received", "recebido", "accepted", "aceito em", "available online",
        "licensed under", "creative commons", "journal of", "revista", "periodico", "volume ", "vol.", "pp.", "page ",
    ];
    if BAD.iter().any(|b| l.contains(b)) || line.contains('©') {
        return true;
    }
    let letters = line.chars().filter(|c| c.is_alphabetic()).count();
    let total = line.chars().filter(|c| !c.is_whitespace()).count();
    total == 0 || letters * 10 < total * 6
}

/// Título provável da página 1: o(s) bloco(s) de maior fonte; sem tamanhos, a
/// primeira linha "forte" (e a seguinte, se parece continuação).
pub fn title_from_page(page: &Page) -> Option<String> {
    let mut blocks: Vec<&crate::model::Block> = page
        .blocks
        .iter()
        .filter(|b| {
            let t = clean_text(&b.text);
            let n = words_of(&t).len();
            (2..=40).contains(&n) && t.chars().count() <= 300 && !is_junk_line(&t)
        })
        .collect();
    let max = blocks.iter().map(|b| b.size).fold(0.0f64, f64::max);
    if max > 0.0 {
        blocks.sort_by(|a, b| b.y.partial_cmp(&a.y).unwrap_or(std::cmp::Ordering::Equal).then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal)));
        let chosen: Vec<String> = blocks
            .iter()
            .filter(|b| b.size >= max - 0.6)
            .take(3)
            .map(|b| clean_text(&b.text))
            .collect();
        let joined = chosen.join(" ");
        if joined.chars().count() >= 12 && words_of(&joined).len() >= 3 {
            return Some(truncate_with_ellipsis(&joined, 250).trim_end_matches('…').to_string());
        }
    }
    let lines: Vec<String> = page.text.lines().map(clean_text).filter(|l| !l.is_empty()).collect();
    for (i, line) in lines.iter().enumerate() {
        if words_of(line).len() >= 4 && line.chars().count() >= 20 && !is_junk_line(line) {
            let mut title = line.clone();
            if let Some(next) = lines.get(i + 1) {
                let ends = title.ends_with(['.', ':', '?', '!']);
                if !ends
                    && title.chars().count() <= 90
                    && (10..=90).contains(&next.chars().count())
                    && !next.contains(',')
                    && !next.chars().any(|c| c.is_ascii_digit())
                    && !is_junk_line(next)
                {
                    title = format!("{title} {next}");
                }
            }
            return Some(truncate_with_ellipsis(&title, 250).trim_end_matches('…').to_string());
        }
    }
    None
}

/// Nome de arquivo ("Lopes_2012_letramento.pdf") limpo, se parecer um título de verdade.
pub fn title_from_name(name: &str) -> Option<String> {
    let mut s = name.trim().to_string();
    if s.to_lowercase().ends_with(".pdf") {
        s.truncate(s.len() - 4);
    }
    let s = clean_text(&s.replace(['_', '+'], " "));
    let ws = words_of(&s);
    // palavras de verdade (só letras): "1-s2.0-S0885-main" não conta como título
    let alpha_words = ws.iter().filter(|w| w.chars().count() >= 2 && w.chars().all(char::is_alphabetic)).count();
    let hexish = ws.iter().any(|w| w.len() >= 16 && w.chars().all(|c| c.is_ascii_hexdigit()));
    (alpha_words >= 3 && s.chars().count() >= 12 && !hexish).then_some(s)
}

/// Candidatos a título, do mais ao menos confiável (no máximo 2).
/// Nome editado pelo usuário vence; senão o título da página 1 e depois o nome.
pub fn guess_titles(name: &str, original: &str, pages: &[Page]) -> Vec<String> {
    let edited = !original.trim().is_empty() && name.trim() != original.trim();
    let from_name = title_from_name(name);
    let from_page = pages.iter().filter(|p| p.n == 1).chain(pages.first()).find_map(title_from_page);
    let mut out: Vec<String> = Vec::new();
    let order: [Option<String>; 2] = if edited { [from_name, from_page] } else { [from_page, from_name] };
    for t in order.into_iter().flatten() {
        if !out.iter().any(|o| title_similarity(o, &t) > 0.9) {
            out.push(t);
        }
    }
    out
}

/// E-mail para o "polite pool" do OpenAlex (parâmetro `mailto` e User-Agent).
pub fn clean_email(raw: &str) -> Result<String, String> {
    let e = raw.trim();
    let ok = e.len() <= 120
        && e.chars().all(|c| c.is_ascii_graphic() && !matches!(c, '(' | ')' | '<' | '>' | '[' | ']' | '\\' | ',' | ';' | ':' | '"'))
        && e.matches('@').count() == 1
        && e.split_once('@').is_some_and(|(l, d)| {
            !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && !d.contains("..")
        });
    if ok {
        Ok(e.to_string())
    } else {
        Err("O e-mail do OpenAlex é inválido (exemplo: nome@instituicao.br).".into())
    }
}

// ------------------------------------------------------------ cache e vínculos

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS openalex_cache(
           url TEXT PRIMARY KEY,
           body TEXT NOT NULL,
           fetched_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS openalex_cache_at ON openalex_cache(fetched_at);
         CREATE TABLE IF NOT EXISTS openalex_links(
           doc_id TEXT PRIMARY KEY,
           work_id TEXT NOT NULL,
           linked_at TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("Falha ao preparar o cache do OpenAlex: {e}"))?;
    // respostas com mais de um mês não servem nem como reserva offline
    let _ = conn.execute(
        "DELETE FROM openalex_cache WHERE fetched_at < ?",
        params![unix_now() - 30 * 24 * 3600],
    );
    Ok(())
}

impl Db {
    /// (corpo, instante em que foi buscado)
    pub fn oa_cache_get(&self, key: &str) -> Option<(String, i64)> {
        self.lock()
            .query_row("SELECT body,fetched_at FROM openalex_cache WHERE url=?", params![key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .ok()
            .flatten()
    }

    pub fn oa_cache_put(&self, key: &str, body: &str, now: i64) {
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO openalex_cache(url,body,fetched_at) VALUES(?,?,?)
             ON CONFLICT(url) DO UPDATE SET body=excluded.body, fetched_at=excluded.fetched_at",
            params![key, body, now],
        );
        // teto de linhas: o cache nunca cresce sem limite
        let _ = conn.execute(
            "DELETE FROM openalex_cache WHERE url IN
               (SELECT url FROM openalex_cache ORDER BY fetched_at DESC, url LIMIT -1 OFFSET ?)",
            params![CACHE_MAX_ROWS],
        );
    }

    pub fn oa_link_get(&self, doc_id: &str) -> Option<String> {
        self.lock()
            .query_row("SELECT work_id FROM openalex_links WHERE doc_id=?", params![doc_id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    /// Salva (`Some`) ou remove (`None`) o vínculo. O id já deve estar validado por `short_id`.
    pub fn oa_link_set(&self, doc_id: &str, work_id: Option<&str>) -> Result<(), String> {
        let conn = self.lock();
        match work_id {
            Some(w) => conn.execute(
                "INSERT INTO openalex_links(doc_id,work_id,linked_at) VALUES(?,?,datetime('now'))
                 ON CONFLICT(doc_id) DO UPDATE SET work_id=excluded.work_id, linked_at=excluded.linked_at",
                params![doc_id, w],
            ),
            None => conn.execute("DELETE FROM openalex_links WHERE doc_id=?", params![doc_id]),
        }
        .map(|_| ())
        .map_err(|e| format!("Não foi possível salvar o vínculo: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Block, Line};
    use serde_json::json;

    // Fixtures no esquema documentado do OpenAlex (a rede estava bloqueada ao escrever:
    // campos, aninhamento e formatos seguem https://docs.openalex.org/api-entities/works/work-object).
    pub fn work_json_full() -> Value {
        json!({
            "id": "https://openalex.org/W2741809807",
            "doi": "https://doi.org/10.1007/s11858-014-0620-0",
            "title": "Statistical <i>literacy</i> &amp; reasoning in schools",
            "display_name": "Statistical literacy & reasoning in schools",
            "publication_year": 2014,
            "cited_by_count": 1234,
            "authorships": [
                {"author_position": "first", "author": {"id": "https://openalex.org/A1", "display_name": "Carmen Batanero", "orcid": null}, "raw_author_name": "C. Batanero"},
                {"author_position": "middle", "author": {"id": "https://openalex.org/A2", "display_name": "Celi Espasandin Lopes"}},
                {"author_position": "middle", "author": {"display_name": "Ana"}},
                {"author_position": "middle", "author": {"display_name": "Bia"}},
                {"author_position": "middle", "author": {"display_name": "Caio"}},
                {"author_position": "middle", "author": {"display_name": "Davi"}},
                {"author_position": "last", "author": {"display_name": "Eva"}},
                {"author_position": "last", "author": {"display_name": "Fábio"}}
            ],
            "primary_location": {"is_oa": false, "landing_page_url": "https://doi.org/10.1007/s11858-014-0620-0", "pdf_url": null, "source": {"id": "https://openalex.org/S1", "display_name": "ZDM", "type": "journal"}},
            "best_oa_location": {"is_oa": true, "landing_page_url": "https://repo.example.org/handle/1", "pdf_url": "https://repo.example.org/bitstream/1/artigo.pdf", "source": {"display_name": "Repositório X"}},
            "open_access": {"is_oa": true, "oa_status": "green", "oa_url": "https://repo.example.org/handle/1"},
            "abstract_inverted_index": {"This": [0], "study": [1, 5], "examines": [2], "how": [3], "teachers": [4], "learn": [6], "statistics.": [7]}
        })
    }

    pub fn list_json() -> Value {
        json!({
            "meta": {"count": 3, "db_response_time_ms": 12, "page": 1, "per_page": 25},
            "results": [
                work_json_full(),
                {"id": "https://openalex.org/W111", "title": null, "display_name": "Só display name", "doi": null, "authorships": [], "primary_location": null, "best_oa_location": null, "open_access": {"is_oa": false, "oa_url": null}, "abstract_inverted_index": null, "cited_by_count": 0, "publication_year": null},
                {"id": "https://openalex.org/W222"},
                {"title": "sem id, descartado"}
            ],
            "group_by": []
        })
    }

    // ----- ids

    #[test]
    fn ids_curtos() {
        assert_eq!(short_id("W123").as_deref(), Some("W123"));
        assert_eq!(short_id("w123").as_deref(), Some("W123"));
        assert_eq!(short_id("https://openalex.org/W2741809807").as_deref(), Some("W2741809807"));
        assert_eq!(short_id("https://openalex.org/W2741809807/").as_deref(), Some("W2741809807"));
        for ruim in ["", "W", "Wabc", "A123", "W12 3", "W1;DROP", "W1234567890123", "../W1/x", "W-1"] {
            assert_eq!(short_id(ruim), None, "{ruim}");
        }
    }

    // ----- DOI

    #[test]
    fn doi_em_varios_formatos() {
        let esperado = Some("10.1007/s11858-014-0620-0".to_string());
        for raw in [
            "10.1007/s11858-014-0620-0",
            "https://doi.org/10.1007/s11858-014-0620-0",
            "http://dx.doi.org/10.1007/s11858-014-0620-0",
            "doi:10.1007/s11858-014-0620-0",
            "DOI: 10.1007/S11858-014-0620-0",
            "  10.1007/S11858-014-0620-0.  ",
            "https://doi.org/10.1007%2Fs11858-014-0620-0",
            "10.1007/s11858-014-0620-0?utm_source=x",
            "10.1007/s11858-014-0620-0,",
            "(10.1007/s11858-014-0620-0)",
            "\"10.1007/s11858-014-0620-0\".",
        ] {
            assert_eq!(normalize_doi(raw), esperado, "{raw}");
        }
        // parênteses que fazem parte do DOI ficam
        assert_eq!(normalize_doi("10.1016/S0360-1315(00)00001-2").as_deref(), Some("10.1016/s0360-1315(00)00001-2"));
        assert_eq!(normalize_doi("10.1016/S0360-1315(00)00001-2.").as_deref(), Some("10.1016/s0360-1315(00)00001-2"));
        assert_eq!(normalize_doi("10.1590/s0102-69092012000100002").as_deref(), Some("10.1590/s0102-69092012000100002"));
        assert_eq!(normalize_doi("10.12345.67/abc").as_deref(), Some("10.12345.67/abc"));
        for ruim in ["", "10.12/abc", "11.1234/abc", "10.1234", "10.1234/", "doi:", "texto", "10.1234abc/x", "10.1234567890/x"] {
            assert_eq!(normalize_doi(ruim), None, "{ruim}");
        }
    }

    #[test]
    fn extrai_dois_do_texto_da_pagina() {
        let t = "Lopes, C. (2012). Título. Revista X, 3(2), 1-20. https://doi.org/10.1590/S0102-69092012000100002.\nOutro: doi:10.1007/s11858-014-0620-0; fim.";
        assert_eq!(extract_dois(t), vec!["10.1590/s0102-69092012000100002", "10.1007/s11858-014-0620-0"]);
        // repetido uma vez só; com "DOI" colado e entre parênteses/aspas
        assert_eq!(extract_dois("DOI10.1000/abc.123 e (10.1000/abc.123) e \"10.1000/abc.123\""), vec!["10.1000/abc.123"]);
        // DOI partido em duas linhas com hífen
        assert_eq!(extract_dois("DOI: 10.1007/s11858-\n014-0620-0 mais texto"), vec!["10.1007/s11858-014-0620-0"]);
        assert_eq!(extract_dois("https://doi.org/10.1007/\ns11858-014-0620-0"), vec!["10.1007/s11858-014-0620-0"]);
        // ponto final de frase na quebra de linha não gruda a próxima frase
        assert_eq!(extract_dois("veja 10.1000/abc.\nOutra frase."), vec!["10.1000/abc"]);
        // números parecidos mas não-DOI
        assert!(extract_dois("versão 10.5 de 2010.1234 e 110.1234/x e abc10.1234/x").is_empty());
        assert!(extract_dois("").is_empty());
        assert!(extract_dois("10.").is_empty());
        // ligadura/NFKC e hífen macio
        assert_eq!(extract_dois("doi: 10.1000/a\u{ad}bc"), vec!["10.1000/abc"]);
        // tags/aspas encerram
        assert_eq!(extract_dois("<a href=\"https://doi.org/10.1000/abc\">x</a>"), vec!["10.1000/abc"]);
    }

    #[test]
    fn dois_so_das_primeiras_paginas() {
        let p = |n: i64, t: &str| Page { n, md: t.into(), text: t.into(), blocks: vec![], lines: vec![], figures: vec![] };
        let pages = vec![p(2, "doi:10.2000/dois"), p(1, "doi:10.1000/um"), p(5, "10.3000/cinco")];
        assert_eq!(dois_from_pages(&pages, 2), vec!["10.1000/um", "10.2000/dois"]);
        assert_eq!(dois_from_pages(&pages, 3).len(), 3);
    }

    // ----- abstract

    #[test]
    fn abstract_invertido_e_reconstruido() {
        let v = work_json_full();
        assert_eq!(reconstruct_abstract(&v["abstract_inverted_index"]).unwrap(), "This study examines how teachers study learn statistics.");
        assert_eq!(reconstruct_abstract(&Value::Null), None);
        assert_eq!(reconstruct_abstract(&json!({})), None);
        assert_eq!(reconstruct_abstract(&json!({"a": "nao-array"})), None);
        // posições esparsas e gigantes não alocam nada
        assert_eq!(reconstruct_abstract(&json!({"b": [5000000000u64], "a": [3]})).unwrap(), "a b");
        // valores inválidos dentro das posições são ignorados
        assert_eq!(reconstruct_abstract(&json!({"a": [0, "x", null, -1]})).unwrap(), "a");
        // truncamento em 600 caracteres com reticências
        let mut m = serde_json::Map::new();
        for i in 0..400u64 {
            m.insert(format!("palavra{i}"), json!([i]));
        }
        let long = reconstruct_abstract(&Value::Object(m)).unwrap();
        assert_eq!(long.chars().count(), MAX_ABSTRACT_CHARS);
        assert!(long.ends_with('…'));
        // acentos não quebram o corte
        let mut m = serde_json::Map::new();
        for i in 0..700u64 {
            m.insert(format!("ção{i}"), json!([i]));
        }
        assert!(reconstruct_abstract(&Value::Object(m)).unwrap().chars().count() <= MAX_ABSTRACT_CHARS);
    }

    // ----- Work

    #[test]
    fn work_completo() {
        let w = parse_work(&work_json_full()).unwrap();
        assert_eq!(w.id, "W2741809807");
        assert_eq!(w.doi.as_deref(), Some("10.1007/s11858-014-0620-0"));
        assert_eq!(w.title, "Statistical literacy & reasoning in schools");
        assert_eq!(w.authors.len(), MAX_AUTHORS);
        assert_eq!(w.authors_total, 8);
        assert_eq!(w.authors[0], "Carmen Batanero");
        assert_eq!(w.year, Some(2014));
        assert_eq!(w.venue.as_deref(), Some("ZDM"));
        assert_eq!(w.cited_by_count, 1234);
        assert!(w.is_oa);
        assert_eq!(w.oa_url.as_deref(), Some("https://repo.example.org/bitstream/1/artigo.pdf"));
        assert!(w.abstract_text.as_deref().unwrap().starts_with("This study"));
        assert_eq!(w.url, "https://doi.org/10.1007/s11858-014-0620-0");
    }

    #[test]
    fn work_serializa_com_os_nomes_do_contrato() {
        let v = serde_json::to_value(parse_work(&work_json_full()).unwrap()).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            ["abstract", "authors", "authors_total", "cited_by_count", "doi", "id", "is_oa", "oa_url", "title", "url", "venue", "year"]
        );
    }

    #[test]
    fn work_so_com_id_e_campos_nulos() {
        let w = parse_work(&json!({"id": "https://openalex.org/W222"})).unwrap();
        assert_eq!(w.title, "(Sem título)");
        assert!(w.doi.is_none() && w.authors.is_empty() && w.year.is_none() && w.venue.is_none());
        assert_eq!((w.cited_by_count, w.is_oa, w.authors_total), (0, false, 0));
        assert!(w.oa_url.is_none() && w.abstract_text.is_none());
        assert_eq!(w.url, "https://openalex.org/W222");
        let w = parse_work(&list_json()["results"][1]).unwrap();
        assert_eq!(w.title, "Só display name");
        assert!(parse_work(&json!({})).is_none());
        assert!(parse_work(&json!({"id": 5})).is_none());
        assert!(parse_work(&json!({"id": "lixo"})).is_none());
        assert!(parse_work(&Value::Null).is_none());
        // tipos errados nos campos não derrubam
        let w = parse_work(&json!({"id": "W9", "authorships": "x", "cited_by_count": "n", "open_access": [], "publication_year": "2020"})).unwrap();
        assert_eq!((w.cited_by_count, w.year, w.is_oa), (0, None, false));
    }

    #[test]
    fn oa_url_cai_para_landing_e_depois_open_access() {
        let w = parse_work(&json!({"id": "W1", "best_oa_location": {"pdf_url": null, "landing_page_url": "https://x.org/land"}})).unwrap();
        assert_eq!(w.oa_url.as_deref(), Some("https://x.org/land"));
        assert!(w.is_oa);
        let w = parse_work(&json!({"id": "W1", "open_access": {"is_oa": true, "oa_url": "https://y.org/a"}})).unwrap();
        assert_eq!(w.oa_url.as_deref(), Some("https://y.org/a"));
        let w = parse_work(&json!({"id": "W1", "open_access": {"is_oa": false}, "host_venue": {"display_name": "Antiga"}})).unwrap();
        assert!(!w.is_oa);
        assert_eq!(w.venue.as_deref(), Some("Antiga"));
    }

    #[test]
    fn listagem_ignora_entradas_sem_id_e_le_o_total() {
        let v = list_json();
        let ws = parse_works(&v);
        assert_eq!(ws.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["W2741809807", "W111", "W222"]);
        assert_eq!(parse_total(&v), Some(3));
        assert!(parse_works(&json!({})).is_empty());
        assert!(parse_works(&json!({"results": null})).is_empty());
        assert_eq!(parse_total(&json!({})), None);
    }

    #[test]
    fn listas_de_ids() {
        let v = json!({"related_works": ["https://openalex.org/W1", "https://openalex.org/W2", "https://openalex.org/W1", "lixo", 3], "referenced_works": []});
        assert_eq!(parse_id_list(&v, "related_works"), ["W1", "W2"]);
        assert!(parse_id_list(&v, "referenced_works").is_empty());
        assert!(parse_id_list(&v, "ausente").is_empty());
    }

    // ----- URL / cache

    #[test]
    fn chave_de_cache_normaliza_ordem_e_ignora_mailto() {
        let a = cache_key(API_BASE, "/works", &[("per-page", "25".into()), ("filter", "cites:W1".into()), ("mailto", "a@b.com".into())]);
        let b = cache_key(API_BASE, "/works", &[("filter", "cites:W1".into()), ("per-page", "25".into())]);
        assert_eq!(a, b);
        assert_eq!(a, "https://api.openalex.org/works?filter=cites:W1&per-page=25");
        let c = cache_key("https://api.openalex.org/", "/works/W1", &[]);
        assert_eq!(c, "https://api.openalex.org/works/W1");
        assert_eq!(pct_encode("a b|c&d=é", ":,"), "a%20b%7Cc%26d%3D%C3%A9");
    }

    #[test]
    fn cache_ttl_teto_e_atualizacao() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.oa_cache_get("k").is_none());
        db.oa_cache_put("k", "{\"a\":1}", 1000);
        assert_eq!(db.oa_cache_get("k").unwrap(), ("{\"a\":1}".to_string(), 1000));
        db.oa_cache_put("k", "{\"a\":2}", 2000);
        assert_eq!(db.oa_cache_get("k").unwrap(), ("{\"a\":2}".to_string(), 2000));
        for i in 0..(CACHE_MAX_ROWS + 50) {
            db.oa_cache_put(&format!("u{i}"), "{}", 3000 + i);
        }
        let n: i64 = db.lock().query_row("SELECT COUNT(*) FROM openalex_cache", [], |r| r.get(0)).unwrap();
        assert_eq!(n, CACHE_MAX_ROWS);
        assert!(db.oa_cache_get("k").is_none(), "o mais antigo sai primeiro");
        assert!(db.oa_cache_get(&format!("u{}", CACHE_MAX_ROWS + 49)).is_some());
    }

    #[test]
    fn vinculos_salvam_trocam_removem_e_somem_com_o_documento() {
        let db = Db::open_in_memory().unwrap();
        db.insert_doc("d1", "A", "/a", "t").unwrap();
        assert!(db.oa_link_get("d1").is_none());
        db.oa_link_set("d1", Some("W1")).unwrap();
        db.oa_link_set("d1", Some("W2")).unwrap();
        assert_eq!(db.oa_link_get("d1").as_deref(), Some("W2"));
        db.oa_link_set("d1", None).unwrap();
        assert!(db.oa_link_get("d1").is_none());
        db.oa_link_set("d1", None).unwrap();
        db.oa_link_set("d1", Some("W3")).unwrap();
        db.delete_doc("d1").unwrap();
        assert!(db.oa_link_get("d1").is_none());
    }

    #[test]
    fn banco_020_ganha_as_tabelas_novas_sem_perder_dados() {
        let dir = std::env::temp_dir().join(format!("margem-oa-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pdfchat.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
                 INSERT INTO documents VALUES('d1','Antigo','/a.pdf',0,'2025-01-01');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        db.oa_link_set("d1", Some("W7")).unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();
        assert_eq!(db.oa_link_get("d1").as_deref(), Some("W7"));
        assert_eq!(db.list_docs().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ----- título

    fn blk(text: &str, y: f64, size: f64) -> Block {
        Block { text: text.into(), x: 72.0, y, w: 400.0, h: size, size }
    }

    fn page1(blocks: Vec<Block>, text: &str) -> Page {
        Page { n: 1, md: text.into(), text: text.into(), blocks, lines: vec![Line { i: 0, text: "x".into(), rect: [0.0; 4] }], figures: vec![] }
    }

    #[test]
    fn titulo_vem_do_bloco_de_maior_fonte() {
        let p = page1(
            vec![
                blk("Revista Brasileira de Educação, v. 12, n. 3, 2020", 780.0, 9.0),
                blk("Letramento estatístico na formação de professores", 700.0, 20.0),
                blk("Maria da Silva, João Souza", 660.0, 11.0),
                blk("Resumo: Este artigo discute o letramento estatístico de professores em formação inicial.", 600.0, 10.0),
            ],
            "",
        );
        assert_eq!(title_from_page(&p).as_deref(), Some("Letramento estatístico na formação de professores"));
    }

    #[test]
    fn titulo_em_dois_blocos_da_mesma_fonte_junta_na_ordem_da_pagina() {
        let p = page1(vec![blk("na formação de professores", 680.0, 20.0), blk("Letramento estatístico", 700.0, 20.0), blk("Autores e filiação aqui hoje", 640.0, 11.0)], "");
        assert_eq!(title_from_page(&p).as_deref(), Some("Letramento estatístico na formação de professores"));
    }

    #[test]
    fn titulo_sem_tamanhos_usa_a_primeira_linha_forte() {
        let p = page1(vec![], "Revista X\nwww.revista.org\n123\nO ensino de probabilidade nos anos\niniciais do fundamental\nMaria Silva, João Souza\nResumo");
        assert_eq!(title_from_page(&p).as_deref(), Some("O ensino de probabilidade nos anos iniciais do fundamental"));
        assert_eq!(title_from_page(&page1(vec![], "")), None);
        assert_eq!(title_from_page(&page1(vec![], "1\n2\ndoi: 10.1000/x\nhttp://a.b")), None);
    }

    #[test]
    fn titulo_do_nome_do_arquivo() {
        assert_eq!(title_from_name("Lopes_2012_letramento_estatistico.pdf").as_deref(), Some("Lopes 2012 letramento estatistico"));
        assert_eq!(title_from_name("Educação Estatística no Brasil").as_deref(), Some("Educação Estatística no Brasil"));
        assert_eq!(title_from_name("1-s2.0-S0885230814000370-main"), None);
        assert_eq!(title_from_name("artigo"), None);
        assert_eq!(title_from_name("a1b2c3d4e5f6a7b8c9d0e1f2"), None);
        assert_eq!(title_from_name(""), None);
    }

    #[test]
    fn candidatos_de_titulo_respeitam_edicao_do_usuario() {
        let p = page1(vec![blk("Título forte do artigo no PDF", 700.0, 20.0)], "");
        // sem edição: página primeiro, nome (se parecer título) depois
        let c = guess_titles("Nome do arquivo bem descritivo", "Nome do arquivo bem descritivo", std::slice::from_ref(&p));
        assert_eq!(c, ["Título forte do artigo no PDF", "Nome do arquivo bem descritivo"]);
        // editado: o nome do usuário vence
        let c = guess_titles("Meu título editado manualmente", "scan0001", std::slice::from_ref(&p));
        assert_eq!(c[0], "Meu título editado manualmente");
        assert_eq!(c.len(), 2);
        // nome inútil: só a página
        assert_eq!(guess_titles("scan0001", "scan0001", std::slice::from_ref(&p)), ["Título forte do artigo no PDF"]);
        // nada: vazio
        assert!(guess_titles("scan", "scan", &[]).is_empty());
        // duplicado não repete
        let c = guess_titles("Título forte do artigo no PDF", "x", std::slice::from_ref(&p));
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn email_do_openalex() {
        assert_eq!(clean_email("  gerlan@ufscar.br ").as_deref(), Ok("gerlan@ufscar.br"));
        assert!(clean_email("nome.sobrenome+tag@sub.dominio.edu.br").is_ok());
        for ruim in ["", "sem-arroba", "a@b", "@x.com", "a@@x.com", "a b@x.com", "a@x..com", "a@.com", "a@x.com.", "a(b)@x.com", "a@x.com\r\nX: y", "ç@x.com", &format!("{}@x.com", "a".repeat(130))] {
            assert!(clean_email(ruim).is_err(), "{ruim:?}");
        }
    }

    #[test]
    fn semelhanca_de_titulos() {
        assert!(title_similarity("Letramento estatístico na escola", "letramento estatistico NA ESCOLA") > 0.99);
        assert!(title_similarity("Letramento estatístico na escola", "Ensino de geometria plana") < 0.1);
        assert_eq!(title_similarity("", "x"), 0.0);
        let meio = title_similarity("Letramento estatístico na escola básica", "Letramento estatístico em professores");
        assert!(meio > 0.2 && meio < 0.9, "{meio}");
    }
}
