use crate::db::dto::CommandError;
use keyring::{Entry, Error as KeyringError};
use std::sync::Mutex;

const KEYRING_SERVICE_NAME: &str = "com.bizora.desktop.auth";
const CHUNK_MANIFEST_PREFIX: &str = "__bizora_chunked_v1__:";
const MAX_CHUNK_CHARS: usize = 700;
const MAX_STORAGE_KEY_LEN: usize = 180;

/// Serializes OS keyring operations so Windows Credential Manager (`CredWriteW` /
/// `CredDeleteW`) never experiences multi-threaded entry races.
static KEYRING_IO_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretBackendError {
    NotFound,
    Unavailable(String),
}

pub trait SecretBackend {
    fn get_secret(&self, entry_key: &str) -> Result<String, SecretBackendError>;
    fn set_secret(&self, entry_key: &str, value: &str) -> Result<(), SecretBackendError>;
    fn delete_secret(&self, entry_key: &str) -> Result<(), SecretBackendError>;
}

struct OsKeyringBackend;

impl SecretBackend for OsKeyringBackend {
    fn get_secret(&self, entry_key: &str) -> Result<String, SecretBackendError> {
        let entry = Entry::new(KEYRING_SERVICE_NAME, entry_key).map_err(|_| {
            SecretBackendError::Unavailable(
                "Unable to initialize OS credential store handle".to_string(),
            )
        })?;

        match entry.get_password() {
            Ok(secret) => Ok(secret),
            Err(KeyringError::NoEntry) => Err(SecretBackendError::NotFound),
            Err(_) => Err(SecretBackendError::Unavailable(
                "Unable to read credential from OS credential store".to_string(),
            )),
        }
    }

    fn set_secret(&self, entry_key: &str, value: &str) -> Result<(), SecretBackendError> {
        let entry = Entry::new(KEYRING_SERVICE_NAME, entry_key).map_err(|_| {
            SecretBackendError::Unavailable(
                "Unable to initialize OS credential store handle".to_string(),
            )
        })?;

        entry.set_password(value).map_err(|_| {
            SecretBackendError::Unavailable(
                "Unable to save credential to OS credential store".to_string(),
            )
        })
    }

    fn delete_secret(&self, entry_key: &str) -> Result<(), SecretBackendError> {
        let entry = Entry::new(KEYRING_SERVICE_NAME, entry_key).map_err(|_| {
            SecretBackendError::Unavailable(
                "Unable to initialize OS credential store handle".to_string(),
            )
        })?;

        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(SecretBackendError::Unavailable(
                "Unable to remove credential from OS credential store".to_string(),
            )),
        }
    }
}

fn validate_storage_key(raw_key: &str) -> Result<String, CommandError> {
    let trimmed = raw_key.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_STORAGE_KEY_LEN {
        return Err(CommandError {
            code: "INVALID_INPUT".to_string(),
            message: "Secure storage key is invalid or exceeds maximum length".to_string(),
            field: Some("key".to_string()),
        });
    }

    let is_valid = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'));
    if !is_valid || trimmed.contains(".__chunk_") {
        return Err(CommandError {
            code: "INVALID_INPUT".to_string(),
            message: "Secure storage key contains unsupported characters".to_string(),
            field: Some("key".to_string()),
        });
    }

    Ok(trimmed.to_string())
}

fn chunk_entry_key(base_key: &str, index: usize) -> String {
    format!("{base_key}.__chunk_{index}")
}

fn parse_chunk_manifest(raw: &str) -> Option<usize> {
    let count_str = raw.strip_prefix(CHUNK_MANIFEST_PREFIX)?;
    count_str.parse::<usize>().ok()
}

fn cleanup_chunks<B: SecretBackend>(
    backend: &B,
    base_key: &str,
    from_index: usize,
    to_exclusive: usize,
) {
    for idx in from_index..to_exclusive {
        let _ = backend.delete_secret(&chunk_entry_key(base_key, idx));
    }
}

