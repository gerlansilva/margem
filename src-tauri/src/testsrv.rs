//! Servidor HTTP mínimo em 127.0.0.1 para os testes de rede (sem dependências).

use std::future::Future;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, v: &Value) -> Self {
        Self::bytes(status, "application/json", serde_json::to_vec(v).unwrap())
    }
    pub fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Reply { status, headers: vec![("Content-Type".into(), content_type.into())], body }
    }
    pub fn text(status: u16, body: &str) -> Self {
        Self::bytes(status, "text/plain", body.as_bytes().to_vec())
    }
    pub fn with_header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
    pub fn redirect(location: &str) -> Self {
        Reply { status: 302, headers: vec![("Location".into(), location.into())], body: vec![] }
    }
}

pub struct Server {
    pub base: String,
    /// "GET /caminho?consulta" seguido dos cabeçalhos, um item por pedido.
    pub requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    addr: std::net::SocketAddr,
}

impl Server {
    pub fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
    pub fn request(&self, i: usize) -> String {
        self.requests.lock().unwrap()[i].clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        302 => "Found",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

/// `handler(n, alvo)`: n é o índice (0, 1, ...) do pedido; alvo é caminho + consulta.
pub fn serve<F>(handler: F) -> Server
where
    F: Fn(usize, &str) -> Reply + Send + Sync + 'static,
{
    serve_body(move |n, target, _| handler(n, target))
}

/// Como `serve`, mas o handler também recebe o corpo do pedido (POST).
pub fn serve_body<F>(handler: F) -> Server
where
    F: Fn(usize, &str, &str) -> Reply + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let handler = Arc::new(handler);
    let (reqs, stop2) = (requests.clone(), stop.clone());
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stop2.load(Ordering::SeqCst) {
                break;
            }
            let Ok(mut stream) = conn else { continue };
            let (reqs, handler) = (reqs.clone(), handler.clone());
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                loop {
                    let n = stream.read(&mut tmp).unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        // lê o corpo (POST) até o Content-Length
                        let head = String::from_utf8_lossy(&buf[..p]).to_string();
                        let len = head
                            .lines()
                            .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        while buf.len() < p + 4 + len {
                            let n = stream.read(&mut tmp).unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            buf.extend_from_slice(&tmp[..n]);
                        }
                        let body = String::from_utf8_lossy(&buf[(p + 4).min(buf.len())..]).to_string();
                        let first = head.lines().next().unwrap_or("").to_string();
                        let target = first.split_whitespace().nth(1).unwrap_or("/").to_string();
                        let idx = {
                            let mut r = reqs.lock().unwrap();
                            r.push(format!("{head}\r\n\r\n{body}"));
                            r.len() - 1
                        };
                        let reply = handler(idx, &target, &body);
                        let mut out = format!("HTTP/1.1 {} {}\r\nConnection: close\r\nContent-Length: {}\r\n", reply.status, reason(reply.status), reply.body.len());
                        for (k, v) in &reply.headers {
                            out.push_str(&format!("{k}: {v}\r\n"));
                        }
                        out.push_str("\r\n");
                        let _ = stream.write_all(out.as_bytes());
                        let _ = stream.write_all(&reply.body);
                        let _ = stream.flush();
                        return;
                    }
                }
            });
        }
    });
    Server { base: format!("http://{addr}"), requests, stop, addr }
}

pub fn block_on<F: Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}
