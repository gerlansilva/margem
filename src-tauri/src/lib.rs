mod ai;
mod cancel;
mod db;
mod evidence;
mod export;
mod fichamento;
mod files;
mod keystore;
mod model;
mod net;
mod secrets;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use ai::DocContext;
use cancel::{BusyDocs, CancelRegistry};
use db::Db;
use model::{Cell, ChatRequest, Column, Doc, Evidence, Page};
use net::NetErrorKind;
use secrets::{KeySource, SecretStore};

const DEFAULT_MODEL: &str = "deepseek-flash";
const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
/// Chave do SQLite onde a chave da API ficava antes do cofre do sistema.
const KEY_SETTING: &str = "api_key";
/// Espera pelo início da resposta do chat (o stream em si não tem teto total).
const CHAT_HEADER_TIMEOUT: Duration = Duration::from_secs(120);
/// Extração não usa stream: o corpo só chega quando o modelo termina.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(360);
/// Extrações simultâneas (documentos diferentes); as demais esperam na fila.
const MAX_CONCURRENT_EXTRACTS: usize = 3;
const MAX_FIGURE_BYTES: usize = 20 * 1024 * 1024;

pub struct AppState {
    db: Db,
    http: reqwest::Client,
    cancel: CancelRegistry,
    /// Documentos em extração (um por vez cada).
    busy_docs: BusyDocs,
    /// No máximo `MAX_CONCURRENT_EXTRACTS` chamadas ao modelo ao mesmo tempo.
    extract_slots: std::sync::Arc<tokio::sync::Semaphore>,
    vault: Box<dyn SecretStore>,
}

struct AiConfig {
    key: String,
    model: String,
    base_url: String,
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

impl AppState {
    fn api_key(&self) -> (Option<String>, KeySource) {
        secrets::resolve_key(env_value("DEEPSEEK_API_KEY"), &*self.vault, self.db.setting(KEY_SETTING))
    }

    fn model(&self) -> String {
        env_value("DEEPSEEK_MODEL")
            .or_else(|| self.db.setting("model"))
            .unwrap_or_else(|| DEFAULT_MODEL.to_string())
    }

    fn base_url(&self) -> String {
        env_value("DEEPSEEK_BASE_URL")
            .or_else(|| self.db.setting("base_url"))
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    }

    fn ai_config(&self) -> Result<AiConfig, String> {
        let (key, _) = self.api_key();
        let key = key.ok_or_else(|| "Configure a chave da DeepSeek nas configurações.".to_string())?;
        let base_url = net::validate_base_url(&self.base_url())
            .map_err(|e| format!("URL base inválida nas configurações: {e}"))?;
        Ok(AiConfig { key, model: self.model(), base_url })
    }

    fn settings_json(&self) -> Value {
        let (key, source) = self.api_key();
        json!({
            "has_key": key.is_some(),
            // "env" | "keychain" | "file" | "none": onde a chave em uso está guardada.
            "key_source": source,
            // O cofre do sistema (Keychain/Credential Manager) está funcionando?
            "secure_storage": self.vault.get().is_ok(),
            "model": self.model(),
            "base_url": self.base_url()
        })
    }
}

fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// Pasta de dados do app. No Windows usa AppData\Local (não a Roaming, que
/// sincroniza com o perfil de domínio): banco e PDFs podem ser grandes.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("Não foi possível localizar a pasta de dados do aplicativo: {e}"))
}

fn emit_ai(app: &AppHandle, payload: Value) {
    if let Err(e) = app.emit("ai", payload) {
        eprintln!("falha ao emitir evento ai: {e}");
    }
}

// ------------------------------------------------------------- documentos

#[tauri::command]
fn import_doc(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Doc, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("Arquivo não encontrado.".into());
    }
    if !files::has_pdf_extension(&source) {
        return Err("Envie um arquivo PDF.".into());
    }
    if !files::looks_like_pdf(&source) {
        return Err("O arquivo não parece ser um PDF válido.".into());
    }
    let id = short_id();
    let dir = data_dir(&app)?.join("uploads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Não foi possível criar a pasta de PDFs: {e}"))?;
    let dest = dir.join(format!("{id}.pdf"));
    std::fs::copy(&source, &dest).map_err(|e| format!("Falha ao copiar o PDF: {e}"))?;
    let created = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    state
        .db
        .insert_doc(&id, &files::display_name(&source), dest.to_string_lossy().as_ref(), &created)
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&dest);
        })
}

