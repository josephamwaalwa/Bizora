use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::db::dto::{
    BackupLegacyStorageInput, BackupLegacyStorageResult, LegacyWorkspaceMigrationInput,
    LineItemInput, MigrationCountsDto, MigrationDiagnosticDto, MigrationResultDto, MigrationState,
    MigrationStatusDto,
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

pub fn get_migration_status(conn: &Connection) -> Result<MigrationStatusDto, DbError> {
    let existing_counts = collect_counts(conn)?;
    let raw_marker = read_setting_json(conn, MIGRATION_SETTING_KEY)?;
    let raw_error = read_setting_json(conn, MIGRATION_ERROR_SETTING_KEY)?;

    let last_error = raw_error.and_then(|json_str| {
        serde_json::from_str::<MigrationDiagnosticDto>(&json_str).ok()
    });

    if let Some(marker_json) = raw_marker {
        let marker: MigrationMarkerPayload =
            serde_json::from_str(&marker_json).map_err(|_| {
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

pub fn sanitize_diagnostic(mut d: MigrationDiagnosticDto) -> MigrationDiagnosticDto {
    if let Some(val) = d.original_value.take() {
        let cleaned: String = val
            .chars()
            .filter(|c| !c.is_control() || *c == ' ')
            .take(120)
            .collect();
        d.original_value = Some(cleaned);
    }
    d
}

pub fn record_migration_error(
    conn: &mut Connection,
    diagnostic: &MigrationDiagnosticDto,
) -> Result<(), DbError> {
    let sanitized = sanitize_diagnostic(diagnostic.clone());
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

    Ok(())
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

    let _ = require_non_empty_id(&input.local_profile.id, "localProfile.id")?;
    let _ = validate_optional_non_empty(
        &input.local_profile.supabase_user_id,
        "localProfile.supabaseUserId",
    )?;
    if let Some(ref ts) = input.local_profile.created_at {
        let _ = require_trimmed_non_empty(ts, "localProfile.createdAt")?;
    }
    if let Some(ref ts) = input.local_profile.updated_at {
        let _ = require_trimmed_non_empty(ts, "localProfile.updatedAt")?;
    }

    let business_id = require_non_empty_id(&input.business.id, "business.id")?;
    let _ = validate_optional_non_empty(&input.business.legacy_id, "business.legacyId")?;
    let _ = validate_optional_non_empty(&input.business.owner_profile_id, "business.ownerProfileId")?;
    let _ = require_trimmed_non_empty(&input.business.name, "business.name")?;
    let _ = validate_optional_non_empty(&input.business.logo_asset_id, "business.logoAssetId")?;
    let _ = require_trimmed_non_empty(&input.business.default_currency, "business.defaultCurrency")?;
    let _ = require_trimmed_non_empty(&input.business.currency_symbol, "business.currencySymbol")?;
    let _ = require_trimmed_non_empty(&input.business.default_tax_name, "business.defaultTaxName")?;
    let _ = require_trimmed_non_empty(&input.business.quote_prefix, "business.quotePrefix")?;
    let _ = require_trimmed_non_empty(&input.business.invoice_prefix, "business.invoicePrefix")?;
    require_positive(input.business.next_quote_number.get(), "business.nextQuoteNumber")?;
    require_positive(
        input.business.next_invoice_number.get(),
        "business.nextInvoiceNumber",
    )?;

    let mut asset_ids = HashSet::with_capacity(input.assets.len());
    let mut asset_hashes = HashSet::with_capacity(input.assets.len());
    for asset in &input.assets {
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

    if let Some(ref logo_id) = input.business.logo_asset_id {
        if !asset_ids.contains(logo_id.trim()) {
            return Err(DbError::ForeignKeyViolation(
                "Business logoAssetId does not exist in migration assets".to_string(),
            ));
        }
    }

    let mut client_ids = HashSet::with_capacity(input.clients.len());
    for client in &input.clients {
        let cid = require_non_empty_id(&client.id, "clients.id")?.to_string();
        if !client_ids.insert(cid) {
            return Err(DbError::DuplicateId("Duplicate client ID in migration payload".to_string()));
        }
        if require_non_empty_id(&client.business_id, "clients.businessId")? != business_id {
            return Err(DbError::ForeignKeyViolation(
                "Client references a different business".to_string(),
            ));
        }
        let _ = validate_optional_non_empty(&client.legacy_id, "clients.legacyId")?;
        let _ = require_trimmed_non_empty(&client.name, "clients.name")?;
    }

    let mut quote_ids = HashSet::with_capacity(input.quotations.len());
    let mut quote_numbers = HashSet::with_capacity(input.quotations.len());
    let mut quote_item_ids = HashSet::new();
    for q in &input.quotations {
        let qid = require_non_empty_id(&q.id, "quotations.id")?.to_string();
        if !quote_ids.insert(qid) {
            return Err(DbError::DuplicateId(
                "Duplicate quotation ID in migration payload".to_string(),
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
                    "Quotation clientId does not exist in migration clients".to_string(),
                ));
            }
        }
        let qnum = require_trimmed_non_empty(&q.quotation_number, "quotations.quotationNumber")?;
        if !quote_numbers.insert(qnum.to_lowercase()) {
            return Err(DbError::DuplicateDocumentNumber(format!(
                "Duplicate quotation number '{qnum}' in migration payload"
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

    let mut invoice_ids = HashSet::with_capacity(input.invoices.len());
    let mut invoice_numbers = HashSet::with_capacity(input.invoices.len());
    let mut invoice_item_ids = HashSet::new();
    for inv in &input.invoices {
        let iid = require_non_empty_id(&inv.id, "invoices.id")?.to_string();
        if !invoice_ids.insert(iid) {
            return Err(DbError::DuplicateId(
                "Duplicate invoice ID in migration payload".to_string(),
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
                    "Invoice clientId does not exist in migration clients".to_string(),
                ));
            }
        }
        if let Some(ref qid) =
            validate_optional_non_empty(&inv.quotation_id, "invoices.quotationId")?
        {
            if !quote_ids.contains(qid) {
                return Err(DbError::ForeignKeyViolation(
                    "Invoice quotationId does not exist in migration quotations".to_string(),
                ));
            }
        }
        let inum = require_trimmed_non_empty(&inv.invoice_number, "invoices.invoiceNumber")?;
        if !invoice_numbers.insert(inum.to_lowercase()) {
            return Err(DbError::DuplicateDocumentNumber(format!(
                "Duplicate invoice number '{inum}' in migration payload"
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
    for q in &input.quotations {
        if let Some(ref conv_id) =
            validate_optional_non_empty(&q.converted_invoice_id, "quotations.convertedInvoiceId")?
        {
            if !invoice_ids.contains(conv_id) {
                return Err(DbError::ForeignKeyViolation(
                    "Quotation convertedInvoiceId does not exist in migration invoices".to_string(),
                ));
            }
            if !claimed_converted_invoices.insert(conv_id.clone()) {
                return Err(DbError::UniqueConstraint(
                    "Multiple quotations claim the same convertedInvoiceId".to_string(),
                ));
            }
        }
    }

    let mut payment_ids = HashSet::with_capacity(input.payments.len());
    for pay in &input.payments {
        let pid = require_non_empty_id(&pay.id, "payments.id")?.to_string();
        if !payment_ids.insert(pid) {
            return Err(DbError::DuplicateId(
                "Duplicate payment ID in migration payload".to_string(),
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
                "Payment invoiceId does not exist in migration invoices".to_string(),
            ));
        }
        let _ = validate_optional_non_empty(&pay.legacy_id, "payments.legacyId")?;
        validate_iso_date(&pay.payment_date, "payments.paymentDate")?;
        validate_enum(&pay.payment_method, &PAYMENT_METHODS, "payments.paymentMethod")?;
    }

    let mut activity_ids = HashSet::with_capacity(input.activity_logs.len());
    for act in &input.activity_logs {
        let aid = require_non_empty_id(&act.id, "activityLogs.id")?.to_string();
        if !activity_ids.insert(aid) {
            return Err(DbError::DuplicateId(
                "Duplicate activity log ID in migration payload".to_string(),
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
            if actor_id != input.local_profile.id.trim() {
                return Err(DbError::ForeignKeyViolation(
                    "Activity log actorLocalProfileId does not match migration profile".to_string(),
                ));
            }
        }
    }

    for setting in &input.settings {
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
    let mut fk_stmt = tx
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
    drop(fk_stmt);

    if !fk_violations.is_empty() {
        return Err(DbError::Integrity(format!(
            "Migration foreign_key_check failed: {}",
            fk_violations.join("; ")
        )));
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dto::{
        CreateActivityLogInput, CreateBusinessAssetInput, CreateBusinessInput, CreateClientInput,
        CreateInvoiceInput, CreateLocalProfileInput, CreatePaymentInput, CreateQuotationInput,
        RawLegacyKeyEntry, SaveAppSettingInput,
    };
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
}
