//! Where secrets live: the endpoint API key is kept in the OS credential
//! store (Keychain on macOS, Credential Manager on Windows, the Secret
//! Service on Linux) rather than in settings.json.
//!
//! [`SettingsStore`](crate::settings::SettingsStore) talks to a
//! [`KeyStore`], so tests use [`MemoryKeyStore`] and never the real one.

use std::fmt;

/// What the credential store files the key under: the app's identifier
/// from tauri.conf.json, and what the key is for.
const SERVICE: &str = "com.kerwincarpede.grabit";
const ACCOUNT: &str = "ai-endpoint-api-key";

/// The credential store could not be reached or refused the request, for
/// example because Linux has no Secret Service running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyStoreError(pub String);

impl fmt::Display for KeyStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for KeyStoreError {}

/// Holds the one API key Grab-it has.
pub trait KeyStore: Send + fmt::Debug {
    /// The stored key; none when no key is stored. An error means the
    /// store itself does not work.
    fn get(&self) -> Result<Option<String>, KeyStoreError>;
    /// Stores `key`, replacing any earlier one.
    fn set(&self, key: &str) -> Result<(), KeyStoreError>;
    /// Removes the key. Removing a key that is not there is not an error.
    fn delete(&self) -> Result<(), KeyStoreError>;
}

/// The OS credential store, through the `keyring` crate.
#[derive(Debug, Default)]
pub struct OsKeyStore;

impl OsKeyStore {
    fn entry() -> Result<keyring::Entry, KeyStoreError> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(failed)
    }
}

fn failed(err: keyring::Error) -> KeyStoreError {
    KeyStoreError(err.to_string())
}

impl KeyStore for OsKeyStore {
    fn get(&self) -> Result<Option<String>, KeyStoreError> {
        match Self::entry()?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(failed(err)),
        }
    }

    fn set(&self, key: &str) -> Result<(), KeyStoreError> {
        Self::entry()?.set_password(key).map_err(failed)
    }

    fn delete(&self) -> Result<(), KeyStoreError> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(failed(err)),
        }
    }
}

/// A key store in memory, for tests. Clones share the same key, so a test
/// can hand one to a settings store and look inside it afterwards.
#[cfg(test)]
#[derive(Debug, Clone, Default)]
pub struct MemoryKeyStore {
    key: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// Every call fails, as on a system without a credential store.
    broken: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(test)]
impl MemoryKeyStore {
    /// A store already holding `key`.
    pub fn with_key(key: &str) -> Self {
        let store = Self::default();
        *store.key.lock().unwrap() = Some(key.to_owned());
        store
    }

    /// A store whose every call fails.
    pub fn unavailable() -> Self {
        let store = Self::default();
        store.set_broken(true);
        store
    }

    /// Makes every later call fail, or work again.
    pub fn set_broken(&self, broken: bool) {
        self.broken
            .store(broken, std::sync::atomic::Ordering::SeqCst);
    }

    /// What the store holds, without going through [`KeyStore`].
    pub fn stored(&self) -> Option<String> {
        self.key.lock().unwrap().clone()
    }

    fn check(&self) -> Result<(), KeyStoreError> {
        if self.broken.load(std::sync::atomic::Ordering::SeqCst) {
            Err(KeyStoreError("no credential store".into()))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
impl KeyStore for MemoryKeyStore {
    fn get(&self) -> Result<Option<String>, KeyStoreError> {
        self.check()?;
        Ok(self.stored())
    }

    fn set(&self, key: &str) -> Result<(), KeyStoreError> {
        self.check()?;
        *self.key.lock().unwrap() = Some(key.to_owned());
        Ok(())
    }

    fn delete(&self) -> Result<(), KeyStoreError> {
        self.check()?;
        *self.key.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_memory_store_sets_gets_and_deletes() {
        let store = MemoryKeyStore::default();
        assert_eq!(store.get(), Ok(None));
        store.set("sk-1").unwrap();
        assert_eq!(store.get(), Ok(Some("sk-1".into())));
        // Clones share the key.
        assert_eq!(store.clone().stored().as_deref(), Some("sk-1"));
        store.delete().unwrap();
        store.delete().unwrap();
        assert_eq!(store.get(), Ok(None));
    }

    #[test]
    fn an_unavailable_store_fails_every_call() {
        let store = MemoryKeyStore::unavailable();
        assert!(store.get().is_err());
        assert!(store.set("sk-1").is_err());
        assert!(store.delete().is_err());
        assert_eq!(store.stored(), None);
    }
}
