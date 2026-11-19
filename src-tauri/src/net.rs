//! Rede sem Tauri: leitura de SSE, política de nova tentativa, mensagens de
//! erro em português e validação do que o usuário digita nas configurações.
//! Tudo aqui é puro e testado com `cargo test --lib`.

use std::time::Duration;

use serde_json::Value;

pub const MAX_RETRIES: u32 = 3;
/// Quanto esperar entre pedaços do stream antes de desistir.
pub const STREAM_IDLE_SECS: u64 = 90;

// ------------------------------------------------------------------ retry

pub fn is_retryable_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504 | 529)
}

/// Espera antes da próxima tentativa. `attempt` é 0 para a primeira falha.
/// Respeita `Retry-After` em segundos (limitado a 30 s); sem ele, 1, 2, 4 s...
pub fn retry_delay(attempt: u32, retry_after: Option<&str>) -> Duration {
    if let Some(secs) = retry_after.and_then(|v| v.trim().parse::<u64>().ok()) {
        return Duration::from_secs(secs.clamp(1, 30));
    }
    Duration::from_secs((1u64 << attempt.min(5)).min(20))
}

// ------------------------------------------------------------------ erros

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// Mensagem que o provedor devolveu no corpo do erro, se houver uma legível.
pub fn provider_message(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        let msg = value["error"]["message"]
            .as_str()
            .or_else(|| value["error"].as_str())
            .or_else(|| value["message"].as_str())
            .or_else(|| value["detail"].as_str());
        return msg
            .map(|m| m.trim())
            .filter(|m| !m.is_empty())
            .map(|m| truncate(m, 240));
    }
    // Página HTML de proxy/Cloudflare não ajuda o leitor.
    if trimmed.starts_with('<') {
        return None;
    }
    Some(truncate(trimmed, 240))
}

pub fn friendly_http_error(status: u16, body: &str) -> String {
    let detail = provider_message(body);
    let with_detail = |base: &str| match &detail {
        Some(d) => format!("{base} Detalhe: {d}"),
        None => base.to_string(),
    };
    match status {
        400 | 422 => {
            let lower = detail.as_deref().unwrap_or("").to_lowercase();
            if lower.contains("context length") || lower.contains("maximum context") || lower.contains("too long") {
                "O contexto enviado ficou grande demais para o modelo. Selecione menos documentos ou faça uma pergunta mais específica.".to_string()
            } else {
                with_detail(&format!("A DeepSeek recusou a requisição ({status})."))
            }
        }
        401 => "Chave da API inválida ou expirada (401). Confira a chave nas configurações.".to_string(),
        402 => "Saldo insuficiente na conta da DeepSeek (402). Recarregue os créditos e tente de novo.".to_string(),
        403 => with_detail("Acesso negado pela DeepSeek (403). Confira se a chave tem permissão para este modelo."),
        404 => "Endereço ou modelo não encontrado (404). Confira a URL base e o nome do modelo nas configurações.".to_string(),
        408 | 504 => format!("A DeepSeek demorou demais para responder ({status}). Tente de novo em instantes."),
        429 => "Muitas requisições à DeepSeek (429). Aguarde alguns instantes e tente de novo.".to_string(),
        500 | 502 | 503 | 529 => format!("O serviço da DeepSeek está instável ou sobrecarregado ({status}). Tente de novo em instantes."),
        _ => with_detail(&format!("Erro {status} da DeepSeek.")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetErrorKind {
    Timeout,
    Connect,
    /// Falha no meio do corpo da resposta.
    Body,
    Other,
}

pub fn net_error_message(kind: NetErrorKind, detail: &str) -> String {
    match kind {
        NetErrorKind::Timeout => "A DeepSeek demorou demais para responder. Tente de novo.".to_string(),
        NetErrorKind::Connect => "Não foi possível conectar à DeepSeek. Verifique sua conexão com a internet, o proxy ou o firewall.".to_string(),
        NetErrorKind::Body => "A conexão foi interrompida no meio da resposta. Tente de novo.".to_string(),
        NetErrorKind::Other => format!("Falha de rede: {}", truncate(detail, 200)),
    }
}

// ------------------------------------------------------- entrada do usuário

/// Limpa a chave colada nas configurações: espaços, aspas e o prefixo "Bearer ".
pub fn clean_api_key(raw: &str) -> Result<String, String> {
    let mut key = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    if key.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("bearer ")) {
        key = key[7..].trim();
    }
    if key.is_empty() {
        return Err("A chave está vazia.".to_string());
    }
    if key.len() > 512 || !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err("A chave contém espaços, quebras de linha ou caracteres inválidos. Cole-a novamente.".to_string());
    }
    Ok(key.to_string())
}

/// Valida e normaliza a URL base da API (sem barra final nem `/chat/completions`).
pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let mut url = raw.trim().trim_end_matches('/').to_string();
    if let Some(stripped) = url.strip_suffix("/chat/completions") {
        url = stripped.trim_end_matches('/').to_string();
    }
    let lower = url.to_lowercase();
    let (secure, rest) = if let Some(rest) = lower.strip_prefix("https://") {
        (true, rest.to_string())
    } else if let Some(rest) = lower.strip_prefix("http://") {
        (false, rest.to_string())
    } else {
        return Err("A URL base deve começar com https:// (exemplo: https://api.deepseek.com).".to_string());
    };
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("A URL base não pode conter espaços.".to_string());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err("A URL base é inválida.".to_string());
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return Err("A URL base é inválida.".to_string());
    }
    // A chave viaja em todo pedido: http puro só para servidores locais.
    let local = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if !secure && !local {
        return Err("Use https:// na URL base; http só é aceito para localhost.".to_string());
    }
    Ok(url)
}

