//! Cliente de embeddings compatível com OpenAI (`POST {base}/embeddings`).
//! Só é usado se o usuário configurar `embed_base_url` + `embed_model` (o
//! DeepSeek não oferece embeddings; Ollama local, por exemplo, serve).

use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde_json::{json, Value};

use crate::asyncutil::{sleep_or_cancel, wait_cancelled};
use crate::net;

pub const BATCH_CHUNKS: usize = 24;
pub const BATCH_CHARS: usize = 24_000;
const HEADER_TIMEOUT: Duration = Duration::from_secs(60);
/// Teto do pedido inteiro: na primeira chamada o Ollama ainda carrega o modelo.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
const RETRY_UNIT: Duration = Duration::from_secs(1);
const MAX_DIMS: usize = 16_384;

#[derive(Debug, Clone, PartialEq)]
pub struct EmbedConfig {
    /// Já validada (ver `validate_embed_url`), sem barra final; ex.: http://localhost:11434/v1
    pub base_url: String,
    pub model: String,
    pub key: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum EmbedError {
    Cancelled,
    Failed(String),
}

/// Valida e normaliza a URL base dos embeddings: https, ou http só em localhost /
/// 127.0.0.1; sem parâmetros; sem `/embeddings` no fim; sem caminho vira `/v1`.
pub fn validate_embed_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let lower = t.to_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("A URL de embeddings deve começar com https:// (exemplos: https://api.openai.com/v1 ou, para Ollama local, http://localhost:11434/v1).".into());
    }
    if t.contains('?') || t.contains('#') {
        return Err("A URL de embeddings não pode ter parâmetros (? ou #).".into());
    }
    let mut url = net::validate_base_url(t)
        .map_err(|e| e.replace("A URL base", "A URL de embeddings").replace("na URL base", "na URL de embeddings"))?;
    if let Some(stripped) = url.strip_suffix("/embeddings") {
        url = stripped.trim_end_matches('/').to_string();
    }
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or("");
    if !after_scheme.contains('/') {
        url.push_str("/v1");
    }
    Ok(url)
}

pub fn validate_embed_model(raw: &str) -> Result<String, String> {
    let m = raw.trim();
    if m.is_empty() {
        return Err("Informe o nome do modelo de embeddings (exemplo: nomic-embed-text).".into());
    }
    if m.chars().count() > 100 || m.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("O nome do modelo de embeddings é inválido.".into());
    }
    Ok(m.to_string())
}

/// Monta a configuração a partir do que está salvo: URL e modelo válidos, chave opcional.
/// `None` (busca semântica desligada) se faltar ou estiver inválido um dos dois.
pub fn config_from_settings(url: Option<String>, model: Option<String>, key: Option<String>) -> Option<EmbedConfig> {
    let base_url = validate_embed_url(&url?).ok()?;
    let model = validate_embed_model(&model?).ok()?;
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    Some(EmbedConfig { base_url, model, key })
}

pub fn embeddings_url(base: &str) -> String {
    format!("{}/embeddings", base.trim_end_matches('/'))
}

pub fn request_body(model: &str, inputs: &[String]) -> Value {
    json!({ "model": model, "input": inputs })
}

/// Lê `data[].embedding` (na ordem de `index`) e confere quantidade e dimensões.
pub fn parse_response(body: &Value, expected: usize) -> Result<Vec<Vec<f32>>, String> {
    if let Some(msg) = body["error"]["message"].as_str().or_else(|| body["error"].as_str()) {
        return Err(format!("O servidor de embeddings devolveu um erro: {}", msg.trim()));
    }
    let data = body["data"]
        .as_array()
        .ok_or("Resposta inesperada do servidor de embeddings (sem o campo data). Confira se a URL termina em /v1.")?;
    let mut items: Vec<(u64, Vec<f32>)> = Vec::with_capacity(data.len());
    for (pos, item) in data.iter().enumerate() {
        let arr = item["embedding"]
            .as_array()
            .ok_or("Resposta inesperada do servidor de embeddings (vetor ausente ou em formato não suportado).")?;
        if arr.is_empty() || arr.len() > MAX_DIMS {
            return Err("O servidor de embeddings devolveu um vetor vazio ou grande demais.".into());
        }
        let mut v = Vec::with_capacity(arr.len());
        for x in arr {
            let f = x.as_f64().ok_or("O servidor de embeddings devolveu um vetor com valores não numéricos.")?;
            v.push(f as f32);
        }
        items.push((item["index"].as_u64().unwrap_or(pos as u64), v));
    }
    if items.len() != expected {
        return Err(format!(
            "O servidor de embeddings devolveu {} vetor(es) para {} trecho(s).",
            items.len(),
            expected
        ));
    }
    items.sort_by_key(|(i, _)| *i);
    let dim = items[0].1.len();
    if items.iter().any(|(_, v)| v.len() != dim) {
        return Err("O servidor de embeddings devolveu vetores de tamanhos diferentes.".into());
    }
    Ok(items.into_iter().map(|(_, v)| v).collect())
}