pub fn get_item_with_backend<B: SecretBackend>(
    backend: &B,
    raw_key: &str,
) -> Result<Option<String>, CommandError> {
    let key = validate_storage_key(raw_key)?;

    let manifest = match backend.get_secret(&key) {
        Ok(value) => value,
        Err(SecretBackendError::NotFound) => return Ok(None),
        Err(SecretBackendError::Unavailable(msg)) => {
            return Err(CommandError {
                code: "SECURE_STORAGE_UNAVAILABLE".to_string(),
                message: msg,
                field: None,
            })
        }
    };

    if let Some(chunk_count) = parse_chunk_manifest(&manifest) {
        if chunk_count == 0 {
            return Ok(Some(String::new()));
        }

        let mut combined = String::new();
        for idx in 0..chunk_count {
            match backend.get_secret(&chunk_entry_key(&key, idx)) {
                Ok(part) => combined.push_str(&part),
                Err(SecretBackendError::NotFound) => {
                    // Clean up partial/corrupted chunked credential so auth falls back to signed-out cleanly
                    cleanup_chunks(backend, &key, 0, chunk_count);
                    let _ = backend.delete_secret(&key);
                    return Ok(None);
                }
                Err(SecretBackendError::Unavailable(msg)) => {
                    return Err(CommandError {
                        code: "SECURE_STORAGE_UNAVAILABLE".to_string(),
                        message: msg,
                        field: None,
                    })
                }
            }
        }
        return Ok(Some(combined));
    }

    Ok(Some(manifest))
}

pub fn set_item_with_backend<B: SecretBackend>(
    backend: &B,
    raw_key: &str,
    value: &str,
) -> Result<(), CommandError> {
    let key = validate_storage_key(raw_key)?;

    // Inspect any previous chunk manifest so stale trailing chunks can be removed
    let previous_chunk_count = match backend.get_secret(&key) {
        Ok(existing) => parse_chunk_manifest(&existing).unwrap_or(0),
        Err(_) => 0,
    };

    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0usize;

    for ch in value.chars() {
        current.push(ch);
        current_chars += 1;
        if current_chars >= MAX_CHUNK_CHARS {
            chunks.push(std::mem::take(&mut current));
            current_chars = 0;
        }
    }
    if !current.is_empty() || chunks.is_empty() {
        chunks.push(current);
    }

    for (idx, chunk) in chunks.iter().enumerate() {
        backend
            .set_secret(&chunk_entry_key(&key, idx), chunk)
            .map_err(|err| match err {
                SecretBackendError::Unavailable(msg) | SecretBackendError::NotFound => {
                    let msg = if matches!(err, SecretBackendError::NotFound) {
                        "OS credential store entry could not be created".to_string()
                    } else {
                        msg
                    };
                    CommandError {
                        code: "SECURE_STORAGE_UNAVAILABLE".to_string(),
                        message: msg,
                        field: None,
                    }
                }
            })?;
    }

    let manifest = format!("{CHUNK_MANIFEST_PREFIX}{}", chunks.len());
    backend.set_secret(&key, &manifest).map_err(|err| match err {
        SecretBackendError::Unavailable(msg) => CommandError {
            code: "SECURE_STORAGE_UNAVAILABLE".to_string(),
            message: msg,
            field: None,
        },
        SecretBackendError::NotFound => CommandError {
            code: "SECURE_STORAGE_UNAVAILABLE".to_string(),
            message: "OS credential store manifest could not be saved".to_string(),
            field: None,
        },
    })?;

    if previous_chunk_count > chunks.len() {
        cleanup_chunks(backend, &key, chunks.len(), previous_chunk_count);
    }

    Ok(())
}

pub fn remove_item_with_backend<B: SecretBackend>(
    backend: &B,
    raw_key: &str,
) -> Result<(), CommandError> {
    let key = validate_storage_key(raw_key)?;

    if let Ok(existing) = backend.get_secret(&key) {
        if let Some(chunk_count) = parse_chunk_manifest(&existing) {
            cleanup_chunks(backend, &key, 0, chunk_count);
        }
    }

    backend.delete_secret(&key).map_err(|err| match err {
        SecretBackendError::Unavailable(msg) => CommandError {
            code: "SECURE_STORAGE_UNAVAILABLE".to_string(),
            message: msg,
            field: None,
        },
        SecretBackendError::NotFound => CommandError {
            code: "SECURE_STORAGE_UNAVAILABLE".to_string(),
            message: "OS credential store entry missing".to_string(),
            field: None,
        },
    })
}

#[tauri::command]
pub async fn secure_storage_get_item(key: String) -> Result<Option<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = KEYRING_IO_LOCK.lock().map_err(|_| CommandError {
            code: "INTERNAL_ERROR".to_string(),
            message: "Credential storage lock was poisoned".to_string(),
            field: None,
        })?;
        get_item_with_backend(&OsKeyringBackend, &key)
    })
    .await
    .map_err(|_| CommandError {
        code: "INTERNAL_ERROR".to_string(),
        message: "Credential read task failed unexpectedly".to_string(),
        field: None,
    })?
}

