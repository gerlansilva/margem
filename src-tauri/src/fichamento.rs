//! Aplica a resposta do modelo ao quadro de fichamento: confere cada citação
//! contra o texto do PDF, resolve o trecho para destaque e grava as células.
//! Sem Tauri, então roda em `cargo test --lib` com SQLite em memória.

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::ai::{self, RawCell};
use crate::db::Db;
use crate::evidence;
use crate::model::{Cell, Column, Page};

pub fn apply_cells(
    db: &Db,
    doc_id: &str,
    pages: &[Page],
    cols: &[Column],
    raw_cells: Vec<RawCell>,
) -> Result<(), String> {
    let mut written: HashSet<String> = HashSet::new();
    for item in raw_cells {
        let Some(column_id) = item.column_id.map(|c| c.trim().to_string()) else { continue };
        if !cols.iter().any(|c| c.id == column_id) {
            continue; // o modelo inventou uma coluna
        }
        let (quote, page) = ai::verify_quote(item.quote, item.page, pages);
        // Valor sem citação verificável não entra: é o que impede "preencher por dedução".
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
                .and_then(|p| evidence::resolve(doc_id, n, q, &p.lines))
                .map(|found| {
                    if let Err(e) = db.save_evidence(&found) {
                        eprintln!("fichamento: evidência não gravada: {e}");
                    }
                    vec![found.id]
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        // Se o modelo repetiu a coluna, a resposta com valor vence a vazia.
        if written.contains(&column_id) && value.is_none() {
            continue;
        }
        db.put_cell(doc_id, &column_id, value.as_deref(), quote.as_deref(), page, status, &evidence_ids)?;
        written.insert(column_id);
    }
    let existing = db.cells(Some(doc_id))?;
    for c in cols {
        if !existing.iter().any(|x| x.column_id == c.id) {
            db.put_cell(doc_id, &c.id, None, None, None, "not_found", &[])?;
        }
    }
    Ok(())
}

/// Eventos `ai` de progresso da extração, um por coluna pedida:
/// `{id: requestId, type: "cell", docId, columnId, cell: Cell}`.
/// Colunas sem célula gravada são omitidas.
pub fn cell_events(request_id: &str, doc_id: &str, cols: &[Column], cells: &[Cell]) -> Vec<Value> {
    cols.iter()
        .filter_map(|c| {
            let cell = cells.iter().find(|x| x.column_id == c.id)?;
            Some(json!({"id": request_id, "type": "cell", "docId": doc_id, "columnId": c.id, "cell": cell}))
        })
        .collect()
}
