use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::model::{Anchor, Annotation, Cell, Column, Doc, Page};

pub struct Db {
    conn: Mutex<Connection>,
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let exists = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !exists {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])
            .map_err(|e| format!("Falha ao migrar o banco de dados ({table}.{column}): {e}"))?;
    }
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| {
            format!("Não foi possível abrir o banco de dados em {}: {e}", path.display())
        })?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        Self::init(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        // Outra instância (ou o antivírus no Windows) pode segurar o arquivo por instantes.
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        // journal_mode devolve uma linha; execute_batch descarta o resultado.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS documents(
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               original_title TEXT NOT NULL DEFAULT '',
               path TEXT NOT NULL,
               page_count INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS pages(
               doc_id TEXT NOT NULL,
               n INTEGER NOT NULL,
               md TEXT NOT NULL,
               text TEXT NOT NULL,
               blocks TEXT NOT NULL,
               lines TEXT NOT NULL DEFAULT '[]',
               figures TEXT NOT NULL DEFAULT '[]',
               PRIMARY KEY(doc_id, n)
             );
             CREATE TABLE IF NOT EXISTS columns(
               id TEXT PRIMARY KEY,
               position INTEGER NOT NULL,
               name TEXT NOT NULL,
               instruction TEXT NOT NULL,
               kind TEXT NOT NULL DEFAULT 'text'
             );
             CREATE TABLE IF NOT EXISTS cells(
               doc_id TEXT NOT NULL,
               column_id TEXT NOT NULL,
               value TEXT,
               quote TEXT,
               page INTEGER,
               evidence TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL DEFAULT 'not_found',
               updated_at TEXT NOT NULL,
               PRIMARY KEY(doc_id, column_id)
             );
             CREATE TABLE IF NOT EXISTS evidence(
               id TEXT PRIMARY KEY,
               doc_id TEXT NOT NULL,
               page INTEGER NOT NULL,
               text TEXT NOT NULL,
               rects TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS evidence_doc_page ON evidence(doc_id, page);
             CREATE TABLE IF NOT EXISTS annotations(
               doc_id TEXT NOT NULL,
               id TEXT NOT NULL,
               page INTEGER NOT NULL,
               color TEXT NOT NULL,
               text TEXT NOT NULL,
               note TEXT NOT NULL DEFAULT '',
               anchor TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL DEFAULT '',
               updated_at TEXT NOT NULL DEFAULT '',
               position INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(doc_id, id)
             );
             CREATE TABLE IF NOT EXISTS settings(
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )
        .map_err(|e| format!("Falha ao preparar o banco de dados: {e}"))?;
        // Bancos criados antes das figuras/linhas/evidências: adiciona a coluna sem
        // quebrar quem já tem (e sem engolir erros que não sejam "coluna já existe").
        ensure_column(&conn, "pages", "figures", "TEXT NOT NULL DEFAULT '[]'")?;
        ensure_column(&conn, "pages", "lines", "TEXT NOT NULL DEFAULT '[]'")?;
        ensure_column(&conn, "cells", "evidence", "TEXT NOT NULL DEFAULT '[]'")?;
        // 0.2.0 -> 0.3: título original (para restaurar após renomear). Bancos antigos
        // recebem o título atual; só preenche o que ainda está vazio, então é idempotente.
        ensure_column(&conn, "documents", "original_title", "TEXT NOT NULL DEFAULT ''")?;
        conn.execute("UPDATE documents SET original_title=name WHERE original_title=''", [])
            .map_err(|e| format!("Falha ao migrar o banco de dados (documents.original_title): {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---------------------------------------------------------- documentos

    pub fn insert_doc(&self, id: &str, name: &str, path: &str, created_at: &str) -> Result<Doc, String> {
        self.lock()
            .execute(
                "INSERT INTO documents(id,name,original_title,path,page_count,created_at) VALUES(?,?,?,?,0,?)",
                params![id, name, name, path, created_at],
            )
            .map_err(|e| e.to_string())?;
        Ok(Doc {
            id: id.to_string(),
            name: name.to_string(),
            original_title: name.to_string(),
            page_count: 0,
            path: path.to_string(),
            created_at: created_at.to_string(),
        })
    }

    pub fn list_docs(&self) -> Result<Vec<Doc>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT id,name,page_count,path,created_at,original_title FROM documents ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Doc {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    page_count: r.get(2)?,
                    path: r.get(3)?,
                    created_at: r.get(4)?,
                    original_title: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_doc(&self, id: &str) -> Result<Option<Doc>, String> {
        self.lock()
            .query_row(
                "SELECT id,name,page_count,path,created_at,original_title FROM documents WHERE id=?",
                params![id],
                |r| {
                    Ok(Doc {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        page_count: r.get(2)?,
                        path: r.get(3)?,
                        created_at: r.get(4)?,
                        original_title: r.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    /// Muda só o título exibido (`documents.name`). Id, caminho, páginas, células,
    /// anotações e evidências são ligados pelo id e não são tocados.
    pub fn rename_doc(&self, id: &str, title: &str) -> Result<Doc, String> {
        let title = crate::model::normalize_title(title)?;
        let changed = self
            .lock()
            .execute("UPDATE documents SET name=? WHERE id=?", params![title, id])
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Documento não encontrado.".into());
        }
        self.get_doc(id)?.ok_or_else(|| "Documento não encontrado.".to_string())
    }

    pub fn delete_doc(&self, id: &str) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM pages WHERE doc_id=?", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM cells WHERE doc_id=?", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM evidence WHERE doc_id=?", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM annotations WHERE doc_id=?", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM documents WHERE id=?", params![id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    // ---------------------------------------------------------- anotações

    pub fn list_annotations(&self, doc_id: &str) -> Result<Vec<Annotation>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id,page,color,text,note,anchor,created_at,updated_at FROM annotations
                 WHERE doc_id=? ORDER BY position, created_at, id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![doc_id], |r| {
                let anchor: String = r.get(5)?;
                Ok(Annotation {
                    id: r.get(0)?,
                    doc_id: doc_id.to_string(),
                    page: r.get(1)?,
                    color: r.get(2)?,
                    text: r.get(3)?,
                    note: r.get(4)?,
                    anchor: serde_json::from_str::<Anchor>(&anchor).unwrap_or_default(),
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Substitui, numa transação, toda a lista de anotações do documento.
    /// O `doc_id` do argumento manda: o campo `docId` de cada item é ignorado.
    pub fn save_annotations(&self, doc_id: &str, list: &[Annotation]) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM annotations WHERE doc_id=?", params![doc_id])
            .map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO annotations(doc_id,id,page,color,text,note,anchor,created_at,updated_at,position)
                     VALUES(?,?,?,?,?,?,?,?,?,?)",
                )
                .map_err(|e| e.to_string())?;
            for (i, a) in list.iter().enumerate() {
                let anchor = serde_json::to_string(&a.anchor).map_err(|e| e.to_string())?;
                stmt.execute(params![
                    doc_id, a.id, a.page, a.color, a.text, a.note, anchor, a.created_at, a.updated_at, i as i64
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn save_pages(&self, doc_id: &str, pages: &[Page]) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM pages WHERE doc_id=?", params![doc_id])
            .map_err(|e| e.to_string())?;
        // Os retângulos das evidências pertencem à extração anterior.
        tx.execute("DELETE FROM evidence WHERE doc_id=?", params![doc_id])
            .map_err(|e| e.to_string())?;
        tx.execute("UPDATE cells SET evidence='[]' WHERE doc_id=?", params![doc_id])
            .map_err(|e| e.to_string())?;
        for p in pages {
            let blocks = serde_json::to_string(&p.blocks).map_err(|e| e.to_string())?;
            let lines = serde_json::to_string(&p.lines).map_err(|e| e.to_string())?;
            let figures = serde_json::to_string(&p.figures).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO pages(doc_id,n,md,text,blocks,lines,figures) VALUES(?,?,?,?,?,?,?)",
                params![doc_id, p.n, p.md, p.text, blocks, lines, figures],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "UPDATE documents SET page_count=? WHERE id=?",
            params![pages.len() as i64, doc_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn pages(&self, doc_id: &str) -> Result<Vec<Page>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT n,md,text,blocks,lines,figures FROM pages WHERE doc_id=? ORDER BY n")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![doc_id], |r| {
                let blocks: String = r.get(3)?;
                let lines: String = r.get(4)?;
                let figures: String = r.get(5)?;
                Ok(Page {
                    n: r.get(0)?,
                    md: r.get(1)?,
                    text: r.get(2)?,
                    blocks: serde_json::from_str(&blocks).unwrap_or_default(),
                    lines: serde_json::from_str(&lines).unwrap_or_default(),
                    figures: serde_json::from_str(&figures).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // -------------------------------------------------------------- colunas

    pub fn columns(&self) -> Result<Vec<Column>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT id,name,instruction,kind FROM columns ORDER BY position")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Column {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    instruction: r.get(2)?,
                    kind: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn replace_columns(&self, cols: &[Column]) -> Result<Vec<Column>, String> {
        {
            let mut conn = self.lock();
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM columns", []).map_err(|e| e.to_string())?;
            for (i, c) in cols.iter().enumerate() {
                tx.execute(
                    "INSERT INTO columns(id,position,name,instruction,kind) VALUES(?,?,?,?,?)",
                    params![c.id, i as i64, c.name, c.instruction, c.kind],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        } // solta o cofre da conexão antes de `columns()` travar de novo (Mutex não é reentrante)
        self.columns()
    }

    // -------------------------------------------------------------- células

    pub fn cells(&self, doc_id: Option<&str>) -> Result<Vec<Cell>, String> {
        let conn = self.lock();
        let map = |r: &rusqlite::Row| {
            let evidence: String = r.get(6)?;
            Ok(Cell {
                doc_title: r.get(7)?,
                doc_id: r.get(0)?,
                column_id: r.get(1)?,
                value: r.get(2)?,
                quote: r.get(3)?,
                page: r.get(4)?,
                status: r.get(5)?,
                evidence: serde_json::from_str(&evidence).unwrap_or_default(),
            })
        };
        let out = match doc_id {
            Some(id) => {
                let mut stmt = conn
                    .prepare("SELECT c.doc_id,c.column_id,c.value,c.quote,c.page,c.status,c.evidence,COALESCE(d.name,'') FROM cells c LEFT JOIN documents d ON d.id=c.doc_id WHERE c.doc_id=?")
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map(params![id], map).map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            }
            None => {
                let mut stmt = conn
                    .prepare("SELECT c.doc_id,c.column_id,c.value,c.quote,c.page,c.status,c.evidence,COALESCE(d.name,'') FROM cells c LEFT JOIN documents d ON d.id=c.doc_id")
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map([], map).map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            }
        };
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn put_cell(
        &self,
        doc_id: &str,
        column_id: &str,
        value: Option<&str>,
        quote: Option<&str>,
        page: Option<i64>,
        status: &str,
        evidence: &[String],
    ) -> Result<(), String> {
        let ids = serde_json::to_string(evidence).map_err(|e| e.to_string())?;
        self.lock()
            .execute(
                "INSERT INTO cells(doc_id,column_id,value,quote,page,evidence,status,updated_at)
                 VALUES(?,?,?,?,?,?,?,datetime('now'))
                 ON CONFLICT(doc_id,column_id) DO UPDATE SET
                   value=excluded.value, quote=excluded.quote, page=excluded.page,
                   evidence=excluded.evidence, status=excluded.status,
                   updated_at=excluded.updated_at",
                params![doc_id, column_id, value, quote, page, ids, status],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_evidence(&self, e: &crate::model::Evidence) -> Result<(), String> {
        let rects = serde_json::to_string(&e.rects).map_err(|err| err.to_string())?;
        self.lock()
            .execute(
                "INSERT INTO evidence(id,doc_id,page,text,rects,created_at)
                 VALUES(?,?,?,?,?,datetime('now'))
                 ON CONFLICT(id) DO UPDATE SET text=excluded.text, rects=excluded.rects",
                params![e.id, e.doc_id, e.page, e.text, rects],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn get_evidence(&self, id: &str) -> Result<Option<crate::model::Evidence>, String> {
        self.lock()
            .query_row(
                "SELECT id,doc_id,page,text,rects FROM evidence WHERE id=?",
                params![id],
                |r| {
                    let rects: String = r.get(4)?;
                    Ok(crate::model::Evidence {
                        id: r.get(0)?,
                        doc_id: r.get(1)?,
                        page: r.get(2)?,
                        text: r.get(3)?,
                        rects: serde_json::from_str(&rects).unwrap_or_default(),
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    // ----------------------------------------------------------- configuração

    pub fn setting(&self, key: &str) -> Option<String> {
        self.lock()
            .query_row("SELECT value FROM settings WHERE key=?", params![key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), String> {
        self.lock()
            .execute("DELETE FROM settings WHERE key=?", params![key])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "INSERT INTO settings(key,value) VALUES(?,?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Block, Evidence, Figure, Line};

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn page(n: i64, text: &str) -> Page {
        Page {
            n,
            md: format!("## Página {n}\n\n{text}"),
            text: text.to_string(),
            blocks: vec![Block { text: text.into(), x: 72.0, y: 700.0, w: 400.0, h: 12.0, size: 11.0 }],
            lines: vec![Line { i: 0, text: text.into(), rect: [72.0, 700.0, 472.0, 712.0] }],
            figures: vec![Figure { index: 0, path: "C:\\Users\\João\\fig.png".into(), w: 1.0, h: 2.0 }],
        }
    }

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("margem-db-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("pdfchat.sqlite3")
    }

    fn ann(id: &str, page: i64, text: &str) -> Annotation {
        Annotation {
            id: id.into(),
            doc_id: "d1".into(),
            page,
            color: "yellow".into(),
            text: text.into(),
            note: "nota com ação".into(),
            anchor: Anchor { text: text.into(), prefix: "antes ".into(), suffix: " depois".into(), offset: 42 },
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-02T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn anotacoes_ida_e_volta_substituem_e_mantem_ordem() {
        let db = db();
        assert!(db.list_annotations("d1").unwrap().is_empty());
        let lista = vec![ann("b", 3, "segundo trecho — ç"), ann("a", 1, "primeiro")];
        db.save_annotations("d1", &lista).unwrap();
        assert_eq!(db.list_annotations("d1").unwrap(), lista);
        db.save_annotations("d1", &lista[..1]).unwrap();
        assert_eq!(db.list_annotations("d1").unwrap().len(), 1);
        db.save_annotations("d1", &[]).unwrap();
        assert!(db.list_annotations("d1").unwrap().is_empty());
    }

    #[test]
    fn anotacoes_sao_isoladas_por_documento_e_apagadas_com_ele() {
        let db = db();
        db.insert_doc("d1", "A", "/a.pdf", "2026-01-01T00:00:00Z").unwrap();
        db.insert_doc("d2", "B", "/b.pdf", "2026-01-01T00:00:00Z").unwrap();
        db.save_annotations("d1", &[ann("x", 1, "um")]).unwrap();
        // mesmo id em outro documento não colide
        db.save_annotations("d2", &[ann("x", 2, "dois")]).unwrap();
        assert_eq!(db.list_annotations("d1").unwrap()[0].text, "um");
        assert_eq!(db.list_annotations("d2").unwrap()[0].doc_id, "d2");
        db.delete_doc("d1").unwrap();
        assert!(db.list_annotations("d1").unwrap().is_empty());
        assert_eq!(db.list_annotations("d2").unwrap().len(), 1);
    }

    #[test]
    fn banco_antigo_sem_tabela_de_anotacoes_e_migrado() {
        let path = tmp_path("ann-migra");
        {
            // banco da versão 0.1: só as tabelas antigas, com dados
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
                   page_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
                 INSERT INTO documents VALUES('d1','Velho','/v.pdf',3,'2025-01-01T00:00:00Z');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(db.list_docs().unwrap().len(), 1);
        db.save_annotations("d1", &[ann("a", 1, "novo")]).unwrap();
        drop(db);
        let db = Db::open(&path).unwrap(); // reabrir não perde nada
        assert_eq!(db.list_annotations("d1").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn documento_ida_e_volta_com_acentos() {
        let db = db();
        let d = db.insert_doc("d1", "Educação Estatística — Batanero (1999)", "/x/y.pdf", "2026-01-01T00:00:00Z").unwrap();
        assert_eq!(d.page_count, 0);
        assert_eq!(db.list_docs().unwrap().len(), 1);
        assert_eq!(db.get_doc("d1").unwrap().unwrap().name, "Educação Estatística — Batanero (1999)");
        assert!(db.get_doc("nao-existe").unwrap().is_none());
        // id repetido: erro, não pânico
        assert!(db.insert_doc("d1", "x", "p", "t").is_err());
    }

    #[test]
    fn paginas_preservam_linhas_figuras_e_caminho_windows() {
        let db = db();
        db.insert_doc("d1", "a", "p", "t").unwrap();
        db.save_pages("d1", &[page(1, "ação"), page(2, "segunda")]).unwrap();
        let pages = db.pages("d1").unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].lines[0].text, "ação");
        assert_eq!(pages[0].figures[0].path, "C:\\Users\\João\\fig.png");
        assert_eq!(db.get_doc("d1").unwrap().unwrap().page_count, 2);
    }

    #[test]
    fn salvar_paginas_de_novo_substitui_e_limpa_evidencias() {
        let db = db();
        db.insert_doc("d1", "a", "p", "t").unwrap();
        db.save_pages("d1", &[page(1, "um")]).unwrap();
        let ev = Evidence { id: "d1:1:0-0".into(), doc_id: "d1".into(), page: 1, text: "um".into(), rects: vec![[0.0, 0.0, 1.0, 1.0]] };
        db.save_evidence(&ev).unwrap();
        db.put_cell("d1", "c1", Some("v"), Some("q q q"), Some(1), "filled", std::slice::from_ref(&ev.id)).unwrap();
        db.save_pages("d1", &[page(1, "novo"), page(2, "dois")]).unwrap();
        assert_eq!(db.pages("d1").unwrap().len(), 2);
        assert!(db.get_evidence("d1:1:0-0").unwrap().is_none());
        assert!(db.cells(Some("d1")).unwrap()[0].evidence.is_empty());
    }

    #[test]
    fn paginas_duplicadas_do_frontend_nao_derrubam_a_gravacao() {
        let db = db();
        db.insert_doc("d1", "a", "p", "t").unwrap();
        db.save_pages("d1", &[page(1, "a"), page(1, "b")]).unwrap();
        assert_eq!(db.pages("d1").unwrap().len(), 1);
    }

    #[test]
    fn excluir_documento_apaga_tudo_dele_e_so_dele() {
        let db = db();
        for id in ["d1", "d2"] {
            db.insert_doc(id, id, "p", "t").unwrap();
            db.save_pages(id, &[page(1, "x")]).unwrap();
            db.put_cell(id, "c1", Some("v"), None, None, "filled", &[]).unwrap();
            db.save_evidence(&Evidence { id: format!("{id}:1:0-0"), doc_id: id.into(), page: 1, text: "x".into(), rects: vec![] }).unwrap();
        }
        db.delete_doc("d1").unwrap();
        assert!(db.get_doc("d1").unwrap().is_none());
        assert!(db.pages("d1").unwrap().is_empty());
        assert!(db.cells(Some("d1")).unwrap().is_empty());
        assert!(db.get_evidence("d1:1:0-0").unwrap().is_none());
        assert_eq!(db.cells(None).unwrap().len(), 1);
        assert!(db.get_evidence("d2:1:0-0").unwrap().is_some());
        db.delete_doc("nao-existe").unwrap();
    }

    #[test]
    fn colunas_substituem_e_mantem_ordem() {
        let db = db();
        let col = |id: &str, n: &str| Column { id: id.into(), name: n.into(), instruction: "i".into(), kind: "text".into() };
        db.replace_columns(&[col("b", "Segunda"), col("a", "Primeira")]).unwrap();
        let got = db.columns().unwrap();
        assert_eq!(got.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        db.replace_columns(&[col("z", "Só")]).unwrap();
        assert_eq!(db.columns().unwrap().len(), 1);
        // id duplicado: erro, e a lista anterior continua valendo (transação)
        assert!(db.replace_columns(&[col("x", "1"), col("x", "2")]).is_err());
        assert_eq!(db.columns().unwrap()[0].id, "z");
    }

    #[test]
    fn celulas_upsert_e_filtro_por_documento() {
        let db = db();
        db.put_cell("d1", "c1", Some("120"), Some("120 participantes"), Some(7), "filled", &["e1".into()]).unwrap();
        db.put_cell("d1", "c1", Some("130"), None, None, "edited", &[]).unwrap();
        db.put_cell("d2", "c1", None, None, None, "not_found", &[]).unwrap();
        let d1 = db.cells(Some("d1")).unwrap();
        assert_eq!(d1.len(), 1);
        assert_eq!(d1[0].value.as_deref(), Some("130"));
        assert_eq!(d1[0].status, "edited");
        assert!(d1[0].quote.is_none() && d1[0].evidence.is_empty());
        assert_eq!(db.cells(None).unwrap().len(), 2);
    }

    #[test]
    fn evidencia_upsert_mantem_id_estavel() {
        let db = db();
        let mut ev = Evidence { id: "d1:2:3-4".into(), doc_id: "d1".into(), page: 2, text: "antes".into(), rects: vec![[1.0, 2.0, 3.0, 4.0]] };
        db.save_evidence(&ev).unwrap();
        ev.text = "depois".into();
        ev.rects.push([5.0, 6.0, 7.0, 8.0]);
        db.save_evidence(&ev).unwrap();
        let got = db.get_evidence("d1:2:3-4").unwrap().unwrap();
        assert_eq!(got.text, "depois");
        assert_eq!(got.rects.len(), 2);
    }

    #[test]
    fn configuracoes_e_remocao() {
        let db = db();
        assert_eq!(db.setting("model"), None);
        db.set_setting("model", "deepseek-flash").unwrap();
        db.set_setting("model", "outro").unwrap();
        assert_eq!(db.setting("model").as_deref(), Some("outro"));
        db.delete_setting("model").unwrap();
        assert_eq!(db.setting("model"), None);
        db.delete_setting("model").unwrap();
    }

    #[test]
    fn json_corrompido_no_banco_vira_vazio_sem_panico() {
        let db = db();
        db.insert_doc("d1", "a", "p", "t").unwrap();
        db.lock()
            .execute(
                "INSERT INTO pages(doc_id,n,md,text,blocks,lines,figures) VALUES('d1',1,'m','t','{quebrado','nao json','[[')",
                [],
            )
            .unwrap();
        let pages = db.pages("d1").unwrap();
        assert_eq!(pages.len(), 1);
        assert!(pages[0].blocks.is_empty() && pages[0].lines.is_empty() && pages[0].figures.is_empty());
    }

    #[test]
    fn banco_em_arquivo_persiste_e_reabre() {
        let path = tmp_path("reabre");
        {
            let db = Db::open(&path).unwrap();
            db.insert_doc("d1", "Tese — Celi & Batanero", "/x.pdf", "2026-01-01T00:00:00Z").unwrap();
            db.set_setting("base_url", "https://api.deepseek.com").unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(db.list_docs().unwrap()[0].name, "Tese — Celi & Batanero");
        assert_eq!(db.setting("base_url").as_deref(), Some("https://api.deepseek.com"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn caminho_com_espacos_e_acentos_abre() {
        let base = tmp_path("acentos");
        let dir = base.parent().unwrap().join("Gerlan Silva — pesquisa");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("pdfchat.sqlite3")).unwrap();
        db.set_setting("k", "v").unwrap();
        drop(db);
        let _ = std::fs::remove_dir_all(base.parent().unwrap());
    }

    #[test]
    fn abrir_em_pasta_inexistente_da_erro_claro() {
        let path = std::env::temp_dir().join("margem-nao-existe-xyz").join("sub").join("a.sqlite3");
        let err = Db::open(&path).err().expect("deveria falhar");
        assert!(err.contains("Não foi possível abrir o banco de dados"), "{err}");
    }

    #[test]
    fn migra_banco_antigo_sem_colunas_novas() {
        let path = tmp_path("migra");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
                 CREATE TABLE pages(doc_id TEXT NOT NULL, n INTEGER NOT NULL, md TEXT NOT NULL, text TEXT NOT NULL, blocks TEXT NOT NULL, PRIMARY KEY(doc_id, n));
                 CREATE TABLE cells(doc_id TEXT NOT NULL, column_id TEXT NOT NULL, value TEXT, quote TEXT, page INTEGER, status TEXT NOT NULL DEFAULT 'not_found', updated_at TEXT NOT NULL, PRIMARY KEY(doc_id, column_id));
                 INSERT INTO documents VALUES('d1','Antigo','/a.pdf',1,'2025-01-01');
                 INSERT INTO pages VALUES('d1',1,'md','texto','[]');
                 INSERT INTO cells VALUES('d1','c1','v','q',1,'filled','2025-01-01');
                 CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO settings VALUES('api_key','sk-antiga');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let pages = db.pages("d1").unwrap();
        assert_eq!(pages[0].text, "texto");
        assert!(pages[0].lines.is_empty() && pages[0].figures.is_empty());
        assert!(db.cells(Some("d1")).unwrap()[0].evidence.is_empty());
        assert_eq!(db.setting("api_key").as_deref(), Some("sk-antiga"));
        // abrir de novo não tenta recriar as colunas
        drop(db);
        Db::open(&path).unwrap();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn migra_banco_020_sem_original_title_preenchendo_com_o_titulo_atual() {
        let path = tmp_path("orig-title");
        {
            // esquema da 0.2.0: documents sem original_title, com um título já em uso
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
                 INSERT INTO documents VALUES('d1','Título 0.2.0 — ç','/a.pdf',1,'2025-01-01');
                 INSERT INTO documents VALUES('d2','Outro','/b.pdf',0,'2025-01-02');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let d1 = db.get_doc("d1").unwrap().unwrap();
        assert_eq!((d1.name.as_str(), d1.original_title.as_str()), ("Título 0.2.0 — ç", "Título 0.2.0 — ç"));
        db.rename_doc("d1", "Renomeado").unwrap();
        drop(db);
        // reabrir não refaz o preenchimento por cima do título original já gravado
        let db = Db::open(&path).unwrap();
        let d1 = db.get_doc("d1").unwrap().unwrap();
        assert_eq!((d1.name.as_str(), d1.original_title.as_str()), ("Renomeado", "Título 0.2.0 — ç"));
        assert_eq!(db.list_docs().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn insert_doc_guarda_o_titulo_original() {
        let db = db();
        let d = db.insert_doc("d1", "Original", "/a.pdf", "t").unwrap();
        assert_eq!(d.original_title, "Original");
        db.rename_doc("d1", "Outro").unwrap();
        let got = db.list_docs().unwrap();
        assert_eq!((got[0].name.as_str(), got[0].original_title.as_str()), ("Outro", "Original"));
    }

    #[test]
    fn acesso_concorrente_nao_corrompe() {
        let db = std::sync::Arc::new(db());
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let db = db.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        db.put_cell(&format!("d{t}"), &format!("c{i}"), Some("v"), None, None, "filled", &[]).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(db.cells(None).unwrap().len(), 200);
    }
}
