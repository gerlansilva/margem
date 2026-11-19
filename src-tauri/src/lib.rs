mod ai;
mod db;
mod evidence;
mod model;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use ai::DocContext;
use db::Db;
use model::{Cell, ChatRequest, Column, Doc, Evidence, Page};

use base64::Engine as _;

const DEFAULT_MODEL: &str = "deepseek-flash";
const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";

pub struct AppState {
    db: Db,
    http: reqwest::Client,
    cancelled: Mutex<HashSet<String>>,
}

fn api_key(state: &AppState) -> Result<String, String> {
    std::env::var("DEEPSEEK_API_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| state.db.setting("api_key"))
        .ok_or_else(|| "Configure a chave da DeepSeek nas configurações.".to_string())
}

fn model_name(state: &AppState) -> String {
    std::env::var("DEEPSEEK_MODEL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| state.db.setting("model"))
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

fn base_url(state: &AppState) -> String {
    std::env::var("DEEPSEEK_BASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| state.db.setting("base_url"))
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

// ------------------------------------------------------------- documentos

#[tauri::command]
fn import_doc(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Doc, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("Arquivo não encontrado.".into());
    }
    if source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        != Some("pdf".to_string())
    {
        return Err("Envie um arquivo PDF.".into());
    }
    let id = short_id();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{id}.pdf"));
    std::fs::copy(&source, &dest).map_err(|e| format!("Falha ao copiar o PDF: {e}"))?;
    let name = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Documento")
        .to_string();
    let created = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    state
        .db
        .insert_doc(&id, &name, dest.to_string_lossy().as_ref(), &created)
}

#[tauri::command]
fn list_docs(state: State<'_, AppState>) -> Result<Vec<Doc>, String> {
    state.db.list_docs()
}

#[tauri::command]
fn get_doc(state: State<'_, AppState>, doc_id: String) -> Result<Value, String> {
    let doc = state.db.get_doc(&doc_id)?.ok_or("Documento não encontrado.")?;
    let pages = state.db.pages(&doc_id)?;
    Ok(json!({ "doc": doc, "pages": pages }))
}

#[tauri::command]
fn delete_doc(app: AppHandle, state: State<'_, AppState>, doc_id: String) -> Result<(), String> {
    if let Some(doc) = state.db.get_doc(&doc_id)? {
        let _ = std::fs::remove_file(doc.path);
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::remove_dir_all(dir.join("figures").join(&doc_id));
    }
    state.db.delete_doc(&doc_id)
}

#[tauri::command]
fn save_pages(state: State<'_, AppState>, doc_id: String, pages: Vec<Page>) -> Result<(), String> {
    state.db.save_pages(&doc_id, &pages)
}

/// Grava o recorte de uma figura/quadro em app_data/figures/<doc>/<página>-<n>.png.
#[tauri::command]
fn save_figure(
    app: AppHandle,
    doc_id: String,
    page: i64,
    index: i64,
    data: String,
) -> Result<String, String> {
    let raw = data.split(',').nth(1).unwrap_or(&data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("Figura inválida: {e}"))?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("figures")
        .join(&doc_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{page}-{index}.png"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ----------------------------------------------------------- configuração

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Value {
    json!({
        "has_key": api_key(&state).is_ok(),
        "model": model_name(&state),
        "base_url": base_url(&state)
    })
}

#[tauri::command]
fn save_settings(
    state: State<'_, AppState>,
    api_key: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<Value, String> {
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        state.db.set_setting("api_key", key.trim())?;
    }
    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
        state.db.set_setting("model", m.trim())?;
    }
    if let Some(b) = base_url.filter(|b| !b.trim().is_empty()) {
        state.db.set_setting("base_url", b.trim())?;
    }
    Ok(get_settings(state))
}

// ---------------------------------------------------------- fichamento

#[tauri::command]
fn get_columns(state: State<'_, AppState>) -> Result<Vec<Column>, String> {
    state.db.columns()
}

#[tauri::command]
fn save_columns(state: State<'_, AppState>, columns: Vec<Column>) -> Result<Vec<Column>, String> {
    let prepared: Vec<Column> = columns
        .into_iter()
        .enumerate()
        .map(|(i, c)| Column {
            id: if c.id.trim().is_empty() { short_id() } else { c.id },
            name: if c.name.trim().is_empty() {
                format!("Coluna {}", i + 1)
            } else {
                c.name.trim().to_string()
            },
            instruction: c.instruction.trim().to_string(),
            kind: if c.kind.trim().is_empty() { "text".into() } else { c.kind },
        })
        .collect();
    state.db.replace_columns(&prepared)
}

#[tauri::command]
fn get_cells(state: State<'_, AppState>, doc_id: Option<String>) -> Result<Vec<Cell>, String> {
    state.db.cells(doc_id.as_deref())
}

#[tauri::command]
fn update_cell(
    state: State<'_, AppState>,
    doc_id: String,
    column_id: String,
    value: Option<String>,
) -> Result<(), String> {
    let current = state
        .db
        .cells(Some(&doc_id))?
        .into_iter()
        .find(|c| c.column_id == column_id);
    let status = if value.as_deref().unwrap_or("").trim().is_empty() {
        "not_found"
    } else {
        "edited"
    };
    state.db.put_cell(
        &doc_id,
        &column_id,
        value.as_deref(),
        current.as_ref().and_then(|c| c.quote.as_deref()),
        current.as_ref().and_then(|c| c.page),
        status,
        current.as_ref().map(|c| c.evidence.as_slice()).unwrap_or(&[]),
    )
}

#[tauri::command]
async fn extract(
    state: State<'_, AppState>,
    doc_id: String,
    column_ids: Option<Vec<String>>,
) -> Result<Vec<Cell>, String> {
    let doc = state.db.get_doc(&doc_id)?.ok_or("Documento não encontrado.")?;
    let pages = state.db.pages(&doc_id)?;
    if pages.is_empty() {
        return Err("O texto deste PDF ainda não foi extraído.".into());
    }
    let mut cols = state.db.columns()?;
    if let Some(ids) = column_ids {
        cols.retain(|c| ids.contains(&c.id));
    }
    if cols.is_empty() {
        return Err("Defina ao menos uma coluna.".into());
    }
    let ctx = [DocContext {
        label: "D1".to_string(),
        doc: &doc,
        pages: &pages,
    }];
    let context = format!("ID do documento: {}\n{}", doc.id, ai::build_context(&ctx, ""));
    let body = ai::extract_body(&model_name(&state), &context, &cols);
    let key = api_key(&state)?;
    let url = format!("{}/chat/completions", base_url(&state).trim_end_matches('/'));

    let resp = state
        .http
        .post(url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Falha na DeepSeek: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        eprintln!("extract: DeepSeek HTTP {status}: {text}");
        return Err(format!("DeepSeek HTTP {status}: {text}"));
    }
    let payload: Value = resp.json().await.map_err(|e| e.to_string())?;
    let raw = payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default();
    eprintln!("extract: resposta bruta ({} chars): {}", raw.len(), &raw.chars().take(400).collect::<String>());
    let raw_cells = ai::parse_cells(raw).map_err(|e| {
        eprintln!("extract: JSON inválido: {e}");
        e
    })?;

    for item in raw_cells {
        let Some(column_id) = item.column_id else { continue };
        if !cols.iter().any(|c| c.id == column_id) {
            continue;
        }
        let (quote, page) = ai::verify_quote(item.quote, item.page, &pages);
        let value = item
            .value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .filter(|_| quote.is_some());
        let status = if value.is_some() { "filled" } else { "not_found" };
        let evidence_ids = match (quote.as_deref(), page) {
            (Some(q), Some(n)) => pages
                .iter()
                .find(|p| p.n == n)
                .and_then(|p| evidence::resolve(&doc_id, n, q, &p.lines))
                .map(|found| {
                    let _ = state.db.save_evidence(&found);
                    vec![found.id]
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        state.db.put_cell(
            &doc_id,
            &column_id,
            value.as_deref(),
            quote.as_deref(),
            page,
            status,
            &evidence_ids,
        )?;
    }
    for c in cols {
        if !state.db.cells(Some(&doc_id))?.iter().any(|x| x.column_id == c.id) {
            state
                .db
                .put_cell(&doc_id, &c.id, None, None, None, "not_found", &[])?;
        }
    }
    state.db.cells(Some(&doc_id))
}

fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[tauri::command]
fn write_csv(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let docs = state.db.list_docs()?;
    let cols = state.db.columns()?;
    let cells = state.db.cells(None)?;
    let mut out = String::new();
    out.push_str("Documento");
    for c in &cols {
        out.push(',');
        out.push_str(&csv_escape(&c.name));
    }
    out.push_str(",Trechos\n");
    for d in docs {
        out.push_str(&csv_escape(&d.name));
        let mut quotes = Vec::new();
        for c in &cols {
            let cell = cells
                .iter()
                .find(|x| x.doc_id == d.id && x.column_id == c.id);
            out.push(',');
            if let Some(cell) = cell {
                out.push_str(&csv_escape(cell.value.as_deref().unwrap_or("")));
                if let (Some(q), Some(p)) = (&cell.quote, cell.page) {
                    quotes.push(format!("[p.{p}] {q}"));
                }
            }
        }
        out.push(',');
        out.push_str(&csv_escape(&quotes.join(" | ")));
        out.push('\n');
    }
    std::fs::write(path, out).map_err(|e| e.to_string())
}

// -------------------------------------------------------------- evidências

/// Localiza a citação nas linhas da página e devolve o trecho com os
/// retângulos de destaque. Grava o resultado para o id ficar estável.
#[tauri::command]
fn resolve_evidence(
    state: State<'_, AppState>,
    doc_id: String,
    page: i64,
    quote: String,
) -> Result<Option<Evidence>, String> {
    let pages = state.db.pages(&doc_id)?;
    let Some(found) = pages
        .iter()
        .find(|p| p.n == page)
        .and_then(|p| evidence::resolve(&doc_id, page, &quote, &p.lines))
    else {
        return Ok(None);
    };
    state.db.save_evidence(&found)?;
    Ok(Some(found))
}

#[tauri::command]
fn get_evidence(state: State<'_, AppState>, id: String) -> Result<Option<Evidence>, String> {
    state.db.get_evidence(&id)
}

// ------------------------------------------------------------------ chat

fn wants_visual(question: &str) -> bool {
    let q = question.to_lowercase();
    [
        "figura", "figuras", "imagem", "imagens", "gráfico", "grafico", "tabela", "tabelas",
        "diagrama", "quadro", "esquema", "chart", "figure", "table", "plot",
    ]
    .iter()
    .any(|word| q.contains(word))
}

/// Recortes de figuras que valem a pena mandar junto com a pergunta.
fn figures_for_question(
    question: &str,
    docs: &[(Doc, Vec<Page>)],
    labels: &[String],
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if !wants_visual(question) {
        return out;
    }
    let q = ai::terms(question);
    let mut ranked: Vec<(usize, usize, i64, String)> = Vec::new();
    for (i, (_doc, pages)) in docs.iter().enumerate() {
        for p in pages {
            let score = ai::terms(&p.md).intersection(&q).count();
            for f in &p.figures {
                ranked.push((score, i, p.n, f.path.clone()));
            }
        }
    }
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.cmp(&b.2)));
    for (_, i, page_n, path) in ranked.into_iter().take(4) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if bytes.len() > 4_000_000 {
            continue;
        }
        let url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        let label = labels.get(i).cloned().unwrap_or_default();
        out.push((
            format!("Imagem {} — {} p.{}", out.len() + 1, label, page_n),
            url,
        ));
    }
    out
}

#[tauri::command]
async fn chat(
    app: AppHandle,
    state: State<'_, AppState>,
    req: ChatRequest,
) -> Result<(), String> {
    let id = req.request_id.clone();
    let mut docs: Vec<(Doc, Vec<Page>)> = Vec::new();
    for doc_id in &req.doc_ids {
        if let Some(doc) = state.db.get_doc(doc_id)? {
            let pages = state.db.pages(doc_id)?;
            if !pages.is_empty() {
                docs.push((doc, pages));
            }
        }
    }
    if docs.is_empty() || req.history.is_empty() {
        let _ = app.emit(
            "ai",
            json!({"id": id, "type": "error", "message": "Nenhum documento pronto para consulta."}),
        );
        return Ok(());
    }
    let labels: Vec<String> = (1..=docs.len()).map(|i| format!("D{i}")).collect();
    let ctx: Vec<DocContext> = docs
        .iter()
        .enumerate()
        .map(|(i, (doc, pages))| DocContext {
            label: labels[i].clone(),
            doc,
            pages,
        })
        .collect();
    let question = req.history.last().map(|m| m.content.as_str()).unwrap_or("");
    let context = ai::build_context(&ctx, question);
    let images = figures_for_question(question, &docs, &labels);
    let figure_count: usize = docs
        .iter()
        .flat_map(|(_, pages)| pages.iter())
        .map(|p| p.figures.len())
        .sum();
    eprintln!(
        "chat: {} recorte(s) anexado(s); visual={}; {figure_count} figura(s) nas páginas",
        images.len(),
        wants_visual(question)
    );
    let body = ai::chat_body(
        &model_name(&state),
        &context,
        &req.history,
        req.selection.as_deref(),
        &images,
    );
    let key = match api_key(&state) {
        Ok(k) => k,
        Err(e) => {
            let _ = app.emit("ai", json!({"id": id, "type": "error", "message": e}));
            return Ok(());
        }
    };
    let url = format!("{}/chat/completions", base_url(&state).trim_end_matches('/'));
    let resp = match state.http.post(url).bearer_auth(key).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                "ai",
                json!({"id": id, "type": "error", "message": format!("Falha na DeepSeek: {e}")}),
            );
            return Ok(());
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit(
            "ai",
            json!({"id": id, "type": "error", "message": format!("DeepSeek HTTP {status}: {text}")}),
        );
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut answer = String::new();
    while let Some(chunk) = stream.next().await {
        if state
            .cancelled
            .lock()
            .map(|c| c.contains(&id))
            .unwrap_or(false)
        {
            break;
        }
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = app.emit(
                    "ai",
                    json!({"id": id, "type": "error", "message": format!("Conexão interrompida: {e}")}),
                );
                break;
            }
        };
        buf.push_str(&String::from_utf8_lossy(&bytes));
        loop {
            let separator = buf
                .find("\n\n")
                .map(|p| (p, 2))
                .or_else(|| buf.find("\r\n\r\n").map(|p| (p, 4)));
            let Some((pos, len)) = separator else { break };
            let event: String = buf.drain(..pos + len).collect();
            for line in event.lines() {
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data) {
                    if let Some(token) = value["choices"][0]["delta"]["content"].as_str() {
                        if !token.is_empty() {
                            answer.push_str(token);
                            let _ = app.emit(
                                "ai",
                                json!({"id": id, "type": "token", "t": token}),
                            );
                        }
                    }
                }
            }
        }
    }
    let _ = app.emit(
        "ai",
        json!({"id": id, "type": "done", "answer": answer, "labels": labels}),
    );
    if let Ok(mut c) = state.cancelled.lock() {
        c.remove(&id);
    }
    Ok(())
}

#[tauri::command]
fn cancel_chat(state: State<'_, AppState>, request_id: String) {
    if let Ok(mut c) = state.cancelled.lock() {
        c.insert(request_id);
    }
}

// ------------------------------------------------------------------- run

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(dir.join("uploads"))?;
            let db = Db::open(&dir.join("pdfchat.sqlite3")).map_err(|e| e.to_string())?;
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(300))
                .build()
                .map_err(|e| e.to_string())?;
            app.manage(AppState {
                db,
                http,
                cancelled: Mutex::new(HashSet::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_doc,
            list_docs,
            get_doc,
            delete_doc,
            save_pages,
            save_figure,
            resolve_evidence,
            get_evidence,
            get_settings,
            save_settings,
            get_columns,
            save_columns,
            get_cells,
            update_cell,
            extract,
            write_csv,
            chat,
            cancel_chat
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o PDF Chat");
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::{Block, Figure};

    fn doc() -> Doc {
        Doc {
            id: "d1".into(),
            name: "artigo".into(),
            page_count: 1,
            path: "/tmp/artigo.pdf".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn pergunta_visual_anexa_recorte_da_figura() {
        let path = std::env::temp_dir().join("figura-teste.png");
        std::fs::write(&path, [0x89u8, b'P', b'N', b'G']).unwrap();
        let page = Page {
            n: 3,
            md: "gráfico de inscritos por estado".into(),
            text: "gráfico de inscritos por estado".into(),
            blocks: vec![Block {
                text: "gráfico de inscritos por estado".into(),
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
                size: 11.0,
            }],
            lines: vec![],
            figures: vec![Figure {
                index: 0,
                path: path.to_string_lossy().to_string(),
                w: 100.0,
                h: 50.0,
            }],
        };
        let docs = vec![(doc(), vec![page])];
        let labels = vec!["D1".to_string()];

        let imagens = figures_for_question("o que mostra a figura 2?", &docs, &labels);
        assert_eq!(imagens.len(), 1);
        assert!(imagens[0].1.starts_with("data:image/png;base64,"));
        assert!(imagens[0].0.contains("p.3"));

        assert!(figures_for_question("qual a metodologia?", &docs, &labels).is_empty());
    }
}
