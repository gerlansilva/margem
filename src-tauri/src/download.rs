//! Download de PDFs (acesso aberto) para uma pasta temporária do app.
//! Só https; segue até 5 redirecionamentos (cada um também precisa ser https e
//! público); confere o cabeçalho `%PDF-`; limite de 100 MB; nome de arquivo seguro.

use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use reqwest::Url;

pub const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 5;
const NAME_MAX_CHARS: usize = 80;
const OLD_DOWNLOAD_AGE: Duration = Duration::from_secs(24 * 3600);

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_loopback() || v.is_private() || v.is_link_local() || v.is_unspecified() || v.is_broadcast() || v.octets()[0] == 0 || (v.octets()[0] == 100 && (64..128).contains(&v.octets()[1])),
        IpAddr::V6(v) => {
            let seg = v.segments();
            v.is_loopback() || v.is_unspecified() || (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80
                || v.to_ipv4_mapped().is_some_and(|m| is_private_ip(IpAddr::V4(m)))
        }
    }
}

fn blocked_host(host: &str) -> bool {
    let h = host.trim_matches(['[', ']']).to_lowercase();
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".internal") || h.ends_with(".lan") {
        return true;
    }
    IpAddr::from_str(&h).is_ok_and(is_private_ip)
}

/// `strict` (produção): só https e nada de endereços locais/privados.
/// Os testes usam `strict = false` para falar com um servidor em 127.0.0.1.
pub fn validate_url(raw: &str, strict: bool) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "O endereço do PDF é inválido.".to_string())?;
    match url.scheme() {
        "https" => {}
        "http" if !strict => {}
        _ => return Err("Só é possível baixar PDFs por https://.".into()),
    }
    let host = url.host_str().ok_or("O endereço do PDF é inválido.")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("O endereço do PDF não pode conter usuário e senha.".into());
    }
    if strict && blocked_host(host) {
        return Err("O endereço do PDF aponta para a rede local; só são aceitos endereços públicos.".into());
    }
    Ok(url)
}

pub fn build_client(strict: bool) -> Result<reqwest::Client, String> {
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        // `previous` inclui a URL inicial: o 6º redirecionamento é o que passa de 5
        if attempt.previous().len() > MAX_REDIRECTS {
            attempt.error("redirecionamentos demais")
        } else if validate_url(attempt.url().as_str(), strict).is_err() {
            attempt.error("redirecionamento para endereço não permitido")
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder()
        .redirect(policy)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .user_agent(concat!("Margem/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Não foi possível iniciar o cliente de download: {e}"))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
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

/// Nome seguro (sem caminhos, sem nomes reservados do Windows, sem ponto/espaço final)
/// sempre terminando em `.pdf`.
pub fn sanitize_name(raw: &str) -> String {
    let mut base = raw.trim().to_string();
    if base.to_lowercase().ends_with(".pdf") {
        base.truncate(base.len() - 4);
    }
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '(' | ')' | ',') { c } else { '_' })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut stem: String = collapsed.trim_matches(|c| c == '.' || c == ' ' || c == '_').chars().take(NAME_MAX_CHARS).collect();
    stem = stem.trim_end_matches(['.', ' ']).to_string();
    let upper = stem.to_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((upper.starts_with("COM") || upper.starts_with("LPT")) && upper.len() == 4 && upper.ends_with(|c: char| c.is_ascii_digit()));
    if stem.is_empty() {
        stem = "artigo".to_string();
    } else if reserved {
        stem = format!("_{stem}");
    }
    format!("{stem}.pdf")
}

fn disposition_filename(cd: &str) -> Option<String> {
    let lower = cd.to_lowercase();
    if let Some(p) = lower.find("filename*=") {
        let v = cd[p + 10..].split(';').next()?.trim().trim_matches('"');
        let v = v.split_once("''").map(|(_, r)| r).unwrap_or(v);
        let d = percent_decode(v);
        if !d.trim().is_empty() {
            return Some(d);
        }
    }
    let p = lower.find("filename=")?;
    let v = cd[p + 9..].split(';').next()?.trim().trim_matches('"');
    (!v.trim().is_empty()).then(|| v.to_string())
}

pub fn pdf_name(url: &Url, content_disposition: Option<&str>) -> String {
    if let Some(n) = content_disposition.and_then(disposition_filename) {
        let n = n.rsplit(['/', '\\']).next().unwrap_or("").to_string();
        return sanitize_name(&n);
    }
    let last = url.path_segments().and_then(|mut s| s.rfind(|x| !x.is_empty())).unwrap_or("");
    sanitize_name(&percent_decode(last))
}

