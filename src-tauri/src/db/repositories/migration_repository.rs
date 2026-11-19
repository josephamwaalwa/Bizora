use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::db::dto::{
    BackupLegacyStorageInput, BackupLegacyStorageResult, CreateActivityLogInput,
    CreateBusinessAssetInput, CreateBusinessInput, CreateClientInput, CreateInvoiceInput,
    CreateLocalProfileInput, CreatePaymentInput, CreateQuotationInput,
    LegacyWorkspaceMigrationInput, LineItemInput, MigrationCountsDto, MigrationDiagnosticDto,
    MigrationResultDto, MigrationState, MigrationStatusDto, ReplaceDesktopWorkspaceInput,
    SaveAppSettingInput, WorkspaceLifecycleResultDto,
};
use crate::db::precision::{require_non_negative, require_positive, SafeI64};
use crate::db::repositories::{
    current_utc_iso, map_rusqlite_error, require_non_empty_id, require_trimmed_non_empty,
    validate_enum, validate_iso_date, validate_json_text, validate_optional_iso_date,
    validate_optional_non_empty, ACTIVITY_TYPES, ASSET_SOURCE_TYPES, DISCOUNT_TYPES,
    INVOICE_STATUSES, PAYMENT_METHODS, QUOTATION_STATUSES,
};
use crate::db::DbError;

pub const MIGRATION_SETTING_KEY: &str = "migration.localstorage_v1";
pub const MIGRATION_ERROR_SETTING_KEY: &str = "migration.localstorage_v1_last_error";
pub const MIGRATION_MARKER_VERSION: i64 = 1;

const BACKUP_DIR_NAME: &str = "backups";
const BACKUP_FILE_PREFIX: &str = "bizora-localstorage-pre-migration-";
const BACKUP_FILE_SUFFIX: &str = ".json";

pub const ALLOWED_LEGACY_KEYS: [&str; 8] = [
    "bizora_business_profile_v1",
    "bizora_clients_v1",
    "bizora_quotations_v1",
    "bizora_invoices_v1",
    "bizora_activities_v1",
    "bizora_has_initialized_v1",
    "bizora_logo_cache_v1",
    "bizora_theme_preference_v1",
];

static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationMarkerPayload {
    version: i64,
    status: String,
    source: String,
    #[serde(default)]
    migrated_business_id: Option<String>,
    #[serde(default)]
    local_profile_id: Option<String>,
    #[serde(default)]
    backup_filename: Option<String>,
    #[serde(default)]
    counts: Option<MigrationCountsDto>,
    #[serde(default)]
    diagnostics: Vec<MigrationDiagnosticDto>,
    #[serde(default)]
    completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBackupEnvelope {
    schema_version: i64,
    captured_at: String,
    created_at_utc: String,
    source: String,
    keys: Vec<crate::db::dto::RawLegacyKeyEntry>,
}

// ============================================================
// Zero-dependency FIPS 180-4 SHA-256
// ============================================================

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(data.len() + 72);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0x00);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = String::with_capacity(64);
    for word in h {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{word:08x}");
    }
    out
}

fn format_utc_timestamp_parts() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;

    // Howard Hinnant civil-from-days algorithm (UTC Gregorian calendar).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };

    let compact = format!("{year:04}{m:02}{d:02}T{hour:02}{minute:02}{second:02}Z");
    let iso = format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.000Z");
    (compact, iso)
}

fn resolve_backups_dir(db_path: &Path) -> Result<PathBuf, DbError> {
    let parent = db_path.parent().ok_or_else(|| {
        DbError::PathResolution("Application database directory could not be resolved".to_string())
    })?;
    if parent.as_os_str().is_empty() {
        return Err(DbError::PathResolution(
            "Application database directory is unavailable".to_string(),
        ));
    }
    Ok(parent.join(BACKUP_DIR_NAME))
}

fn validate_safe_backup_filename(filename: &str) -> Result<(), DbError> {
    if filename.is_empty()
        || !filename.starts_with(BACKUP_FILE_PREFIX)
        || !filename.ends_with(BACKUP_FILE_SUFFIX)
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.contains(':')
        || filename.contains('\0')
        || !filename
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return Err(DbError::InvalidInput {
            field: Some("backupFilename".to_string()),
            message: "Invalid backup filename reference".to_string(),
        });
    }
    Ok(())
}

fn validate_raw_backup_keys(keys: &[crate::db::dto::RawLegacyKeyEntry]) -> Result<i64, DbError> {
    let mut seen = HashSet::with_capacity(keys.len());
    let mut present_count: i64 = 0;

    for entry in keys {
        if !ALLOWED_LEGACY_KEYS.contains(&entry.key.as_str()) {
            return Err(DbError::InvalidInput {
                field: Some("keys".to_string()),
                message: format!("Unsupported legacy storage key '{}'", entry.key),
            });
        }
        if !seen.insert(entry.key.clone()) {
            return Err(DbError::InvalidInput {
                field: Some("keys".to_string()),
                message: format!("Duplicate legacy storage key '{}' in snapshot", entry.key),
            });
        }
        if entry.present && entry.raw_value.is_none() {
            return Err(DbError::InvalidInput {
                field: Some("keys".to_string()),
                message: format!(
                    "Key '{}' is marked present without its raw serialized value",
                    entry.key
                ),
            });
        }
        if entry.present {
            present_count += 1;
        }
    }

    Ok(present_count)
}

/// Captures raw unmodified LocalStorage / memory-fallback key strings into an atomic,
/// verified JSON backup file under `<app_data_dir>/backups/`.
/// Never accepts filesystem paths from callers and never writes raw values into logs/errors.
pub fn backup_legacy_localstorage(
    db_path: &Path,
    input: &BackupLegacyStorageInput,
) -> Result<BackupLegacyStorageResult, DbError> {
    let captured_at = require_trimmed_non_empty(&input.captured_at, "capturedAt")?;
    let present_count = validate_raw_backup_keys(&input.keys)?;
    let source = if input.source.trim().is_empty() {
        "localStorage".to_string()
    } else {
        input.source.trim().to_string()
    };

    let backups_dir = resolve_backups_dir(db_path)?;
    fs::create_dir_all(&backups_dir).map_err(|_| {
        DbError::Config("Failed to prepare application backup directory".to_string())
    })?;

    let (compact_utc, iso_utc) = format_utc_timestamp_parts();
    let envelope = RawBackupEnvelope {
        schema_version: MIGRATION_MARKER_VERSION,
        captured_at,
        created_at_utc: iso_utc,
        source,
        keys: input.keys.clone(),
    };

    let serialized = serde_json::to_vec_pretty(&envelope).map_err(|_| {
        DbError::InvalidInput {
            field: Some("keys".to_string()),
            message: "Failed to serialize raw legacy backup payload".to_string(),
        }
    })?;

    let expected_sha256 = sha256_hex(&serialized);
    let expected_len = serialized.len();
    let seq = BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let short_hash = &expected_sha256[..8];
    let filename = format!("{BACKUP_FILE_PREFIX}{compact_utc}-{short_hash}-{seq:04}{BACKUP_FILE_SUFFIX}");
    validate_safe_backup_filename(&filename)?;

    let final_path = backups_dir.join(&filename);
    let temp_filename = format!(".{filename}.tmp");
    let temp_path = backups_dir.join(&temp_filename);

    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(&serialized)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp_path, &final_path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
        return Err(DbError::Config(
            "Failed to persist verified raw LocalStorage backup".to_string(),
        ));
    }

    // Reopen and strictly verify byte length, SHA-256 checksum, and JSON envelope integrity.
    let mut reopened = File::open(&final_path).map_err(|_| {
        DbError::Integrity("Backup file could not be reopened for verification".to_string())
    })?;
    let mut verified_bytes = Vec::with_capacity(expected_len);
    reopened.read_to_end(&mut verified_bytes).map_err(|_| {
        DbError::Integrity("Backup file could not be read back for verification".to_string())
    })?;

    if verified_bytes.len() != expected_len {
        return Err(DbError::Integrity(
            "Backup verification failed: written byte length mismatch".to_string(),
        ));
    }

    let actual_sha256 = sha256_hex(&verified_bytes);
    if actual_sha256 != expected_sha256 {
        return Err(DbError::Integrity(
            "Backup verification failed: SHA-256 integrity mismatch".to_string(),
        ));
    }

    let parsed: RawBackupEnvelope = serde_json::from_slice(&verified_bytes).map_err(|_| {
        DbError::Integrity(
            "Backup verification failed: persisted backup is not valid JSON".to_string(),
        )
    })?;
    let _ = validate_raw_backup_keys(&parsed.keys)?;

    let byte_size = i64::try_from(verified_bytes.len())
        .map_err(|_| DbError::NumericOverflow("Backup byte size exceeds i64".to_string()))?;

    Ok(BackupLegacyStorageResult {
        backup_filename: filename,
        byte_size: SafeI64(byte_size),
        sha256: actual_sha256,
        verified: true,
        captured_key_count: SafeI64(present_count),
    })
}

pub fn verify_existing_backup_file(
    db_path: &Path,
    expected: &BackupLegacyStorageResult,
) -> Result<(), DbError> {
    if !expected.verified {
        return Err(DbError::Integrity(
            "Backup must be verified before starting SQLite migration".to_string(),
        ));
    }
    validate_safe_backup_filename(&expected.backup_filename)?;
    let expected_len = usize::try_from(expected.byte_size.get()).map_err(|_| {
        DbError::InvalidInput {
            field: Some("backupVerification.byteSize".to_string()),
            message: "Backup byteSize must be non-negative".to_string(),
        }
    })?;

    let backups_dir = resolve_backups_dir(db_path)?;
    let full_path = backups_dir.join(&expected.backup_filename);
    let mut file = File::open(&full_path).map_err(|_| {
        DbError::Integrity(
            "Verified pre-migration backup file was not found in application backup directory"
                .to_string(),
        )
    })?;

    let mut bytes = Vec::with_capacity(expected_len);
    file.read_to_end(&mut bytes).map_err(|_| {
        DbError::Integrity("Failed to read verified backup file prior to migration".to_string())
    })?;

    if bytes.len() != expected_len {
        return Err(DbError::Integrity(
            "Pre-migration backup file size does not match verification metadata".to_string(),
        ));
    }

    let actual_sha256 = sha256_hex(&bytes);
    if actual_sha256 != expected.sha256 {
        return Err(DbError::Integrity(
            "Pre-migration backup SHA-256 digest verification failed".to_string(),
        ));
    }

    let parsed: RawBackupEnvelope = serde_json::from_slice(&bytes).map_err(|_| {
        DbError::Integrity("Pre-migration backup file JSON verification failed".to_string())
    })?;
    let _ = validate_raw_backup_keys(&parsed.keys)?;

    Ok(())
}

// ============================================================
// Migration State Inspection & Safe Error Recording
// ============================================================

fn query_table_count(conn: &Connection, table: &str) -> Result<i64, DbError> {
    let sql = format!("SELECT COUNT(*) FROM {table};");
    conn.query_row(&sql, [], |row| row.get(0))
        .map_err(|err| map_rusqlite_error(err, &format!("counting rows in {table}")))
}

fn collect_counts(conn: &Connection) -> Result<MigrationCountsDto, DbError> {
    Ok(MigrationCountsDto {
        local_profiles: SafeI64(query_table_count(conn, "local_profiles")?),
        businesses: SafeI64(query_table_count(conn, "businesses")?),
        business_assets: SafeI64(query_table_count(conn, "business_assets")?),
        clients: SafeI64(query_table_count(conn, "clients")?),
        quotations: SafeI64(query_table_count(conn, "quotations")?),
        quotation_items: SafeI64(query_table_count(conn, "quotation_items")?),
        invoices: SafeI64(query_table_count(conn, "invoices")?),
        invoice_items: SafeI64(query_table_count(conn, "invoice_items")?),
        payments: SafeI64(query_table_count(conn, "payments")?),
        activity_logs: SafeI64(query_table_count(conn, "activity_logs")?),
        app_settings: SafeI64(query_table_count(conn, "app_settings")?),
    })
}

fn has_existing_business_data(counts: &MigrationCountsDto) -> bool {
    counts.businesses.get() > 0
        || counts.business_assets.get() > 0
        || counts.clients.get() > 0
        || counts.quotations.get() > 0
        || counts.quotation_items.get() > 0
        || counts.invoices.get() > 0
        || counts.invoice_items.get() > 0
        || counts.payments.get() > 0
        || counts.activity_logs.get() > 0
}

fn read_setting_json(conn: &Connection, key: &str) -> Result<Option<String>, DbError> {
    conn.query_row(
        "SELECT value_json FROM app_settings WHERE key = ?1;",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "reading migration setting"))
}

fn parse_marker_payload(raw_json: &str) -> Result<(MigrationState, MigrationMarkerPayload), DbError> {
    let marker: MigrationMarkerPayload = serde_json::from_str(raw_json).map_err(|_| {
        DbError::Integrity("Stored migration marker is malformed JSON".to_string())
    })?;

    let state = match marker.status.as_str() {
        "completed" => MigrationState::Completed,
        "not_needed" => MigrationState::NotNeeded,
        "conflict_existing_data" => MigrationState::ConflictExistingData,
        other => {
            return Err(DbError::Integrity(format!(
                "Unknown stored migration marker status '{other}'"
            )));
        }
    };

    Ok((state, marker))
}

pub fn get_migration_status(conn: &Connection) -> Result<MigrationStatusDto, DbError> {
    let existing_counts = collect_counts(conn)?;
    let raw_marker = read_setting_json(conn, MIGRATION_SETTING_KEY)?;
    let raw_error = read_setting_json(conn, MIGRATION_ERROR_SETTING_KEY)?;

    let last_error = raw_error.and_then(|json_str| {
        serde_json::from_str::<MigrationDiagnosticDto>(&json_str).ok()
    });

    if let Some(marker_json) = raw_marker {
        let (state, marker) = parse_marker_payload(&marker_json)?;

        return Ok(MigrationStatusDto {
            state,
            marker_version: Some(marker.version),
            completed_at: marker.completed_at,
            migrated_business_id: marker.migrated_business_id,
            backup_filename: marker.backup_filename,
            last_error,
            existing_counts,
        });
    }

    let state = if has_existing_business_data(&existing_counts) {
        MigrationState::ConflictExistingData
    } else {
        MigrationState::Absent
    };

    Ok(MigrationStatusDto {
        state,
        marker_version: None,
        completed_at: None,
        migrated_business_id: None,
        backup_filename: None,
        last_error,
        existing_counts,
    })
}

fn redact_data_uris(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;

    while let Some(rel) = lower[cursor..].find("data:") {
        let start = cursor + rel;
        let rest_lower = &lower[start..];
        let token_len = input[start..]
            .find(char::is_whitespace)
            .unwrap_or_else(|| input.len() - start);
        let header: String = rest_lower[..token_len].chars().take(96).collect();

        if header.contains(";base64,")
            || header.starts_with("data:image/")
            || header.starts_with("data:application/")
            || header.starts_with("data:text/")
        {
            out.push_str(&input[cursor..start]);
            out.push_str("[REDACTED_DATA_URI]");
            cursor = start + token_len;
        } else {
            let advance = "data:".len();
            out.push_str(&input[cursor..start + advance]);
            cursor = start + advance;
        }
    }

    out.push_str(&input[cursor..]);
    out
}

fn contains_jwt_like_token(text: &str) -> bool {
    text.split_whitespace().any(|tok| {
        let trimmed = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-' && c != '_');
        trimmed.starts_with("eyJ") && trimmed.len() >= 20 && trimmed.matches('.').count() >= 2
    })
}

