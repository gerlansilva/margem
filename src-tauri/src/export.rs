//! Exportação do fichamento em CSV (sem Tauri).

use std::borrow::Cow;

use crate::model::{Cell, Column, Doc};

/// Neutraliza injeção de fórmula ao abrir no Excel/Planilhas: valores que
/// começam com `=`, `@`, tab, CR, ou `+`/`-` que não sejam número ganham um apóstrofo.
fn guard_formula(value: &str) -> Cow<'_, str> {
    let mut chars = value.chars();
    let risky = match chars.next() {
        Some('=') | Some('@') | Some('\t') | Some('\r') => true,
        Some('+') | Some('-') => {
            let second = chars.next();
            let numeric = value.replace(',', ".").trim().parse::<f64>().is_ok();
            !(numeric || second.is_none() || second.is_some_and(char::is_whitespace))
        }
        _ => false,
    };
    if risky {
        Cow::Owned(format!("'{value}"))
    } else {
        Cow::Borrowed(value)
    }
}

/// Delimitador aceito: vírgula (padrão) ou ponto e vírgula (Excel em pt-BR).
pub fn parse_delimiter(value: Option<&str>) -> Result<char, String> {
    match value {
        None | Some("") | Some(",") => Ok(','),
        Some(";") => Ok(';'),
        Some(other) => Err(format!("Delimitador inválido: {other:?} (use \",\" ou \";\").")),
    }
}

#[cfg(test)]
pub fn csv_escape(value: &str) -> String {
    csv_escape_with(value, ',')
}

pub fn csv_escape_with(value: &str, delim: char) -> String {
    let value = guard_formula(value);
    if value.contains([delim, '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.into_owned()
    }
}

/// CSV em UTF-8 com BOM: sem ele o Excel do Windows lê "ção" como "Ã§Ã£o".
pub fn csv_string(docs: &[Doc], cols: &[Column], cells: &[Cell], delim: char) -> String {
    let esc = |v: &str| csv_escape_with(v, delim);
    let mut out = String::from("\u{feff}Documento");
    for c in cols {
        out.push(delim);
        out.push_str(&esc(&c.name));
    }
    out.push(delim);
    out.push_str("Trechos\n");
    for d in docs {
        out.push_str(&esc(&d.name));
        let mut quotes = Vec::new();
        for c in cols {
            out.push(delim);
            if let Some(cell) = cells.iter().find(|x| x.doc_id == d.id && x.column_id == c.id) {
                out.push_str(&esc(cell.value.as_deref().unwrap_or("")));
                if let (Some(q), Some(p)) = (&cell.quote, cell.page) {
                    quotes.push(format!("[p.{p}] {q}"));
                }
            }
        }
        out.push(delim);
        out.push_str(&esc(&quotes.join(" | ")));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, name: &str) -> Doc {
        Doc { id: id.into(), name: name.into(), original_title: name.into(), page_count: 1, path: "".into(), created_at: "".into() }
    }
    fn col(id: &str, name: &str) -> Column {
        Column { id: id.into(), name: name.into(), instruction: "".into(), kind: "text".into() }
    }
    fn cell(d: &str, c: &str, v: Option<&str>, q: Option<&str>, p: Option<i64>) -> Cell {
        Cell {
            doc_id: d.into(),
            doc_title: String::new(),
            column_id: c.into(),
            value: v.map(Into::into),
            quote: q.map(Into::into),
            page: p,
            status: "filled".into(),
            evidence: vec![],
        }
    }

    #[test]
    fn escapa_virgula_aspas_e_quebra_de_linha() {
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("diz \"oi\""), "\"diz \"\"oi\"\"\"");
        assert_eq!(csv_escape("l1\nl2"), "\"l1\nl2\"");
        assert_eq!(csv_escape("l1\r\nl2"), "\"l1\r\nl2\"");
        assert_eq!(csv_escape("simples"), "simples");
    }

    #[test]
    fn bloqueia_injecao_de_formula_mas_preserva_numeros() {
        assert_eq!(csv_escape("=SOMA(A1)"), "'=SOMA(A1)");
        assert_eq!(csv_escape("@cmd"), "'@cmd");
        assert_eq!(csv_escape("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
        assert_eq!(csv_escape("-2,4"), "\"-2,4\""); // número negativo intacto (só entre aspas pela vírgula)
        assert_eq!(csv_escape("-3.5"), "-3.5");
        assert_eq!(csv_escape("- item"), "- item");
        assert_eq!(csv_escape("-"), "-");
        assert_eq!(csv_escape("-1+2"), "'-1+2");
    }

    #[test]
    fn delimitador_ponto_e_virgula() {
        assert_eq!(parse_delimiter(None), Ok(','));
        assert_eq!(parse_delimiter(Some(",")), Ok(','));
        assert_eq!(parse_delimiter(Some(";")), Ok(';'));
        assert!(parse_delimiter(Some("\t")).is_err());
        assert!(parse_delimiter(Some(";;")).is_err());
        // com ';' a vírgula deixa de exigir aspas, e o ';' passa a exigir
        assert_eq!(csv_escape_with("a,b", ';'), "a,b");
        assert_eq!(csv_escape_with("a;b", ';'), "\"a;b\"");
        assert_eq!(csv_escape_with("a;b", ','), "a;b");
        let docs = vec![doc("d1", "Análise; 2024")];
        let cols = vec![col("c1", "Amostra")];
        let cells = vec![cell("d1", "c1", Some("1,5 mil"), Some("trecho"), Some(2))];
        let csv = csv_string(&docs, &cols, &cells, ';');
        assert!(csv.starts_with('\u{feff}'));
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "\u{feff}Documento;Amostra;Trechos");
        assert_eq!(lines[1], "\"Análise; 2024\";1,5 mil;[p.2] trecho");
    }

    #[test]
    fn csv_completo_com_bom_e_acentos() {
        let docs = vec![doc("d1", "Análise, 2024")];
        let cols = vec![col("c1", "Amostra"), col("c2", "Método")];
        let cells = vec![
            cell("d1", "c1", Some("120 participantes"), Some("A amostra teve 120 participantes."), Some(7)),
            cell("d1", "c2", None, None, None),
        ];
        let csv = csv_string(&docs, &cols, &cells, ',');
        assert!(csv.starts_with('\u{feff}'));
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "\u{feff}Documento,Amostra,Método,Trechos");
        assert_eq!(
            lines[1],
            "\"Análise, 2024\",120 participantes,,[p.7] A amostra teve 120 participantes."
        );
    }
}
