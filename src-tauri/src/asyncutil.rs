//! Esperas assíncronas canceláveis, compartilhadas por chat, embeddings e OpenAlex.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Espera `d`, acordando a cada 100 ms para ver o cancelamento. `true` se cancelou.
pub async fn sleep_or_cancel(d: Duration, cancel: Option<&AtomicBool>) -> bool {
    let deadline = Instant::now() + d;
    loop {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        tokio::time::sleep((deadline - now).min(Duration::from_millis(100))).await;
    }
}

/// Resolve quando o sinal de cancelamento é acionado (nunca, se não houver sinal).
pub async fn wait_cancelled(cancel: Option<&AtomicBool>) {
    match cancel {
        Some(flag) => {
            while !flag.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}