fn sanitize_diagnostic_text(raw: &str, max_chars: usize) -> String {
    let stripped: String = raw
        .chars()
        .filter_map(|c| {
            if matches!(c, '\r' | '\n' | '\t') {
                Some(' ')
            } else if c.is_control() {
                None
            } else {
                Some(c)
            }
        })
        .collect();

    let collapsed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    let uri_redacted = redact_data_uris(&collapsed);
    let trimmed = uri_redacted.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let lower = trimmed.to_ascii_lowercase();
    let looks_like_raw_storage = ALLOWED_LEGACY_KEYS.iter().any(|k| lower.contains(k))
        || (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || trimmed.starts_with("{\"")
        || trimmed.starts_with("[{\"")
        || trimmed.contains("\":{\"")
        || trimmed.contains("\":[{\"");

    if looks_like_raw_storage {
        return "[REDACTED_RAW_PAYLOAD]"
            .chars()
            .take(max_chars)
            .collect();
    }

    let looks_like_secret = lower.contains("bearer ")
        || lower.contains("password=")
        || lower.contains("password:")
        || lower.contains("\"password\"")
        || lower.contains("secret=")
        || lower.contains("secret:")
        || lower.contains("client_secret")
        || lower.contains("service_role")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("access_token")
        || lower.contains("refresh_token")
        || lower.contains("private_key")
        || lower.contains("token=")
        || contains_jwt_like_token(trimmed);

    if looks_like_secret {
        return "[REDACTED_SECRET]".chars().take(max_chars).collect();
    }

    trimmed.chars().take(max_chars).collect()
}

fn sanitize_optional_diagnostic_text(raw: Option<String>, max_chars: usize) -> Option<String> {
    raw.and_then(|val| {
        let cleaned = sanitize_diagnostic_text(&val, max_chars);
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    })
}

pub fn sanitize_diagnostic(mut d: MigrationDiagnosticDto) -> MigrationDiagnosticDto {
    d.code = sanitize_diagnostic_text(&d.code, 80);
    d.severity = sanitize_diagnostic_text(&d.severity, 32).to_ascii_lowercase();
    d.stage = sanitize_diagnostic_text(&d.stage, 64);
    d.entity_type = sanitize_diagnostic_text(&d.entity_type, 64);
    d.record_id = sanitize_optional_diagnostic_text(d.record_id.take(), 120);
    d.field = sanitize_optional_diagnostic_text(d.field.take(), 120);
    d.original_value = sanitize_optional_diagnostic_text(d.original_value.take(), 120);
    d.message = sanitize_diagnostic_text(&d.message, 400);
    d.suggested_action = sanitize_diagnostic_text(&d.suggested_action, 400);
    d
}

fn sanitize_and_validate_diagnostic(
    diagnostic: &MigrationDiagnosticDto,
) -> Result<MigrationDiagnosticDto, DbError> {
    let sanitized = sanitize_diagnostic(diagnostic.clone());
    let _ = require_trimmed_non_empty(&sanitized.code, "code")?;
    let _ = validate_enum(&sanitized.severity, &["error", "warning", "info"], "severity")?;
    let _ = require_trimmed_non_empty(&sanitized.stage, "stage")?;
    let _ = require_trimmed_non_empty(&sanitized.entity_type, "entityType")?;
    let _ = require_trimmed_non_empty(&sanitized.message, "message")?;
    let _ = require_trimmed_non_empty(&sanitized.suggested_action, "suggestedAction")?;
    Ok(sanitized)
}

pub fn record_migration_error(
    conn: &mut Connection,
    diagnostic: &MigrationDiagnosticDto,
) -> Result<MigrationDiagnosticDto, DbError> {
    let sanitized = sanitize_and_validate_diagnostic(diagnostic)?;
    let value_json = serde_json::to_string(&sanitized)
        .map_err(|_| DbError::Config("Failed to serialize migration error state".to_string()))?;
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    tx.execute(
        "INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at;",
        params![MIGRATION_ERROR_SETTING_KEY, value_json, updated_at],
    )
    .map_err(|err| map_rusqlite_error(err, "recording migration diagnostic error"))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing migration diagnostic error"))?;

    Ok(sanitized)
}

fn normalize_lifecycle_source(
    source: Option<&str>,
    default_source: &str,
) -> Result<String, DbError> {
    match source {
        None => Ok(default_source.to_string()),
        Some(raw) => {
            if raw.chars().any(|c| c.is_control()) {
                return Err(DbError::InvalidInput {
                    field: Some("source".to_string()),
                    message: "source must not contain control characters".to_string(),
                });
            }
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(DbError::InvalidInput {
                    field: Some("source".to_string()),
                    message: "source cannot be blank when provided".to_string(),
                });
            }
            if trimmed.chars().count() > 64 {
                return Err(DbError::InvalidInput {
                    field: Some("source".to_string()),
                    message: "source exceeds maximum allowed length of 64 characters".to_string(),
                });
            }
            Ok(trimmed.to_string())
        }
    }
}

/// Atomically records `migration.localstorage_v1` with `status: "not_needed"` when SQLite
/// contains no unmigrated business data and no `completed` / `conflict_existing_data` marker.
pub fn mark_migration_not_needed(
    conn: &mut Connection,
    source: Option<&str>,
) -> Result<MigrationStatusDto, DbError> {
    let source = normalize_lifecycle_source(source, "desktop_fresh_install")?;
    let now_utc = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing_counts = collect_counts(&tx)?;
    let has_data = has_existing_business_data(&existing_counts);
    let raw_marker = read_setting_json(&tx, MIGRATION_SETTING_KEY)?;

    if let Some(marker_json) = raw_marker {
        let (state, _marker) = parse_marker_payload(&marker_json)?;
        match state {
            MigrationState::Completed => {
                return Err(DbError::UniqueConstraint(
                    "Cannot mark legacy migration as not needed because migration is already completed".to_string(),
                ));
            }
            MigrationState::ConflictExistingData => {
                return Err(DbError::UniqueConstraint(
                    "Cannot mark legacy migration as not needed while SQLite migration conflict exists".to_string(),
                ));
            }
            MigrationState::NotNeeded => {
                tx.commit().map_err(|err| {
                    map_rusqlite_error(err, "finalizing migration status check")
                })?;
                return get_migration_status(conn);
            }
            MigrationState::Absent => {
                return Err(DbError::Integrity(
                    "Stored migration marker resolved to unexpected absent state".to_string(),
                ));
            }
        }
    }

    if has_data {
        return Err(DbError::UniqueConstraint(
            "Cannot mark legacy migration as not needed because SQLite already contains existing business data requiring conflict resolution".to_string(),
        ));
    }

    let marker_payload = MigrationMarkerPayload {
        version: MIGRATION_MARKER_VERSION,
        status: "not_needed".to_string(),
        source,
        migrated_business_id: None,
        local_profile_id: None,
        backup_filename: None,
        counts: Some(existing_counts),
        diagnostics: Vec::new(),
        completed_at: Some(now_utc.clone()),
    };

    let marker_json = serde_json::to_string(&marker_payload).map_err(|_| {
        DbError::Config("Failed to serialize migration not_needed marker".to_string())
    })?;

    tx.execute(
        "INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?1, ?2, ?3);",
        params![MIGRATION_SETTING_KEY, marker_json, now_utc],
    )
    .map_err(|err| map_rusqlite_error(err, "saving migration not_needed marker"))?;

    tx.execute(
        "DELETE FROM app_settings WHERE key = ?1;",
        params![MIGRATION_ERROR_SETTING_KEY],
    )
    .map_err(|err| map_rusqlite_error(err, "clearing prior migration error diagnostic"))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing migration not_needed marker"))?;

    get_migration_status(conn)
}

// ============================================================
// Atomic Batch Workspace Importer
// ============================================================

fn validate_line_items_for_migration(
    items: &[LineItemInput],
    seen_item_ids: &mut HashSet<String>,
) -> Result<(), DbError> {
    for (idx, item) in items.iter().enumerate() {
        let id = require_non_empty_id(&item.id, "items.id")?.to_string();
        if !seen_item_ids.insert(id) {
            return Err(DbError::DuplicateId(format!(
                "Duplicate line item identifier at position {idx}"
            )));
        }
        let _ = validate_optional_non_empty(&item.legacy_id, "items.legacyId")?;
        if let Some(ref ts) = item.created_at {
            let _ = require_trimmed_non_empty(ts, "items.createdAt")?;
        }
        // Historical financial values (quantity_scaled, unit_price_scaled, total_minor)
        // may be negative if allowed by schema; never clamp or reject negative values here.
    }
    Ok(())
}

struct WorkspaceSnapshotRef<'a> {
    local_profile: &'a CreateLocalProfileInput,
    business: &'a CreateBusinessInput,
    assets: &'a [CreateBusinessAssetInput],
    clients: &'a [CreateClientInput],
    quotations: &'a [CreateQuotationInput],
    invoices: &'a [CreateInvoiceInput],
    payments: &'a [CreatePaymentInput],
    activity_logs: &'a [CreateActivityLogInput],
    settings: &'a [SaveAppSettingInput],
}

fn validate_workspace_snapshot(ws: &WorkspaceSnapshotRef<'_>) -> Result<(), DbError> {
    let _ = require_non_empty_id(&ws.local_profile.id, "localProfile.id")?;
    let _ = validate_optional_non_empty(
        &ws.local_profile.supabase_user_id,
        "localProfile.supabaseUserId",
    )?;
    if let Some(ref ts) = ws.local_profile.created_at {
        let _ = require_trimmed_non_empty(ts, "localProfile.createdAt")?;
    }
    if let Some(ref ts) = ws.local_profile.updated_at {
        let _ = require_trimmed_non_empty(ts, "localProfile.updatedAt")?;
    }

    let business_id = require_non_empty_id(&ws.business.id, "business.id")?;
    let _ = validate_optional_non_empty(&ws.business.legacy_id, "business.legacyId")?;
    let _ = validate_optional_non_empty(&ws.business.owner_profile_id, "business.ownerProfileId")?;
    let _ = require_trimmed_non_empty(&ws.business.name, "business.name")?;
    let _ = validate_optional_non_empty(&ws.business.logo_asset_id, "business.logoAssetId")?;
    let _ = require_trimmed_non_empty(&ws.business.default_currency, "business.defaultCurrency")?;
    let _ = require_trimmed_non_empty(&ws.business.currency_symbol, "business.currencySymbol")?;
    let _ = require_trimmed_non_empty(&ws.business.default_tax_name, "business.defaultTaxName")?;
    let _ = require_trimmed_non_empty(&ws.business.quote_prefix, "business.quotePrefix")?;
    let _ = require_trimmed_non_empty(&ws.business.invoice_prefix, "business.invoicePrefix")?;
    require_positive(ws.business.next_quote_number.get(), "business.nextQuoteNumber")?;
    require_positive(
        ws.business.next_invoice_number.get(),
        "business.nextInvoiceNumber",
    )?;

    let mut asset_ids = HashSet::with_capacity(ws.assets.len());
    let mut asset_hashes = HashSet::with_capacity(ws.assets.len());
    for asset in ws.assets {
        let aid = require_non_empty_id(&asset.id, "assets.id")?.to_string();
        if !asset_ids.insert(aid) {
            return Err(DbError::DuplicateId("Duplicate business asset ID".to_string()));
        }
        let abid = require_non_empty_id(&asset.business_id, "assets.businessId")?;
        if abid != business_id {
            return Err(DbError::ForeignKeyViolation(
                "Business asset references a different business".to_string(),
            ));
        }
        let hash = require_trimmed_non_empty(&asset.content_hash, "assets.contentHash")?;
        if !asset_hashes.insert(hash) {
            return Err(DbError::UniqueConstraint(
                "Duplicate asset contentHash within business".to_string(),
            ));
        }
        let source_type = validate_enum(&asset.source_type, &ASSET_SOURCE_TYPES, "assets.sourceType")?;
        let inline_data = validate_optional_non_empty(&asset.inline_data, "assets.inlineData")?;
        let file_path = validate_optional_non_empty(&asset.file_path, "assets.filePath")?;
        let external_url = validate_optional_non_empty(&asset.external_url, "assets.externalUrl")?;
        if let Some(bs) = asset.byte_size {
            require_non_negative(bs.get(), "assets.byteSize")?;
        }
        match source_type {
            "data_url" if inline_data.is_none() => {
                return Err(DbError::InvalidInput {
                    field: Some("assets.inlineData".to_string()),
                    message: "inlineData is required for data_url asset".to_string(),
                });
            }
            "file" if file_path.is_none() => {
                return Err(DbError::InvalidInput {
                    field: Some("assets.filePath".to_string()),
                    message: "filePath is required for file asset".to_string(),
                });
            }
            "external_url" if external_url.is_none() => {
                return Err(DbError::InvalidInput {
                    field: Some("assets.externalUrl".to_string()),
                    message: "externalUrl is required for external_url asset".to_string(),
                });
            }
            _ => {}
        }
    }

    if let Some(ref logo_id) = ws.business.logo_asset_id {
        if !asset_ids.contains(logo_id.trim()) {
            return Err(DbError::ForeignKeyViolation(
                "Business logoAssetId does not exist in workspace assets".to_string(),
            ));
        }
    }

    let mut client_ids = HashSet::with_capacity(ws.clients.len());
    for client in ws.clients {
        let cid = require_non_empty_id(&client.id, "clients.id")?.to_string();
        if !client_ids.insert(cid) {
            return Err(DbError::DuplicateId("Duplicate client ID in workspace payload".to_string()));
        }
        if require_non_empty_id(&client.business_id, "clients.businessId")? != business_id {
            return Err(DbError::ForeignKeyViolation(
                "Client references a different business".to_string(),
            ));
        }
        let _ = validate_optional_non_empty(&client.legacy_id, "clients.legacyId")?;
        let _ = require_trimmed_non_empty(&client.name, "clients.name")?;
    }

    let mut quote_ids = HashSet::with_capacity(ws.quotations.len());
    let mut quote_numbers = HashSet::with_capacity(ws.quotations.len());
    let mut quote_item_ids = HashSet::new();
    for q in ws.quotations {
        let qid = require_non_empty_id(&q.id, "quotations.id")?.to_string();
        if !quote_ids.insert(qid) {
            return Err(DbError::DuplicateId(
                "Duplicate quotation ID in workspace payload".to_string(),
            ));
        }
        if require_non_empty_id(&q.business_id, "quotations.businessId")? != business_id {
            return Err(DbError::ForeignKeyViolation(
                "Quotation references a different business".to_string(),
            ));
        }
        let _ = validate_optional_non_empty(&q.legacy_id, "quotations.legacyId")?;
        if let Some(ref cid) = validate_optional_non_empty(&q.client_id, "quotations.clientId")? {
            if !client_ids.contains(cid) {
                return Err(DbError::ForeignKeyViolation(
                    "Quotation clientId does not exist in workspace clients".to_string(),
                ));
            }
        }
        let qnum = require_trimmed_non_empty(&q.quotation_number, "quotations.quotationNumber")?;
        if !quote_numbers.insert(qnum.to_lowercase()) {
            return Err(DbError::DuplicateDocumentNumber(format!(
                "Duplicate quotation number '{qnum}' in workspace payload"
            )));
        }
        validate_json_text(&q.client_snapshot_json, "quotations.clientSnapshotJson")?;
        validate_json_text(&q.business_snapshot_json, "quotations.businessSnapshotJson")?;
        validate_iso_date(&q.issue_date, "quotations.issueDate")?;
        validate_optional_iso_date(&q.expiry_date, "quotations.expiryDate")?;
        let _ = require_trimmed_non_empty(&q.currency, "quotations.currency")?;
        let _ = require_trimmed_non_empty(&q.currency_symbol, "quotations.currencySymbol")?;
        validate_enum(&q.discount_type, &DISCOUNT_TYPES, "quotations.discountType")?;
        validate_enum(&q.status, &QUOTATION_STATUSES, "quotations.status")?;
        if let Some(ref pre) = q.pre_conversion_status {
            validate_enum(pre, &QUOTATION_STATUSES, "quotations.preConversionStatus")?;
        }
        validate_line_items_for_migration(&q.items, &mut quote_item_ids)?;
    }

    let mut invoice_ids = HashSet::with_capacity(ws.invoices.len());
    let mut invoice_numbers = HashSet::with_capacity(ws.invoices.len());
    let mut invoice_item_ids = HashSet::new();
    for inv in ws.invoices {
        let iid = require_non_empty_id(&inv.id, "invoices.id")?.to_string();
        if !invoice_ids.insert(iid) {
            return Err(DbError::DuplicateId(
                "Duplicate invoice ID in workspace payload".to_string(),
            ));
        }
        if require_non_empty_id(&inv.business_id, "invoices.businessId")? != business_id {
            return Err(DbError::ForeignKeyViolation(
                "Invoice references a different business".to_string(),
            ));
        }
        let _ = validate_optional_non_empty(&inv.legacy_id, "invoices.legacyId")?;
        if let Some(ref cid) = validate_optional_non_empty(&inv.client_id, "invoices.clientId")? {
            if !client_ids.contains(cid) {
                return Err(DbError::ForeignKeyViolation(
                    "Invoice clientId does not exist in workspace clients".to_string(),
                ));
            }
        }
        if let Some(ref qid) =
            validate_optional_non_empty(&inv.quotation_id, "invoices.quotationId")?
        {
            if !quote_ids.contains(qid) {
                return Err(DbError::ForeignKeyViolation(
                    "Invoice quotationId does not exist in workspace quotations".to_string(),
                ));
            }
        }
        let inum = require_trimmed_non_empty(&inv.invoice_number, "invoices.invoiceNumber")?;
        if !invoice_numbers.insert(inum.to_lowercase()) {
            return Err(DbError::DuplicateDocumentNumber(format!(
                "Duplicate invoice number '{inum}' in workspace payload"
            )));
        }
        validate_json_text(&inv.client_snapshot_json, "invoices.clientSnapshotJson")?;
        validate_json_text(&inv.business_snapshot_json, "invoices.businessSnapshotJson")?;
        validate_iso_date(&inv.issue_date, "invoices.issueDate")?;
        validate_optional_iso_date(&inv.due_date, "invoices.dueDate")?;
        let _ = require_trimmed_non_empty(&inv.currency, "invoices.currency")?;
        let _ = require_trimmed_non_empty(&inv.currency_symbol, "invoices.currencySymbol")?;
        validate_enum(&inv.discount_type, &DISCOUNT_TYPES, "invoices.discountType")?;
        validate_enum(&inv.status, &INVOICE_STATUSES, "invoices.status")?;
        validate_line_items_for_migration(&inv.items, &mut invoice_item_ids)?;
    }

    let mut claimed_converted_invoices = HashSet::new();
    for q in ws.quotations {
        if let Some(ref conv_id) =
            validate_optional_non_empty(&q.converted_invoice_id, "quotations.convertedInvoiceId")?
        {
            if !invoice_ids.contains(conv_id) {
                return Err(DbError::ForeignKeyViolation(
                    "Quotation convertedInvoiceId does not exist in workspace invoices".to_string(),
                ));
            }
            if !claimed_converted_invoices.insert(conv_id.clone()) {
                return Err(DbError::UniqueConstraint(
                    "Multiple quotations claim the same convertedInvoiceId".to_string(),
                ));
            }
        }
    }

    let mut payment_ids = HashSet::with_capacity(ws.payments.len());
    for pay in ws.payments {
        let pid = require_non_empty_id(&pay.id, "payments.id")?.to_string();
        if !payment_ids.insert(pid) {
            return Err(DbError::DuplicateId(
                "Duplicate payment ID in workspace payload".to_string(),
            ));
        }
        if require_non_empty_id(&pay.business_id, "payments.businessId")? != business_id {
            return Err(DbError::ForeignKeyViolation(
                "Payment references a different business".to_string(),
            ));
        }
        let iid = require_non_empty_id(&pay.invoice_id, "payments.invoiceId")?;
        if !invoice_ids.contains(iid) {
            return Err(DbError::ForeignKeyViolation(
                "Payment invoiceId does not exist in workspace invoices".to_string(),
            ));
        }
        let _ = validate_optional_non_empty(&pay.legacy_id, "payments.legacyId")?;
        validate_iso_date(&pay.payment_date, "payments.paymentDate")?;
        validate_enum(&pay.payment_method, &PAYMENT_METHODS, "payments.paymentMethod")?;
    }

    let mut activity_ids = HashSet::with_capacity(ws.activity_logs.len());
    for act in ws.activity_logs {
        let aid = require_non_empty_id(&act.id, "activityLogs.id")?.to_string();
        if !activity_ids.insert(aid) {
            return Err(DbError::DuplicateId(
                "Duplicate activity log ID in workspace payload".to_string(),
            ));
        }
        if require_non_empty_id(&act.business_id, "activityLogs.businessId")? != business_id {
            return Err(DbError::ForeignKeyViolation(
                "Activity log references a different business".to_string(),
            ));
        }
        let _ = validate_optional_non_empty(&act.legacy_id, "activityLogs.legacyId")?;
        validate_enum(&act.log_type, &ACTIVITY_TYPES, "activityLogs.type")?;
        let _ = require_trimmed_non_empty(&act.title, "activityLogs.title")?;
        if let Some(ref actor_id) =
            validate_optional_non_empty(&act.actor_local_profile_id, "activityLogs.actorLocalProfileId")?
        {
            if actor_id != ws.local_profile.id.trim() {
                return Err(DbError::ForeignKeyViolation(
                    "Activity log actorLocalProfileId does not match workspace profile".to_string(),
                ));
            }
        }
    }

    for setting in ws.settings {
        let key = require_trimmed_non_empty(&setting.key, "settings.key")?;
        if key == MIGRATION_SETTING_KEY || key == MIGRATION_ERROR_SETTING_KEY {
            return Err(DbError::InvalidInput {
                field: Some("settings.key".to_string()),
                message: "Reserved migration state setting cannot be supplied in settings array"
                    .to_string(),
            });
        }
        validate_json_text(&setting.value_json, "settings.valueJson")?;
    }

    Ok(())
}