#[tauri::command]
fn list_docs(state: State<'_, AppState>) -> Result<Vec<Doc>, String> {
    state.db.list_docs()
}

/// Renomeia só o título exibido. Devolve o Doc no formato de `list_docs`;
/// `original_title` permite restaurar (o frontend reenvia esse valor).
#[tauri::command]
fn rename_doc(state: State<'_, AppState>, doc_id: String, title: String) -> Result<Doc, String> {
    state.db.rename_doc(&doc_id, &title)
}

#[tauri::command]
fn get_doc(state: State<'_, AppState>, doc_id: String) -> Result<Value, String> {
    let doc = state.db.get_doc(&doc_id)?.ok_or("Documento não encontrado.")?;
    let pages = state.db.pages(&doc_id)?;
    Ok(json!({ "doc": doc, "pages": pages }))
}

#[tauri::command]
fn delete_doc(app: AppHandle, state: State<'_, AppState>, doc_id: String) -> Result<(), String> {
    let base = data_dir(&app).ok();
    if let Some(doc) = state.db.get_doc(&doc_id)? {
        // Só apaga o que o próprio app copiou; nunca um caminho arbitrário vindo do banco.
        let inside = base
            .as_ref()
            .is_some_and(|b| files::is_inside(std::path::Path::new(&doc.path), &b.join("uploads")));
        if inside {
            let _ = std::fs::remove_file(&doc.path);
        }
    }
    if let (Some(dir), true) = (base, files::is_safe_id(&doc_id)) {
        let _ = std::fs::remove_dir_all(dir.join("figures").join(&doc_id));
    }
    state.db.delete_doc(&doc_id)
}

#[tauri::command]
fn save_pages(state: State<'_, AppState>, doc_id: String, pages: Vec<Page>) -> Result<(), String> {
    state.db.save_pages(&doc_id, &pages)
}

