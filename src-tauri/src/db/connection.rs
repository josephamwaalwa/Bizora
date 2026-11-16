use std::path::Path;

use rusqlite::Connection;

use super::DbError;

pub const REQUIRED_BUSY_TIMEOUT_MS: i64 = 5000;

#[derive(Debug, Clone)]
pub struct ConnectionPragmas {
    pub journal_mode: String,
    pub foreign_keys_enabled: bool,
    pub busy_timeout_ms: i64,
    pub sqlite_version: String,
}

/// Opens a file-backed SQLite connection and applies per-connection PRAGMAs.
/// Never falls back to an in-memory database.
pub fn open_configured_connection(db_path: &Path) -> Result<Connection, DbError> {
    let conn = Connection::open(db_path).map_err(|source| DbError::Open {
        path: db_path.display().to_string(),
        source,
    })?;

    configure_connection(&conn)?;
    Ok(conn)
}

/// Applies required per-connection PRAGMA settings and verifies they took effect.
pub fn configure_connection(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|err| DbError::ForeignKeyConfig(format!("Failed to enable foreign_keys: {err}")))?;

    let fk_status: i64 = conn
        .query_row("PRAGMA foreign_keys;", [], |row| row.get(0))
        .map_err(|err| {
            DbError::ForeignKeyConfig(format!("Failed to verify foreign_keys PRAGMA: {err}"))
        })?;

    if fk_status != 1 {
        return Err(DbError::ForeignKeyConfig(format!(
            "SQLite foreign_keys enforcement is disabled (expected 1, got {fk_status})"
        )));
    }

    let timeout_ms: i64 = conn
        .query_row(
            &format!("PRAGMA busy_timeout = {REQUIRED_BUSY_TIMEOUT_MS};"),
            [],
            |row| row.get(0),
        )
        .map_err(|err| DbError::Config(format!("Failed to set busy_timeout PRAGMA: {err}")))?;

    if timeout_ms != REQUIRED_BUSY_TIMEOUT_MS {
        return Err(DbError::Config(format!(
            "SQLite busy_timeout mismatch (expected {REQUIRED_BUSY_TIMEOUT_MS}, got {timeout_ms})"
        )));
    }

    Ok(())
}

/// Configures database-level WAL journal mode outside any active transaction.
pub fn configure_wal_mode(conn: &Connection) -> Result<String, DbError> {
    if !conn.is_autocommit() {
        return Err(DbError::Config(
            "PRAGMA journal_mode = WAL must be configured outside an active transaction"
                .to_string(),
        ));
    }

    let mode: String = conn
        .query_row("PRAGMA journal_mode = WAL;", [], |row| row.get(0))
        .map_err(|err| DbError::Config(format!("Failed to set WAL journal mode: {err}")))?;

    if !mode.eq_ignore_ascii_case("wal") {
        return Err(DbError::Config(format!(
            "Expected SQLite journal_mode 'wal', got '{mode}'"
        )));
    }

    Ok(mode)
}

/// Reads current PRAGMA status and SQLite version from an open connection.
pub fn query_connection_pragmas(conn: &Connection) -> Result<ConnectionPragmas, DbError> {
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
        .map_err(|source| DbError::Query {
            context: "PRAGMA journal_mode".to_string(),
            source,
        })?;

    let fk_value: i64 = conn
        .query_row("PRAGMA foreign_keys;", [], |row| row.get(0))
        .map_err(|source| DbError::Query {
            context: "PRAGMA foreign_keys".to_string(),
            source,
        })?;

    let busy_timeout_ms: i64 = conn
        .query_row("PRAGMA busy_timeout;", [], |row| row.get(0))
        .map_err(|source| DbError::Query {
            context: "PRAGMA busy_timeout".to_string(),
            source,
        })?;

    Ok(ConnectionPragmas {
        journal_mode,
        foreign_keys_enabled: fk_value == 1,
        busy_timeout_ms,
        sqlite_version: rusqlite::version().to_string(),
    })
}

/// Verifies database structure and relational integrity using PRAGMA integrity_check
/// and PRAGMA foreign_key_check.
pub fn verify_database_integrity(conn: &Connection) -> Result<(), DbError> {
    let mut integrity_stmt = conn
        .prepare("PRAGMA integrity_check;")
        .map_err(|err| DbError::Integrity(format!("Failed to prepare integrity_check: {err}")))?;

    let integrity_rows = integrity_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| DbError::Integrity(format!("Failed to execute integrity_check: {err}")))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|err| DbError::Integrity(format!("Failed to read integrity_check result: {err}")))?;

    if integrity_rows.len() != 1 || !integrity_rows[0].eq_ignore_ascii_case("ok") {
        let details = if integrity_rows.is_empty() {
            "empty response".to_string()
        } else {
            integrity_rows.join("; ")
        };
        return Err(DbError::Integrity(format!(
            "SQLite integrity_check failed: {details}"
        )));
    }

    let mut fk_stmt = conn
        .prepare("PRAGMA foreign_key_check;")
        .map_err(|err| DbError::Integrity(format!("Failed to prepare foreign_key_check: {err}")))?;

    let fk_violations = fk_stmt
        .query_map([], |row| {
            let table: String = row.get(0)?;
            let rowid: i64 = row.get(1)?;
            let parent: String = row.get(2)?;
            let fkid: i64 = row.get(3)?;
            Ok(format!(
                "table='{table}' rowid={rowid} parent='{parent}' fkid={fkid}"
            ))
        })
        .map_err(|err| DbError::Integrity(format!("Failed to execute foreign_key_check: {err}")))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|err| DbError::Integrity(format!("Failed to read foreign_key_check result: {err}")))?;

    if !fk_violations.is_empty() {
        return Err(DbError::Integrity(format!(
            "SQLite foreign_key_check failed: {}",
            fk_violations.join("; ")
        )));
    }

    Ok(())
}