fn friendly_error(status: u16, body: &str) -> String {
    let detail = net::provider_message(body);
    let with = |base: &str| match &detail {
        Some(d) => format!("{base} Detalhe: {d}"),
        None => base.to_string(),
    };
    match status {
        400 | 422 => with(&format!("O servidor de embeddings recusou a requisição ({status}).")),
        401 => "Chave inválida ou ausente no servidor de embeddings (401). Confira a chave nas configurações.".into(),
        403 => with("Acesso negado pelo servidor de embeddings (403)."),
        404 => "Endereço ou modelo de embeddings não encontrado (404). Confira a URL (termina em /v1) e o nome do modelo; no Ollama, rode \"ollama pull\" com esse modelo.".into(),
        429 => "Muitas requisições ao servidor de embeddings (429). Aguarde alguns instantes.".into(),
        408 | 500 | 502 | 503 | 504 | 529 => format!("O servidor de embeddings está instável ou sobrecarregado ({status})."),
        _ => with(&format!("Erro {status} do servidor de embeddings.")),
    }
}

fn delay(unit: Duration, attempt: u32, retry_after: Option<&str>) -> Duration {
    if let Some(secs) = retry_after.and_then(|v| v.trim().parse::<u64>().ok()) {
        return unit * secs.clamp(1, 30) as u32;
    }
    unit * (1u32 << attempt.min(4))
}

pub async fn embed_batch(
    http: &reqwest::Client,
    cfg: &EmbedConfig,
    inputs: &[String],
    cancel: Option<&AtomicBool>,
) -> Result<Vec<Vec<f32>>, EmbedError> {
    embed_batch_with(http, cfg, inputs, cancel, RETRY_UNIT, net::MAX_RETRIES).await
}

