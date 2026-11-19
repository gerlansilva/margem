//! Guarda da chave da API. A lógica (migração, verificação, ordem de busca) é
//! independente do sistema operacional; o cofre real fica em `keystore.rs`.

use serde::Serialize;

/// Cofre de um único segredo (a chave da API).
pub trait SecretStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// Plataforma sem cofre (ou cofre indisponível): tudo falha e o app usa o arquivo.
pub struct NoStore;

impl SecretStore for NoStore {
    fn get(&self) -> Result<Option<String>, String> {
        Err("Cofre do sistema indisponível nesta plataforma.".into())
    }
    fn set(&self, _: &str) -> Result<(), String> {
        Err("Cofre do sistema indisponível nesta plataforma.".into())
    }
    fn delete(&self) -> Result<(), String> {
        Err("Cofre do sistema indisponível nesta plataforma.".into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    /// Variável de ambiente DEEPSEEK_API_KEY.
    Env,
    /// Keychain (macOS) ou Credential Manager (Windows).
    Keychain,
    /// Texto puro no SQLite: legado ou fallback quando o cofre falha.
    File,
    None,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Migration {
    NothingToDo,
    /// A chave está no cofre; o chamador pode apagar a cópia do SQLite.
    Migrated,
    /// O cofre falhou; a cópia do SQLite deve ser mantida.
    KeptInFile(String),
}

fn nonblank(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Grava no cofre e confere lendo de volta; só então o chamador remove a cópia antiga.
pub fn save_key(store: &dyn SecretStore, key: &str) -> Result<(), String> {
    store.set(key)?;
    match store.get()? {
        Some(read) if read == key => Ok(()),
        _ => Err("O cofre do sistema não confirmou a gravação da chave.".to_string()),
    }
}

/// Move a chave antiga do SQLite para o cofre, sem nunca perdê-la.
pub fn migrate_legacy(store: &dyn SecretStore, legacy: Option<&str>) -> Migration {
    let Some(legacy) = nonblank(legacy.map(str::to_string)) else {
        return Migration::NothingToDo;
    };
    match store.get() {
        // O cofre já tem uma chave (mais recente): ela vence, a antiga some.
        Ok(Some(existing)) if !existing.trim().is_empty() => Migration::Migrated,
        Ok(_) => match save_key(store, &legacy) {
            Ok(()) => Migration::Migrated,
            Err(why) => Migration::KeptInFile(why),
        },
        Err(why) => Migration::KeptInFile(why),
    }
}

/// Ordem de busca: variável de ambiente, cofre, arquivo.
pub fn resolve_key(
    env: Option<String>,
    store: &dyn SecretStore,
    legacy: Option<String>,
) -> (Option<String>, KeySource) {
    if let Some(key) = nonblank(env) {
        return (Some(key), KeySource::Env);
    }
    if let Ok(found) = store.get() {
        if let Some(key) = nonblank(found) {
            return (Some(key), KeySource::Keychain);
        }
    }
    if let Some(key) = nonblank(legacy) {
        return (Some(key), KeySource::File);
    }
    (None, KeySource::None)
}

#[cfg(test)]
pub mod mem {
    use super::*;
    use std::sync::Mutex;

    /// Cofre em memória; `fail` simula Keychain bloqueado, `lossy` simula um
    /// cofre que aceita a gravação mas não devolve o valor.
    #[derive(Default)]
    pub struct MemStore {
        pub value: Mutex<Option<String>>,
        pub fail: bool,
        pub lossy: bool,
    }

    impl SecretStore for MemStore {
        fn get(&self) -> Result<Option<String>, String> {
            if self.fail {
                return Err("bloqueado".into());
            }
            Ok(self.value.lock().unwrap().clone())
        }
        fn set(&self, v: &str) -> Result<(), String> {
            if self.fail {
                return Err("bloqueado".into());
            }
            if !self.lossy {
                *self.value.lock().unwrap() = Some(v.to_string());
            }
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            if self.fail {
                return Err("bloqueado".into());
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::mem::MemStore;
    use super::*;

    #[test]
    fn migra_chave_do_sqlite_para_o_cofre() {
        let store = MemStore::default();
        assert_eq!(migrate_legacy(&store, Some("sk-antiga")), Migration::Migrated);
        assert_eq!(store.get().unwrap().as_deref(), Some("sk-antiga"));
    }

    #[test]
    fn sem_chave_antiga_nada_a_fazer() {
        let store = MemStore::default();
        assert_eq!(migrate_legacy(&store, None), Migration::NothingToDo);
        assert_eq!(migrate_legacy(&store, Some("   ")), Migration::NothingToDo);
        assert_eq!(store.get().unwrap(), None);
    }

    #[test]
    fn cofre_com_falha_mantem_a_chave_no_arquivo() {
        let store = MemStore { fail: true, ..Default::default() };
        assert!(matches!(migrate_legacy(&store, Some("sk-x")), Migration::KeptInFile(_)));
        let (key, source) = resolve_key(None, &store, Some("sk-x".into()));
        assert_eq!((key.as_deref(), source), (Some("sk-x"), KeySource::File));
    }

    #[test]
    fn cofre_que_nao_confirma_leitura_nao_apaga_a_copia_antiga() {
        let store = MemStore { lossy: true, ..Default::default() };
        assert!(matches!(migrate_legacy(&store, Some("sk-x")), Migration::KeptInFile(_)));
    }

    #[test]
    fn chave_do_cofre_vence_a_do_arquivo() {
        let store = MemStore::default();
        store.set("sk-nova").unwrap();
        assert_eq!(migrate_legacy(&store, Some("sk-velha")), Migration::Migrated);
        assert_eq!(store.get().unwrap().as_deref(), Some("sk-nova"));
    }

    #[test]
    fn ordem_env_cofre_arquivo() {
        let store = MemStore::default();
        store.set("sk-cofre").unwrap();
        let (k, s) = resolve_key(Some("sk-env".into()), &store, Some("sk-arq".into()));
        assert_eq!((k.as_deref(), s), (Some("sk-env"), KeySource::Env));
        let (k, s) = resolve_key(Some("  ".into()), &store, Some("sk-arq".into()));
        assert_eq!((k.as_deref(), s), (Some("sk-cofre"), KeySource::Keychain));
        store.delete().unwrap();
        let (k, s) = resolve_key(None, &store, Some("sk-arq".into()));
        assert_eq!((k.as_deref(), s), (Some("sk-arq"), KeySource::File));
        let (k, s) = resolve_key(None, &store, None);
        assert_eq!((k, s), (None, KeySource::None));
    }

    #[test]
    fn save_key_confere_a_leitura() {
        let ok = MemStore::default();
        assert!(save_key(&ok, "sk-1").is_ok());
        let lossy = MemStore { lossy: true, ..Default::default() };
        assert!(save_key(&lossy, "sk-1").is_err());
        assert!(save_key(&NoStore, "sk-1").is_err());
    }

    #[test]
    fn serializa_origem_em_minusculas() {
        assert_eq!(serde_json::to_string(&KeySource::Keychain).unwrap(), "\"keychain\"");
        assert_eq!(serde_json::to_string(&KeySource::None).unwrap(), "\"none\"");
    }
}