fn is_pdf_head(head: &[u8]) -> bool {
    head.windows(5).any(|w| w == b"%PDF-")
}

fn http_message(status: u16) -> String {
    match status {
        401 | 403 => format!("O site não permite baixar o PDF automaticamente ({status}). Abra o link no navegador e importe o arquivo manualmente."),
        404 | 410 => format!("O PDF não foi encontrado no endereço informado ({status})."),
        429 => "O site limitou os downloads (429). Tente de novo em instantes.".into(),
        s if s >= 500 => format!("O site do PDF está com problemas ({s}). Tente de novo mais tarde."),
        s => format!("O site respondeu {s} ao tentar baixar o PDF."),
    }
}

/// Remove pastas de downloads com mais de um dia (melhor esforço).
pub fn cleanup_old(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > OLD_DOWNLOAD_AGE);
        if old && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Baixa o PDF para `<root>/<id aleatório>/<nome>.pdf`. Devolve (caminho, nome do arquivo).
pub async fn fetch_pdf(
    client: &reqwest::Client,
    raw_url: &str,
    root: &Path,
    strict: bool,
    max_bytes: u64,
) -> Result<(PathBuf, String), String> {
    let url = validate_url(raw_url, strict)?;
    let mut resp = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "application/pdf,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| {
            if e.is_redirect() {
                "O endereço redireciona demais ou para um local não permitido.".to_string()
            } else if e.is_timeout() {
                "O download demorou demais. Tente de novo.".to_string()
            } else if e.is_connect() {
                "Sem conexão com o site do PDF. Verifique sua internet.".to_string()
            } else {
                format!("Falha ao baixar o PDF: {}", e.without_url())
            }
        })?;
    if !resp.status().is_success() {
        return Err(http_message(resp.status().as_u16()));
    }
    if resp.content_length().is_some_and(|n| n > max_bytes) {
        return Err(format!("O PDF é grande demais (limite de {} MB).", max_bytes / 1024 / 1024));
    }
    let disposition = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let name = pdf_name(resp.url(), disposition.as_deref());

    let dir = root.join(&uuid::Uuid::new_v4().simple().to_string()[..12]);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Não foi possível criar a pasta temporária: {e}"))?;
    let path = dir.join(&name);
    let cleanup = |path: &Path, dir: &Path| {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir(dir);
    };
    let mut file = std::fs::File::create(&path).map_err(|e| format!("Não foi possível gravar o PDF: {e}"))?;
    let mut head: Vec<u8> = Vec::new();
    let mut checked = false;
    let mut total = 0u64;
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                drop(file);
                cleanup(&path, &dir);
                return Err(if e.is_timeout() {
                    "O download demorou demais. Tente de novo.".to_string()
                } else {
                    "A conexão foi interrompida durante o download. Tente de novo.".to_string()
                });
            }
        };
        total += chunk.len() as u64;
        if total > max_bytes {
            drop(file);
            cleanup(&path, &dir);
            return Err(format!("O PDF passa de {} MB (limite do app).", max_bytes / 1024 / 1024));
        }
        if !checked {
            head.extend_from_slice(&chunk);
            if head.len() >= 1024 {
                if !is_pdf_head(&head[..1024]) {
                    drop(file);
                    cleanup(&path, &dir);
                    return Err(not_pdf_message());
                }
                checked = true;
                file.write_all(&head).map_err(|e| write_err(e, &path, &dir))?;
                head = Vec::new();
            }
        } else {
            file.write_all(&chunk).map_err(|e| write_err(e, &path, &dir))?;
        }
    }
    if !checked {
        if !is_pdf_head(&head) {
            drop(file);
            cleanup(&path, &dir);
            return Err(not_pdf_message());
        }
        file.write_all(&head).map_err(|e| write_err(e, &path, &dir))?;
    }
    file.flush().map_err(|e| write_err(e, &path, &dir))?;
    Ok((path, name))
}

fn not_pdf_message() -> String {
    "O endereço não devolveu um PDF (provavelmente é uma página da web). Abra o link no navegador e importe o arquivo manualmente.".to_string()
}