fn validate_migration_payload(input: &LegacyWorkspaceMigrationInput) -> Result<(), DbError> {
    if let Some(err_diag) = input.diagnostics.iter().find(|d| d.severity == "error") {
        return Err(DbError::InvalidInput {
            field: err_diag.field.clone(),
            message: format!(
                "Migration payload contains unresolved error diagnostic {}: {}",
                err_diag.code, err_diag.message
            ),
        });
    }

    let ws = WorkspaceSnapshotRef {
        local_profile: &input.local_profile,
        business: &input.business,
        assets: &input.assets,
        clients: &input.clients,
        quotations: &input.quotations,
        invoices: &input.invoices,
        payments: &input.payments,
        activity_logs: &input.activity_logs,
        settings: &input.settings,
    };
    validate_workspace_snapshot(&ws)
}

fn verify_foreign_keys_in_tx(conn: &Connection, context: &str) -> Result<(), DbError> {
    let mut fk_stmt = conn
        .prepare("PRAGMA foreign_key_check;")
        .map_err(|err| DbError::Integrity(format!("Failed to prepare foreign_key_check: {err}")))?;
    let fk_violations = fk_stmt
        .query_map([], |row| {
            let table: String = row.get(0)?;
            let rowid: i64 = row.get(1)?;
            let parent: String = row.get(2)?;
            Ok(format!("table='{table}' rowid={rowid} parent='{parent}'"))
        })
        .map_err(|err| DbError::Integrity(format!("Failed to execute foreign_key_check: {err}")))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|err| DbError::Integrity(format!("Failed to read foreign_key_check: {err}")))?;

    if !fk_violations.is_empty() {
        return Err(DbError::Integrity(format!(
            "{context} foreign_key_check failed: {}",
            fk_violations.join("; ")
        )));
    }
    Ok(())
}

fn clear_business_tables_in_tx(conn: &Connection) -> Result<(), DbError> {
    // Break all deferred / circular foreign keys cleanly before leaf-to-root deletion.
    conn.execute("UPDATE businesses SET logo_asset_id = NULL;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing business logo links"))?;
    conn.execute(
        "UPDATE quotations SET converted_invoice_id = NULL, client_id = NULL;",
        [],
    )
    .map_err(|err| map_rusqlite_error(err, "clearing quotation links"))?;
    conn.execute("UPDATE invoices SET quotation_id = NULL, client_id = NULL;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing invoice links"))?;

    conn.execute("DELETE FROM activity_logs;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing activity logs"))?;
    conn.execute("DELETE FROM payments;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing payments"))?;
    conn.execute("DELETE FROM invoice_items;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing invoice items"))?;
    conn.execute("DELETE FROM quotation_items;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing quotation items"))?;
    conn.execute("DELETE FROM invoices;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing invoices"))?;
    conn.execute("DELETE FROM quotations;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing quotations"))?;
    conn.execute("DELETE FROM clients;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing clients"))?;
    conn.execute("DELETE FROM business_assets;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing business assets"))?;
    conn.execute("DELETE FROM businesses;", [])
        .map_err(|err| map_rusqlite_error(err, "clearing businesses"))?;

    Ok(())
}

