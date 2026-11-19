//! Cofre real do sistema: Keychain no macOS e Credential Manager no Windows.
//! Em outras plataformas (ou se o cofre falhar) o app usa o fallback em SQLite.

use crate::secrets::SecretStore;

#[cfg(any(target_os = "macos", target_os = "windows", margem_keyring))]
mod native {
    use super::SecretStore;

    const SERVICE: &str = "br.com.gerlan.pdfchat";
    const ACCOUNT: &str = "deepseek-api-key";

    pub struct SystemStore;

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Cofre do sistema indisponível: {e}"))
    }

    impl SecretStore for SystemStore {
        fn get(&self) -> Result<Option<String>, String> {
            match entry()?.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(format!("Não foi possível ler o cofre do sistema: {e}")),
            }
        }

        fn set(&self, value: &str) -> Result<(), String> {
            entry()?
                .set_password(value)
                .map_err(|e| format!("Não foi possível gravar no cofre do sistema: {e}"))
        }

        fn delete(&self) -> Result<(), String> {
            match entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(format!("Não foi possível remover do cofre do sistema: {e}")),
            }
        }
    }
}

pub fn system_store() -> Box<dyn SecretStore> {
    #[cfg(any(target_os = "macos", target_os = "windows", margem_keyring))]
    {
        Box::new(native::SystemStore)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", margem_keyring)))]
    {
        Box::new(crate::secrets::NoStore)
    }
}
