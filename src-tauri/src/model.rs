use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Doc {
    pub id: String,
    pub name: String,
    pub page_count: i64,
    pub path: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Block {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub size: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Figure {
    pub index: i64,
    pub path: String,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Line {
    pub i: i64,
    pub text: String,
    /// [x0, y0, x1, y1] no espaço do PDF, com origem embaixo à esquerda.
    pub rect: [f64; 4],
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Page {
    pub n: i64,
    pub md: String,
    pub text: String,
    pub blocks: Vec<Block>,
    #[serde(default)]
    pub lines: Vec<Line>,
    #[serde(default)]
    pub figures: Vec<Figure>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Column {
    pub id: String,
    pub name: String,
    pub instruction: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Cell {
    pub doc_id: String,
    pub column_id: String,
    pub value: Option<String>,
    pub quote: Option<String>,
    pub page: Option<i64>,
    pub status: String,
    #[serde(default)]
    pub evidence: Vec<String>,
}

/// Passagem citável: texto de uma ou mais linhas com os retângulos para
/// destacar no PDF. O id é estável dentro do documento.
#[derive(Serialize, Deserialize, Clone)]
pub struct Evidence {
    pub id: String,
    pub doc_id: String,
    pub page: i64,
    pub text: String,
    pub rects: Vec<[f64; 4]>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct ChatRequest {
    pub request_id: String,
    pub doc_ids: Vec<String>,
    pub history: Vec<Msg>,
    pub selection: Option<String>,
}
