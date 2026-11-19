//! Utilitários de arquivo sem Tauri: ids seguros para montar caminhos, checagem
//! de PDF e de contenção em pasta. Sempre `Path`/`PathBuf`, nunca "/" ou "\\" digitados.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Id que pode virar nome de pasta/arquivo sem escapar do diretório (`..`, `/`, `\`, `:`).
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// O arquivo começa como PDF? O cabeçalho `%PDF-` pode vir após alguns bytes de lixo (até 1 KB).
pub fn looks_like_pdf(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut buf = [0u8; 1024];
    let n = file.read(&mut buf).unwrap_or(0);
    buf[..n].windows(5).any(|w| w == b"%PDF-")
}

/// Resolve `.` e `..` sem tocar no disco (o arquivo pode não existir mais).
fn lexical_clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `child` está dentro de `parent`? Compara por componentes, então funciona com
/// `\` no Windows e não confunde `/dados/up` com `/dados/uploads`.
pub fn is_inside(child: &Path, parent: &Path) -> bool {
    lexical_clean(child).starts_with(lexical_clean(parent))
}

/// Nome de arquivo exibível a partir do caminho escolhido pelo usuário.
pub fn display_name(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Documento")
        .to_string()
}

pub fn has_pdf_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// Extensões que o app grava a pedido do usuário (exportações).
const EXPORT_EXTENSIONS: [&str; 3] = ["md", "txt", "csv"];
/// Teto para o conteúdo de uma exportação de texto.
pub const MAX_EXPORT_BYTES: usize = 50 * 1024 * 1024;

/// Valida o caminho vindo do diálogo "salvar": absoluto, sem NUL, extensão
/// .md/.txt/.csv e pasta de destino existente.
pub fn validate_export_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Escolha onde salvar o arquivo.".into());
    }
    if path.contains('\0') {
        return Err("Caminho inválido.".into());
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("O caminho do arquivo precisa ser absoluto.".into());
    }
    let ext_ok = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXPORT_EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)));
    if !ext_ok {
        return Err("Só é possível salvar arquivos .md, .txt ou .csv.".into());
    }
    if p.file_name().is_none() || p.is_dir() {
        return Err("O caminho escolhido é uma pasta.".into());
    }
    match p.parent() {
        Some(dir) if dir.is_dir() => Ok(p),
        _ => Err("A pasta de destino não existe.".into()),
    }
}

/// Grava `contents` (UTF-8) em `path` validado. Escreve num temporário ao lado
/// e renomeia, para não deixar um arquivo pela metade se algo falhar.
pub fn write_text_file(path: &str, contents: &str) -> Result<(), String> {
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("O conteúdo é grande demais para exportar.".into());
    }
    let dest = validate_export_path(path)?;
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dest.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents.as_bytes()).map_err(|e| format!("Não foi possível salvar o arquivo: {e}"))?;
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Não foi possível salvar o arquivo: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("margem-files-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ids_seguros() {
        assert!(is_safe_id("a1b2c3d4e5f6"));
        assert!(is_safe_id("doc-1_x"));
        for ruim in ["", "..", "../x", "a/b", "a\\b", "C:\\x", "a b", "ação", "x\0y", &"a".repeat(65)] {
            assert!(!is_safe_id(ruim), "{ruim:?}");
        }
    }

    #[test]
    fn detecta_pdf_pelo_cabecalho() {
        let dir = tmp("pdf");
        let ok = dir.join("a.pdf");
        std::fs::write(&ok, b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj").unwrap();
        let com_lixo = dir.join("b.pdf");
        std::fs::write(&com_lixo, [b"\xef\xbb\xbf\r\n".as_slice(), b"%PDF-1.4 resto"].concat()).unwrap();
        let html = dir.join("c.pdf");
        std::fs::write(&html, b"<html><body>erro 404</body></html>").unwrap();
        let vazio = dir.join("d.pdf");
        std::fs::write(&vazio, b"").unwrap();
        assert!(looks_like_pdf(&ok));
        assert!(looks_like_pdf(&com_lixo));
        assert!(!looks_like_pdf(&html));
        assert!(!looks_like_pdf(&vazio));
        assert!(!looks_like_pdf(&dir.join("nao-existe.pdf")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn contencao_em_pasta() {
        let base = Path::new("/dados/app/uploads");
        assert!(is_inside(Path::new("/dados/app/uploads/a.pdf"), base));
        assert!(is_inside(Path::new("/dados/app/uploads/./sub/a.pdf"), base));
        assert!(!is_inside(Path::new("/dados/app/uploads/../app.sqlite3"), base));
        assert!(!is_inside(Path::new("/dados/app/uploads-velho/a.pdf"), base));
        assert!(!is_inside(Path::new("/outro/a.pdf"), base));
    }

    #[test]
    fn nome_e_extensao() {
        assert_eq!(display_name(Path::new("/x/Batanero (1999) — Educação.pdf")), "Batanero (1999) — Educação");
        assert_eq!(display_name(Path::new("/x/a.b.pdf")), "a.b");
        assert_eq!(display_name(Path::new("/")), "Documento");
        assert!(has_pdf_extension(Path::new("A.PDF")));
        assert!(has_pdf_extension(Path::new("a.Pdf")));
        assert!(!has_pdf_extension(Path::new("a.pdf.exe")));
        assert!(!has_pdf_extension(Path::new("pdf")));
    }

    #[test]
    fn valida_caminho_de_exportacao() {
        let dir = tmp("export");
        for ext in ["md", "txt", "csv", "MD", "Csv"] {
            assert!(validate_export_path(dir.join(format!("a.{ext}")).to_str().unwrap()).is_ok(), "{ext}");
        }
        for ruim in ["a.md", "", "  ", "relativo/a.md"] {
            assert!(validate_export_path(ruim).is_err(), "{ruim:?}");
        }
        for nome in ["a.exe", "a.pdf", "a", "a.md.exe", "a.sqlite3", "a.html"] {
            assert!(validate_export_path(dir.join(nome).to_str().unwrap()).is_err(), "{nome}");
        }
        assert!(validate_export_path(dir.join("nao/existe/a.md").to_str().unwrap()).is_err());
        assert!(validate_export_path(&format!("{}/a\0.md", dir.display())).is_err());
        let pasta = dir.join("pasta.md");
        std::fs::create_dir(&pasta).unwrap();
        assert!(validate_export_path(pasta.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn grava_utf8_e_substitui_sem_deixar_temporario() {
        let dir = tmp("write");
        let alvo = dir.join("Notas — ação.md");
        write_text_file(alvo.to_str().unwrap(), "# Título\n\nção ✓\n").unwrap();
        assert_eq!(std::fs::read_to_string(&alvo).unwrap(), "# Título\n\nção ✓\n");
        write_text_file(alvo.to_str().unwrap(), "novo").unwrap();
        assert_eq!(std::fs::read_to_string(&alvo).unwrap(), "novo");
        let restos: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(Result::ok).collect();
        assert_eq!(restos.len(), 1);
        assert!(write_text_file(dir.join("x.exe").to_str().unwrap(), "x").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn caminhos_do_windows() {
        let base = Path::new(r"C:\Users\João\AppData\Local\br.com.gerlan.pdfchat\uploads");
        assert!(is_inside(&base.join("a.pdf"), base));
        assert!(!is_inside(Path::new(r"C:\Users\João\AppData\Local\br.com.gerlan.pdfchat\pdfchat.sqlite3"), base));
        assert_eq!(display_name(Path::new(r"C:\Users\João\Documentos\Tese — v2.pdf")), "Tese — v2");
    }
}