/// Grava o recorte de uma figura/quadro em <dados>/figures/<doc>/<página>-<n>.png.
#[tauri::command]
fn save_figure(
    app: AppHandle,
    doc_id: String,
    page: i64,
    index: i64,
    data: String,
) -> Result<String, String> {
    if !files::is_safe_id(&doc_id) {
        return Err("Identificador de documento inválido.".into());
    }
    if page < 0 || index < 0 {
        return Err("Página ou índice da figura inválido.".into());
    }
    let raw = data.split_once(',').map(|(_, rest)| rest).unwrap_or(&data);
    if raw.len() > MAX_FIGURE_BYTES * 4 / 3 + 16 {
        return Err("A figura é grande demais.".into());
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("Figura inválida: {e}"))?;
    let dir = data_dir(&app)?.join("figures").join(&doc_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Não foi possível criar a pasta de figuras: {e}"))?;
    let path = dir.join(format!("{page}-{index}.png"));
    std::fs::write(&path, bytes).map_err(|e| format!("Não foi possível gravar a figura: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

// ----------------------------------------------------------- configuração

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Value {
    state.settings_json()
}

#[tauri::command]
fn save_settings(
    state: State<'_, AppState>,
    api_key: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<Value, String> {
    // Valida tudo antes de gravar qualquer coisa: salvar pela metade confunde.
    let key = api_key
        .filter(|k| !k.trim().is_empty())
        .map(|k| net::clean_api_key(&k))
        .transpose()?;
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    if model.as_deref().is_some_and(|m| m.chars().count() > 100 || m.chars().any(char::is_whitespace)) {
        return Err("O nome do modelo é inválido.".into());
    }
    let base_url = base_url
        .filter(|b| !b.trim().is_empty())
        .map(|b| net::validate_base_url(&b))
        .transpose()?;

    if let Some(key) = key {
        match secrets::save_key(&*state.vault, &key) {
            // No cofre e conferido: a cópia em texto puro do SQLite some.
            Ok(()) => state.db.delete_setting(KEY_SETTING)?,
            Err(why) => {
                eprintln!("cofre indisponível, guardando a chave no arquivo: {why}");
                state.db.set_setting(KEY_SETTING, &key)?;
            }
        }
    }
    if let Some(m) = model {
        state.db.set_setting("model", &m)?;
    }
    if let Some(b) = base_url {
        state.db.set_setting("base_url", &b)?;
    }
    Ok(state.settings_json())
}

/// Remove a chave da API do cofre do sistema e do arquivo.
#[tauri::command]
fn clear_api_key(state: State<'_, AppState>) -> Result<Value, String> {
    if let Err(why) = state.vault.delete() {
        eprintln!("cofre: não foi possível remover a chave: {why}");
    }
    state.db.delete_setting(KEY_SETTING)?;
    Ok(state.settings_json())
}

// ---------------------------------------------------------------- rede

enum SendError {
    Cancelled,
    Failed(String),
}

struct Outgoing {
    url: String,
    key: String,
    payload: Vec<u8>,
    /// Quanto esperar pelo início da resposta.
    header_timeout: Duration,
    /// Teto do pedido inteiro, incluindo o corpo (só para respostas sem stream).
    total_timeout: Option<Duration>,
}

fn net_kind(e: &reqwest::Error) -> NetErrorKind {
    if e.is_timeout() {
        NetErrorKind::Timeout
    } else if e.is_connect() {
        NetErrorKind::Connect
    } else if e.is_body() || e.is_decode() {
        NetErrorKind::Body
    } else {
        NetErrorKind::Other
    }
}

fn net_message(e: reqwest::Error) -> String {
    let kind = net_kind(&e);
    net::net_error_message(kind, &e.without_url().to_string())
}

/// Espera `d`, acordando a cada 100 ms para ver o cancelamento. `true` se cancelou.
async fn sleep_or_cancel(d: Duration, cancel: Option<&AtomicBool>) -> bool {
    let deadline = Instant::now() + d;
    loop {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        tokio::time::sleep((deadline - now).min(Duration::from_millis(100))).await;
    }
}

async fn wait_cancelled(cancel: Option<&AtomicBool>) {
    match cancel {
        Some(flag) => {
            while !flag.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

/// POST com nova tentativa em 429/5xx e falha de conexão (backoff exponencial,
/// respeitando Retry-After), cancelável. Erros definitivos voltam já em português.
async fn post_with_retry(
    http: &reqwest::Client,
    out: &Outgoing,
    cancel: Option<&AtomicBool>,
    mut on_retry: impl FnMut(&str),
) -> Result<reqwest::Response, SendError> {
    let mut attempt = 0;
    loop {
        let mut request = http
            .post(&out.url)
            .bearer_auth(&out.key)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(out.payload.clone());
        if let Some(total) = out.total_timeout {
            request = request.timeout(total);
        }
        let sent = tokio::select! {
            r = tokio::time::timeout(out.header_timeout, request.send()) => r,
            _ = wait_cancelled(cancel) => return Err(SendError::Cancelled),
        };
        let (retry_after, reason) = match sent {
            Ok(Ok(resp)) if resp.status().is_success() => return Ok(resp),
            Ok(Ok(resp)) => {
                let status = resp.status().as_u16();
                let retry_after = resp
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                if !net::is_retryable_status(status) || attempt >= net::MAX_RETRIES {
                    let body = resp.text().await.unwrap_or_default();
                    eprintln!("DeepSeek HTTP {status}: {}", ai::truncate_chars(&body, 400));
                    return Err(SendError::Failed(net::friendly_http_error(status, &body)));
                }
                (retry_after, format!("A DeepSeek respondeu {status}"))
            }
            Ok(Err(e)) => {
                if net_kind(&e) != NetErrorKind::Connect || attempt >= net::MAX_RETRIES {
                    return Err(SendError::Failed(net_message(e)));
                }
                (None, "Sem conexão com a DeepSeek".to_string())
            }
            Err(_elapsed) => {
                return Err(SendError::Failed(net::net_error_message(NetErrorKind::Timeout, "")));
            }
        };
        let wait = net::retry_delay(attempt, retry_after.as_deref());
        on_retry(&format!(
            "{reason}. Nova tentativa em {} s ({}/{})…",
            wait.as_secs(),
            attempt + 1,
            net::MAX_RETRIES
        ));
        if sleep_or_cancel(wait, cancel).await {
            return Err(SendError::Cancelled);
        }
        attempt += 1;
    }
}

// ---------------------------------------------------------- fichamento

#[tauri::command]
fn get_columns(state: State<'_, AppState>) -> Result<Vec<Column>, String> {
    state.db.columns()
}

#[tauri::command]
fn save_columns(state: State<'_, AppState>, columns: Vec<Column>) -> Result<Vec<Column>, String> {
    let mut seen = std::collections::HashSet::new();
    let prepared: Vec<Column> = columns
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            // Id vazio ou repetido receberia erro de chave primária no banco.
            let mut id = c.id.trim().to_string();
            if id.is_empty() || !seen.insert(id.clone()) {
                id = short_id();
                seen.insert(id.clone());
            }
            Column {
                id,
                name: if c.name.trim().is_empty() {
                    format!("Coluna {}", i + 1)
                } else {
                    c.name.trim().to_string()
                },
                instruction: c.instruction.trim().to_string(),
                kind: if c.kind.trim().is_empty() { "text".into() } else { c.kind },
            }
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

/// Extrai células do fichamento de UM documento. Seguro para vários documentos
/// em sequência ou em paralelo (o frontend pode chamar 2–3 ao mesmo tempo):
/// - nenhum Mutex do banco é segurado durante rede/`.await`;
/// - no máximo `MAX_CONCURRENT_EXTRACTS` chamadas ao modelo; as outras esperam;
/// - o mesmo documento não extrai duas vezes ao mesmo tempo (erro em pt-BR);
/// - só as colunas pedidas (`column_ids`; todas se `None`) são gravadas: células
///   de outras colunas nunca são tocadas.
///
/// `request_id` (opcional, um por documento) habilita `cancel_chat(request_id)`
/// e eventos no canal `ai`: `{id, type:"status", docId, message}` (nova tentativa)
/// e, após gravar, `{id, type:"cell", docId, columnId, cell}` por coluna pedida.
/// A resposta do modelo vem inteira, então os eventos `cell` saem juntos ao final.
/// Cancelado: nada é gravado e o comando falha com "Operação cancelada.".
#[tauri::command]
async fn extract(
    app: AppHandle,
    state: State<'_, AppState>,
    doc_id: String,
    column_ids: Option<Vec<String>>,
    request_id: Option<String>,
) -> Result<Vec<Cell>, String> {
    let rid = request_id.filter(|r| !r.trim().is_empty());
    let cancel = rid.as_ref().map(|r| state.cancel.token(r));
    let result = run_extract(&app, &state, &doc_id, column_ids, rid.as_deref(), cancel.as_deref()).await;
    if let Some(r) = &rid {
        state.cancel.release(r);
    }
    result
}

const CANCELLED_MSG: &str = "Operação cancelada.";

async fn run_extract(
    app: &AppHandle,
    state: &AppState,
    doc_id: &str,
    column_ids: Option<Vec<String>>,
    rid: Option<&str>,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<Cell>, String> {
    let is_cancelled = || cancel.is_some_and(|c| c.load(Ordering::SeqCst));
    let doc = state.db.get_doc(doc_id)?.ok_or("Documento não encontrado.")?;
    let pages = state.db.pages(doc_id)?;
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
    let cfg = state.ai_config()?;
    let _busy = state
        .busy_docs
        .try_acquire(doc_id)
        .ok_or("Este documento já está sendo extraído. Aguarde terminar.")?;
    // Fila: espera uma vaga, mas sai na hora se cancelarem.
    let _slot = tokio::select! {
        p = state.extract_slots.clone().acquire_owned() => p.map_err(|e| e.to_string())?,
        _ = wait_cancelled(cancel) => return Err(CANCELLED_MSG.into()),
    };
    if is_cancelled() {
        return Err(CANCELLED_MSG.into());
    }
    let ctx = [DocContext {
        label: "D1".to_string(),
        doc: &doc,
        pages: &pages,
    }];
    let context = format!("ID do documento: {}\n{}", doc.id, ai::build_extract_context(&ctx).text);
    let body = ai::extract_body(&cfg.model, &context, &cols);
    let out = Outgoing {
        url: format!("{}/chat/completions", cfg.base_url),
        key: cfg.key,
        payload: serde_json::to_vec(&body).map_err(|e| e.to_string())?,
        header_timeout: EXTRACT_TIMEOUT,
        total_timeout: Some(EXTRACT_TIMEOUT),
    };

    // Duas tentativas: o modelo às vezes devolve JSON quebrado na primeira.
    let mut raw_cells = None;
    let mut last_error = String::new();
    for _ in 0..2 {
        let resp = post_with_retry(&state.http, &out, cancel, |message| {
            if let Some(id) = rid {
                emit_ai(app, json!({"id": id, "type": "status", "docId": doc_id, "message": message}));
            }
        })
        .await
        .map_err(|e| match e {
            SendError::Failed(m) => m,
            SendError::Cancelled => CANCELLED_MSG.to_string(),
        })?;
        let payload: Value = tokio::select! {
            r = resp.json::<Value>() => r.map_err(net_message)?,
            _ = wait_cancelled(cancel) => return Err(CANCELLED_MSG.into()),
        };
        if let Some(msg) = payload["error"]["message"].as_str() {
            return Err(format!("A DeepSeek devolveu um erro: {msg}"));
        }
        let choice = &payload["choices"][0];
        let raw = choice["message"]["content"].as_str().unwrap_or_default();
        let truncated = choice["finish_reason"].as_str() == Some("length");
        eprintln!("extract: resposta de {} caracteres (finish_reason={})", raw.chars().count(), choice["finish_reason"]);
        match ai::parse_cells(raw) {
            Ok(cells) => {
                raw_cells = Some(cells);
                break;
            }
            Err(_) if truncated => {
                return Err("A resposta do modelo foi cortada por tamanho. Extraia menos colunas por vez.".into());
            }
            Err(e) => last_error = e,
        }
    }
    let raw_cells = raw_cells.ok_or(last_error)?;
    if is_cancelled() {
        return Err(CANCELLED_MSG.into());
    }
    // Colunas apagadas durante a espera não ganham células órfãs.
    let current = state.db.columns()?;
    cols.retain(|c| current.iter().any(|x| x.id == c.id));
    if state.db.get_doc(doc_id)?.is_none() {
        return Err("O documento foi removido durante a extração.".into());
    }
    fichamento::apply_cells(&state.db, doc_id, &pages, &cols, raw_cells)?;
    let cells = state.db.cells(Some(doc_id))?;
    if let Some(id) = rid {
        for event in fichamento::cell_events(id, doc_id, &cols, &cells) {
            emit_ai(app, event);
        }
    }
    Ok(cells)
}

#[tauri::command]
fn write_csv(state: State<'_, AppState>, path: String, delimiter: Option<String>) -> Result<(), String> {
    let delim = export::parse_delimiter(delimiter.as_deref())?;
    let csv = export::csv_string(&state.db.list_docs()?, &state.db.columns()?, &state.db.cells(None)?, delim);
    files::write_text_file(&path, &csv)
}

/// Grava um texto UTF-8 (Markdown, TXT ou CSV) no caminho escolhido no diálogo "salvar".
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    files::write_text_file(&path, &contents)
}

// -------------------------------------------------------------- anotações

#[tauri::command]
fn list_annotations(state: State<'_, AppState>, doc_id: String) -> Result<Vec<model::Annotation>, String> {
    state.db.list_annotations(&doc_id)
}

/// Substitui a lista de anotações do documento (o frontend manda a lista inteira).
#[tauri::command]
fn save_annotations(
    state: State<'_, AppState>,
    doc_id: String,
    annotations: Vec<model::Annotation>,
) -> Result<(), String> {
    if state.db.get_doc(&doc_id)?.is_none() {
        return Err("Documento não encontrado.".into());
    }
    model::validate_annotations(&annotations)?;
    state.db.save_annotations(&doc_id, &annotations)
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

const TRUNCATED_NOTICE: &str = "\n\n*(Resposta interrompida pelo limite de tamanho do modelo.)*";

/// Aplica ao texto da resposta o que veio do stream, emitindo cada token.
fn apply_stream_items(
    app: &AppHandle,
    id: &str,
    items: Vec<net::SseItem>,
    answer: &mut String,
    finish_reason: &mut Option<String>,
    error: &mut Option<String>,
) {
    for item in items {
        let net::SseItem::Data(data) = item else { continue };
        let delta = net::parse_stream_payload(&data);
        if let Some(e) = delta.error {
            *error = Some(format!("A DeepSeek interrompeu a resposta: {e}"));
        }
        if let Some(token) = delta.token {
            answer.push_str(&token);
            emit_ai(app, json!({"id": id, "type": "token", "t": token}));
        }
        if delta.finish_reason.is_some() {
            *finish_reason = delta.finish_reason;
        }
    }
}

#[tauri::command]
async fn chat(app: AppHandle, state: State<'_, AppState>, req: ChatRequest) -> Result<(), String> {
    let id = req.request_id.clone();
    let cancel = state.cancel.token(&id);
    // Falhas viram evento "error" (o frontend espera por ele); o comando em si não falha.
    if let Err(message) = run_chat(&app, &state, &req, &cancel).await {
        emit_ai(&app, json!({"id": id, "type": "error", "message": message}));
    }
    state.cancel.release(&id);
    Ok(())
}

async fn run_chat(
    app: &AppHandle,
    state: &AppState,
    req: &ChatRequest,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let id = req.request_id.as_str();
    // O rótulo é a posição na lista que o frontend enviou (D1 = doc_ids[0]), mesmo
    // que algum documento não esteja pronto: o frontend resolve [D2 p.3] por esse índice.
    let mut docs: Vec<(Doc, Vec<Page>)> = Vec::new();
    let mut labels: Vec<String> = Vec::new();
    for (index, doc_id) in req.doc_ids.iter().enumerate() {
        if let Some(doc) = state.db.get_doc(doc_id)? {
            let pages = state.db.pages(doc_id)?;
            if !pages.is_empty() {
                labels.push(format!("D{}", index + 1));
                docs.push((doc, pages));
            }
        }
    }
    if docs.is_empty() || req.history.is_empty() {
        return Err("Nenhum documento pronto para consulta.".into());
    }
    let cfg = state.ai_config()?;

    let ctx: Vec<DocContext> = docs
        .iter()
        .zip(&labels)
        .map(|((doc, pages), label)| DocContext {
            label: label.clone(),
            doc,
            pages,
        })
        .collect();
    let question = req.history.last().map(|m| m.content.as_str()).unwrap_or("");
    let built = ai::build_context(&ctx, question);
    let images = ai::figures_for_question(question, &docs, &labels);
    eprintln!("chat: {} recorte(s) anexado(s); visual={}", images.len(), ai::wants_visual(question));
    let body = ai::chat_body(&cfg.model, &built.text, &req.history, req.selection.as_deref(), &images);
    let out = Outgoing {
        url: format!("{}/chat/completions", cfg.base_url),
        key: cfg.key,
        payload: serde_json::to_vec(&body).map_err(|e| e.to_string())?,
        header_timeout: CHAT_HEADER_TIMEOUT,
        total_timeout: None,
    };

    let sent = post_with_retry(&state.http, &out, Some(cancel), |message| {
        emit_ai(app, json!({"id": id, "type": "status", "message": message}));
    })
    .await;
    let resp = match sent {
        Ok(r) => r,
        Err(SendError::Failed(message)) => return Err(message),
        Err(SendError::Cancelled) => {
            emit_ai(
                app,
                json!({"id": id, "type": "done", "answer": "", "labels": labels,
                       "citations": [], "cancelled": true, "truncated": false}),
            );
            return Ok(());
        }
    };

    let mut stream = resp.bytes_stream();
    let mut parser = net::SseParser::new();
    let mut answer = String::new();
    let mut finish_reason: Option<String> = None;
    let mut stream_error: Option<String> = None;
    let mut cancelled = false;
    let mut last_activity = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        // Acorda a cada 250 ms para ver o cancelamento mesmo com o servidor mudo.
        let next = tokio::time::timeout(Duration::from_millis(250), stream.next()).await;
        let chunk = match next {
            Err(_) => {
                if last_activity.elapsed() > Duration::from_secs(net::STREAM_IDLE_SECS) {
                    stream_error = Some("A DeepSeek parou de responder. Tente de novo.".to_string());
                    break;
                }
                continue;
            }
            Ok(None) => break,
            Ok(Some(chunk)) => chunk,
        };
        last_activity = Instant::now();
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                stream_error = Some(if e.is_timeout() {
                    net_message(e)
                } else {
                    net::net_error_message(NetErrorKind::Body, "")
                });
                break;
            }
        };
        match parser.feed(&bytes) {
            Ok(items) => apply_stream_items(app, id, items, &mut answer, &mut finish_reason, &mut stream_error),
            Err(e) => {
                stream_error = Some(e);
                break;
            }
        }
        if stream_error.is_some() {
            break;
        }
    }
    if !cancelled && stream_error.is_none() {
        let rest = parser.finish();
        apply_stream_items(app, id, rest, &mut answer, &mut finish_reason, &mut stream_error);
    }
    if let Some(e) = stream_error {
        return Err(e);
    }
    if answer.trim().is_empty() && !cancelled {
        // 200 com corpo que não é SSE (ex.: JSON de erro): mostra o que o provedor disse.
        return Err(match net::provider_message(parser.stray()) {
            Some(m) => format!("A DeepSeek respondeu sem texto: {m}"),
            None => "A DeepSeek não devolveu texto. Tente de novo.".to_string(),
        });
    }
    let truncated = finish_reason.as_deref() == Some("length");
    if truncated {
        answer.push_str(TRUNCATED_NOTICE);
        emit_ai(app, json!({"id": id, "type": "token", "t": TRUNCATED_NOTICE}));
    }
    let citations = ai::check_citations(&answer, &built.sent_pages);
    emit_ai(
        app,
        json!({"id": id, "type": "done", "answer": answer, "labels": labels,
               "citations": citations, "cancelled": cancelled, "truncated": truncated}),
    );
    Ok(())
}

#[tauri::command]
fn cancel_chat(state: State<'_, AppState>, request_id: String) {
    state.cancel.cancel(&request_id);
}

// ------------------------------------------------------------------- run

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(dir.join("uploads"))?;
            let db = Db::open(&dir.join("pdfchat.sqlite3"))?;
            let vault = keystore::system_store();

            // Migração automática: a chave que versões antigas guardavam em texto
            // puro no SQLite vai para o Keychain/Credential Manager. Só apaga a
            // cópia antiga depois de conferir a leitura; se o cofre falhar, ela fica.
            match secrets::migrate_legacy(&*vault, db.setting(KEY_SETTING).as_deref()) {
                secrets::Migration::Migrated => {
                    if let Err(e) = db.delete_setting(KEY_SETTING) {
                        eprintln!("cofre: chave migrada, mas a cópia antiga não foi removida: {e}");
                    }
                }
                secrets::Migration::KeptInFile(why) => {
                    eprintln!("cofre: mantendo a chave no arquivo ({why})");
                }
                secrets::Migration::NothingToDo => {}
            }

            let http = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .tcp_keepalive(Some(Duration::from_secs(30)))
                // Conexões ociosas morrem quando o notebook dorme: não reaproveitar por muito tempo.
                .pool_idle_timeout(Duration::from_secs(30))
                .user_agent(concat!("Margem/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| format!("Não foi possível iniciar o cliente de rede: {e}"))?;
            app.manage(AppState {
                db,
                http,
                cancel: CancelRegistry::new(),
                busy_docs: BusyDocs::default(),
                extract_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_EXTRACTS)),
                vault,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_doc,
            list_docs,
            rename_doc,
            get_doc,
            delete_doc,
            save_pages,
            save_figure,
            resolve_evidence,
            get_evidence,
            get_settings,
            save_settings,
            clear_api_key,
            get_columns,
            save_columns,
            get_cells,
            update_cell,
            extract,
            write_csv,
            write_text_file,
            list_annotations,
            save_annotations,
            chat,
            cancel_chat
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Margem");
}