fn write_err(e: std::io::Error, path: &Path, dir: &Path) -> String {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_dir(dir);
    format!("Não foi possível gravar o PDF: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testsrv::{block_on, serve, Reply};

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("margem-dl-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn pdf_bytes(n: usize) -> Vec<u8> {
        let mut v = b"%PDF-1.7\n".to_vec();
        v.resize(n.max(9), b'x');
        v
    }

    #[test]
    fn so_https_e_so_publico_em_modo_estrito() {
        assert!(validate_url("https://repo.example.org/a.pdf", true).is_ok());
        for ruim in [
            "http://repo.example.org/a.pdf", "ftp://x.org/a.pdf", "file:///etc/passwd", "javascript:alert(1)", "",
            "https://localhost/a.pdf", "https://127.0.0.1/a.pdf", "https://10.0.0.5/a.pdf", "https://192.168.1.1/a.pdf",
            "https://172.16.0.1/a.pdf", "https://169.254.169.254/latest", "https://[::1]/a.pdf", "https://[fd00::1]/a.pdf",
            "https://meu.local/a.pdf", "https://user:senha@x.org/a.pdf", "https://[::ffff:127.0.0.1]/a.pdf", "https://100.64.0.1/a",
        ] {
            assert!(validate_url(ruim, true).is_err(), "{ruim}");
        }
        assert!(validate_url("http://127.0.0.1:8080/a.pdf", false).is_ok());
        assert!(validate_url("https://8.8.8.8/a.pdf", true).is_ok());
    }

    #[test]
    fn nomes_seguros() {
        assert_eq!(sanitize_name("Letramento estatístico.pdf"), "Letramento estatístico.pdf");
        assert_eq!(sanitize_name("../../etc/passwd"), "etc_passwd.pdf");
        assert_eq!(sanitize_name("..\\..\\Windows\\system32"), "Windows_system32.pdf");
        assert_eq!(sanitize_name("a:b*c?d\"e<f>g|h.PDF"), "a_b_c_d_e_f_g_h.pdf");
        assert_eq!(sanitize_name(""), "artigo.pdf");
        assert_eq!(sanitize_name("...."), "artigo.pdf");
        assert_eq!(sanitize_name("CON"), "_CON.pdf");
        assert_eq!(sanitize_name("com1.pdf"), "_com1.pdf");
        assert_eq!(sanitize_name("nome com ponto final."), "nome com ponto final.pdf");
        assert!(sanitize_name(&"ção".repeat(100)).chars().count() <= NAME_MAX_CHARS + 4);
        assert_eq!(sanitize_name("x\u{0}y\ny"), "x_y_y.pdf");
    }

    #[test]
    fn nome_vem_do_content_disposition_ou_da_url() {
        let u = Url::parse("https://x.org/files/Artigo%20Bom.pdf?download=1").unwrap();
        assert_eq!(pdf_name(&u, None), "Artigo Bom.pdf");
        assert_eq!(pdf_name(&u, Some("attachment; filename=\"outro nome.pdf\"")), "outro nome.pdf");
        assert_eq!(pdf_name(&u, Some("attachment; filename*=UTF-8''Educa%C3%A7%C3%A3o.pdf")), "Educação.pdf");
        assert_eq!(pdf_name(&u, Some("attachment; filename=\"../../x.pdf\"")), "x.pdf");
        let bare = Url::parse("https://x.org/").unwrap();
        assert_eq!(pdf_name(&bare, None), "artigo.pdf");
    }

    #[test]
    fn baixa_pdf_grande_o_bastante_para_varios_pedacos() {
        let body = pdf_bytes(3 * 1024 * 1024);
        let b2 = body.clone();
        let srv = serve(move |_, _| Reply::bytes(200, "application/pdf", b2.clone()).with_header("Content-Disposition", "attachment; filename=\"Meu Artigo.pdf\""));
        let root = tmp();
        let client = build_client(false).unwrap();
        let (path, name) = block_on(fetch_pdf(&client, &format!("{}/x", srv.base), &root, false, MAX_PDF_BYTES)).unwrap();
        assert_eq!(name, "Meu Artigo.pdf");
        assert!(path.starts_with(&root) && path.ends_with("Meu Artigo.pdf"));
        assert_eq!(std::fs::read(&path).unwrap(), body);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pdf_pequeno_com_cabecalho_depois_de_lixo() {
        let mut body = b"\xEF\xBB\xBFlixo antes\n".to_vec();
        body.extend(pdf_bytes(300));
        let srv = serve(move |_, _| Reply::bytes(200, "application/octet-stream", body.clone()));
        let root = tmp();
        let client = build_client(false).unwrap();
        let (path, name) = block_on(fetch_pdf(&client, &format!("{}/arquivo.pdf", srv.base), &root, false, MAX_PDF_BYTES)).unwrap();
        assert_eq!(name, "arquivo.pdf");
        assert!(path.is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pagina_html_nao_e_pdf_e_nao_deixa_arquivo() {
        let srv = serve(|_, _| Reply::bytes(200, "text/html", format!("<html>{}</html>", "a".repeat(5000)).into_bytes()));
        let root = tmp();
        let client = build_client(false).unwrap();
        let e = block_on(fetch_pdf(&client, &format!("{}/p", srv.base), &root, false, MAX_PDF_BYTES)).unwrap_err();
        assert!(e.contains("não devolveu um PDF"), "{e}");
        let restos: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().flat_map(|d| std::fs::read_dir(d.path()).unwrap().flatten()).collect();
        assert!(restos.is_empty(), "sobrou arquivo");
        let srv2 = serve(|_, _| Reply::bytes(200, "text/html", b"<html>curto</html>".to_vec()));
        assert!(block_on(fetch_pdf(&client, &format!("{}/p", srv2.base), &root, false, MAX_PDF_BYTES)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn limite_de_tamanho_por_content_length_e_por_fluxo() {
        let srv = serve(|_, _| Reply::bytes(200, "application/pdf", pdf_bytes(5000)));
        let root = tmp();
        let client = build_client(false).unwrap();
        let e = block_on(fetch_pdf(&client, &format!("{}/x", srv.base), &root, false, 4000)).unwrap_err();
        assert!(e.contains("grande demais") || e.contains("passa de"), "{e}");
        assert!(block_on(fetch_pdf(&client, &format!("{}/x", srv.base), &root, false, 6000)).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn segue_ate_5_redirects_e_no_sexto_desiste() {
        // /rN redireciona para /r(N+1); a partir de /r100 devolve o PDF
        let srv = serve(|_, t| {
            let n: usize = t.trim_start_matches("/r").parse().unwrap_or(0);
            if n < 100 {
                Reply::redirect(&format!("/r{}", n + 1))
            } else {
                Reply::bytes(200, "application/pdf", pdf_bytes(2000))
            }
        });
        let root = tmp();
        let client = build_client(false).unwrap();
        // 5 redirects: /r95 -> r96 -> r97 -> r98 -> r99 -> r100 (PDF): ok
        assert!(block_on(fetch_pdf(&client, &format!("{}/r95", srv.base), &root, false, MAX_PDF_BYTES)).is_ok());
        // 6 redirects: /r94 -> ... -> r100: erro
        let e = block_on(fetch_pdf(&client, &format!("{}/r94", srv.base), &root, false, MAX_PDF_BYTES)).unwrap_err();
        assert!(e.contains("redireciona demais"), "{e}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn redirect_para_http_ou_rede_local_e_bloqueado_no_modo_estrito() {
        // modo estrito: a validação do redirecionamento é a mesma de `validate_url`
        let client = build_client(true).unwrap();
        let srv = serve(|_, _| Reply::redirect("http://127.0.0.1:1/x.pdf"));
        let root = tmp();
        // a primeira URL (127.0.0.1 em http) já é recusada antes de qualquer pedido
        let e = block_on(fetch_pdf(&client, &format!("{}/a", srv.base), &root, true, MAX_PDF_BYTES)).unwrap_err();
        assert!(e.contains("https://"), "{e}");
        assert_eq!(srv.count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn erros_http_em_portugues() {
        let srv = serve(|_, t| match t {
            "/403" => Reply::text(403, "x"),
            "/404" => Reply::text(404, "x"),
            _ => Reply::text(503, "x"),
        });
        let root = tmp();
        let client = build_client(false).unwrap();
        let go = |p: &str| block_on(fetch_pdf(&client, &format!("{}{p}", srv.base), &root, false, MAX_PDF_BYTES)).unwrap_err();
        assert!(go("/403").contains("navegador"));
        assert!(go("/404").contains("não foi encontrado"));
        assert!(go("/x").contains("problemas"));
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let dead = format!("http://{}/a.pdf", l.local_addr().unwrap());
        drop(l);
        let e = block_on(fetch_pdf(&client, &dead, &root, false, MAX_PDF_BYTES)).unwrap_err();
        assert!(e.contains("Sem conexão"), "{e}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn limpeza_nao_apaga_o_recente() {
        let root = tmp();
        std::fs::create_dir_all(root.join("novo")).unwrap();
        cleanup_old(&root);
        assert!(root.join("novo").is_dir());
        cleanup_old(&root.join("nao-existe"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