/// Imports a normalized workspace migration payload inside one `TransactionBehavior::Immediate`
/// SQLite transaction after verifying the pre-migration raw backup file on disk.
pub fn migrate_legacy_workspace(
    conn: &mut Connection,
    db_path: &Path,
    input: &LegacyWorkspaceMigrationInput,
) -> Result<MigrationResultDto, DbError> {
    verify_existing_backup_file(db_path, &input.backup_verification)?;
    validate_migration_payload(input)?;

    let now_utc = current_utc_iso(conn)?;
    let profile_created_at = input
        .local_profile
        .created_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&now_utc)
        .to_string();
    let profile_updated_at = input
        .local_profile
        .updated_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&profile_created_at)
        .to_string();

    let biz_created_at = input
        .business
        .created_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&now_utc)
        .to_string();
    let biz_updated_at = input
        .business
        .updated_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&biz_created_at)
        .to_string();

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    if let Some(existing_marker) = read_setting_json(&tx, MIGRATION_SETTING_KEY)? {
        return Err(DbError::UniqueConstraint(format!(
            "Migration state marker already exists ({}); duplicate import rejected",
            if existing_marker.contains("\"completed\"") {
                "completed"
            } else {
                "active"
            }
        )));
    }

    let existing_counts = collect_counts(&tx)?;
    if has_existing_business_data(&existing_counts) {
        return Err(DbError::UniqueConstraint(
            "SQLite database already contains existing business records; migration aborted to prevent data overwrite".to_string(),
        ));
    }

    // 1. Insert local profile (only if not already present)
    let profile_id = input.local_profile.id.trim().to_string();
    let profile_exists: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM local_profiles WHERE id = ?1;",
            params![profile_id],
            |row| row.get(0),
        )
        .map_err(|err| map_rusqlite_error(err, "checking existing local profile"))?;

    if profile_exists == 0 {
        let supabase_user_id = validate_optional_non_empty(
            &input.local_profile.supabase_user_id,
            "localProfile.supabaseUserId",
        )?;
        tx.execute(
            "INSERT INTO local_profiles (id, display_name, email, supabase_user_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
            params![
                profile_id,
                input.local_profile.display_name.trim(),
                input.local_profile.email.trim(),
                supabase_user_id,
                profile_created_at,
                profile_updated_at
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting migrated local profile"))?;
    }

    // 2. Insert business initially with logo_asset_id = NULL (resolved after business_assets insert)
    let business_id = input.business.id.trim().to_string();
    let business_legacy_id = validate_optional_non_empty(&input.business.legacy_id, "business.legacyId")?;
    let owner_profile_id =
        validate_optional_non_empty(&input.business.owner_profile_id, "business.ownerProfileId")?
            .or_else(|| Some(profile_id.clone()));

    tx.execute(
        "INSERT INTO businesses (
            id, legacy_id, owner_profile_id, name, tagline,
            logo_asset_id, logo_url_fallback, email, phone, address,
            city, country, postal_code, website, tax_number,
            registration_number, default_currency, currency_symbol,
            default_tax_name, default_tax_rate_ppm, is_tax_enabled,
            quote_prefix, invoice_prefix, next_quote_number, next_invoice_number,
            default_terms_quotation, default_terms_invoice, default_notes,
            bank_name, account_name, account_number, branch_code,
            account_type, swift_code, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            NULL, ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?17,
            ?18, ?19, ?20,
            ?21, ?22, ?23, ?24,
            ?25, ?26, ?27,
            ?28, ?29, ?30, ?31,
            ?32, ?33, ?34, ?35
        );",
        params![
            business_id,
            business_legacy_id,
            owner_profile_id,
            input.business.name.trim(),
            input.business.tagline,
            input.business.logo_url_fallback,
            input.business.email,
            input.business.phone,
            input.business.address,
            input.business.city,
            input.business.country,
            input.business.postal_code,
            input.business.website,
            input.business.tax_number,
            input.business.registration_number,
            input.business.default_currency.trim(),
            input.business.currency_symbol.trim(),
            input.business.default_tax_name.trim(),
            input.business.default_tax_rate_ppm.get(),
            if input.business.is_tax_enabled { 1_i64 } else { 0_i64 },
            input.business.quote_prefix.trim(),
            input.business.invoice_prefix.trim(),
            input.business.next_quote_number.get(),
            input.business.next_invoice_number.get(),
            input.business.default_terms_quotation,
            input.business.default_terms_invoice,
            input.business.default_notes,
            input.business.bank_name,
            input.business.account_name,
            input.business.account_number,
            input.business.branch_code,
            input.business.account_type,
            input.business.swift_code,
            biz_created_at,
            biz_updated_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "inserting migrated business"))?;

    // 3. Insert business_assets & attach business.logo_asset_id
    for asset in &input.assets {
        let asset_created = asset
            .created_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&biz_created_at);
        tx.execute(
            "INSERT INTO business_assets (
                id, business_id, content_hash, source_type, mime_type,
                inline_data, file_path, external_url, original_filename, byte_size, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);",
            params![
                asset.id.trim(),
                business_id,
                asset.content_hash.trim(),
                asset.source_type,
                validate_optional_non_empty(&asset.mime_type, "assets.mimeType")?,
                validate_optional_non_empty(&asset.inline_data, "assets.inlineData")?,
                validate_optional_non_empty(&asset.file_path, "assets.filePath")?,
                validate_optional_non_empty(&asset.external_url, "assets.externalUrl")?,
                validate_optional_non_empty(&asset.original_filename, "assets.originalFilename")?,
                asset.byte_size.map(SafeI64::get),
                asset_created
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting migrated business asset"))?;
    }

    if let Some(logo_asset_id) =
        validate_optional_non_empty(&input.business.logo_asset_id, "business.logoAssetId")?
    {
        tx.execute(
            "UPDATE businesses SET logo_asset_id = ?1 WHERE id = ?2;",
            params![logo_asset_id, business_id],
        )
        .map_err(|err| map_rusqlite_error(err, "attaching migrated business logo asset"))?;
    }

    // 4. Insert clients
    for client in &input.clients {
        let c_created = client
            .created_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&now_utc);
        let c_updated = client
            .updated_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(c_created);
        tx.execute(
            "INSERT INTO clients (
                id, business_id, legacy_id, name, company_name,
                email, phone, address, city, country,
                vat_number, notes, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14);",
            params![
                client.id.trim(),
                business_id,
                validate_optional_non_empty(&client.legacy_id, "clients.legacyId")?,
                client.name.trim(),
                client.company_name,
                client.email,
                client.phone,
                client.address,
                client.city,
                client.country,
                client.vat_number,
                client.notes,
                c_created,
                c_updated
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting migrated client"))?;
    }

    // 5. Insert quotations (initially with converted_invoice_id = NULL) & quotation_items
    let mut expected_quote_item_count: i64 = 0;
    for q in &input.quotations {
        let q_created = q
            .created_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&now_utc);
        let q_updated = q
            .updated_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(q_created);
        let (disc_pct, disc_fixed) = if q.discount_type == "percentage" {
            (q.discount_percentage_ppm.get(), 0_i64)
        } else {
            (0_i64, q.discount_fixed_minor.get())
        };

        tx.execute(
            "INSERT INTO quotations (
                id, business_id, legacy_id, client_id, quotation_number,
                client_snapshot_json, business_snapshot_json, issue_date, expiry_date,
                currency, currency_symbol, subtotal_minor, discount_type,
                discount_percentage_ppm, discount_fixed_minor, discount_amount_minor,
                tax_name, tax_rate_ppm, tax_amount_minor, grand_total_minor,
                status, pre_conversion_status, notes, terms, converted_invoice_id,
                created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13,
                ?14, ?15, ?16,
                ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, NULL,
                ?25, ?26
            );",
            params![
                q.id.trim(),
                business_id,
                validate_optional_non_empty(&q.legacy_id, "quotations.legacyId")?,
                validate_optional_non_empty(&q.client_id, "quotations.clientId")?,
                q.quotation_number.trim(),
                q.client_snapshot_json,
                q.business_snapshot_json,
                q.issue_date.trim(),
                validate_optional_iso_date(&q.expiry_date, "quotations.expiryDate")?,
                q.currency.trim(),
                q.currency_symbol.trim(),
                q.subtotal_minor.get(),
                q.discount_type,
                disc_pct,
                disc_fixed,
                q.discount_amount_minor.get(),
                q.tax_name.trim(),
                q.tax_rate_ppm.get(),
                q.tax_amount_minor.get(),
                q.grand_total_minor.get(),
                q.status,
                validate_optional_non_empty(&q.pre_conversion_status, "quotations.preConversionStatus")?,
                q.notes,
                q.terms,
                q_created,
                q_updated
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting migrated quotation"))?;

        for (idx, item) in q.items.iter().enumerate() {
            let item_created = item
                .created_at
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(q_created);
            let sort_order = item.sort_order.map(SafeI64::get).unwrap_or(idx as i64);
            tx.execute(
                "INSERT INTO quotation_items (
                    id, business_id, quotation_id, legacy_id, sort_order,
                    description, quantity_scaled, unit_price_scaled, total_minor, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
                params![
                    item.id.trim(),
                    business_id,
                    q.id.trim(),
                    validate_optional_non_empty(&item.legacy_id, "quotationItems.legacyId")?,
                    sort_order,
                    item.description,
                    item.quantity_scaled.get(),
                    item.unit_price_scaled.get(),
                    item.total_minor.get(),
                    item_created
                ],
            )
            .map_err(|err| map_rusqlite_error(err, "inserting migrated quotation item"))?;
            expected_quote_item_count += 1;
        }
    }

    // 6. Insert invoices (preserving historical balances, status, quotation_id, timestamps) & items
    let mut expected_invoice_item_count: i64 = 0;
    for inv in &input.invoices {
        let inv_created = inv
            .created_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&now_utc);
        let inv_updated = inv
            .updated_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(inv_created);
        let (disc_pct, disc_fixed) = if inv.discount_type == "percentage" {
            (inv.discount_percentage_ppm.get(), 0_i64)
        } else {
            (0_i64, inv.discount_fixed_minor.get())
        };

        tx.execute(
            "INSERT INTO invoices (
                id, business_id, legacy_id, client_id, quotation_id, invoice_number,
                client_snapshot_json, business_snapshot_json, issue_date, due_date,
                currency, currency_symbol, subtotal_minor, discount_type,
                discount_percentage_ppm, discount_fixed_minor, discount_amount_minor,
                tax_name, tax_rate_ppm, tax_amount_minor, grand_total_minor,
                amount_paid_minor, outstanding_balance_minor, status,
                notes, terms, payment_instructions, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14,
                ?15, ?16, ?17,
                ?18, ?19, ?20, ?21,
                ?22, ?23, ?24,
                ?25, ?26, ?27, ?28, ?29
            );",
            params![
                inv.id.trim(),
                business_id,
                validate_optional_non_empty(&inv.legacy_id, "invoices.legacyId")?,
                validate_optional_non_empty(&inv.client_id, "invoices.clientId")?,
                validate_optional_non_empty(&inv.quotation_id, "invoices.quotationId")?,
                inv.invoice_number.trim(),
                inv.client_snapshot_json,
                inv.business_snapshot_json,
                inv.issue_date.trim(),
                validate_optional_iso_date(&inv.due_date, "invoices.dueDate")?,
                inv.currency.trim(),
                inv.currency_symbol.trim(),
                inv.subtotal_minor.get(),
                inv.discount_type,
                disc_pct,
                disc_fixed,
                inv.discount_amount_minor.get(),
                inv.tax_name.trim(),
                inv.tax_rate_ppm.get(),
                inv.tax_amount_minor.get(),
                inv.grand_total_minor.get(),
                inv.amount_paid_minor.get(),
                inv.outstanding_balance_minor.get(),
                inv.status,
                inv.notes,
                inv.terms,
                inv.payment_instructions,
                inv_created,
                inv_updated
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting migrated invoice"))?;

        for (idx, item) in inv.items.iter().enumerate() {
            let item_created = item
                .created_at
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(inv_created);
            let sort_order = item.sort_order.map(SafeI64::get).unwrap_or(idx as i64);
            tx.execute(
                "INSERT INTO invoice_items (
                    id, business_id, invoice_id, legacy_id, sort_order,
                    description, quantity_scaled, unit_price_scaled, total_minor, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
                params![
                    item.id.trim(),
                    business_id,
                    inv.id.trim(),
                    validate_optional_non_empty(&item.legacy_id, "invoiceItems.legacyId")?,
                    sort_order,
                    item.description,
                    item.quantity_scaled.get(),
                    item.unit_price_scaled.get(),
                    item.total_minor.get(),
                    item_created
                ],
            )
            .map_err(|err| map_rusqlite_error(err, "inserting migrated invoice item"))?;
            expected_invoice_item_count += 1;
        }
    }

    // 7. Attach canonical quotation.converted_invoice_id links now that invoices exist
    for q in &input.quotations {
        if let Some(conv_inv_id) =
            validate_optional_non_empty(&q.converted_invoice_id, "quotations.convertedInvoiceId")?
        {
            tx.execute(
                "UPDATE quotations SET converted_invoice_id = ?1 WHERE business_id = ?2 AND id = ?3;",
                params![conv_inv_id, business_id, q.id.trim()],
            )
            .map_err(|err| map_rusqlite_error(err, "linking quotation convertedInvoiceId"))?;
        }
    }

    // 8. Insert payments verbatim (without recalculating invoice balances or mutating updated_at)
    for pay in &input.payments {
        let recorded_at = pay
            .recorded_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&now_utc);
        tx.execute(
            "INSERT INTO payments (
                id, business_id, invoice_id, legacy_id, amount_minor,
                payment_date, payment_method, reference, notes, recorded_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
            params![
                pay.id.trim(),
                business_id,
                pay.invoice_id.trim(),
                validate_optional_non_empty(&pay.legacy_id, "payments.legacyId")?,
                pay.amount_minor.get(),
                pay.payment_date.trim(),
                pay.payment_method,
                pay.reference,
                pay.notes,
                recorded_at
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting migrated payment"))?;
    }

    // 9. Insert activity_logs
    for act in &input.activity_logs {
        let timestamp = act
            .timestamp
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&now_utc);
        tx.execute(
            "INSERT INTO activity_logs (
                id, business_id, legacy_id, type, title, description,
                timestamp, reference_id, reference_type, actor_local_profile_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
            params![
                act.id.trim(),
                business_id,
                validate_optional_non_empty(&act.legacy_id, "activityLogs.legacyId")?,
                act.log_type,
                act.title.trim(),
                act.description,
                timestamp,
                validate_optional_non_empty(&act.reference_id, "activityLogs.referenceId")?,
                validate_optional_non_empty(&act.reference_type, "activityLogs.referenceType")?,
                validate_optional_non_empty(
                    &act.actor_local_profile_id,
                    "activityLogs.actorLocalProfileId",
                )?
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting migrated activity log"))?;
    }

    // 10. Insert non-migration app_settings (e.g. theme_preference)
    for setting in &input.settings {
        let s_updated = setting
            .updated_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&now_utc);
        tx.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at;",
            params![setting.key.trim(), setting.value_json, s_updated],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting migrated app setting"))?;
    }

    // 11. Verify exact inserted row counts & financial sums inside transaction
    let actual_counts = collect_counts(&tx)?;
    let expected_business_assets = i64::try_from(input.assets.len()).unwrap_or(i64::MAX);
    let expected_clients = i64::try_from(input.clients.len()).unwrap_or(i64::MAX);
    let expected_quotations = i64::try_from(input.quotations.len()).unwrap_or(i64::MAX);
    let expected_invoices = i64::try_from(input.invoices.len()).unwrap_or(i64::MAX);
    let expected_payments = i64::try_from(input.payments.len()).unwrap_or(i64::MAX);
    let expected_activities = i64::try_from(input.activity_logs.len()).unwrap_or(i64::MAX);

    if actual_counts.businesses.get() != 1
        || actual_counts.business_assets.get() != expected_business_assets
        || actual_counts.clients.get() != expected_clients
        || actual_counts.quotations.get() != expected_quotations
        || actual_counts.quotation_items.get() != expected_quote_item_count
        || actual_counts.invoices.get() != expected_invoices
        || actual_counts.invoice_items.get() != expected_invoice_item_count
        || actual_counts.payments.get() != expected_payments
        || actual_counts.activity_logs.get() != expected_activities
    {
        return Err(DbError::Integrity(
            "Post-import row count verification failed inside migration transaction".to_string(),
        ));
    }

    if let Some(ref sums) = input.expected_financial_sums {
        let q_sum: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(grand_total_minor), 0) FROM quotations WHERE business_id = ?1;",
                params![business_id],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying quotation financial totals"))?;
        let inv_sum: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(grand_total_minor), 0) FROM invoices WHERE business_id = ?1;",
                params![business_id],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying invoice financial totals"))?;
        let paid_sum: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(amount_paid_minor), 0) FROM invoices WHERE business_id = ?1;",
                params![business_id],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying invoice amount_paid totals"))?;
        let pay_sum: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE business_id = ?1;",
                params![business_id],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying payment totals"))?;

        if q_sum != sums.quotation_grand_total_sum_minor.get()
            || inv_sum != sums.invoice_grand_total_sum_minor.get()
            || paid_sum != sums.invoice_amount_paid_sum_minor.get()
            || pay_sum != sums.payment_amount_sum_minor.get()
        {
            return Err(DbError::Integrity(
                "Post-import financial sum verification failed inside migration transaction"
                    .to_string(),
            ));
        }
    }

    // 12. Verify foreign keys inside the transaction before writing completion marker
    verify_foreign_keys_in_tx(&tx, "Migration")?;

    // 13. Write migration completion marker atomically within the exact same transaction
    let sanitized_diagnostics: Vec<MigrationDiagnosticDto> = input
        .diagnostics
        .iter()
        .cloned()
        .map(sanitize_diagnostic)
        .collect();

    let marker_payload = MigrationMarkerPayload {
        version: MIGRATION_MARKER_VERSION,
        status: "completed".to_string(),
        source: "localStorage".to_string(),
        migrated_business_id: Some(business_id.clone()),
        local_profile_id: Some(profile_id.clone()),
        backup_filename: Some(input.backup_verification.backup_filename.clone()),
        counts: Some(actual_counts.clone()),
        diagnostics: sanitized_diagnostics.clone(),
        completed_at: Some(now_utc.clone()),
    };

    let marker_json = serde_json::to_string(&marker_payload).map_err(|_| {
        DbError::Config("Failed to serialize migration completion marker".to_string())
    })?;

    tx.execute(
        "INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?1, ?2, ?3);",
        params![MIGRATION_SETTING_KEY, marker_json, now_utc],
    )
    .map_err(|err| map_rusqlite_error(err, "saving migration completion marker"))?;

    tx.execute(
        "DELETE FROM app_settings WHERE key = ?1;",
        params![MIGRATION_ERROR_SETTING_KEY],
    )
    .map_err(|err| map_rusqlite_error(err, "clearing prior migration error diagnostic"))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing workspace migration"))?;

    let final_counts = collect_counts(conn)?;
    Ok(MigrationResultDto {
        state: MigrationState::Completed,
        migrated_business_id: business_id,
        local_profile_id: profile_id,
        backup_filename: input.backup_verification.backup_filename.clone(),
        counts: final_counts,
        diagnostics: sanitized_diagnostics,
        completed_at: now_utc,
    })
}

