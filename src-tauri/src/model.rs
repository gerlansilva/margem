use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Doc {
    pub id: String,
    /// Título exibido (editável por `rename_doc`). O arquivo em disco não muda.
    pub name: String,
    /// Título original, definido na importação; o frontend o envia a `rename_doc`
    /// para "restaurar nome original".
    #[serde(default)]
    pub original_title: String,
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
    /// Título atual do documento (vem do banco; ignorado ao gravar células).
    #[serde(default)]
    pub doc_title: String,
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

/// Âncora para reencontrar o trecho destacado no texto da página.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Anchor {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    #[serde(default)]
    pub offset: i64,
}

/// Destaque colorido com nota. O JSON usa camelCase, igual ao frontend.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub doc_id: String,
    pub page: i64,
    pub color: String,
    pub text: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub anchor: Anchor,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

pub const MAX_TITLE_CHARS: usize = 200;

/// Normaliza o título: controles viram espaço, espaços repetidos/pontas somem.
/// Rejeita vazio e mais de 200 caracteres (contados após normalizar).
pub fn normalize_title(raw: &str) -> Result<String, String> {
    let cleaned: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let title = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err("O título não pode ficar vazio.".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("O título é longo demais (máximo de {MAX_TITLE_CHARS} caracteres)."));
    }
    Ok(title)
}

const MAX_ANNOTATIONS: usize = 20_000;
const MAX_ANNOTATION_TEXT: usize = 100_000;
const ANNOTATION_COLORS: [&str; 5] = ["yellow", "green", "blue", "pink", "orange"];

pub fn validate_annotations(list: &[Annotation]) -> Result<(), String> {
    if list.len() > MAX_ANNOTATIONS {
        return Err("Anotações demais para um documento.".into());
    }
    for a in list {
        if a.id.is_empty() || a.id.len() > 128 || a.id.contains('\0') {
            return Err("Anotação com id inválido.".into());
        }
        if a.page < 1 {
            return Err("Anotação com página inválida.".into());
        }
        if !ANNOTATION_COLORS.contains(&a.color.as_str()) {
            return Err(format!("Cor de anotação inválida: {}.", a.color));
        }
        if a.text.len() > MAX_ANNOTATION_TEXT || a.note.len() > MAX_ANNOTATION_TEXT {
            return Err("Anotação grande demais.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok() -> Annotation {
        Annotation {
            id: "a1".into(),
            doc_id: "d".into(),
            page: 1,
            color: "green".into(),
            text: "t".into(),
            note: String::new(),
            anchor: Anchor::default(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn normaliza_titulo() {
        assert_eq!(normalize_title("  Batanero \t (1999)\n— Educação  ").unwrap(), "Batanero (1999) — Educação");
        assert!(normalize_title("").is_err());
        assert!(normalize_title(" \n\t ").is_err());
        assert!(normalize_title(&"ã".repeat(200)).is_ok());
        assert!(normalize_title(&"ã".repeat(201)).is_err());
        // o limite vale depois de normalizar
        assert!(normalize_title(&format!("  {}  ", "a ".repeat(100).trim())).is_ok());
    }

    #[test]
    fn valida_anotacoes() {
        assert!(validate_annotations(&[ok()]).is_ok());
        let mut a = ok();
        a.id = String::new();
        assert!(validate_annotations(&[a]).is_err());
        let mut a = ok();
        a.page = 0;
        assert!(validate_annotations(&[a]).is_err());
        let mut a = ok();
        a.color = "roxo".into();
        assert!(validate_annotations(&[a]).is_err());
        let mut a = ok();
        a.note = "x".repeat(MAX_ANNOTATION_TEXT + 1);
        assert!(validate_annotations(&[a]).is_err());
    }

    #[test]
    fn json_camel_case_com_campos_opcionais() {
        let a: Annotation = serde_json::from_str(
            r#"{"id":"x","docId":"d","page":2,"color":"blue","text":"oi","anchor":{"text":"oi","offset":3}}"#,
        )
        .unwrap();
        assert_eq!(a.doc_id, "d");
        assert_eq!(a.anchor.offset, 3);
        assert_eq!(a.note, "");
        let v = serde_json::to_value(&a).unwrap();
        assert!(v.get("docId").is_some() && v.get("createdAt").is_some());
    }
}