// -------------------------------------------------------------------- SSE

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
    Data(String),
    Done,
}

const MAX_BUFFER: usize = 8 * 1024 * 1024;

/// Leitor incremental de Server-Sent Events que trabalha em bytes. O corpo
/// chega em pedaços arbitrários: um caractere UTF-8 de vários bytes ("ç", "ã")
/// pode ser cortado no meio, então só se decodifica linha completa.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    data: Vec<String>,
    stray: String,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Linhas que não eram campos SSE (ex.: corpo JSON de erro devolto com 200).
    pub fn stray(&self) -> &str {
        &self.stray
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<SseItem>, String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some((end, term)) = line_end(&self.buf, false) {
            let line: Vec<u8> = self.buf.drain(..end + term).take(end).collect();
            self.handle_line(&line, &mut out);
        }
        if self.buf.len() > MAX_BUFFER {
            self.buf.clear();
            return Err("Resposta fora do formato esperado (linha grande demais).".to_string());
        }
        Ok(out)
    }

    /// Fim da conexão: processa o que sobrou, mesmo sem a linha em branco final.
    pub fn finish(&mut self) -> Vec<SseItem> {
        let mut out = Vec::new();
        while let Some((end, term)) = line_end(&self.buf, true) {
            let line: Vec<u8> = self.buf.drain(..end + term).take(end).collect();
            self.handle_line(&line, &mut out);
        }
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            self.handle_line(&rest, &mut out);
        }
        self.dispatch(&mut out);
        out
    }

    fn handle_line(&mut self, line: &[u8], out: &mut Vec<SseItem>) {
        if line.is_empty() {
            self.dispatch(out);
            return;
        }
        let text = String::from_utf8_lossy(line);
        if text.starts_with(':') {
            return; // comentário, usado como keep-alive
        }
        let (field, value) = match text.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (text.as_ref(), ""),
        };
        match field {
            "data" => self.data.push(value.to_string()),
            "event" | "id" | "retry" => {}
            _ => {
                if self.stray.len() < 4000 {
                    self.stray.push_str(&text);
                    self.stray.push('\n');
                }
            }
        }
    }

    fn dispatch(&mut self, out: &mut Vec<SseItem>) {
        if self.data.is_empty() {
            return;
        }
        let payload = self.data.join("\n");
        self.data.clear();
        if payload.trim() == "[DONE]" {
            out.push(SseItem::Done);
        } else if !payload.trim().is_empty() {
            out.push(SseItem::Data(payload));
        }
    }
}

