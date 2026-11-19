use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::model::{Cell, Column, Doc, Page};

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS documents(
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
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
             CREATE TABLE IF NOT EXISTS settings(
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )
        .map_err(|e| e.to_string())?;
        // Bancos criados antes das figuras: adiciona a coluna sem quebrar quem já tem.
        let _ = conn.execute(
            "ALTER TABLE pages ADD COLUMN figures TEXT NOT NULL DEFAULT '[]'",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE pages ADD COLUMN lines TEXT NOT NULL DEFAULT '[]'",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE cells ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]'",
            [],
        );
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
                "INSERT INTO documents(id,name,path,page_count,created_at) VALUES(?,?,?,0,?)",
                params![id, name, path, created_at],
            )
            .map_err(|e| e.to_string())?;
        Ok(Doc {
            id: id.to_string(),
            name: name.to_string(),
            page_count: 0,
            path: path.to_string(),
            created_at: created_at.to_string(),
        })
    }

    pub fn list_docs(&self) -> Result<Vec<Doc>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT id,name,page_count,path,created_at FROM documents ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Doc {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    page_count: r.get(2)?,
                    path: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_doc(&self, id: &str) -> Result<Option<Doc>, String> {
        self.lock()
            .query_row(
                "SELECT id,name,page_count,path,created_at FROM documents WHERE id=?",
                params![id],
                |r| {
                    Ok(Doc {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        page_count: r.get(2)?,
                        path: r.get(3)?,
                        created_at: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
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
        tx.execute("DELETE FROM documents WHERE id=?", params![id])
            .map_err(|e| e.to_string())?;
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
                "INSERT INTO pages(doc_id,n,md,text,blocks,lines,figures) VALUES(?,?,?,?,?,?,?)",
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
        self.columns()
    }

    // -------------------------------------------------------------- células

    pub fn cells(&self, doc_id: Option<&str>) -> Result<Vec<Cell>, String> {
        let conn = self.lock();
        let map = |r: &rusqlite::Row| {
            let evidence: String = r.get(6)?;
            Ok(Cell {
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
                    .prepare("SELECT doc_id,column_id,value,quote,page,status,evidence FROM cells WHERE doc_id=?")
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map(params![id], map).map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            }
            None => {
                let mut stmt = conn
                    .prepare("SELECT doc_id,column_id,value,quote,page,status,evidence FROM cells")
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map([], map).map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            }
        };
        Ok(out)
    }

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
