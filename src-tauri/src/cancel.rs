//! Registro de pedidos de chat cancelados. O cancelamento pode chegar antes de
//! o chat registrar o pedido, ou depois de ele terminar, sem vazar memória.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(15 * 60);
const MAX_ENTRIES: usize = 512;

/// Documentos com extração em andamento: impede duas extrações simultâneas do
/// mesmo documento (uma sobrescreveria as células da outra). O Mutex só é
/// segurado dentro das funções, nunca através de um `.await`.
#[derive(Default, Clone)]
pub struct BusyDocs {
    inner: Arc<Mutex<HashSet<String>>>,
}

pub struct BusyGuard {
    set: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.set.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
    }
}

impl BusyDocs {
    /// `None` se o documento já está ocupado. A trava some quando o guarda cai.
    pub fn try_acquire(&self, id: &str) -> Option<BusyGuard> {
        let mut set = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(id.to_string()) {
            return None;
        }
        Some(BusyGuard { set: self.inner.clone(), id: id.to_string() })
    }
}

#[derive(Default)]
pub struct CancelRegistry {
    inner: Mutex<HashMap<String, (Arc<AtomicBool>, Instant)>>,
}

impl CancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Arc<AtomicBool>, Instant)>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn entry(map: &mut HashMap<String, (Arc<AtomicBool>, Instant)>, id: &str) -> Arc<AtomicBool> {
        let now = Instant::now();
        if map.len() >= MAX_ENTRIES {
            map.retain(|_, (_, at)| now.duration_since(*at) < TTL);
        }
        if map.len() >= MAX_ENTRIES {
            map.clear(); // proteção extra; pedidos reais são poucos e curtos
        }
        map.entry(id.to_string())
            .or_insert_with(|| (Arc::new(AtomicBool::new(false)), now))
            .0
            .clone()
    }

    /// Sinal do pedido; já nasce cancelado se o cancelamento chegou antes.
    pub fn token(&self, id: &str) -> Arc<AtomicBool> {
        Self::entry(&mut self.lock(), id)
    }

    pub fn cancel(&self, id: &str) {
        Self::entry(&mut self.lock(), id).store(true, Ordering::SeqCst);
    }

    pub fn release(&self, id: &str) {
        self.lock().remove(id);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelar_depois_de_registrar() {
        let r = CancelRegistry::new();
        let t = r.token("a");
        assert!(!t.load(Ordering::SeqCst));
        r.cancel("a");
        assert!(t.load(Ordering::SeqCst));
        r.release("a");
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn cancelar_antes_de_registrar() {
        let r = CancelRegistry::new();
        r.cancel("b");
        assert!(r.token("b").load(Ordering::SeqCst));
    }

    #[test]
    fn documento_ocupado_so_libera_ao_soltar_o_guarda() {
        let busy = BusyDocs::default();
        let g = busy.try_acquire("d1").expect("livre");
        assert!(busy.try_acquire("d1").is_none());
        assert!(busy.try_acquire("d2").is_some()); // outro documento não é afetado
        drop(g);
        assert!(busy.try_acquire("d1").is_some());
    }

    #[test]
    fn guarda_libera_mesmo_com_pânico() {
        let busy = BusyDocs::default();
        let b2 = busy.clone();
        let _ = std::thread::spawn(move || {
            let _g = b2.try_acquire("d1").unwrap();
            panic!("falha no meio da extração");
        })
        .join();
        assert!(busy.try_acquire("d1").is_some());
    }

    #[test]
    fn ids_independentes() {
        let r = CancelRegistry::new();
        let a = r.token("a");
        let b = r.token("b");
        r.cancel("a");
        assert!(a.load(Ordering::SeqCst));
        assert!(!b.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelamentos_orfaos_nao_crescem_sem_limite() {
        let r = CancelRegistry::new();
        for i in 0..5_000 {
            r.cancel(&format!("x{i}"));
        }
        assert!(r.len() <= MAX_ENTRIES);
    }
}
