//! Cofre real do sistema: Keychain no macOS e Credential Manager no Windows.
//! Em outras plataformas (ou se o cofre falhar) o app usa o fallback em SQLite.

use crate::secrets::SecretStore;

#[cfg(any(target_os = "macos", target_os = "windows", margem_keyring))]
mod native {
    use super::SecretStore;

    const SERVICE: &str = "br.com.gerlan.pdfchat";

    /// Um segredo por `account` (chave da DeepSeek, chave dos embeddings...).
    pub struct SystemStore(pub &'static str);

    impl SystemStore {
        fn entry(&self) -> Result<keyring::Entry, String> {
            keyring::Entry::new(SERVICE, self.0).map_err(|e| format!("Cofre do sistema indisponível: {e}"))
        }
    }

    impl SecretStore for SystemStore {
        fn get(&self) -> Result<Option<String>, String> {
            match self.entry()?.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(format!("Não foi possível ler o cofre do sistema: {e}")),
            }
        }

        fn set(&self, value: &str) -> Result<(), String> {
            self.entry()?
                .set_password(value)
                .map_err(|e| format!("Não foi possível gravar no cofre do sistema: {e}"))
        }

        fn delete(&self) -> Result<(), String> {
            match self.entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(format!("Não foi possível remover do cofre do sistema: {e}")),
            }
        }
    }
}

/// Conta do cofre onde fica a chave da DeepSeek.
pub const ACCOUNT_DEEPSEEK: &str = "deepseek-api-key";
/// Conta do cofre onde fica a chave (opcional) do servidor de embeddings.
pub const ACCOUNT_EMBED: &str = "embeddings-api-key";

pub fn system_store() -> Box<dyn SecretStore> {
    system_store_for(ACCOUNT_DEEPSEEK)
}

pub fn system_store_for(account: &'static str) -> Box<dyn SecretStore> {
    #[cfg(any(target_os = "macos", target_os = "windows", margem_keyring))]
    {
        Box::new(native::SystemStore(account))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", margem_keyring)))]
    {
        let _ = account;
        Box::new(crate::secrets::NoStore)
    }
}