#[tauri::command]
pub async fn secure_storage_set_item(key: String, value: String) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = KEYRING_IO_LOCK.lock().map_err(|_| CommandError {
            code: "INTERNAL_ERROR".to_string(),
            message: "Credential storage lock was poisoned".to_string(),
            field: None,
        })?;
        set_item_with_backend(&OsKeyringBackend, &key, &value)
    })
    .await
    .map_err(|_| CommandError {
        code: "INTERNAL_ERROR".to_string(),
        message: "Credential write task failed unexpectedly".to_string(),
        field: None,
    })?
}

#[tauri::command]
pub async fn secure_storage_remove_item(key: String) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = KEYRING_IO_LOCK.lock().map_err(|_| CommandError {
            code: "INTERNAL_ERROR".to_string(),
            message: "Credential storage lock was poisoned".to_string(),
            field: None,
        })?;
        remove_item_with_backend(&OsKeyringBackend, &key)
    })
    .await
    .map_err(|_| CommandError {
        code: "INTERNAL_ERROR".to_string(),
        message: "Credential removal task failed unexpectedly".to_string(),
        field: None,
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct InMemorySecretBackend {
        map: StdMutex<HashMap<String, String>>,
    }

    impl InMemorySecretBackend {
        fn len(&self) -> usize {
            self.map.lock().expect("lock").len()
        }
    }

    impl SecretBackend for InMemorySecretBackend {
        fn get_secret(&self, entry_key: &str) -> Result<String, SecretBackendError> {
            self.map
                .lock()
                .expect("lock")
                .get(entry_key)
                .cloned()
                .ok_or(SecretBackendError::NotFound)
        }

        fn set_secret(&self, entry_key: &str, value: &str) -> Result<(), SecretBackendError> {
            self.map
                .lock()
                .expect("lock")
                .insert(entry_key.to_string(), value.to_string());
            Ok(())
        }

        fn delete_secret(&self, entry_key: &str) -> Result<(), SecretBackendError> {
            self.map.lock().expect("lock").remove(entry_key);
            Ok(())
        }
    }

    #[test]
    fn stores_and_restores_large_chunked_session_payloads_and_cleans_up_on_remove() {
        let backend = InMemorySecretBackend::default();
        let large_payload = "eyJhbGciOiJIUzI1NiJ9.".repeat(150);
        assert!(large_payload.len() > 2500);

        set_item_with_backend(&backend, "sb-bizora-auth-token", &large_payload)
            .expect("should write chunked session");
        assert!(backend.len() > 2);

        let loaded = get_item_with_backend(&backend, "sb-bizora-auth-token")
            .expect("should read chunked session");
        assert_eq!(loaded.as_deref(), Some(large_payload.as_str()));

        // Shrinking overwrite removes obsolete trailing chunks
        set_item_with_backend(&backend, "sb-bizora-auth-token", "short_value")
            .expect("should overwrite with smaller payload");
        assert_eq!(backend.len(), 2); // manifest + 1 chunk
        assert_eq!(
            get_item_with_backend(&backend, "sb-bizora-auth-token").unwrap().as_deref(),
            Some("short_value")
        );

        remove_item_with_backend(&backend, "sb-bizora-auth-token")
            .expect("should delete manifest and chunks");
        assert_eq!(backend.len(), 0);
        assert_eq!(
            get_item_with_backend(&backend, "sb-bizora-auth-token").unwrap(),
            None
        );
    }

    #[test]
    fn corrupt_missing_chunk_cleans_up_and_returns_none() {
        let backend = InMemorySecretBackend::default();
        let payload = "a".repeat(1600);
        set_item_with_backend(&backend, "sb-bizora-auth-token", &payload).unwrap();

        backend
            .delete_secret(&chunk_entry_key("sb-bizora-auth-token", 1))
            .unwrap();

        let loaded = get_item_with_backend(&backend, "sb-bizora-auth-token").unwrap();
        assert_eq!(loaded, None);
        assert_eq!(backend.len(), 0);
    }

    #[test]
    fn rejects_invalid_or_reserved_storage_keys() {
        let backend = InMemorySecretBackend::default();
        assert!(set_item_with_backend(&backend, "", "x").is_err());
        assert!(set_item_with_backend(&backend, "../escape", "x").is_err());
        assert!(set_item_with_backend(&backend, "bad.__chunk_0", "x").is_err());
    }
}