/// Como `embed_batch`, com a unidade de espera e o número de tentativas à escolha
/// (a busca interativa usa 1 nova tentativa e espera curta).
pub async fn embed_batch_with(
    http: &reqwest::Client,
    cfg: &EmbedConfig,
    inputs: &[String],
    cancel: Option<&AtomicBool>,
    unit: Duration,
    max_retries: u32,
) -> Result<Vec<Vec<f32>>, EmbedError> {
    if inputs.is_empty() {
        return Ok(vec![]);
    }
    let payload = serde_json::to_vec(&request_body(&cfg.model, inputs)).map_err(|e| EmbedError::Failed(e.to_string()))?;
    let url = embeddings_url(&cfg.base_url);
    let host = url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or("").to_string();
    let mut attempt = 0u32;
    loop {
        let mut req = http
            .post(&url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(TOTAL_TIMEOUT)
            .body(payload.clone());
        if let Some(key) = cfg.key.as_deref().filter(|k| !k.is_empty()) {
            req = req.bearer_auth(key);
        }
        let sent = tokio::select! {
            r = tokio::time::timeout(HEADER_TIMEOUT, req.send()) => r,
            _ = wait_cancelled(cancel) => return Err(EmbedError::Cancelled),
        };
        let (retry_after, why): (Option<String>, String) = match sent {
            Ok(Ok(resp)) if resp.status().is_success() => {
                let body: Value = tokio::select! {
                    r = resp.json::<Value>() => r.map_err(|_| EmbedError::Failed("Resposta inválida do servidor de embeddings (não é JSON).".into()))?,
                    _ = wait_cancelled(cancel) => return Err(EmbedError::Cancelled),
                };
                return parse_response(&body, inputs.len()).map_err(EmbedError::Failed);
            }
            Ok(Ok(resp)) => {
                let status = resp.status().as_u16();
                let retry_after = resp
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                if !net::is_retryable_status(status) || attempt >= max_retries {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(EmbedError::Failed(friendly_error(status, &body)));
                }
                (retry_after, format!("status {status}"))
            }
            Ok(Err(e)) => {
                if e.is_timeout() {
                    return Err(EmbedError::Failed("O servidor de embeddings demorou demais para responder.".into()));
                }
                if !e.is_connect() || attempt >= max_retries {
                    return Err(EmbedError::Failed(if e.is_connect() {
                        format!("Não foi possível conectar ao servidor de embeddings ({host}). Se for o Ollama, confira se está em execução.")
                    } else {
                        format!("Falha de rede nos embeddings: {}", e.without_url())
                    }));
                }
                (None, "sem conexão".to_string())
            }
            Err(_elapsed) => {
                return Err(EmbedError::Failed("O servidor de embeddings demorou demais para responder.".into()));
            }
        };
        let _ = why;
        if sleep_or_cancel(delay(unit, attempt, retry_after.as_deref()), cancel).await {
            return Err(EmbedError::Cancelled);
        }
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testsrv::{block_on, client, serve, serve_body, Reply};
    use std::sync::atomic::Ordering;

    fn cfg(base: &str, key: Option<&str>) -> EmbedConfig {
        EmbedConfig { base_url: format!("{base}/v1"), model: "nomic-embed-text".into(), key: key.map(str::to_string) }
    }

    fn inputs(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("trecho {i}")).collect()
    }

    #[test]
    fn url_de_embeddings_https_ou_http_so_local() {
        assert_eq!(validate_embed_url("https://api.openai.com/v1").unwrap(), "https://api.openai.com/v1");
        assert_eq!(validate_embed_url("https://api.openai.com").unwrap(), "https://api.openai.com/v1");
        assert_eq!(validate_embed_url(" https://api.openai.com/v1/ ").unwrap(), "https://api.openai.com/v1");
        assert_eq!(validate_embed_url("https://api.openai.com/v1/embeddings").unwrap(), "https://api.openai.com/v1");
        assert_eq!(validate_embed_url("http://localhost:11434").unwrap(), "http://localhost:11434/v1");
        assert_eq!(validate_embed_url("http://localhost:11434/v1").unwrap(), "http://localhost:11434/v1");
        assert_eq!(validate_embed_url("http://127.0.0.1:11434/v1/").unwrap(), "http://127.0.0.1:11434/v1");
        assert_eq!(validate_embed_url("HTTP://LOCALHOST:8080").unwrap(), "HTTP://LOCALHOST:8080/v1");
        assert_eq!(validate_embed_url("http://[::1]:11434").unwrap(), "http://[::1]:11434/v1");
        assert_eq!(validate_embed_url("https://meu-servidor.edu.br/ollama/v1").unwrap(), "https://meu-servidor.edu.br/ollama/v1");
        for ruim in [
            "", "   ", "api.openai.com/v1", "ftp://x.org/v1", "http://servidor.edu.br/v1", "http://192.168.0.10:11434/v1",
            "http://localhost.evil.com/v1", "https://", "https://user:pw@x.org/v1", "https://x.org/v1?key=abc", "https://x.org/v1#a",
            "https://x .org/v1", "http://localhost@evil.com/v1",
        ] {
            assert!(validate_embed_url(ruim).is_err(), "{ruim:?} deveria ser recusada");
        }
        let e = validate_embed_url("http://servidor.edu.br/v1").unwrap_err();
        assert!(e.contains("URL de embeddings") && !e.contains("deepseek"), "{e}");
    }

    #[test]
    fn modelo_de_embeddings() {
        assert_eq!(validate_embed_model(" nomic-embed-text ").unwrap(), "nomic-embed-text");
        assert_eq!(validate_embed_model("text-embedding-3-small").unwrap(), "text-embedding-3-small");
        assert!(validate_embed_model("").is_err());
        assert!(validate_embed_model("dois nomes").is_err());
        assert!(validate_embed_model(&"x".repeat(101)).is_err());
    }

    #[test]
    fn configuracao_so_com_url_e_modelo_validos() {
        let c = config_from_settings(Some("http://localhost:11434".into()), Some("m".into()), Some("  ".into())).unwrap();
        assert_eq!((c.base_url.as_str(), c.model.as_str(), c.key), ("http://localhost:11434/v1", "m", None));
        let c = config_from_settings(Some("https://x.org/v1".into()), Some("m".into()), Some(" sk-1 ".into())).unwrap();
        assert_eq!(c.key.as_deref(), Some("sk-1"));
        assert!(config_from_settings(None, Some("m".into()), None).is_none());
        assert!(config_from_settings(Some("https://x.org".into()), None, None).is_none());
        assert!(config_from_settings(Some("http://x.org".into()), Some("m".into()), None).is_none());
        assert_eq!(embeddings_url("https://x.org/v1/"), "https://x.org/v1/embeddings");
    }

    #[test]
    fn resposta_no_formato_openai() {
        let body = json!({"object": "list", "model": "m", "usage": {"prompt_tokens": 3},
            "data": [{"object": "embedding", "index": 1, "embedding": [0.5, 0.25]}, {"object": "embedding", "index": 0, "embedding": [1.0, -1.0]}]});
        let v = parse_response(&body, 2).unwrap();
        assert_eq!(v, vec![vec![1.0f32, -1.0], vec![0.5, 0.25]], "reordena por index");
        // sem index: vale a posição
        let body = json!({"data": [{"embedding": [1.0]}, {"embedding": [2.0]}]});
        assert_eq!(parse_response(&body, 2).unwrap(), vec![vec![1.0f32], vec![2.0]]);
    }

    #[test]
    fn respostas_defeituosas_viram_erro_claro() {
        assert!(parse_response(&json!({}), 1).unwrap_err().contains("/v1"));
        assert!(parse_response(&json!({"data": []}), 1).unwrap_err().contains("0 vetor"));
        assert!(parse_response(&json!({"data": [{"embedding": []}]}), 1).is_err());
        assert!(parse_response(&json!({"data": [{"embedding": "base64=="}]}), 1).is_err());
        assert!(parse_response(&json!({"data": [{"embedding": [1.0, "x"]}]}), 1).is_err());
        assert!(parse_response(&json!({"data": [{"embedding": [1.0]}, {"embedding": [1.0, 2.0]}]}), 2).unwrap_err().contains("tamanhos"));
        assert!(parse_response(&json!({"data": [{"embedding": [1.0]}]}), 2).unwrap_err().contains("1 vetor"));
        assert!(parse_response(&json!({"error": {"message": "model not found"}}), 1).unwrap_err().contains("model not found"));
        assert!(parse_response(&Value::Null, 1).is_err());
    }

    #[test]
    fn manda_chave_e_corpo_e_sem_chave_nao_manda_autorizacao() {
        let srv = serve_body(|_, _, body| {
            let n = serde_json::from_str::<Value>(body).unwrap()["input"].as_array().unwrap().len();
            Reply::json(200, &json!({"data": (0..n).map(|i| json!({"index": i, "embedding": [i as f64, 1.0]})).collect::<Vec<_>>()}))
        });
        let http = client();
        let v = block_on(embed_batch(&http, &cfg(&srv.base, Some("sk-abc")), &inputs(3), None)).unwrap();
        assert_eq!(v.len(), 3);
        let r = srv.request(0);
        assert!(r.starts_with("POST /v1/embeddings "), "{r}");
        assert!(r.to_lowercase().contains("authorization: bearer sk-abc"));
        assert!(r.contains("\"model\":\"nomic-embed-text\"") && r.contains("\"input\":[\"trecho 0\""), "{r}");
        block_on(embed_batch(&http, &cfg(&srv.base, None), &inputs(1), None)).unwrap();
        assert!(!srv.request(1).to_lowercase().contains("authorization"));
        assert!(block_on(embed_batch(&http, &cfg(&srv.base, None), &[], None)).unwrap().is_empty());
        assert_eq!(srv.count(), 2, "lista vazia não chama a rede");
    }

    #[test]
    fn retry_com_backoff_em_429_e_5xx() {
        let srv = serve(|n, _| match n {
            0 => Reply::text(429, "x").with_header("Retry-After", "1"),
            1 => Reply::text(503, "x"),
            _ => Reply::json(200, &json!({"data": [{"embedding": [1.0, 0.0]}]})),
        });
        let http = client();
        let v = block_on(embed_batch_with(&http, &cfg(&srv.base, None), &inputs(1), None, Duration::from_millis(2), 3)).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(srv.count(), 3);
        // esgota as tentativas: erro em português
        let srv2 = serve(|_, _| Reply::text(503, "x"));
        let e = block_on(embed_batch_with(&http, &cfg(&srv2.base, None), &inputs(1), None, Duration::from_millis(1), 2)).unwrap_err();
        assert!(matches!(&e, EmbedError::Failed(m) if m.contains("instável")), "{e:?}");
        assert_eq!(srv2.count(), 3);
    }

    #[test]
    fn erros_definitivos_nao_repetem_e_trazem_dica() {
        let http = client();
        for (status, trecho) in [(401, "Chave inválida"), (404, "ollama pull"), (400, "recusou")] {
            let srv = serve(move |_, _| Reply::json(status, &json!({"error": {"message": "detalhe do servidor"}})));
            let e = block_on(embed_batch_with(&http, &cfg(&srv.base, None), &inputs(1), None, Duration::from_millis(1), 3)).unwrap_err();
            assert!(matches!(&e, EmbedError::Failed(m) if m.contains(trecho)), "{status}: {e:?}");
            assert_eq!(srv.count(), 1);
        }
        let srv = serve(|_, _| Reply::json(400, &json!({"error": {"message": "input too long"}})));
        let EmbedError::Failed(m) = block_on(embed_batch(&http, &cfg(&srv.base, None), &inputs(1), None)).unwrap_err() else { panic!() };
        assert!(m.contains("input too long"));
    }

    #[test]
    fn servidor_desligado_aponta_o_ollama() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        drop(l);
        let http = client();
        let e = block_on(embed_batch_with(&http, &cfg(&base, None), &inputs(1), None, Duration::from_millis(1), 1)).unwrap_err();
        assert!(matches!(&e, EmbedError::Failed(m) if m.contains("Não foi possível conectar") && m.contains("Ollama")), "{e:?}");
    }

    #[test]
    fn corpo_que_nao_e_json_e_cancelamento() {
        let http = client();
        let srv = serve(|_, _| Reply::text(200, "<html>proxy</html>"));
        let e = block_on(embed_batch(&http, &cfg(&srv.base, None), &inputs(1), None)).unwrap_err();
        assert!(matches!(&e, EmbedError::Failed(m) if m.contains("não é JSON")), "{e:?}");
        // já cancelado: nem espera a resposta
        let flag = AtomicBool::new(true);
        let slow = serve(|_, _| {
            std::thread::sleep(Duration::from_millis(300));
            Reply::json(200, &json!({"data": [{"embedding": [1.0]}]}))
        });
        let e = block_on(embed_batch(&http, &cfg(&slow.base, None), &inputs(1), Some(&flag))).unwrap_err();
        assert_eq!(e, EmbedError::Cancelled);
        // cancelado durante a espera do backoff
        let flag2 = std::sync::Arc::new(AtomicBool::new(false));
        let f2 = flag2.clone();
        let srv = serve(move |_, _| {
            f2.store(true, Ordering::SeqCst);
            Reply::text(503, "x")
        });
        let e = block_on(embed_batch_with(&http, &cfg(&srv.base, None), &inputs(1), Some(&flag2), Duration::from_secs(5), 3)).unwrap_err();
        assert_eq!(e, EmbedError::Cancelled);
        assert_eq!(srv.count(), 1);
    }
}