fn insert_workspace_snapshot_in_tx(
    tx: &Connection,
    ws: &WorkspaceSnapshotRef<'_>,
    now_utc: &str,
) -> Result<(String, String, MigrationCountsDto), DbError> {
    let profile_created_at = ws
        .local_profile
        .created_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(now_utc)
        .to_string();
    let profile_updated_at = ws
        .local_profile
        .updated_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&profile_created_at)
        .to_string();

    let biz_created_at = ws
        .business
        .created_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(now_utc)
        .to_string();
    let biz_updated_at = ws
        .business
        .updated_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&biz_created_at)
        .to_string();

    // 1. Upsert local profile
    let profile_id = ws.local_profile.id.trim().to_string();
    let supabase_user_id = validate_optional_non_empty(
        &ws.local_profile.supabase_user_id,
        "localProfile.supabaseUserId",
    )?;
    tx.execute(
        "INSERT INTO local_profiles (id, display_name, email, supabase_user_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            display_name = excluded.display_name,
            email = excluded.email,
            supabase_user_id = excluded.supabase_user_id,
            updated_at = excluded.updated_at;",
        params![
            profile_id,
            ws.local_profile.display_name.trim(),
            ws.local_profile.email.trim(),
            supabase_user_id,
            profile_created_at,
            profile_updated_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "upserting workspace local profile"))?;

    // 2. Insert business initially with logo_asset_id = NULL
    let business_id = ws.business.id.trim().to_string();
    let business_legacy_id = validate_optional_non_empty(&ws.business.legacy_id, "business.legacyId")?;
    let owner_profile_id =
        validate_optional_non_empty(&ws.business.owner_profile_id, "business.ownerProfileId")?
            .or_else(|| Some(profile_id.clone()));

    tx.execute(
        "INSERT INTO businesses (
            id, legacy_id, owner_profile_id, name, tagline,
            logo_asset_id, logo_url_fallback, email, phone, address,
            city, country, postal_code, website, tax_number,
            registration_number, default_currency, currency_symbol,
            default_tax_name, default_tax_rate_ppm, is_tax_enabled,
            quote_prefix, invoice_prefix, next_quote_number, next_invoice_number,
            default_terms_quotation, default_terms_invoice, default_notes,
            bank_name, account_name, account_number, branch_code,
            account_type, swift_code, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            NULL, ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?17,
            ?18, ?19, ?20,
            ?21, ?22, ?23, ?24,
            ?25, ?26, ?27,
            ?28, ?29, ?30, ?31,
            ?32, ?33, ?34, ?35
        );",
        params![
            business_id,
            business_legacy_id,
            owner_profile_id,
            ws.business.name.trim(),
            ws.business.tagline,
            ws.business.logo_url_fallback,
            ws.business.email,
            ws.business.phone,
            ws.business.address,
            ws.business.city,
            ws.business.country,
            ws.business.postal_code,
            ws.business.website,
            ws.business.tax_number,
            ws.business.registration_number,
            ws.business.default_currency.trim(),
            ws.business.currency_symbol.trim(),
            ws.business.default_tax_name.trim(),
            ws.business.default_tax_rate_ppm.get(),
            if ws.business.is_tax_enabled { 1_i64 } else { 0_i64 },
            ws.business.quote_prefix.trim(),
            ws.business.invoice_prefix.trim(),
            ws.business.next_quote_number.get(),
            ws.business.next_invoice_number.get(),
            ws.business.default_terms_quotation,
            ws.business.default_terms_invoice,
            ws.business.default_notes,
            ws.business.bank_name,
            ws.business.account_name,
            ws.business.account_number,
            ws.business.branch_code,
            ws.business.account_type,
            ws.business.swift_code,
            biz_created_at,
            biz_updated_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "inserting workspace business"))?;

    // 3. Insert business_assets & attach business.logo_asset_id
    for asset in ws.assets {
        let asset_created = asset
            .created_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&biz_created_at);
        tx.execute(
            "INSERT INTO business_assets (
                id, business_id, content_hash, source_type, mime_type,
                inline_data, file_path, external_url, original_filename, byte_size, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);",
            params![
                asset.id.trim(),
                business_id,
                asset.content_hash.trim(),
                asset.source_type,
                validate_optional_non_empty(&asset.mime_type, "assets.mimeType")?,
                validate_optional_non_empty(&asset.inline_data, "assets.inlineData")?,
                validate_optional_non_empty(&asset.file_path, "assets.filePath")?,
                validate_optional_non_empty(&asset.external_url, "assets.externalUrl")?,
                validate_optional_non_empty(&asset.original_filename, "assets.originalFilename")?,
                asset.byte_size.map(SafeI64::get),
                asset_created
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting workspace business asset"))?;
    }

    if let Some(logo_asset_id) =
        validate_optional_non_empty(&ws.business.logo_asset_id, "business.logoAssetId")?
    {
        tx.execute(
            "UPDATE businesses SET logo_asset_id = ?1 WHERE id = ?2;",
            params![logo_asset_id, business_id],
        )
        .map_err(|err| map_rusqlite_error(err, "attaching workspace business logo asset"))?;
    }

    // 4. Insert clients
    for client in ws.clients {
        let c_created = client
            .created_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(now_utc);
        let c_updated = client
            .updated_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(c_created);
        tx.execute(
            "INSERT INTO clients (
                id, business_id, legacy_id, name, company_name,
                email, phone, address, city, country,
                vat_number, notes, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14);",
            params![
                client.id.trim(),
                business_id,
                validate_optional_non_empty(&client.legacy_id, "clients.legacyId")?,
                client.name.trim(),
                client.company_name,
                client.email,
                client.phone,
                client.address,
                client.city,
                client.country,
                client.vat_number,
                client.notes,
                c_created,
                c_updated
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting workspace client"))?;
    }

    // 5. Insert quotations (initially with converted_invoice_id = NULL) & quotation_items
    let mut expected_quote_item_count: i64 = 0;
    for q in ws.quotations {
        let q_created = q
            .created_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(now_utc);
        let q_updated = q
            .updated_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(q_created);
        let (disc_pct, disc_fixed) = if q.discount_type == "percentage" {
            (q.discount_percentage_ppm.get(), 0_i64)
        } else {
            (0_i64, q.discount_fixed_minor.get())
        };

        tx.execute(
            "INSERT INTO quotations (
                id, business_id, legacy_id, client_id, quotation_number,
                client_snapshot_json, business_snapshot_json, issue_date, expiry_date,
                currency, currency_symbol, subtotal_minor, discount_type,
                discount_percentage_ppm, discount_fixed_minor, discount_amount_minor,
                tax_name, tax_rate_ppm, tax_amount_minor, grand_total_minor,
                status, pre_conversion_status, notes, terms, converted_invoice_id,
                created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13,
                ?14, ?15, ?16,
                ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, NULL,
                ?25, ?26
            );",
            params![
                q.id.trim(),
                business_id,
                validate_optional_non_empty(&q.legacy_id, "quotations.legacyId")?,
                validate_optional_non_empty(&q.client_id, "quotations.clientId")?,
                q.quotation_number.trim(),
                q.client_snapshot_json,
                q.business_snapshot_json,
                q.issue_date.trim(),
                validate_optional_iso_date(&q.expiry_date, "quotations.expiryDate")?,
                q.currency.trim(),
                q.currency_symbol.trim(),
                q.subtotal_minor.get(),
                q.discount_type,
                disc_pct,
                disc_fixed,
                q.discount_amount_minor.get(),
                q.tax_name.trim(),
                q.tax_rate_ppm.get(),
                q.tax_amount_minor.get(),
                q.grand_total_minor.get(),
                q.status,
                validate_optional_non_empty(&q.pre_conversion_status, "quotations.preConversionStatus")?,
                q.notes,
                q.terms,
                q_created,
                q_updated
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting workspace quotation"))?;

        for (idx, item) in q.items.iter().enumerate() {
            let item_created = item
                .created_at
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(q_created);
            let sort_order = item.sort_order.map(SafeI64::get).unwrap_or(idx as i64);
            tx.execute(
                "INSERT INTO quotation_items (
                    id, business_id, quotation_id, legacy_id, sort_order,
                    description, quantity_scaled, unit_price_scaled, total_minor, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
                params![
                    item.id.trim(),
                    business_id,
                    q.id.trim(),
                    validate_optional_non_empty(&item.legacy_id, "quotationItems.legacyId")?,
                    sort_order,
                    item.description,
                    item.quantity_scaled.get(),
                    item.unit_price_scaled.get(),
                    item.total_minor.get(),
                    item_created
                ],
            )
            .map_err(|err| map_rusqlite_error(err, "inserting workspace quotation item"))?;
            expected_quote_item_count += 1;
        }
    }

    // 6. Insert invoices & invoice_items
    let mut expected_invoice_item_count: i64 = 0;
    for inv in ws.invoices {
        let inv_created = inv
            .created_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(now_utc);
        let inv_updated = inv
            .updated_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(inv_created);
        let (disc_pct, disc_fixed) = if inv.discount_type == "percentage" {
            (inv.discount_percentage_ppm.get(), 0_i64)
        } else {
            (0_i64, inv.discount_fixed_minor.get())
        };

        tx.execute(
            "INSERT INTO invoices (
                id, business_id, legacy_id, client_id, quotation_id, invoice_number,
                client_snapshot_json, business_snapshot_json, issue_date, due_date,
                currency, currency_symbol, subtotal_minor, discount_type,
                discount_percentage_ppm, discount_fixed_minor, discount_amount_minor,
                tax_name, tax_rate_ppm, tax_amount_minor, grand_total_minor,
                amount_paid_minor, outstanding_balance_minor, status,
                notes, terms, payment_instructions, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14,
                ?15, ?16, ?17,
                ?18, ?19, ?20, ?21,
                ?22, ?23, ?24,
                ?25, ?26, ?27, ?28, ?29
            );",
            params![
                inv.id.trim(),
                business_id,
                validate_optional_non_empty(&inv.legacy_id, "invoices.legacyId")?,
                validate_optional_non_empty(&inv.client_id, "invoices.clientId")?,
                validate_optional_non_empty(&inv.quotation_id, "invoices.quotationId")?,
                inv.invoice_number.trim(),
                inv.client_snapshot_json,
                inv.business_snapshot_json,
                inv.issue_date.trim(),
                validate_optional_iso_date(&inv.due_date, "invoices.dueDate")?,
                inv.currency.trim(),
                inv.currency_symbol.trim(),
                inv.subtotal_minor.get(),
                inv.discount_type,
                disc_pct,
                disc_fixed,
                inv.discount_amount_minor.get(),
                inv.tax_name.trim(),
                inv.tax_rate_ppm.get(),
                inv.tax_amount_minor.get(),
                inv.grand_total_minor.get(),
                inv.amount_paid_minor.get(),
                inv.outstanding_balance_minor.get(),
                inv.status,
                inv.notes,
                inv.terms,
                inv.payment_instructions,
                inv_created,
                inv_updated
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting workspace invoice"))?;

        for (idx, item) in inv.items.iter().enumerate() {
            let item_created = item
                .created_at
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(inv_created);
            let sort_order = item.sort_order.map(SafeI64::get).unwrap_or(idx as i64);
            tx.execute(
                "INSERT INTO invoice_items (
                    id, business_id, invoice_id, legacy_id, sort_order,
                    description, quantity_scaled, unit_price_scaled, total_minor, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
                params![
                    item.id.trim(),
                    business_id,
                    inv.id.trim(),
                    validate_optional_non_empty(&item.legacy_id, "invoiceItems.legacyId")?,
                    sort_order,
                    item.description,
                    item.quantity_scaled.get(),
                    item.unit_price_scaled.get(),
                    item.total_minor.get(),
                    item_created
                ],
            )
            .map_err(|err| map_rusqlite_error(err, "inserting workspace invoice item"))?;
            expected_invoice_item_count += 1;
        }
    }

    // 7. Attach canonical quotation.converted_invoice_id links
    for q in ws.quotations {
        if let Some(conv_inv_id) =
            validate_optional_non_empty(&q.converted_invoice_id, "quotations.convertedInvoiceId")?
        {
            tx.execute(
                "UPDATE quotations SET converted_invoice_id = ?1 WHERE business_id = ?2 AND id = ?3;",
                params![conv_inv_id, business_id, q.id.trim()],
            )
            .map_err(|err| map_rusqlite_error(err, "linking workspace quotation convertedInvoiceId"))?;
        }
    }

    // 8. Insert payments verbatim
    for pay in ws.payments {
        let recorded_at = pay
            .recorded_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(now_utc);
        tx.execute(
            "INSERT INTO payments (
                id, business_id, invoice_id, legacy_id, amount_minor,
                payment_date, payment_method, reference, notes, recorded_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
            params![
                pay.id.trim(),
                business_id,
                pay.invoice_id.trim(),
                validate_optional_non_empty(&pay.legacy_id, "payments.legacyId")?,
                pay.amount_minor.get(),
                pay.payment_date.trim(),
                pay.payment_method,
                pay.reference,
                pay.notes,
                recorded_at
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting workspace payment"))?;
    }

    // 9. Insert activity_logs
    for act in ws.activity_logs {
        let timestamp = act
            .timestamp
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(now_utc);
        tx.execute(
            "INSERT INTO activity_logs (
                id, business_id, legacy_id, type, title, description,
                timestamp, reference_id, reference_type, actor_local_profile_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
            params![
                act.id.trim(),
                business_id,
                validate_optional_non_empty(&act.legacy_id, "activityLogs.legacyId")?,
                act.log_type,
                act.title.trim(),
                act.description,
                timestamp,
                validate_optional_non_empty(&act.reference_id, "activityLogs.referenceId")?,
                validate_optional_non_empty(&act.reference_type, "activityLogs.referenceType")?,
                validate_optional_non_empty(
                    &act.actor_local_profile_id,
                    "activityLogs.actorLocalProfileId",
                )?
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting workspace activity log"))?;
    }

    // 10. Upsert optional non-migration settings
    for setting in ws.settings {
        let s_updated = setting
            .updated_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(now_utc);
        tx.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at;",
            params![setting.key.trim(), setting.value_json, s_updated],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting workspace app setting"))?;
    }

    // 11. Verify exact inserted counts & foreign keys
    let actual_counts = collect_counts(tx)?;
    let expected_business_assets = i64::try_from(ws.assets.len()).unwrap_or(i64::MAX);
    let expected_clients = i64::try_from(ws.clients.len()).unwrap_or(i64::MAX);
    let expected_quotations = i64::try_from(ws.quotations.len()).unwrap_or(i64::MAX);
    let expected_invoices = i64::try_from(ws.invoices.len()).unwrap_or(i64::MAX);
    let expected_payments = i64::try_from(ws.payments.len()).unwrap_or(i64::MAX);
    let expected_activities = i64::try_from(ws.activity_logs.len()).unwrap_or(i64::MAX);

    if actual_counts.businesses.get() != 1
        || actual_counts.business_assets.get() != expected_business_assets
        || actual_counts.clients.get() != expected_clients
        || actual_counts.quotations.get() != expected_quotations
        || actual_counts.quotation_items.get() != expected_quote_item_count
        || actual_counts.invoices.get() != expected_invoices
        || actual_counts.invoice_items.get() != expected_invoice_item_count
        || actual_counts.payments.get() != expected_payments
        || actual_counts.activity_logs.get() != expected_activities
    {
        return Err(DbError::Integrity(
            "Post-replace row count verification failed inside workspace transaction".to_string(),
        ));
    }

    verify_foreign_keys_in_tx(tx, "Workspace replacement")?;

    Ok((business_id, profile_id, actual_counts))
}

/// Atomically replaces the SQLite desktop workspace in a single `TransactionBehavior::Immediate`
/// transaction (for fresh desktop initialization, JSON backup import/restore, demo reset, or
/// starter workspace creation) while enforcing conflict safeguards and preserving valid
/// `migration.localstorage_v1` markers and backup files on disk.
pub fn replace_desktop_workspace(
    conn: &mut Connection,
    input: &ReplaceDesktopWorkspaceInput,
) -> Result<WorkspaceLifecycleResultDto, DbError> {
    let source = normalize_lifecycle_source(input.source.as_deref(), "workspace_replace")?;
    let ws = WorkspaceSnapshotRef {
        local_profile: &input.local_profile,
        business: &input.business,
        assets: &input.assets,
        clients: &input.clients,
        quotations: &input.quotations,
        invoices: &input.invoices,
        payments: &input.payments,
        activity_logs: &input.activity_logs,
        settings: &input.settings,
    };

    // Full validation BEFORE opening destructive DB writes.
    validate_workspace_snapshot(&ws)?;

    let now_utc = current_utc_iso(conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing_counts = collect_counts(&tx)?;
    let has_data = has_existing_business_data(&existing_counts);
    let raw_marker = read_setting_json(&tx, MIGRATION_SETTING_KEY)?;

    let should_write_not_needed = match raw_marker {
        Some(ref marker_json) => {
            let (state, _) = parse_marker_payload(marker_json)?;
            match state {
                MigrationState::ConflictExistingData => {
                    return Err(DbError::UniqueConstraint(
                        "Cannot replace desktop workspace while existing SQLite data requires migration conflict resolution".to_string(),
                    ));
                }
                MigrationState::Absent => {
                    return Err(DbError::Integrity(
                        "Stored migration marker resolved to unexpected absent state".to_string(),
                    ));
                }
                MigrationState::Completed | MigrationState::NotNeeded => false,
            }
        }
        None => {
            if has_data {
                return Err(DbError::UniqueConstraint(
                    "Cannot replace desktop workspace because SQLite already contains existing business data requiring migration conflict resolution".to_string(),
                ));
            }
            true
        }
    };

    clear_business_tables_in_tx(&tx)?;
    let (business_id, profile_id, actual_counts) =
        insert_workspace_snapshot_in_tx(&tx, &ws, &now_utc)?;

    if should_write_not_needed {
        let marker_payload = MigrationMarkerPayload {
            version: MIGRATION_MARKER_VERSION,
            status: "not_needed".to_string(),
            source,
            migrated_business_id: None,
            local_profile_id: Some(profile_id.clone()),
            backup_filename: None,
            counts: Some(actual_counts),
            diagnostics: Vec::new(),
            completed_at: Some(now_utc.clone()),
        };

        let marker_json = serde_json::to_string(&marker_payload).map_err(|_| {
            DbError::Config("Failed to serialize migration not_needed marker".to_string())
        })?;

        tx.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3);",
            params![MIGRATION_SETTING_KEY, marker_json, now_utc],
        )
        .map_err(|err| map_rusqlite_error(err, "saving migration not_needed marker"))?;

        tx.execute(
            "DELETE FROM app_settings WHERE key = ?1;",
            params![MIGRATION_ERROR_SETTING_KEY],
        )
        .map_err(|err| map_rusqlite_error(err, "clearing prior migration error diagnostic"))?;
    }

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing workspace replacement"))?;

    let final_status = get_migration_status(conn)?;
    Ok(WorkspaceLifecycleResultDto {
        migration_state: final_status.state,
        business_id: Some(business_id),
        local_profile_id: Some(profile_id),
        counts: final_status.existing_counts,
        completed_at: now_utc,
    })
}

/// Atomically clears all business-scoped tables (`businesses`, `business_assets`, `clients`,
/// `quotations`, `quotation_items`, `invoices`, `invoice_items`, `payments`, `activity_logs`)
/// in a single `TransactionBehavior::Immediate` transaction after breaking circular FKs.
/// Preserves existing `migration.localstorage_v1` markers (or stamps `not_needed` when clearing
/// an unmarked empty workspace), preserves non-business `app_settings`, preserves backup files
/// on disk, verifies `PRAGMA foreign_key_check`, and refuses if SQLite has unresolved conflicts.
pub fn clear_desktop_workspace(
    conn: &mut Connection,
    source: Option<&str>,
) -> Result<WorkspaceLifecycleResultDto, DbError> {
    let source = normalize_lifecycle_source(source, "clear_workspace")?;
    let now_utc = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing_counts = collect_counts(&tx)?;
    let has_data = has_existing_business_data(&existing_counts);
    let raw_marker = read_setting_json(&tx, MIGRATION_SETTING_KEY)?;

    let should_write_not_needed = match raw_marker {
        Some(ref marker_json) => {
            let (state, _) = parse_marker_payload(marker_json)?;
            match state {
                MigrationState::ConflictExistingData => {
                    return Err(DbError::UniqueConstraint(
                        "Cannot clear desktop workspace while existing SQLite data requires migration conflict resolution".to_string(),
                    ));
                }
                MigrationState::Absent => {
                    return Err(DbError::Integrity(
                        "Stored migration marker resolved to unexpected absent state".to_string(),
                    ));
                }
                MigrationState::Completed | MigrationState::NotNeeded => false,
            }
        }
        None => {
            if has_data {
                return Err(DbError::UniqueConstraint(
                    "Cannot clear desktop workspace because SQLite already contains existing business data requiring migration conflict resolution".to_string(),
                ));
            }
            true
        }
    };

    clear_business_tables_in_tx(&tx)?;

    let post_counts = collect_counts(&tx)?;
    if has_existing_business_data(&post_counts) {
        return Err(DbError::Integrity(
            "Post-clear verification found remaining business records inside transaction"
                .to_string(),
        ));
    }

    verify_foreign_keys_in_tx(&tx, "Workspace clear")?;

    if should_write_not_needed {
        let marker_payload = MigrationMarkerPayload {
            version: MIGRATION_MARKER_VERSION,
            status: "not_needed".to_string(),
            source,
            migrated_business_id: None,
            local_profile_id: None,
            backup_filename: None,
            counts: Some(post_counts),
            diagnostics: Vec::new(),
            completed_at: Some(now_utc.clone()),
        };

        let marker_json = serde_json::to_string(&marker_payload).map_err(|_| {
            DbError::Config("Failed to serialize migration not_needed marker".to_string())
        })?;

        tx.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3);",
            params![MIGRATION_SETTING_KEY, marker_json, now_utc],
        )
        .map_err(|err| map_rusqlite_error(err, "saving migration not_needed marker"))?;

        tx.execute(
            "DELETE FROM app_settings WHERE key = ?1;",
            params![MIGRATION_ERROR_SETTING_KEY],
        )
        .map_err(|err| map_rusqlite_error(err, "clearing prior migration error diagnostic"))?;
    }

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing workspace clear"))?;

    let final_status = get_migration_status(conn)?;
    Ok(WorkspaceLifecycleResultDto {
        migration_state: final_status.state,
        business_id: None,
        local_profile_id: None,
        counts: final_status.existing_counts,
        completed_at: now_utc,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dto::RawLegacyKeyEntry;
    use crate::db::DatabaseManager;
    use std::sync::atomic::AtomicU64;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(1);

    struct TempDbEnv {
        dir: PathBuf,
        db_path: PathBuf,
        conn: Connection,
    }

    impl TempDbEnv {
        fn new(label: &str) -> Self {
            let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "bizora_mig_test_{label}_{}_{}",
                std::process::id(),
                seq
            ));
            let _ = fs::remove_dir_all(&dir);
            let manager = DatabaseManager::with_app_data_dir(&dir);
            manager.initialize().expect("DB init must succeed");
            let db_path = manager.db_path().expect("db path").to_path_buf();
            let conn = manager
                .ensure_initialized_connection()
                .expect("initialized connection");
            Self { dir, db_path, conn }
        }
    }

    impl Drop for TempDbEnv {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn make_raw_backup_input() -> BackupLegacyStorageInput {
        BackupLegacyStorageInput {
            captured_at: "2026-11-19T06:00:00.000Z".to_string(),
            source: "localStorage".to_string(),
            keys: vec![
                RawLegacyKeyEntry {
                    key: "bizora_business_profile_v1".to_string(),
                    present: true,
                    present_in_local_storage: true,
                    present_in_memory_fallback: false,
                    raw_value: Some("{\"id\":\"biz_default\",\"name\":\"Studio\"}".to_string()),
                },
                RawLegacyKeyEntry {
                    key: "bizora_has_initialized_v1".to_string(),
                    present: true,
                    present_in_local_storage: true,
                    present_in_memory_fallback: false,
                    raw_value: Some("true".to_string()),
                },
            ],
        }
    }

    fn make_valid_migration_payload(
        backup: BackupLegacyStorageResult,
    ) -> LegacyWorkspaceMigrationInput {
        let profile_id = "11111111-1111-4111-8111-111111111111".to_string();
        let business_id = "22222222-2222-4222-8222-222222222222".to_string();
        let asset_id = "33333333-3333-4333-8333-333333333333".to_string();
        let client_id = "44444444-4444-4444-8444-444444444444".to_string();
        let quote_id = "55555555-5555-4555-8555-555555555555".to_string();
        let inv_id = "66666666-6666-4666-8666-666666666666".to_string();
        let inv2_id = "77777777-7777-4777-8777-777777777777".to_string();
        let pay_id = "88888888-8888-4888-8888-888888888888".to_string();
        let act_id = "99999999-9999-4999-8999-999999999999".to_string();

        LegacyWorkspaceMigrationInput {
            backup_verification: backup,
            local_profile: CreateLocalProfileInput {
                id: profile_id.clone(),
                display_name: "Local Owner".to_string(),
                email: "owner@example.com".to_string(),
                supabase_user_id: None,
                created_at: Some("2026-10-01T08:00:00.000Z".to_string()),
                updated_at: Some("2026-10-01T08:00:00.000Z".to_string()),
            },
            business: CreateBusinessInput {
                id: business_id.clone(),
                legacy_id: Some("biz_default".to_string()),
                owner_profile_id: Some(profile_id.clone()),
                name: "Kalahari Creative Studio".to_string(),
                tagline: "Design & Digital".to_string(),
                logo_asset_id: Some(asset_id.clone()),
                logo_url_fallback: "".to_string(),
                email: "hello@studio.na".to_string(),
                phone: "+264 61 000 000".to_string(),
                address: "Windhoek".to_string(),
                city: "Windhoek".to_string(),
                country: "Namibia".to_string(),
                postal_code: Some("9000".to_string()),
                website: None,
                tax_number: None,
                registration_number: None,
                default_currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                default_tax_name: "VAT".to_string(),
                default_tax_rate_ppm: SafeI64(150_000),
                is_tax_enabled: true,
                quote_prefix: "QUO-".to_string(),
                invoice_prefix: "INV-".to_string(),
                next_quote_number: SafeI64(4),
                next_invoice_number: SafeI64(5),
                default_terms_quotation: "Valid 30 days".to_string(),
                default_terms_invoice: "Due 14 days".to_string(),
                default_notes: "Thanks".to_string(),
                bank_name: "FNB".to_string(),
                account_name: "Studio".to_string(),
                account_number: "12345".to_string(),
                branch_code: "280172".to_string(),
                account_type: None,
                swift_code: None,
                created_at: Some("2026-10-01T09:00:00.000Z".to_string()),
                updated_at: Some("2026-10-01T09:00:00.000Z".to_string()),
            },
            assets: vec![CreateBusinessAssetInput {
                id: asset_id,
                business_id: business_id.clone(),
                content_hash: sha256_hex(b"data:image/png;base64,AAAA"),
                source_type: "data_url".to_string(),
                mime_type: Some("image/png".to_string()),
                inline_data: Some("data:image/png;base64,AAAA".to_string()),
                file_path: None,
                external_url: None,
                original_filename: None,
                byte_size: Some(SafeI64(26)),
                created_at: Some("2026-10-01T09:00:00.000Z".to_string()),
            }],
            clients: vec![CreateClientInput {
                id: client_id.clone(),
                business_id: business_id.clone(),
                legacy_id: Some("cli_1".to_string()),
                name: "Helena".to_string(),
                company_name: Some("Desert Bloom".to_string()),
                email: "helena@example.na".to_string(),
                phone: "123".to_string(),
                address: "Swakopmund".to_string(),
                city: Some("Swakopmund".to_string()),
                country: Some("Namibia".to_string()),
                vat_number: None,
                notes: None,
                created_at: Some("2026-10-02T10:00:00.000Z".to_string()),
                updated_at: Some("2026-10-02T10:00:00.000Z".to_string()),
            }],
            quotations: vec![CreateQuotationInput {
                id: quote_id.clone(),
                business_id: business_id.clone(),
                legacy_id: Some("quo_1".to_string()),
                client_id: Some(client_id.clone()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: "{\"name\":\"Helena\"}".to_string(),
                business_snapshot_json: "{\"name\":\"Kalahari Creative Studio\"}".to_string(),
                issue_date: "2026-10-05".to_string(),
                expiry_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: SafeI64(100_00),
                discount_type: "fixed".to_string(),
                discount_percentage_ppm: SafeI64(0),
                discount_fixed_minor: SafeI64(0),
                discount_amount_minor: SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: SafeI64(150_000),
                tax_amount_minor: SafeI64(15_00),
                grand_total_minor: SafeI64(115_00),
                status: "accepted".to_string(),
                pre_conversion_status: Some("sent".to_string()),
                notes: None,
                terms: None,
                converted_invoice_id: Some(inv_id.clone()),
                items: vec![LineItemInput {
                    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                    legacy_id: Some("item_1".to_string()),
                    sort_order: Some(SafeI64(0)),
                    description: "Branding".to_string(),
                    quantity_scaled: SafeI64(1_000_000),
                    unit_price_scaled: SafeI64(100_000_000),
                    total_minor: SafeI64(100_00),
                    created_at: Some("2026-10-05T09:00:00.000Z".to_string()),
                }],
                created_at: Some("2026-10-05T09:00:00.000Z".to_string()),
                updated_at: Some("2026-10-06T09:00:00.000Z".to_string()),
            }],
            invoices: vec![
                // Historical invoice 1 (paid with mismatch vs payments preserved verbatim)
                CreateInvoiceInput {
                    id: inv_id.clone(),
                    business_id: business_id.clone(),
                    legacy_id: Some("inv_1".to_string()),
                    client_id: Some(client_id.clone()),
                    quotation_id: Some(quote_id.clone()),
                    invoice_number: "INV-0001".to_string(),
                    client_snapshot_json: "{\"name\":\"Helena\"}".to_string(),
                    business_snapshot_json: "{\"name\":\"Kalahari Creative Studio\"}".to_string(),
                    issue_date: "2026-10-06".to_string(),
                    due_date: Some("2026-10-20".to_string()),
                    currency: "NAD".to_string(),
                    currency_symbol: "N$".to_string(),
                    subtotal_minor: SafeI64(100_00),
                    discount_type: "percentage".to_string(),
                    discount_percentage_ppm: SafeI64(0),
                    discount_fixed_minor: SafeI64(0),
                    discount_amount_minor: SafeI64(0),
                    tax_name: "VAT".to_string(),
                    tax_rate_ppm: SafeI64(150_000),
                    tax_amount_minor: SafeI64(15_00),
                    grand_total_minor: SafeI64(115_00),
                    amount_paid_minor: SafeI64(115_00),
                    outstanding_balance_minor: SafeI64(0),
                    status: "paid".to_string(),
                    notes: None,
                    terms: None,
                    payment_instructions: None,
                    items: vec![LineItemInput {
                        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
                        legacy_id: Some("item_inv_1".to_string()),
                        sort_order: Some(SafeI64(0)),
                        description: "Branding".to_string(),
                        quantity_scaled: SafeI64(1_000_000),
                        unit_price_scaled: SafeI64(100_000_000),
                        total_minor: SafeI64(100_00),
                        created_at: Some("2026-10-06T09:00:00.000Z".to_string()),
                    }],
                    created_at: Some("2026-10-06T09:00:00.000Z".to_string()),
                    updated_at: Some("2026-10-07T09:00:00.000Z".to_string()),
                },
                // Historical invoice 2: deleted client (client_id = None), multi-invoice link to quote_id, negative item preserved
                CreateInvoiceInput {
                    id: inv2_id.clone(),
                    business_id: business_id.clone(),
                    legacy_id: Some("inv_2".to_string()),
                    client_id: None,
                    quotation_id: Some(quote_id),
                    invoice_number: "INV-0002".to_string(),
                    client_snapshot_json: "{\"name\":\"Deleted Client\"}".to_string(),
                    business_snapshot_json: "{\"name\":\"Kalahari Creative Studio\"}".to_string(),
                    issue_date: "2026-10-08".to_string(),
                    due_date: None,
                    currency: "NAD".to_string(),
                    currency_symbol: "N$".to_string(),
                    subtotal_minor: SafeI64(-50_00),
                    discount_type: "fixed".to_string(),
                    discount_percentage_ppm: SafeI64(0),
                    discount_fixed_minor: SafeI64(0),
                    discount_amount_minor: SafeI64(0),
                    tax_name: "VAT".to_string(),
                    tax_rate_ppm: SafeI64(0),
                    tax_amount_minor: SafeI64(0),
                    grand_total_minor: SafeI64(-50_00),
                    amount_paid_minor: SafeI64(0),
                    outstanding_balance_minor: SafeI64(0),
                    status: "overdue".to_string(),
                    notes: None,
                    terms: None,
                    payment_instructions: None,
                    items: vec![LineItemInput {
                        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_string(),
                        legacy_id: Some("item_inv_2".to_string()),
                        sort_order: Some(SafeI64(0)),
                        description: "Historical credit".to_string(),
                        quantity_scaled: SafeI64(1_000_000),
                        unit_price_scaled: SafeI64(-50_000_000),
                        total_minor: SafeI64(-50_00),
                        created_at: Some("2026-10-08T09:00:00.000Z".to_string()),
                    }],
                    created_at: Some("2026-10-08T09:00:00.000Z".to_string()),
                    updated_at: Some("2026-10-09T09:00:00.000Z".to_string()),
                },
            ],
            payments: vec![CreatePaymentInput {
                id: pay_id,
                business_id: business_id.clone(),
                invoice_id: inv_id.clone(),
                legacy_id: Some("pay_1".to_string()),
                amount_minor: SafeI64(100_00), // Deliberate mismatch with 115_00 amount_paid_minor preserved
                payment_date: "2026-10-07".to_string(),
                payment_method: "eft".to_string(),
                reference: Some("REF-1".to_string()),
                notes: None,
                recorded_at: Some("2026-10-07T12:00:00.000Z".to_string()),
            }],
            activity_logs: vec![CreateActivityLogInput {
                id: act_id,
                business_id,
                legacy_id: Some("act_1".to_string()),
                log_type: "invoice_created".to_string(),
                title: "Invoice INV-0001 Created".to_string(),
                description: "Migrated activity".to_string(),
                timestamp: Some("2026-10-06T09:00:00.000Z".to_string()),
                reference_id: Some(inv_id),
                reference_type: Some("invoice".to_string()),
                actor_local_profile_id: Some(profile_id),
            }],
            settings: vec![SaveAppSettingInput {
                key: "theme_preference".to_string(),
                value_json: "\"dark\"".to_string(),
                updated_at: Some("2026-11-19T06:00:00.000Z".to_string()),
            }],
            diagnostics: vec![MigrationDiagnosticDto {
                code: "NEGATIVE_FINANCIAL_VALUE_PRESERVED".to_string(),
                severity: "warning".to_string(),
                stage: "normalize".to_string(),
                entity_type: "invoice".to_string(),
                record_id: Some(inv2_id),
                field: Some("grandTotal".to_string()),
                original_value: Some("-50.00".to_string()),
                message: "Negative historical total preserved verbatim.".to_string(),
                suggested_action: "Confirm adjustment was intentional.".to_string(),
            }],
            expected_financial_sums: Some(crate::db::dto::ExpectedFinancialSumsInput {
                quotation_grand_total_sum_minor: SafeI64(115_00),
                invoice_grand_total_sum_minor: SafeI64(65_00),
                invoice_amount_paid_sum_minor: SafeI64(115_00),
                payment_amount_sum_minor: SafeI64(100_00),
            }),
        }
    }

    #[test]
    fn sha256_matches_standard_nist_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn backup_creates_verified_file_inside_app_data_backups_and_rejects_tamper() {
        let mut env = TempDbEnv::new("backup_verify");
        let backup = backup_legacy_localstorage(&env.db_path, &make_raw_backup_input())
            .expect("backup must succeed");

        assert!(backup.verified);
        assert!(backup.backup_filename.starts_with(BACKUP_FILE_PREFIX));
        assert!(!backup.backup_filename.contains('/'));
        assert!(!backup.backup_filename.contains('\\'));
        assert_eq!(backup.captured_key_count.get(), 2);

        verify_existing_backup_file(&env.db_path, &backup).expect("backup verification passes");

        // Tamper with backup file on disk -> migration must abort before DB writes
        let full_backup = env.dir.join("backups").join(&backup.backup_filename);
        fs::write(&full_backup, b"{}").expect("tamper write");

        let payload = make_valid_migration_payload(backup);
        let err = migrate_legacy_workspace(&mut env.conn, &env.db_path, &payload)
            .expect_err("tampered backup must abort migration");
        assert!(matches!(err, DbError::Integrity(_)));
        assert_eq!(query_table_count(&env.conn, "businesses").unwrap(), 0);
    }

    #[test]
    fn migration_aborts_if_backup_missing_or_unverified() {
        let mut env = TempDbEnv::new("backup_required");
        let fake_backup = BackupLegacyStorageResult {
            backup_filename: "bizora-localstorage-pre-migration-missing.json".to_string(),
            byte_size: SafeI64(10),
            sha256: "0".repeat(64),
            verified: true,
            captured_key_count: SafeI64(1),
        };
        let payload = make_valid_migration_payload(fake_backup);
        let err = migrate_legacy_workspace(&mut env.conn, &env.db_path, &payload)
            .expect_err("missing backup must abort");
        assert!(matches!(err, DbError::Integrity(_)));
        assert_eq!(query_table_count(&env.conn, "businesses").unwrap(), 0);
    }

    #[test]
    fn atomic_migration_imports_preserves_history_verifies_fk_and_rejects_duplicate() {
        let mut env = TempDbEnv::new("atomic_success");
        assert_eq!(
            get_migration_status(&env.conn).unwrap().state,
            MigrationState::Absent
        );

        let backup = backup_legacy_localstorage(&env.db_path, &make_raw_backup_input()).unwrap();
        let payload = make_valid_migration_payload(backup);
        let result = migrate_legacy_workspace(&mut env.conn, &env.db_path, &payload)
            .expect("atomic migration must succeed");

        assert_eq!(result.state, MigrationState::Completed);
        assert_eq!(result.counts.businesses.get(), 1);
        assert_eq!(result.counts.business_assets.get(), 1);
        assert_eq!(result.counts.clients.get(), 1);
        assert_eq!(result.counts.quotations.get(), 1);
        assert_eq!(result.counts.quotation_items.get(), 1);
        assert_eq!(result.counts.invoices.get(), 2);
        assert_eq!(result.counts.invoice_items.get(), 2);
        assert_eq!(result.counts.payments.get(), 1);
        assert_eq!(result.counts.activity_logs.get(), 1);

        // Verify historical balances & negative total preserved without recalculation
        let (paid1, out1): (i64, i64) = env
            .conn
            .query_row(
                "SELECT amount_paid_minor, outstanding_balance_minor FROM invoices WHERE invoice_number = 'INV-0001';",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((paid1, out1), (115_00, 0));

        let neg_total: i64 = env
            .conn
            .query_row(
                "SELECT grand_total_minor FROM invoices WHERE invoice_number = 'INV-0002';",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(neg_total, -50_00);

        // Status endpoint reflects Completed + atomically persisted marker
        let status = get_migration_status(&env.conn).unwrap();
        assert_eq!(status.state, MigrationState::Completed);
        assert_eq!(status.marker_version, Some(MIGRATION_MARKER_VERSION));

        // Duplicate migration attempt must be rejected
        let dup_err = migrate_legacy_workspace(&mut env.conn, &env.db_path, &payload)
            .expect_err("duplicate import must be rejected");
        assert!(matches!(dup_err, DbError::UniqueConstraint(_)));
    }

    #[test]
    fn failed_migration_rolls_back_all_tables_and_completion_marker() {
        let mut env = TempDbEnv::new("rollback");
        let backup = backup_legacy_localstorage(&env.db_path, &make_raw_backup_input()).unwrap();
        let mut payload = make_valid_migration_payload(backup);

        // Inject invalid activity log reference to trigger failure near end of transaction (step 9)
        payload.activity_logs[0].actor_local_profile_id =
            Some("aaaaaaaa-0000-4000-8000-000000000000".to_string());

        let err = migrate_legacy_workspace(&mut env.conn, &env.db_path, &payload)
            .expect_err("invalid actor profile must fail");
        assert!(matches!(err, DbError::ForeignKeyViolation(_)));

        // Even if payload bypasses pre-validation via an invalid SQL FK on activity_logs:
        payload.activity_logs[0].actor_local_profile_id = None;
        payload.quotations[0].client_id = None;
        // Cause SQLite FK or check error during transaction: invalid created_at empty check? No, try duplicate payment ID inside SQL vs invalid quotation status? Let's test SQL-time rollback by inserting invalid setting error? Even better: check rollback when duplicate legacy_id occurs inside SQL!
        payload.clients.push(CreateClientInput {
            id: "44444444-4444-4444-8444-444444444445".to_string(),
            business_id: payload.business.id.clone(),
            legacy_id: Some("cli_1".to_string()), // duplicates client[0].legacy_id -> SQLite UNIQUE(business_id, legacy_id) failure mid-tx!
            name: "Duplicate Legacy Client".to_string(),
            company_name: None,
            email: "".to_string(),
            phone: "".to_string(),
            address: "".to_string(),
            city: None,
            country: None,
            vat_number: None,
            notes: None,
            created_at: None,
            updated_at: None,
        });

        let rollback_err = migrate_legacy_workspace(&mut env.conn, &env.db_path, &payload)
            .expect_err("mid-transaction SQLite constraint error must roll back");
        assert!(matches!(rollback_err, DbError::UniqueConstraint(_)));

        let counts = collect_counts(&env.conn).unwrap();
        assert_eq!(counts.local_profiles.get(), 0);
        assert_eq!(counts.businesses.get(), 0);
        assert_eq!(counts.business_assets.get(), 0);
        assert_eq!(counts.clients.get(), 0);
        assert_eq!(counts.quotations.get(), 0);
        assert_eq!(counts.invoices.get(), 0);
        assert_eq!(counts.payments.get(), 0);
        assert_eq!(counts.activity_logs.get(), 0);
        assert!(read_setting_json(&env.conn, MIGRATION_SETTING_KEY)
            .unwrap()
            .is_none());
    }

    #[test]
    fn existing_sqlite_data_without_marker_triggers_conflict_and_prevents_overwrite() {
        let mut env = TempDbEnv::new("conflict");
        // Seed one business outside migration
        env.conn
            .execute(
                "INSERT INTO businesses (id, name, created_at, updated_at)
                 VALUES ('biz_existing', 'Existing Biz', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');",
                [],
            )
            .unwrap();

        let status = get_migration_status(&env.conn).unwrap();
        assert_eq!(status.state, MigrationState::ConflictExistingData);

        let backup = backup_legacy_localstorage(&env.db_path, &make_raw_backup_input()).unwrap();
        let payload = make_valid_migration_payload(backup);
        let err = migrate_legacy_workspace(&mut env.conn, &env.db_path, &payload)
            .expect_err("pre-populated DB must reject migration");
        assert!(matches!(err, DbError::UniqueConstraint(_)));
        assert_eq!(query_table_count(&env.conn, "businesses").unwrap(), 1);
    }

    fn make_replace_workspace_input(source: &str, suffix: &str) -> ReplaceDesktopWorkspaceInput {
        let profile_id = format!("11111111-1111-4111-8111-0000000000{suffix}");
        let business_id = format!("22222222-2222-4222-8222-0000000000{suffix}");
        let asset_id = format!("33333333-3333-4333-8333-0000000000{suffix}");
        let client_id = format!("44444444-4444-4444-8444-0000000000{suffix}");
        let quote_id = format!("55555555-5555-4555-8555-0000000000{suffix}");
        let inv_id = format!("66666666-6666-4666-8666-0000000000{suffix}");
        let pay_id = format!("88888888-8888-4888-8888-0000000000{suffix}");
        let act_id = format!("99999999-9999-4999-8999-0000000000{suffix}");
        let q_item_id = format!("aaaaaaaa-aaaa-4aaa-8aaa-0000000000{suffix}");
        let i_item_id = format!("bbbbbbbb-bbbb-4bbb-8bbb-0000000000{suffix}");

        let inline_logo = format!("data:image/png;base64,BBBB{suffix}");
        ReplaceDesktopWorkspaceInput {
            source: Some(source.to_string()),
            local_profile: CreateLocalProfileInput {
                id: profile_id.clone(),
                display_name: format!("Owner {suffix}"),
                email: format!("owner{suffix}@example.com"),
                supabase_user_id: None,
                created_at: None,
                updated_at: None,
            },
            business: CreateBusinessInput {
                id: business_id.clone(),
                legacy_id: Some(format!("biz_{suffix}")),
                owner_profile_id: Some(profile_id.clone()),
                name: format!("Namib Studio {suffix}"),
                tagline: "Modern Services".to_string(),
                logo_asset_id: Some(asset_id.clone()),
                logo_url_fallback: "".to_string(),
                email: format!("hello{suffix}@studio.na"),
                phone: "+264 61 111 111".to_string(),
                address: "Windhoek".to_string(),
                city: "Windhoek".to_string(),
                country: "Namibia".to_string(),
                postal_code: Some("9000".to_string()),
                website: None,
                tax_number: None,
                registration_number: None,
                default_currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                default_tax_name: "VAT".to_string(),
                default_tax_rate_ppm: SafeI64(150_000),
                is_tax_enabled: true,
                quote_prefix: "QUO-".to_string(),
                invoice_prefix: "INV-".to_string(),
                next_quote_number: SafeI64(2),
                next_invoice_number: SafeI64(2),
                default_terms_quotation: "Valid 30 days".to_string(),
                default_terms_invoice: "Due 14 days".to_string(),
                default_notes: "Thank you".to_string(),
                bank_name: "Bank Windhoek".to_string(),
                account_name: "Namib Studio".to_string(),
                account_number: "987654321".to_string(),
                branch_code: "481972".to_string(),
                account_type: None,
                swift_code: None,
                created_at: None,
                updated_at: None,
            },
            assets: vec![CreateBusinessAssetInput {
                id: asset_id,
                business_id: business_id.clone(),
                content_hash: sha256_hex(inline_logo.as_bytes()),
                source_type: "data_url".to_string(),
                mime_type: Some("image/png".to_string()),
                inline_data: Some(inline_logo),
                file_path: None,
                external_url: None,
                original_filename: Some("logo.png".to_string()),
                byte_size: Some(SafeI64(32)),
                created_at: None,
            }],
            clients: vec![CreateClientInput {
                id: client_id.clone(),
                business_id: business_id.clone(),
                legacy_id: Some(format!("cli_{suffix}")),
                name: format!("Client {suffix}"),
                company_name: Some("Dune Holdings".to_string()),
                email: format!("client{suffix}@example.na"),
                phone: "123".to_string(),
                address: "Walvis Bay".to_string(),
                city: Some("Walvis Bay".to_string()),
                country: Some("Namibia".to_string()),
                vat_number: None,
                notes: None,
                created_at: None,
                updated_at: None,
            }],
            quotations: vec![CreateQuotationInput {
                id: quote_id.clone(),
                business_id: business_id.clone(),
                legacy_id: Some(format!("quo_{suffix}")),
                client_id: Some(client_id.clone()),
                quotation_number: format!("QUO-10{suffix}"),
                client_snapshot_json: "{\"name\":\"Client\"}".to_string(),
                business_snapshot_json: "{\"name\":\"Namib Studio\"}".to_string(),
                issue_date: "2026-11-01".to_string(),
                expiry_date: Some("2026-12-01".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: SafeI64(200_00),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: SafeI64(0),
                discount_fixed_minor: SafeI64(0),
                discount_amount_minor: SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: SafeI64(150_000),
                tax_amount_minor: SafeI64(30_00),
                grand_total_minor: SafeI64(230_00),
                status: "accepted".to_string(),
                pre_conversion_status: Some("sent".to_string()),
                notes: None,
                terms: None,
                converted_invoice_id: Some(inv_id.clone()),
                items: vec![LineItemInput {
                    id: q_item_id,
                    legacy_id: Some(format!("qi_{suffix}")),
                    sort_order: Some(SafeI64(0)),
                    description: "Retainer".to_string(),
                    quantity_scaled: SafeI64(2_000_000),
                    unit_price_scaled: SafeI64(100_000_000),
                    total_minor: SafeI64(200_00),
                    created_at: None,
                }],
                created_at: None,
                updated_at: None,
            }],
            invoices: vec![CreateInvoiceInput {
                id: inv_id.clone(),
                business_id: business_id.clone(),
                legacy_id: Some(format!("inv_{suffix}")),
                client_id: Some(client_id),
                quotation_id: Some(quote_id),
                invoice_number: format!("INV-10{suffix}"),
                client_snapshot_json: "{\"name\":\"Client\"}".to_string(),
                business_snapshot_json: "{\"name\":\"Namib Studio\"}".to_string(),
                issue_date: "2026-11-02".to_string(),
                due_date: Some("2026-11-16".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: SafeI64(200_00),
                discount_type: "fixed".to_string(),
                discount_percentage_ppm: SafeI64(0),
                discount_fixed_minor: SafeI64(0),
                discount_amount_minor: SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: SafeI64(150_000),
                tax_amount_minor: SafeI64(30_00),
                grand_total_minor: SafeI64(230_00),
                amount_paid_minor: SafeI64(100_00),
                outstanding_balance_minor: SafeI64(130_00),
                status: "partially_paid".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![LineItemInput {
                    id: i_item_id,
                    legacy_id: Some(format!("ii_{suffix}")),
                    sort_order: Some(SafeI64(0)),
                    description: "Retainer".to_string(),
                    quantity_scaled: SafeI64(2_000_000),
                    unit_price_scaled: SafeI64(100_000_000),
                    total_minor: SafeI64(200_00),
                    created_at: None,
                }],
                created_at: None,
                updated_at: None,
            }],
            payments: vec![CreatePaymentInput {
                id: pay_id,
                business_id: business_id.clone(),
                invoice_id: inv_id.clone(),
                legacy_id: Some(format!("pay_{suffix}")),
                amount_minor: SafeI64(100_00),
                payment_date: "2026-11-03".to_string(),
                payment_method: "eft".to_string(),
                reference: Some("EFT-100".to_string()),
                notes: None,
                recorded_at: None,
            }],
            activity_logs: vec![CreateActivityLogInput {
                id: act_id,
                business_id,
                legacy_id: Some(format!("act_{suffix}")),
                log_type: "invoice_created".to_string(),
                title: format!("Created INV-10{suffix}"),
                description: "Workspace entry".to_string(),
                timestamp: None,
                reference_id: Some(inv_id),
                reference_type: Some("invoice".to_string()),
                actor_local_profile_id: Some(profile_id),
            }],
            settings: Vec::new(),
        }
    }

    #[test]
    fn mark_migration_not_needed_succeeds_on_empty_db_with_version_timestamp_and_source() {
        let mut env = TempDbEnv::new("not_needed_empty");
        assert_eq!(
            get_migration_status(&env.conn).unwrap().state,
            MigrationState::Absent
        );

        let status = mark_migration_not_needed(&mut env.conn, Some("desktop_fresh_install"))
            .expect("marking empty DB as not_needed must succeed");
        assert_eq!(status.state, MigrationState::NotNeeded);
        assert_eq!(status.marker_version, Some(MIGRATION_MARKER_VERSION));
        assert!(status.completed_at.is_some());

        let raw_marker = read_setting_json(&env.conn, MIGRATION_SETTING_KEY)
            .unwrap()
            .expect("marker must be persisted");
        let parsed: MigrationMarkerPayload = serde_json::from_str(&raw_marker).unwrap();
        assert_eq!(parsed.version, MIGRATION_MARKER_VERSION);
        assert_eq!(parsed.status, "not_needed");
        assert_eq!(parsed.source, "desktop_fresh_install");
        assert!(parsed.completed_at.is_some());

        // Calling again is idempotent and preserves NotNeeded
        let again = mark_migration_not_needed(&mut env.conn, Some("desktop_fresh_install"))
            .expect("idempotent call must succeed");
        assert_eq!(again.state, MigrationState::NotNeeded);
        assert_eq!(again.completed_at, status.completed_at);
    }

    #[test]
    fn mark_migration_not_needed_refuses_safely_when_sqlite_has_existing_business_data() {
        let mut env = TempDbEnv::new("not_needed_conflict");
        env.conn
            .execute(
                "INSERT INTO businesses (id, name, created_at, updated_at)
                 VALUES ('biz_conflict', 'Preexisting Co', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');",
                [],
            )
            .unwrap();

        let err = mark_migration_not_needed(&mut env.conn, Some("desktop_fresh_install"))
            .expect_err("must refuse when SQLite has existing business data without marker");
        assert!(matches!(err, DbError::UniqueConstraint(_)));

        assert!(read_setting_json(&env.conn, MIGRATION_SETTING_KEY)
            .unwrap()
            .is_none());
        assert_eq!(
            get_migration_status(&env.conn).unwrap().state,
            MigrationState::ConflictExistingData
        );
    }

    #[test]
    fn mark_migration_not_needed_preserves_existing_completed_marker() {
        let mut env = TempDbEnv::new("not_needed_preserves_completed");
        let backup = backup_legacy_localstorage(&env.db_path, &make_raw_backup_input()).unwrap();
        let payload = make_valid_migration_payload(backup);
        let migrated = migrate_legacy_workspace(&mut env.conn, &env.db_path, &payload).unwrap();

        let err = mark_migration_not_needed(&mut env.conn, Some("desktop_fresh_install"))
            .expect_err("must never overwrite a completed migration marker");
        assert!(matches!(err, DbError::UniqueConstraint(_)));

        let status = get_migration_status(&env.conn).unwrap();
        assert_eq!(status.state, MigrationState::Completed);
        assert_eq!(
            status.migrated_business_id.as_deref(),
            Some(migrated.migrated_business_id.as_str())
        );
        assert_eq!(
            status.backup_filename.as_deref(),
            Some(migrated.backup_filename.as_str())
        );
    }

    #[test]
    fn record_migration_error_persists_sanitized_diagnostic_and_redacts_sensitive_payloads() {
        let mut env = TempDbEnv::new("record_err_sanitized");

        let raw_diag = MigrationDiagnosticDto {
            code: "BACKUP_WRITE_FAILED\n\x1b[31m".to_string(),
            severity: "ERROR".to_string(),
            stage: "backup".to_string(),
            entity_type: "workspace\t".to_string(),
            record_id: Some("bizora_business_profile_v1".to_string()),
            field: Some("logoDataUrl".to_string()),
            original_value: Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA==".to_string()),
            message: "Failed parsing {\"bizora_clients_v1\":[{\"id\":\"1\"}]} with Bearer super_secret_token and data:image/jpeg;base64,/9j/4AAQSk".to_string(),
            suggested_action: "Retry backup after freeing disk space.\r\nKeep password=topsecret out.".to_string(),
        };

        let persisted = record_migration_error(&mut env.conn, &raw_diag)
            .expect("sanitized diagnostic recording must succeed");

        assert_eq!(persisted.code, "BACKUP_WRITE_FAILED [31m");
        assert_eq!(persisted.severity, "error");
        assert!(!persisted.code.contains('\n'));
        assert!(!persisted.code.contains('\x1b'));
        assert_eq!(
            persisted.record_id.as_deref(),
            Some("[REDACTED_RAW_PAYLOAD]")
        );
        assert_eq!(
            persisted.original_value.as_deref(),
            Some("[REDACTED_DATA_URI]")
        );
        assert_eq!(persisted.message, "[REDACTED_RAW_PAYLOAD]");
        assert_eq!(persisted.suggested_action, "[REDACTED_SECRET]");

        // Verify data URI redaction inline inside plain messages as well
        let data_uri_msg = MigrationDiagnosticDto {
            code: "INVALID_LOGO".to_string(),
            severity: "warning".to_string(),
            stage: "normalize".to_string(),
            entity_type: "business".to_string(),
            record_id: Some("biz_1".to_string()),
            field: Some("logoUrl".to_string()),
            original_value: Some("data:image/png;base64,AAAA".to_string()),
            message: "Logo skipped — data:image/png;base64,iVBORw0KGgo= exceeded inline limit".to_string(),
            suggested_action: "Upload a smaller PNG or SVG logo.".to_string(),
        };
        let persisted_inline = record_migration_error(&mut env.conn, &data_uri_msg).unwrap();
        assert_eq!(
            persisted_inline.message,
            "Logo skipped — [REDACTED_DATA_URI] exceeded inline limit"
        );
        assert_eq!(
            persisted_inline.original_value.as_deref(),
            Some("[REDACTED_DATA_URI]")
        );

        let status = get_migration_status(&env.conn).unwrap();
        assert_eq!(status.state, MigrationState::Absent);
        assert_eq!(status.last_error, Some(persisted_inline));

        // Blank required fields must be rejected
        let invalid_diag = MigrationDiagnosticDto {
            code: "   ".to_string(),
            ..data_uri_msg
        };
        let err = record_migration_error(&mut env.conn, &invalid_diag)
            .expect_err("blank code must fail validation");
        assert!(matches!(err, DbError::InvalidInput { .. }));
    }

    #[test]
    fn replace_desktop_workspace_rolls_back_mid_transaction_leaving_previous_workspace_intact() {
        let mut env = TempDbEnv::new("replace_rollback");
        let backup = backup_legacy_localstorage(&env.db_path, &make_raw_backup_input()).unwrap();
        let initial_payload = make_valid_migration_payload(backup);
        migrate_legacy_workspace(&mut env.conn, &env.db_path, &initial_payload).unwrap();

        // 1. Pre-validation error leaves existing workspace untouched
        let mut invalid_replace = make_replace_workspace_input("json_backup_restore", "01");
        invalid_replace.business.name = "   ".to_string();
        let pre_err = replace_desktop_workspace(&mut env.conn, &invalid_replace)
            .expect_err("blank business name must fail before delete");
        assert!(matches!(pre_err, DbError::InvalidInput { .. }));

        // 2. Mid-transaction SQLite constraint error (after DELETE + partial INSERTs) must roll back cleanly
        let mut mid_tx_fail = make_replace_workspace_input("json_backup_restore", "02");
        let mut dup_client = mid_tx_fail.clients[0].clone();
        dup_client.id = "44444444-4444-4444-8444-000000000099".to_string();
        // Same business_id + legacy_id triggers SQLite UNIQUE(business_id, legacy_id) after business + assets + client[0] inserted!
        mid_tx_fail.clients.push(dup_client);

        let tx_err = replace_desktop_workspace(&mut env.conn, &mid_tx_fail)
            .expect_err("mid-transaction constraint error must roll back");
        assert!(matches!(tx_err, DbError::UniqueConstraint(_)));

        // Previous migrated workspace and its Completed marker remain 100% intact
        let counts = collect_counts(&env.conn).unwrap();
        assert_eq!(counts.businesses.get(), 1);
        assert_eq!(counts.clients.get(), 1);
        assert_eq!(counts.quotations.get(), 1);
        assert_eq!(counts.invoices.get(), 2);
        assert_eq!(counts.payments.get(), 1);
        assert_eq!(counts.activity_logs.get(), 1);

        let biz_name: String = env
            .conn
            .query_row("SELECT name FROM businesses LIMIT 1;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(biz_name, "Kalahari Creative Studio");
        assert_eq!(
            get_migration_status(&env.conn).unwrap().state,
            MigrationState::Completed
        );
    }

    #[test]
    fn replace_desktop_workspace_preserves_completed_marker_refuses_conflict_and_marks_fresh_not_needed() {
        // Subcase A: Fresh empty DB -> marks not_needed atomically
        let mut env_fresh = TempDbEnv::new("replace_fresh");
        let fresh_input = make_replace_workspace_input("desktop_fresh_install", "11");
        let fresh_res = replace_desktop_workspace(&mut env_fresh.conn, &fresh_input)
            .expect("fresh workspace init must succeed");
        assert_eq!(fresh_res.migration_state, MigrationState::NotNeeded);
        assert_eq!(
            fresh_res.business_id.as_deref(),
            Some(fresh_input.business.id.as_str())
        );
        assert_eq!(
            get_migration_status(&env_fresh.conn).unwrap().state,
            MigrationState::NotNeeded
        );

        // Subcase B: Migrated DB (Completed) -> replacement preserves Completed marker
        let mut env_migrated = TempDbEnv::new("replace_completed");
        let backup = backup_legacy_localstorage(&env_migrated.db_path, &make_raw_backup_input()).unwrap();
        let migrated_payload = make_valid_migration_payload(backup);
        let migrated = migrate_legacy_workspace(&mut env_migrated.conn, &env_migrated.db_path, &migrated_payload).unwrap();

        let demo_input = make_replace_workspace_input("demo_reset", "22");
        let res = replace_desktop_workspace(&mut env_migrated.conn, &demo_input)
            .expect("demo reset on Completed workspace must succeed");
        assert_eq!(res.migration_state, MigrationState::Completed);
        assert_eq!(
            res.business_id.as_deref(),
            Some(demo_input.business.id.as_str())
        );

        let status = get_migration_status(&env_migrated.conn).unwrap();
        assert_eq!(status.state, MigrationState::Completed);
        assert_eq!(
            status.migrated_business_id.as_deref(),
            Some(migrated.migrated_business_id.as_str())
        );
        assert_eq!(
            status.backup_filename.as_deref(),
            Some(migrated.backup_filename.as_str())
        );

        // Subcase C: Conflicted DB (business row exists with NO marker) -> must refuse cleanly
        let mut env_conflict = TempDbEnv::new("replace_conflict");
        env_conflict
            .conn
            .execute(
                "INSERT INTO businesses (id, name, created_at, updated_at)
                 VALUES ('biz_conflict', 'Untracked Biz', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');",
                [],
            )
            .unwrap();
        let conflict_err = replace_desktop_workspace(
            &mut env_conflict.conn,
            &make_replace_workspace_input("demo_reset", "33"),
        )
        .expect_err("conflicted DB must refuse silent replacement");
        assert!(matches!(conflict_err, DbError::UniqueConstraint(_)));
        let kept_name: String = env_conflict
            .conn
            .query_row("SELECT name FROM businesses LIMIT 1;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept_name, "Untracked Biz");
    }

    #[test]
    fn replace_desktop_workspace_verifies_circular_fk_and_relationship_integrity() {
        let mut env = TempDbEnv::new("replace_fk");
        let first = make_replace_workspace_input("desktop_fresh_install", "41");
        replace_desktop_workspace(&mut env.conn, &first).unwrap();

        let second = make_replace_workspace_input("json_backup_restore", "42");
        let res = replace_desktop_workspace(&mut env.conn, &second)
            .expect("replacing circular-FK workspace with another circular-FK workspace must succeed");

        assert_eq!(res.counts.businesses.get(), 1);
        assert_eq!(res.counts.business_assets.get(), 1);
        assert_eq!(res.counts.clients.get(), 1);
        assert_eq!(res.counts.quotations.get(), 1);
        assert_eq!(res.counts.quotation_items.get(), 1);
        assert_eq!(res.counts.invoices.get(), 1);
        assert_eq!(res.counts.invoice_items.get(), 1);
        assert_eq!(res.counts.payments.get(), 1);
        assert_eq!(res.counts.activity_logs.get(), 1);

        let (logo_id, q_conv_id, inv_q_id): (Option<String>, Option<String>, Option<String>) = env
            .conn
            .query_row(
                "SELECT
                    (SELECT logo_asset_id FROM businesses LIMIT 1),
                    (SELECT converted_invoice_id FROM quotations LIMIT 1),
                    (SELECT quotation_id FROM invoices LIMIT 1);",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(logo_id, second.business.logo_asset_id);
        assert_eq!(q_conv_id, second.quotations[0].converted_invoice_id);
        assert_eq!(inv_q_id, second.invoices[0].quotation_id);
        verify_foreign_keys_in_tx(&env.conn, "Post-replace test").unwrap();
    }

    #[test]
    fn clear_desktop_workspace_clears_all_business_tables_safely_preserving_marker_backups_and_theme() {
        let mut env = TempDbEnv::new("clear_safe");
        let backup = backup_legacy_localstorage(&env.db_path, &make_raw_backup_input()).unwrap();
        let payload = make_valid_migration_payload(backup.clone());
        let migrated = migrate_legacy_workspace(&mut env.conn, &env.db_path, &payload).unwrap();

        let cleared = clear_desktop_workspace(&mut env.conn, Some("clear_all_data"))
            .expect("clearing migrated workspace must succeed cleanly");
        assert_eq!(cleared.migration_state, MigrationState::Completed);
        assert!(cleared.business_id.is_none());
        assert_eq!(cleared.counts.businesses.get(), 0);
        assert_eq!(cleared.counts.business_assets.get(), 0);
        assert_eq!(cleared.counts.clients.get(), 0);
        assert_eq!(cleared.counts.quotations.get(), 0);
        assert_eq!(cleared.counts.quotation_items.get(), 0);
        assert_eq!(cleared.counts.invoices.get(), 0);
        assert_eq!(cleared.counts.invoice_items.get(), 0);
        assert_eq!(cleared.counts.payments.get(), 0);
        assert_eq!(cleared.counts.activity_logs.get(), 0);

        // Migration marker preserved (prevents silent LocalStorage re-import on next boot)
        let status = get_migration_status(&env.conn).unwrap();
        assert_eq!(status.state, MigrationState::Completed);
        assert_eq!(
            status.migrated_business_id.as_deref(),
            Some(migrated.migrated_business_id.as_str())
        );

        // Non-migration theme preference preserved
        let theme = read_setting_json(&env.conn, "theme_preference")
            .unwrap()
            .expect("theme_preference must remain intact");
        assert_eq!(theme, "\"dark\"");

        // Verified backup file on disk untouched
        verify_existing_backup_file(&env.db_path, &backup)
            .expect("verified pre-migration backup on disk must remain intact");
        verify_foreign_keys_in_tx(&env.conn, "Post-clear test").unwrap();

        // Conflicted DB must refuse clear_desktop_workspace
        let mut env_conflict = TempDbEnv::new("clear_conflict");
        env_conflict
            .conn
            .execute(
                "INSERT INTO businesses (id, name, created_at, updated_at)
                 VALUES ('biz_conflict', 'Conflicted Biz', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');",
                [],
            )
            .unwrap();
        let clear_err = clear_desktop_workspace(&mut env_conflict.conn, Some("clear_all_data"))
            .expect_err("conflicted DB must refuse workspace clear");
        assert!(matches!(clear_err, DbError::UniqueConstraint(_)));
        assert_eq!(query_table_count(&env_conflict.conn, "businesses").unwrap(), 1);
    }
}