/// Fim da primeira linha completa: (posição do terminador, tamanho dele).
fn line_end(buf: &[u8], eof: bool) -> Option<(usize, usize)> {
    for (i, b) in buf.iter().enumerate() {
        match b {
            b'\n' => return Some((i, 1)),
            b'\r' => {
                if i + 1 < buf.len() {
                    return Some((i, if buf[i + 1] == b'\n' { 2 } else { 1 }));
                }
                // "\r" no fim do buffer: o "\n" pode vir no próximo pedaço.
                return if eof { Some((i, 1)) } else { None };
            }
            _ => {}
        }
    }
    None
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct StreamDelta {
    pub token: Option<String>,
    pub finish_reason: Option<String>,
    pub error: Option<String>,
}

/// Interpreta um `data:` de /chat/completions com stream. JSON inválido ou
/// pedaços sem `choices` (uso, keep-alive) viram um delta vazio.
pub fn parse_stream_payload(data: &str) -> StreamDelta {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return StreamDelta::default();
    };
    let mut delta = StreamDelta::default();
    if let Some(err) = value.get("error") {
        let msg = err["message"].as_str().or_else(|| err.as_str()).unwrap_or("erro desconhecido");
        delta.error = Some(truncate(msg, 240));
        return delta;
    }
    let choice = &value["choices"][0];
    delta.token = choice["delta"]["content"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    delta.finish_reason = choice["finish_reason"].as_str().map(str::to_string);
    delta
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(items: Vec<SseItem>) -> Vec<String> {
        items
            .into_iter()
            .filter_map(|i| match i {
                SseItem::Data(d) => Some(d),
                SseItem::Done => None,
            })
            .collect()
    }

    #[test]
    fn sse_basico_com_done() {
        let mut p = SseParser::new();
        let items = p
            .feed(b"data: {\"a\":1}\n\ndata: {\"a\":2}\n\ndata: [DONE]\n\n")
            .unwrap();
        assert_eq!(
            items,
            vec![
                SseItem::Data("{\"a\":1}".into()),
                SseItem::Data("{\"a\":2}".into()),
                SseItem::Done
            ]
        );
    }

    #[test]
    fn sse_nao_corrompe_utf8_cortado_entre_pedacos() {
        // "ção" cortado no meio dos bytes de "ç" (2 bytes) e de "ã" (2 bytes).
        let evento = "data: {\"choices\":[{\"delta\":{\"content\":\"informação\"}}]}\n\n".as_bytes();
        let corte = evento.iter().position(|&b| b == 0xC3).unwrap() + 1; // meio do "ç"
        let mut p = SseParser::new();
        assert!(p.feed(&evento[..corte]).unwrap().is_empty());
        let items = p.feed(&evento[corte..]).unwrap();
        let d = parse_stream_payload(&data(items)[0]);
        assert_eq!(d.token.as_deref(), Some("informação"));
    }

    #[test]
    fn sse_um_byte_por_vez() {
        let evento = "data: {\"choices\":[{\"delta\":{\"content\":\"Educação Estatística — “ok” 日本\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
        let mut p = SseParser::new();
        let mut tokens = String::new();
        let mut done = false;
        for b in evento.as_bytes() {
            for item in p.feed(&[*b]).unwrap() {
                match item {
                    SseItem::Data(d) => tokens.push_str(&parse_stream_payload(&d).token.unwrap_or_default()),
                    SseItem::Done => done = true,
                }
            }
        }
        assert_eq!(tokens, "Educação Estatística — “ok” 日本");
        assert!(done);
        assert!(!tokens.contains('\u{FFFD}'));
    }

    #[test]
    fn sse_crlf_cr_isolado_e_comentarios_keep_alive() {
        let mut p = SseParser::new();
        assert!(p.feed(b": keep-alive\n\n").unwrap().is_empty());
        // sem espaço após ':' e linha em branco só com CR: o último CR espera um
        // possível LF no próximo pedaço, e o fim da conexão libera o evento.
        assert!(p.feed(b"data:{\"x\":1}\r\r").unwrap().is_empty());
        assert_eq!(data(p.finish()), vec!["{\"x\":1}".to_string()]);
    }

    #[test]
    fn sse_cr_no_fim_do_pedaco_espera_o_lf() {
        let mut p = SseParser::new();
        assert!(p.feed(b"data: oi\r").unwrap().is_empty());
        assert!(p.feed(b"\n").unwrap().is_empty());
        let items = p.feed(b"\r\n").unwrap();
        assert_eq!(items, vec![SseItem::Data("oi".into())]);
    }

    #[test]
    fn sse_varias_linhas_data_viram_um_evento() {
        let mut p = SseParser::new();
        let items = p.feed(b"data: a\ndata: b\n\n").unwrap();
        assert_eq!(items, vec![SseItem::Data("a\nb".into())]);
    }

    #[test]
    fn sse_finish_processa_evento_sem_linha_em_branco() {
        let mut p = SseParser::new();
        assert!(p.feed(b"data: {\"y\":2}").unwrap().is_empty());
        assert_eq!(p.finish(), vec![SseItem::Data("{\"y\":2}".into())]);
    }

    #[test]
    fn sse_corpo_json_de_erro_sem_data_fica_em_stray() {
        let mut p = SseParser::new();
        p.feed(b"{\"error\":{\"message\":\"Authentication Fails\"}}").unwrap();
        p.finish();
        assert!(p.stray().contains("Authentication Fails"));
    }

    #[test]
    fn sse_linha_gigante_sem_quebra_e_recusada() {
        let mut p = SseParser::new();
        let chunk = vec![b'x'; 1024 * 1024];
        let mut falhou = false;
        for _ in 0..10 {
            if p.feed(&chunk).is_err() {
                falhou = true;
                break;
            }
        }
        assert!(falhou);
    }

    #[test]
    fn payload_de_stream() {
        let d = parse_stream_payload(r#"{"choices":[{"delta":{"content":"Olá"},"finish_reason":null}]}"#);
        assert_eq!(d.token.as_deref(), Some("Olá"));
        assert_eq!(d.finish_reason, None);

        let d = parse_stream_payload(r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#);
        assert_eq!(d.token, None);
        assert_eq!(d.finish_reason.as_deref(), Some("length"));

        // chunk de uso final, sem choices
        let d = parse_stream_payload(r#"{"choices":[],"usage":{"total_tokens":10}}"#);
        assert_eq!(d, StreamDelta::default());

        // reasoning_content não vira texto da resposta
        let d = parse_stream_payload(r#"{"choices":[{"delta":{"reasoning_content":"pensando","content":null}}]}"#);
        assert_eq!(d.token, None);

        let d = parse_stream_payload(r#"{"error":{"message":"Server is busy","type":"x"}}"#);
        assert_eq!(d.error.as_deref(), Some("Server is busy"));

        assert_eq!(parse_stream_payload("não é json {"), StreamDelta::default());
        assert_eq!(parse_stream_payload(""), StreamDelta::default());
    }

    #[test]
    fn status_que_merece_nova_tentativa() {
        for s in [408, 429, 500, 502, 503, 504] {
            assert!(is_retryable_status(s), "{s}");
        }
        for s in [200, 400, 401, 402, 403, 404, 422] {
            assert!(!is_retryable_status(s), "{s}");
        }
    }

    #[test]
    fn espera_exponencial_e_retry_after() {
        assert_eq!(retry_delay(0, None), Duration::from_secs(1));
        assert_eq!(retry_delay(1, None), Duration::from_secs(2));
        assert_eq!(retry_delay(2, None), Duration::from_secs(4));
        assert_eq!(retry_delay(30, None), Duration::from_secs(20)); // sem overflow
        assert_eq!(retry_delay(0, Some("7")), Duration::from_secs(7));
        assert_eq!(retry_delay(0, Some(" 3 ")), Duration::from_secs(3));
        assert_eq!(retry_delay(0, Some("0")), Duration::from_secs(1));
        assert_eq!(retry_delay(0, Some("3600")), Duration::from_secs(30));
        // data HTTP não é interpretada: cai no padrão
        assert_eq!(retry_delay(1, Some("Wed, 21 Oct 2026 07:28:00 GMT")), Duration::from_secs(2));
    }

    #[test]
    fn mensagens_http_em_portugues() {
        assert!(friendly_http_error(401, r#"{"error":{"message":"Authentication Fails"}}"#).contains("Chave da API inválida"));
        assert!(friendly_http_error(402, "").contains("Saldo insuficiente"));
        assert!(friendly_http_error(429, "").contains("Muitas requisições"));
        assert!(friendly_http_error(503, "<html>Bad gateway</html>").contains("instável"));
        assert!(friendly_http_error(404, "").contains("URL base"));
        let m = friendly_http_error(400, r#"{"error":{"message":"Invalid max_tokens value"}}"#);
        assert!(m.contains("Invalid max_tokens value"));
        let m = friendly_http_error(
            400,
            r#"{"error":{"message":"This model's maximum context length is 65536 tokens"}}"#,
        );
        assert!(m.contains("contexto"));
        // corpo HTML não vaza para a interface
        assert!(!friendly_http_error(418, "<html><body>oops</body></html>").contains("<html"));
        assert!(friendly_http_error(418, "teapot").contains("teapot"));
    }

    #[test]
    fn mensagens_de_rede() {
        assert!(net_error_message(NetErrorKind::Connect, "dns error").contains("conexão com a internet"));
        assert!(net_error_message(NetErrorKind::Timeout, "").contains("demorou"));
        assert!(net_error_message(NetErrorKind::Body, "").contains("interrompida"));
        assert!(net_error_message(NetErrorKind::Other, "boom").contains("boom"));
    }

    #[test]
    fn mensagem_do_provedor_e_truncada_sem_cortar_utf8() {
        let longo = "ção ".repeat(200);
        let m = provider_message(&longo).unwrap();
        assert!(m.chars().count() <= 241);
    }

    #[test]
    fn limpa_chave_colada() {
        assert_eq!(clean_api_key("  sk-abc123  \n").unwrap(), "sk-abc123");
        assert_eq!(clean_api_key("Bearer sk-abc123").unwrap(), "sk-abc123");
        assert_eq!(clean_api_key("\"sk-abc123\"").unwrap(), "sk-abc123");
        assert!(clean_api_key("   ").is_err());
        assert!(clean_api_key("sk-abc 123").is_err());
        assert!(clean_api_key("sk-chavé").is_err());
        assert!(clean_api_key(&"a".repeat(600)).is_err());
        // "Bearer" com multibyte logo depois não pode causar pânico de fatiamento
        assert!(clean_api_key("Bearexé").is_err());
        assert!(clean_api_key("é").is_err());
    }

    #[test]
    fn valida_url_base() {
        assert_eq!(validate_base_url("https://api.deepseek.com/").unwrap(), "https://api.deepseek.com");
        assert_eq!(
            validate_base_url(" https://api.deepseek.com/chat/completions ").unwrap(),
            "https://api.deepseek.com"
        );
        assert_eq!(validate_base_url("https://api.deepseek.com/v1").unwrap(), "https://api.deepseek.com/v1");
        assert_eq!(validate_base_url("http://localhost:11434/v1").unwrap(), "http://localhost:11434/v1");
        assert!(validate_base_url("api.deepseek.com").is_err());
        assert!(validate_base_url("http://api.deepseek.com").is_err());
        assert!(validate_base_url("https://").is_err());
        assert!(validate_base_url("https://user:pw@host.com").is_err());
        assert!(validate_base_url("https://api deepseek.com").is_err());
        assert!(validate_base_url("").is_err());
    }
}
