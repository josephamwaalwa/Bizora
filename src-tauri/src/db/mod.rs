pub mod commands;
pub mod connection;
pub mod dto;
pub mod migrations;
pub mod models;
pub mod precision;
pub mod repositories;
pub mod schema;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use rusqlite::Connection;
use serde::Serialize;

use connection::{
    configure_wal_mode, open_configured_connection, query_connection_pragmas,
    verify_database_integrity, REQUIRED_BUSY_TIMEOUT_MS,
};
use dto::CommandError;
use migrations::{apply_migrations, current_schema_version};
use schema::INITIAL_SCHEMA_VERSION;

pub const DATABASE_FILENAME: &str = "bizora.db";

#[derive(Debug)]
pub enum DbError {
    DirectoryCreation {
        path: String,
        source: std::io::Error,
    },
    Open {
        path: String,
        source: rusqlite::Error,
    },
    Config(String),
    ForeignKeyConfig(String),
    Migration {
        version: i64,
        message: String,
    },
    Integrity(String),
    Query {
        context: String,
        source: rusqlite::Error,
    },
    PathResolution(String),
    LockPoisoned(String),
    NotInitialized(String),
    InvalidInput {
        field: Option<String>,
        message: String,
    },
    NotFound(String),
    DuplicateId(String),
    DuplicateDocumentNumber(String),
    UniqueConstraint(String),
    ForeignKeyViolation(String),
    TransactionFailed(String),
    NumericOverflow(String),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::DirectoryCreation { path, source } => {
                write!(
                    f,
                    "Failed to create application database directory '{path}': {source}"
                )
            }
            DbError::Open { path, source } => {
                write!(f, "Failed to open SQLite database '{path}': {source}")
            }
            DbError::Config(msg) => write!(f, "SQLite configuration error: {msg}"),
            DbError::ForeignKeyConfig(msg) => {
                write!(f, "SQLite foreign key configuration error: {msg}")
            }
            DbError::Migration { version, message } => {
                write!(f, "Database migration error (v{version}): {message}")
            }
            DbError::Integrity(msg) => write!(f, "Database integrity check failed: {msg}"),
            DbError::Query { context, source } => {
                write!(f, "SQLite query error while {context}: {source}")
            }
            DbError::PathResolution(msg) => write!(f, "Database path resolution error: {msg}"),
            DbError::LockPoisoned(msg) => write!(f, "Database synchronization error: {msg}"),
            DbError::NotInitialized(msg) => write!(f, "Database not initialized: {msg}"),
            DbError::InvalidInput { message, .. } => write!(f, "Validation error: {message}"),
            DbError::NotFound(msg) => write!(f, "Record not found: {msg}"),
            DbError::DuplicateId(msg) => write!(f, "Duplicate identifier: {msg}"),
            DbError::DuplicateDocumentNumber(msg) => {
                write!(f, "Duplicate document number: {msg}")
            }
            DbError::UniqueConstraint(msg) => write!(f, "Unique constraint violation: {msg}"),
            DbError::ForeignKeyViolation(msg) => {
                write!(f, "Foreign key constraint violation: {msg}")
            }
            DbError::TransactionFailed(msg) => write!(f, "Database transaction failed: {msg}"),
            DbError::NumericOverflow(msg) => write!(f, "Numeric overflow: {msg}"),
        }
    }
}

impl std::error::Error for DbError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            DbError::DirectoryCreation { source, .. } => Some(source),
            DbError::Open { source, .. } => Some(source),
            DbError::Query { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<&DbError> for CommandError {
    fn from(err: &DbError) -> Self {
        match err {
            DbError::InvalidInput { field, message } => CommandError {
                code: "INVALID_INPUT".to_string(),
                message: message.clone(),
                field: field.clone(),
            },
            DbError::NotFound(message) => CommandError {
                code: "NOT_FOUND".to_string(),
                message: message.clone(),
                field: None,
            },
            DbError::DuplicateId(message) => CommandError {
                code: "DUPLICATE_ID".to_string(),
                message: message.clone(),
                field: Some("id".to_string()),
            },
            DbError::DuplicateDocumentNumber(message) => CommandError {
                code: "DUPLICATE_DOCUMENT_NUMBER".to_string(),
                message: message.clone(),
                field: None,
            },
            DbError::UniqueConstraint(message) => CommandError {
                code: "UNIQUE_CONSTRAINT".to_string(),
                message: message.clone(),
                field: None,
            },
            DbError::ForeignKeyViolation(message) => CommandError {
                code: "FOREIGN_KEY_VIOLATION".to_string(),
                message: message.clone(),
                field: None,
            },
            DbError::NotInitialized(message) => CommandError {
                code: "NOT_INITIALIZED".to_string(),
                message: message.clone(),
                field: None,
            },
            DbError::NumericOverflow(message) => CommandError {
                code: "NUMERIC_OVERFLOW".to_string(),
                message: message.clone(),
                field: None,
            },
            DbError::TransactionFailed(message) => CommandError {
                code: "TRANSACTION_FAILED".to_string(),
                message: message.clone(),
                field: None,
            },
            DbError::Query { context, .. } => CommandError {
                code: "QUERY_FAILED".to_string(),
                message: format!("Database operation failed while {context}"),
                field: None,
            },
            DbError::DirectoryCreation { .. }
            | DbError::Open { .. }
            | DbError::PathResolution(_) => CommandError {
                code: "DATABASE_UNAVAILABLE".to_string(),
                message: "Local desktop database is currently unavailable".to_string(),
                field: None,
            },
            DbError::Config(message)
            | DbError::ForeignKeyConfig(message)
            | DbError::Integrity(message) => CommandError {
                code: "DATABASE_CONFIGURATION_ERROR".to_string(),
                message: message.clone(),
                field: None,
            },
            DbError::Migration { version, message } => CommandError {
                code: "DATABASE_CONFIGURATION_ERROR".to_string(),
                message: format!("Database migration v{version} error: {message}"),
                field: None,
            },
            DbError::LockPoisoned(_) => CommandError {
                code: "INTERNAL_ERROR".to_string(),
                message: "Database synchronization state became unavailable".to_string(),
                field: None,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
    pub initialized: bool,
    pub database_path: String,
    pub schema_version: i64,
    pub sqlite_version: String,
    pub journal_mode: String,
    pub foreign_keys_enabled: bool,
    pub busy_timeout_ms: i64,
    pub integrity_ok: bool,
    pub foreign_key_check_passed: bool,
}

#[derive(Debug, Clone)]
enum StartupPhase {
    NotStarted,
    InProgress,
    Completed(Result<(), String>),
}

#[derive(Debug, Clone)]
pub struct DatabaseManager {
    db_path: Result<PathBuf, String>,
    init_mutex: Arc<Mutex<()>>,
    startup_state: Arc<(Mutex<StartupPhase>, Condvar)>,
}

impl DatabaseManager {
    pub fn with_app_data_dir(app_data_dir: &Path) -> Self {
        Self::with_path(app_data_dir.join(DATABASE_FILENAME))
    }

    pub fn with_path(db_path: PathBuf) -> Self {
        Self {
            db_path: Ok(db_path),
            init_mutex: Arc::new(Mutex::new(())),
            startup_state: Arc::new((Mutex::new(StartupPhase::NotStarted), Condvar::new())),
        }
    }

    pub fn with_resolution_error(message: String) -> Self {
        Self {
            db_path: Err(message),
            init_mutex: Arc::new(Mutex::new(())),
            startup_state: Arc::new((Mutex::new(StartupPhase::NotStarted), Condvar::new())),
        }
    }

    pub fn db_path(&self) -> Result<&Path, DbError> {
        self.db_path
            .as_deref()
            .map_err(|msg| DbError::PathResolution(msg.clone()))
    }

    /// Marks startup initialization as in progress before spawning background work.
    pub fn mark_startup_in_progress(&self) {
        if let Ok(mut phase) = self.startup_state.0.lock() {
            *phase = StartupPhase::InProgress;
        }
    }

    /// Records startup outcome and wakes any callers awaiting initial startup.
    pub fn complete_startup(&self, outcome: Result<(), String>) {
        if let Ok(mut phase) = self.startup_state.0.lock() {
            *phase = StartupPhase::Completed(outcome);
            self.startup_state.1.notify_all();
        }
    }

    /// Waits for background startup initialization if it is currently in progress.
    pub fn wait_for_startup_if_running(&self) -> Result<(), DbError> {
        let (lock, cvar) = &*self.startup_state;
        let mut phase = lock
            .lock()
            .map_err(|_| DbError::LockPoisoned("startup state mutex poisoned".to_string()))?;

        while matches!(*phase, StartupPhase::InProgress) {
            phase = cvar
                .wait(phase)
                .map_err(|_| DbError::LockPoisoned("startup state mutex poisoned".to_string()))?;
        }

        if let StartupPhase::Completed(Err(ref msg)) = *phase {
            return Err(DbError::Config(msg.clone()));
        }

        Ok(())
    }

    /// Ensures the application data directory exists, opens or creates `bizora.db`,
    /// configures WAL + per-connection PRAGMAs, applies pending migrations, and
    /// verifies database and foreign-key integrity.
    pub fn initialize(&self) -> Result<DatabaseStatus, DbError> {
        let _guard = self
            .init_mutex
            .lock()
            .map_err(|_| DbError::LockPoisoned("database init mutex poisoned".to_string()))?;

        let db_path = self.db_path()?;

        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|source| DbError::DirectoryCreation {
                    path: parent.display().to_string(),
                    source,
                })?;
            }
        }

        let mut conn = open_configured_connection(db_path)?;

        // Must execute outside any active transaction.
        configure_wal_mode(&conn)?;

        let schema_version = apply_migrations(&mut conn)?;
        if schema_version < INITIAL_SCHEMA_VERSION {
            return Err(DbError::Migration {
                version: INITIAL_SCHEMA_VERSION,
                message: format!(
                    "Expected schema version >= {INITIAL_SCHEMA_VERSION}, got {schema_version}"
                ),
            });
        }

        verify_database_integrity(&conn)?;
        let status = inspect_status(&conn, db_path)?;
        self.complete_startup(Ok(()));
        Ok(status)
    }

    /// Verifies an existing database connection, schema version, PRAGMA configuration,
    /// and structural/relational integrity without modifying schema state.
    pub fn health_check(&self) -> Result<DatabaseStatus, DbError> {
        self.wait_for_startup_if_running()?;

        let _guard = self
            .init_mutex
            .lock()
            .map_err(|_| DbError::LockPoisoned("database init mutex poisoned".to_string()))?;

        let db_path = self.db_path()?;
        if !db_path.exists() {
            return Err(DbError::NotInitialized(
                "Local desktop database has not been initialized yet".to_string(),
            ));
        }

        let conn = open_configured_connection(db_path)?;
        let status = inspect_status(&conn, db_path)?;

        if status.schema_version < INITIAL_SCHEMA_VERSION {
            return Err(DbError::Migration {
                version: INITIAL_SCHEMA_VERSION,
                message: format!(
                    "Database schema version is {} (expected at least {INITIAL_SCHEMA_VERSION})",
                    status.schema_version
                ),
            });
        }

        if !status.journal_mode.eq_ignore_ascii_case("wal") {
            return Err(DbError::Config(format!(
                "Expected journal_mode 'wal', got '{}'",
                status.journal_mode
            )));
        }

        if !status.foreign_keys_enabled {
            return Err(DbError::ForeignKeyConfig(
                "Foreign key enforcement is disabled on SQLite connection".to_string(),
            ));
        }

        if status.busy_timeout_ms != REQUIRED_BUSY_TIMEOUT_MS {
            return Err(DbError::Config(format!(
                "Expected busy_timeout {REQUIRED_BUSY_TIMEOUT_MS}, got {}",
                status.busy_timeout_ms
            )));
        }

        verify_database_integrity(&conn)?;
        Ok(status)
    }

    /// Opens a fresh, properly configured connection to an initialized database.
    #[allow(dead_code)]
    pub fn open_connection(&self) -> Result<Connection, DbError> {
        let db_path = self.db_path()?;
        open_configured_connection(db_path)
    }

    /// Waits for startup if running, verifies that the SQLite file and v1 schema
    /// are initialized, and opens a fresh configured connection for repository work.
    pub fn ensure_initialized_connection(&self) -> Result<Connection, DbError> {
        self.wait_for_startup_if_running()?;

        let db_path = self.db_path()?;
        if !db_path.exists() {
            return Err(DbError::NotInitialized(
                "Local desktop database has not been initialized yet".to_string(),
            ));
        }

        let conn = open_configured_connection(db_path)?;
        let schema_version = current_schema_version(&conn)?;
        if schema_version < INITIAL_SCHEMA_VERSION {
            return Err(DbError::NotInitialized(
                "Local desktop database schema has not been initialized".to_string(),
            ));
        }

        Ok(conn)
    }
}

fn inspect_status(conn: &Connection, db_path: &Path) -> Result<DatabaseStatus, DbError> {
    let pragmas = query_connection_pragmas(conn)?;
    let schema_version = current_schema_version(conn)?;
    verify_database_integrity(conn)?;

    Ok(DatabaseStatus {
        initialized: schema_version >= INITIAL_SCHEMA_VERSION
            && pragmas.foreign_keys_enabled
            && pragmas.journal_mode.eq_ignore_ascii_case("wal")
            && pragmas.busy_timeout_ms == REQUIRED_BUSY_TIMEOUT_MS,
        database_path: db_path.display().to_string(),
        schema_version,
        sqlite_version: pragmas.sqlite_version,
        journal_mode: pragmas.journal_mode,
        foreign_keys_enabled: pragmas.foreign_keys_enabled,
        busy_timeout_ms: pragmas.busy_timeout_ms,
        integrity_ok: true,
        foreign_key_check_passed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicU64, Ordering};

    use migrations::apply_migration_step;
    use schema::{EXPECTED_TABLES, SCHEMA_MIGRATIONS_TABLE_SQL};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(label: &str) -> Self {
            let seq = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let pid = std::process::id();
            let dir = std::env::temp_dir().join(format!("bizora_db_test_{label}_{pid}_{seq}"));
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
            Self { path: dir }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn first_launch_creates_directory_database_tables_and_version_1() {
        let temp = TempDirGuard::new("first_launch");
        let app_data_dir = temp.path.join("nested").join("app_data");
        assert!(!app_data_dir.exists());

        let manager = DatabaseManager::with_app_data_dir(&app_data_dir);
        let status = manager.initialize().expect("first initialization must pass");

        let db_file = app_data_dir.join(DATABASE_FILENAME);
        assert!(app_data_dir.exists(), "app data directory should be created");
        assert!(db_file.exists(), "bizora.db should be created");
        assert!(status.initialized);
        assert_eq!(status.schema_version, 1);
        assert!(status.journal_mode.eq_ignore_ascii_case("wal"));
        assert!(status.foreign_keys_enabled);
        assert_eq!(status.busy_timeout_ms, 5000);
        assert!(status.integrity_ok);
        assert!(status.foreign_key_check_passed);

        let conn = open_configured_connection(&db_file).expect("open created db");
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';")
            .unwrap();
        let actual_tables: HashSet<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<HashSet<_>, _>>()
            .unwrap();

        for expected in EXPECTED_TABLES {
            assert!(
                actual_tables.contains(expected),
                "Expected table '{expected}' to exist"
            );
        }
        assert_eq!(actual_tables.len(), EXPECTED_TABLES.len());

        let recorded_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 1;",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recorded_count, 1);
    }

    #[test]
    fn subsequent_launch_reuses_database_without_reapplying_v1_or_losing_data() {
        let temp = TempDirGuard::new("subsequent_launch");
        let manager = DatabaseManager::with_app_data_dir(&temp.path);

        let first = manager.initialize().expect("initial setup");
        assert_eq!(first.schema_version, 1);

        let applied_at_first: String;
        {
            let conn = manager.open_connection().unwrap();
            applied_at_first = conn
                .query_row(
                    "SELECT applied_at FROM schema_migrations WHERE version = 1;",
                    [],
                    |row| row.get(0),
                )
                .unwrap();

            conn.execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3);",
                rusqlite::params!["theme", "\"dark\"", "2026-11-16T10:00:00.000Z"],
            )
            .unwrap();
        }

        let second = manager.initialize().expect("subsequent init must succeed");
        assert_eq!(second.schema_version, 1);

        let conn = manager.open_connection().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations;", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);

        let applied_at_second: String = conn
            .query_row(
                "SELECT applied_at FROM schema_migrations WHERE version = 1;",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(applied_at_first, applied_at_second);

        let saved_value: String = conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'theme';",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(saved_value, "\"dark\"");
    }

    #[test]
    fn every_new_connection_receives_foreign_keys_and_busy_timeout() {
        let temp = TempDirGuard::new("connection_pragmas");
        let manager = DatabaseManager::with_app_data_dir(&temp.path);
        manager.initialize().unwrap();

        let conn_a = manager.open_connection().unwrap();
        let conn_b = manager.open_connection().unwrap();

        for conn in [&conn_a, &conn_b] {
            let pragmas = query_connection_pragmas(conn).unwrap();
            assert!(pragmas.journal_mode.eq_ignore_ascii_case("wal"));
            assert!(pragmas.foreign_keys_enabled);
            assert_eq!(pragmas.busy_timeout_ms, 5000);

            // Prove foreign keys are actually enforced on each independent connection.
            let fk_err = conn.execute(
                "INSERT INTO clients (id, business_id, name, created_at, updated_at)
                 VALUES ('cli_1', 'missing_biz', 'Test Client', '2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z');",
                [],
            );
            assert!(
                fk_err.is_err(),
                "Foreign key constraint should block orphaned client insert"
            );
        }
    }

    #[test]
    fn wal_configuration_fails_inside_active_transaction() {
        let temp = TempDirGuard::new("wal_in_tx");
        std::fs::create_dir_all(&temp.path).unwrap();
        let db_path = temp.path.join(DATABASE_FILENAME);
        let mut conn = open_configured_connection(&db_path).unwrap();

        let tx = conn.transaction().unwrap();
        let err = configure_wal_mode(&tx).expect_err("WAL inside transaction must error");
        assert!(err.to_string().contains("outside an active transaction"));
    }

    #[test]
    fn failed_migration_rolls_back_completely_without_partial_schema_or_version() {
        let temp = TempDirGuard::new("failed_migration");
        std::fs::create_dir_all(&temp.path).unwrap();
        let db_path = temp.path.join(DATABASE_FILENAME);
        let mut conn = open_configured_connection(&db_path).unwrap();
        configure_wal_mode(&conn).unwrap();
        conn.execute_batch(SCHEMA_MIGRATIONS_TABLE_SQL).unwrap();

        // Failing initial migration: creates a table then executes invalid SQL.
        let result = apply_migration_step(
            &mut conn,
            1,
            "broken v1",
            "CREATE TABLE partial_should_rollback (id TEXT PRIMARY KEY); INVALID SQL HERE;",
        );
        assert!(result.is_err());

        let partial_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'partial_should_rollback';",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(partial_exists, 0, "Partial table must be rolled back");

        assert_eq!(current_schema_version(&conn).unwrap(), 0);

        // Now initialize legitimately (v1) and test a failing v2 migration.
        let manager = DatabaseManager::with_app_data_dir(&temp.path);
        manager.initialize().unwrap();

        let mut conn2 = manager.open_connection().unwrap();
        let v2_result = apply_migration_step(
            &mut conn2,
            2,
            "broken v2",
            "CREATE TABLE v2_partial (id TEXT PRIMARY KEY); SELECT * FROM missing_table;",
        );
        assert!(v2_result.is_err());

        let v2_partial_exists: i64 = conn2
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'v2_partial';",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(v2_partial_exists, 0);
        assert_eq!(current_schema_version(&conn2).unwrap(), 1);
    }

    #[test]
    fn health_check_verifies_integrity_and_rejects_uninitialized_db() {
        let temp = TempDirGuard::new("health_check");
        let manager = DatabaseManager::with_app_data_dir(&temp.path);

        assert!(
            manager.health_check().is_err(),
            "Health check must fail before database is created"
        );

        manager.initialize().unwrap();
        let status = manager.health_check().expect("health check should pass");
        assert!(status.initialized);
        assert!(status.integrity_ok);
        assert!(status.foreign_key_check_passed);
    }

    #[test]
    fn directory_creation_failure_returns_error_without_memory_fallback() {
        let temp = TempDirGuard::new("dir_failure");
        std::fs::create_dir_all(&temp.path).unwrap();
        let blocking_file = temp.path.join("not_a_directory");
        std::fs::write(&blocking_file, b"file").unwrap();

        let manager = DatabaseManager::with_app_data_dir(&blocking_file);
        let err = manager
            .initialize()
            .expect_err("Expected directory creation failure");
        assert!(matches!(err, DbError::DirectoryCreation { .. }));
    }

    fn init_test_db(label: &str) -> (TempDirGuard, DatabaseManager, Connection) {
        let temp = TempDirGuard::new(label);
        let manager = DatabaseManager::with_app_data_dir(&temp.path);
        manager.initialize().expect("initialize test db");
        let conn = manager
            .ensure_initialized_connection()
            .expect("open initialized connection");
        (temp, manager, conn)
    }

    fn seed_business(conn: &mut Connection, id: &str) -> dto::BusinessDto {
        repositories::business_repository::create_business(
            conn,
            &dto::CreateBusinessInput {
                id: id.to_string(),
                legacy_id: None,
                owner_profile_id: None,
                name: format!("Biz {id}"),
                tagline: "Services".to_string(),
                logo_asset_id: None,
                logo_url_fallback: "".to_string(),
                email: "hello@bizora.test".to_string(),
                phone: "+264 61 000 0000".to_string(),
                address: "10 Independence Ave".to_string(),
                city: "Windhoek".to_string(),
                country: "Namibia".to_string(),
                postal_code: None,
                website: None,
                tax_number: None,
                registration_number: None,
                default_currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                default_tax_name: "VAT".to_string(),
                default_tax_rate_ppm: precision::SafeI64(150_000),
                is_tax_enabled: true,
                quote_prefix: "QUO-".to_string(),
                invoice_prefix: "INV-".to_string(),
                next_quote_number: precision::SafeI64(1),
                next_invoice_number: precision::SafeI64(1),
                default_terms_quotation: "Valid 30 days".to_string(),
                default_terms_invoice: "Due 14 days".to_string(),
                default_notes: "Thank you".to_string(),
                bank_name: "First Bank".to_string(),
                account_name: "Bizora Studio".to_string(),
                account_number: "123456789".to_string(),
                branch_code: "280172".to_string(),
                account_type: Some("Cheque".to_string()),
                swift_code: None,
                created_at: None,
                updated_at: None,
            },
        )
        .expect("create seed business")
    }

    fn seed_client(conn: &mut Connection, business_id: &str, id: &str) -> dto::ClientDto {
        repositories::client_repository::create_client(
            conn,
            &dto::CreateClientInput {
                id: id.to_string(),
                business_id: business_id.to_string(),
                legacy_id: None,
                name: format!("Client {id}"),
                company_name: Some("Acme Corp".to_string()),
                email: "client@acme.test".to_string(),
                phone: "+264 81 000 0000".to_string(),
                address: "42 Sam Nujoma Dr".to_string(),
                city: Some("Windhoek".to_string()),
                country: Some("Namibia".to_string()),
                vat_number: None,
                notes: None,
                created_at: None,
                updated_at: None,
            },
        )
        .expect("create seed client")
    }

    fn sample_item(id: &str, sort_order: Option<i64>, qty: i64, price: i64, total: i64) -> dto::LineItemInput {
        dto::LineItemInput {
            id: id.to_string(),
            legacy_id: None,
            sort_order: sort_order.map(precision::SafeI64),
            description: format!("Item {id}"),
            quantity_scaled: precision::SafeI64(qty),
            unit_price_scaled: precision::SafeI64(price),
            total_minor: precision::SafeI64(total),
            created_at: None,
        }
    }

    #[test]
    fn local_profile_and_business_crud_and_safe_delete() {
        let (_temp, _manager, mut conn) = init_test_db("biz_crud");

        let profile = repositories::local_profile_repository::create_local_profile(
            &mut conn,
            &dto::CreateLocalProfileInput {
                id: "prof_1".to_string(),
                display_name: "Ada".to_string(),
                email: "ada@bizora.test".to_string(),
                supabase_user_id: Some("sup_1".to_string()),
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();
        assert_eq!(profile.display_name, "Ada");

        let updated_profile = repositories::local_profile_repository::update_local_profile(
            &mut conn,
            &dto::UpdateLocalProfileInput {
                id: "prof_1".to_string(),
                display_name: "Ada Lovelace".to_string(),
                email: "ada@bizora.test".to_string(),
                supabase_user_id: Some("sup_1".to_string()),
            },
        )
        .unwrap();
        assert_eq!(updated_profile.display_name, "Ada Lovelace");
        assert_eq!(
            repositories::local_profile_repository::get_local_profiles(&conn)
                .unwrap()
                .len(),
            1
        );

        let mut biz_input = dto::CreateBusinessInput {
            id: "biz_1".to_string(),
            legacy_id: None,
            owner_profile_id: Some("prof_1".to_string()),
            name: "Alpha Studio".to_string(),
            tagline: "Design".to_string(),
            logo_asset_id: None,
            logo_url_fallback: "".to_string(),
            email: "alpha@test.com".to_string(),
            phone: "".to_string(),
            address: "".to_string(),
            city: "".to_string(),
            country: "".to_string(),
            postal_code: None,
            website: None,
            tax_number: None,
            registration_number: None,
            default_currency: "NAD".to_string(),
            currency_symbol: "N$".to_string(),
            default_tax_name: "VAT".to_string(),
            default_tax_rate_ppm: precision::SafeI64(150_000),
            is_tax_enabled: true,
            quote_prefix: "QUO-".to_string(),
            invoice_prefix: "INV-".to_string(),
            next_quote_number: precision::SafeI64(1),
            next_invoice_number: precision::SafeI64(1),
            default_terms_quotation: "".to_string(),
            default_terms_invoice: "".to_string(),
            default_notes: "".to_string(),
            bank_name: "".to_string(),
            account_name: "".to_string(),
            account_number: "".to_string(),
            branch_code: "".to_string(),
            account_type: None,
            swift_code: None,
            created_at: None,
            updated_at: None,
        };
        let created = repositories::business_repository::create_business(&mut conn, &biz_input).unwrap();
        assert_eq!(created.name, "Alpha Studio");

        biz_input.id = "biz_2".to_string();
        biz_input.owner_profile_id = None;
        repositories::business_repository::create_business(&mut conn, &biz_input).unwrap();

        assert_eq!(
            repositories::business_repository::get_businesses(&conn, Some("prof_1"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            repositories::business_repository::get_businesses(&conn, None)
                .unwrap()
                .len(),
            2
        );

        let asset = repositories::asset_repository::create_asset(
            &mut conn,
            &dto::CreateBusinessAssetInput {
                id: "asset_1".to_string(),
                business_id: "biz_1".to_string(),
                content_hash: "hash_1".to_string(),
                source_type: "data_url".to_string(),
                mime_type: Some("image/png".to_string()),
                inline_data: Some("data:image/png;base64,AAAA".to_string()),
                file_path: None,
                external_url: None,
                original_filename: Some("logo.png".to_string()),
                byte_size: Some(precision::SafeI64(4)),
                created_at: None,
            },
        )
        .unwrap();

        let updated_biz = repositories::business_repository::update_business(
            &mut conn,
            &dto::UpdateBusinessInput {
                id: "biz_1".to_string(),
                owner_profile_id: Some("prof_1".to_string()),
                name: "Alpha Studio Updated".to_string(),
                tagline: "Design & Dev".to_string(),
                logo_asset_id: Some(asset.id),
                logo_url_fallback: "".to_string(),
                email: "alpha@test.com".to_string(),
                phone: "".to_string(),
                address: "".to_string(),
                city: "".to_string(),
                country: "".to_string(),
                postal_code: None,
                website: None,
                tax_number: None,
                registration_number: None,
                default_currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                default_tax_name: "VAT".to_string(),
                default_tax_rate_ppm: precision::SafeI64(150_000),
                is_tax_enabled: true,
                quote_prefix: "QUO-".to_string(),
                invoice_prefix: "INV-".to_string(),
                next_quote_number: precision::SafeI64(2),
                next_invoice_number: precision::SafeI64(3),
                default_terms_quotation: "".to_string(),
                default_terms_invoice: "".to_string(),
                default_notes: "".to_string(),
                bank_name: "".to_string(),
                account_name: "".to_string(),
                account_number: "".to_string(),
                branch_code: "".to_string(),
                account_type: None,
                swift_code: None,
            },
        )
        .unwrap();
        assert_eq!(updated_biz.name, "Alpha Studio Updated");
        assert_eq!(updated_biz.logo_asset_id.as_deref(), Some("asset_1"));

        // FK-safe deletion clears circular logo reference and removes business cleanly
        repositories::business_repository::delete_business(&mut conn, "biz_1").unwrap();
        assert!(
            repositories::business_repository::get_business_by_id(&conn, "biz_1")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn client_crud_and_snapshot_preserving_deletion() {
        let (_temp, _manager, mut conn) = init_test_db("client_crud");
        seed_business(&mut conn, "biz_1");
        let client = seed_client(&mut conn, "biz_1", "cli_1");

        let updated = repositories::client_repository::update_client(
            &mut conn,
            &dto::UpdateClientInput {
                id: client.id.clone(),
                business_id: "biz_1".to_string(),
                name: "Renamed Client".to_string(),
                company_name: Some("Acme Ltd".to_string()),
                email: "new@acme.test".to_string(),
                phone: "123".to_string(),
                address: "Addr".to_string(),
                city: None,
                country: None,
                vat_number: None,
                notes: None,
            },
        )
        .unwrap();
        assert_eq!(updated.name, "Renamed Client");
        assert_eq!(
            repositories::client_repository::get_clients_by_business(&conn, "biz_1")
                .unwrap()
                .len(),
            1
        );

        repositories::quotation_repository::create_quotation(
            &mut conn,
            &dto::CreateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: r#"{"name":"Snapshot Client"}"#.to_string(),
                business_snapshot_json: r#"{"name":"Biz"}"#.to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: Some("2099-01-01".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(150_000),
                tax_amount_minor: precision::SafeI64(1_500),
                grand_total_minor: precision::SafeI64(11_500),
                status: "sent".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![sample_item("qi_1", Some(0), 1_000_000, 100_000_000, 10_000)],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        repositories::client_repository::delete_client(&mut conn, "cli_1").unwrap();
        assert!(
            repositories::client_repository::get_client_by_id(&conn, "cli_1")
                .unwrap()
                .is_none()
        );

        let quote = repositories::quotation_repository::get_quotation_by_id(&conn, "quo_1")
            .unwrap()
            .expect("quotation must remain after client deletion");
        assert!(quote.client_id.is_none());
        assert_eq!(quote.client_snapshot_json, r#"{"name":"Snapshot Client"}"#);
    }

    #[test]
    fn quotation_items_ordering_replacement_and_safe_deletion() {
        let (_temp, _manager, mut conn) = init_test_db("quote_crud");
        seed_business(&mut conn, "biz_1");
        seed_client(&mut conn, "biz_1", "cli_1");

        let created = repositories::quotation_repository::create_quotation(
            &mut conn,
            &dto::CreateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: r#"{"name":"Client"}"#.to_string(),
                business_snapshot_json: r#"{"name":"Biz"}"#.to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(30_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(100_000),
                discount_fixed_minor: precision::SafeI64(999),
                discount_amount_minor: precision::SafeI64(3_000),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(150_000),
                tax_amount_minor: precision::SafeI64(4_050),
                grand_total_minor: precision::SafeI64(31_050),
                status: "draft".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![
                    sample_item("qi_b", Some(1), 1_000_000, 100_000_000, 10_000),
                    sample_item("qi_a", Some(0), 2_000_000, 100_000_000, 20_000),
                ],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();
        // Inactive discount_fixed_minor normalized to 0 when discount_type == 'percentage'
        assert_eq!(created.discount_fixed_minor.get(), 0);
        assert_eq!(created.items[0].id, "qi_a");
        assert_eq!(created.items[1].id, "qi_b");

        let updated = repositories::quotation_repository::update_quotation(
            &mut conn,
            &dto::UpdateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: r#"{"name":"Client"}"#.to_string(),
                business_snapshot_json: r#"{"name":"Biz"}"#.to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(50_000),
                discount_type: "fixed".to_string(),
                discount_percentage_ppm: precision::SafeI64(50_000),
                discount_fixed_minor: precision::SafeI64(5_000),
                discount_amount_minor: precision::SafeI64(5_000),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(150_000),
                tax_amount_minor: precision::SafeI64(6_750),
                grand_total_minor: precision::SafeI64(51_750),
                status: "sent".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![sample_item("qi_c", Some(0), 5_000_000, 100_000_000, 50_000)],
            },
        )
        .unwrap();
        assert_eq!(updated.discount_percentage_ppm.get(), 0);
        assert_eq!(updated.items.len(), 1);
        assert_eq!(updated.items[0].id, "qi_c");
        assert_eq!(
            repositories::quotation_repository::get_quotation_items(&conn, "quo_1")
                .unwrap()
                .len(),
            1
        );

        // Link an invoice to quo_1 then delete quo_1 -> invoice remains with quotation_id = NULL
        repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: Some("quo_1".to_string()),
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: r#"{"name":"Client"}"#.to_string(),
                business_snapshot_json: r#"{"name":"Biz"}"#.to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(50_000),
                discount_type: "fixed".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(5_000),
                discount_amount_minor: precision::SafeI64(5_000),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(150_000),
                tax_amount_minor: precision::SafeI64(6_750),
                grand_total_minor: precision::SafeI64(51_750),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(51_750),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![sample_item("ii_1", Some(0), 5_000_000, 100_000_000, 50_000)],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        repositories::quotation_repository::delete_quotation(&mut conn, "quo_1").unwrap();
        let inv = repositories::invoice_repository::get_invoice_by_id(&conn, "inv_1")
            .unwrap()
            .expect("invoice must survive quotation deletion");
        assert!(inv.quotation_id.is_none());
    }

    #[test]
    fn invoice_conversion_sync_declined_duplicate_guard_and_status_restoration() {
        let (_temp, _manager, mut conn) = init_test_db("inv_sync");
        seed_business(&mut conn, "biz_1");
        seed_client(&mut conn, "biz_1", "cli_1");

        // Draft quote & declined quote
        for (qid, qnum, status, expiry) in [
            ("quo_draft", "QUO-0001", "draft", Some("2099-01-01".to_string())),
            ("quo_expired_sent", "QUO-0002", "sent", Some("2000-01-01".to_string())),
            ("quo_declined", "QUO-0003", "declined", Some("2099-01-01".to_string())),
        ] {
            repositories::quotation_repository::create_quotation(
                &mut conn,
                &dto::CreateQuotationInput {
                    id: qid.to_string(),
                    business_id: "biz_1".to_string(),
                    legacy_id: None,
                    client_id: Some("cli_1".to_string()),
                    quotation_number: qnum.to_string(),
                    client_snapshot_json: r#"{"name":"Client"}"#.to_string(),
                    business_snapshot_json: r#"{"name":"Biz"}"#.to_string(),
                    issue_date: "2026-11-16".to_string(),
                    expiry_date: expiry,
                    currency: "NAD".to_string(),
                    currency_symbol: "N$".to_string(),
                    subtotal_minor: precision::SafeI64(10_000),
                    discount_type: "percentage".to_string(),
                    discount_percentage_ppm: precision::SafeI64(0),
                    discount_fixed_minor: precision::SafeI64(0),
                    discount_amount_minor: precision::SafeI64(0),
                    tax_name: "VAT".to_string(),
                    tax_rate_ppm: precision::SafeI64(0),
                    tax_amount_minor: precision::SafeI64(0),
                    grand_total_minor: precision::SafeI64(10_000),
                    status: status.to_string(),
                    pre_conversion_status: None,
                    notes: None,
                    terms: None,
                    converted_invoice_id: None,
                    items: vec![sample_item(&format!("qi_{qid}"), None, 1_000_000, 100_000_000, 10_000)],
                    created_at: None,
                    updated_at: None,
                },
            )
            .unwrap();
        }

        // Declined quote cannot be linked
        let declined_err = repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_bad".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: Some("quo_declined".to_string()),
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "draft".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .expect_err("declined quote link must fail");
        assert!(matches!(declined_err, DbError::InvalidInput { .. }));

        // Link draft quote
        repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: Some("quo_draft".to_string()),
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![sample_item("ii_1", Some(0), 1_000_000, 100_000_000, 10_000)],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        let converted = repositories::quotation_repository::get_quotation_by_id(&conn, "quo_draft")
            .unwrap()
            .unwrap();
        assert_eq!(converted.status, "accepted");
        assert_eq!(converted.pre_conversion_status.as_deref(), Some("draft"));
        assert_eq!(converted.converted_invoice_id.as_deref(), Some("inv_1"));

        // Duplicate conversion link blocked
        let dup_link_err = repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_2".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: Some("quo_draft".to_string()),
                invoice_number: "INV-0002".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .expect_err("duplicate quotation link must fail");
        assert!(matches!(dup_link_err, DbError::UniqueConstraint(_)));

        // Re-link inv_1 to quo_expired_sent -> quo_draft restores to 'draft'
        repositories::invoice_repository::update_invoice(
            &mut conn,
            &dto::UpdateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: Some("cli_1".to_string()),
                quotation_id: Some("quo_expired_sent".to_string()),
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![sample_item("ii_1_new", Some(0), 1_000_000, 100_000_000, 10_000)],
            },
        )
        .unwrap();

        let restored_draft = repositories::quotation_repository::get_quotation_by_id(&conn, "quo_draft")
            .unwrap()
            .unwrap();
        assert_eq!(restored_draft.status, "draft");
        assert!(restored_draft.pre_conversion_status.is_none());
        assert!(restored_draft.converted_invoice_id.is_none());

        // Deleting inv_1 restores quo_expired_sent back to 'expired' based on expiry_date
        repositories::invoice_repository::delete_invoice(&mut conn, "inv_1").unwrap();
        let restored_expired = repositories::quotation_repository::get_quotation_by_id(&conn, "quo_expired_sent")
            .unwrap()
            .unwrap();
        assert_eq!(restored_expired.status, "expired");
        assert!(restored_expired.converted_invoice_id.is_none());
    }

    #[test]
    fn payments_recalculate_balances_preserve_overpayment_tolerance_and_delete_cleanly() {
        let (_temp, _manager, mut conn) = init_test_db("payments");
        seed_business(&mut conn, "biz_1");
        seed_client(&mut conn, "biz_1", "cli_1");

        repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![sample_item("ii_1", Some(0), 1_000_000, 100_000_000, 10_000)],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        let bad_amt = repositories::payment_repository::create_payment(
            &mut conn,
            &dto::CreatePaymentInput {
                id: "pay_bad".to_string(),
                business_id: "biz_1".to_string(),
                invoice_id: "inv_1".to_string(),
                legacy_id: None,
                amount_minor: precision::SafeI64(0),
                payment_date: "2026-11-16".to_string(),
                payment_method: "eft".to_string(),
                reference: None,
                notes: None,
                recorded_at: None,
            },
        )
        .expect_err("non-positive payment must fail");
        assert!(matches!(bad_amt, DbError::InvalidInput { .. }));

        // Partial payment (40.00)
        repositories::payment_repository::create_payment(
            &mut conn,
            &dto::CreatePaymentInput {
                id: "pay_1".to_string(),
                business_id: "biz_1".to_string(),
                invoice_id: "inv_1".to_string(),
                legacy_id: None,
                amount_minor: precision::SafeI64(4_000),
                payment_date: "2026-11-16".to_string(),
                payment_method: "eft".to_string(),
                reference: Some("EFT-1".to_string()),
                notes: None,
                recorded_at: None,
            },
        )
        .unwrap();

        let inv_partial = repositories::invoice_repository::get_invoice_by_id(&conn, "inv_1")
            .unwrap()
            .unwrap();
        assert_eq!(inv_partial.amount_paid_minor.get(), 4_000);
        assert_eq!(inv_partial.outstanding_balance_minor.get(), 6_000);
        assert_eq!(inv_partial.status, "partially_paid");

        // Completing payment with +0.01 tolerance (60.01 -> total paid 100.01, balance 0, paid)
        repositories::payment_repository::create_payment(
            &mut conn,
            &dto::CreatePaymentInput {
                id: "pay_2".to_string(),
                business_id: "biz_1".to_string(),
                invoice_id: "inv_1".to_string(),
                legacy_id: None,
                amount_minor: precision::SafeI64(6_001),
                payment_date: "2026-11-17".to_string(),
                payment_method: "bank_transfer".to_string(),
                reference: None,
                notes: None,
                recorded_at: None,
            },
        )
        .unwrap();

        let inv_paid = repositories::invoice_repository::get_invoice_by_id(&conn, "inv_1")
            .unwrap()
            .unwrap();
        assert_eq!(inv_paid.amount_paid_minor.get(), 10_001);
        assert_eq!(inv_paid.outstanding_balance_minor.get(), 0);
        assert_eq!(inv_paid.status, "paid");
        assert_eq!(
            repositories::payment_repository::get_payments_by_business(&conn, "biz_1")
                .unwrap()
                .len(),
            2
        );

        // Delete second payment -> back to partially_paid
        repositories::payment_repository::delete_payment(&mut conn, "pay_2").unwrap();
        let inv_reverted = repositories::invoice_repository::get_invoice_by_id(&conn, "inv_1")
            .unwrap()
            .unwrap();
        assert_eq!(inv_reverted.amount_paid_minor.get(), 4_000);
        assert_eq!(inv_reverted.outstanding_balance_minor.get(), 6_000);
        assert_eq!(inv_reverted.status, "partially_paid");

        // Delete first payment -> back to sent
        repositories::payment_repository::delete_payment(&mut conn, "pay_1").unwrap();
        let inv_unpaid = repositories::invoice_repository::get_invoice_by_id(&conn, "inv_1")
            .unwrap()
            .unwrap();
        assert_eq!(inv_unpaid.amount_paid_minor.get(), 0);
        assert_eq!(inv_unpaid.outstanding_balance_minor.get(), 10_000);
        assert_eq!(inv_unpaid.status, "sent");
    }

    #[test]
    fn activity_logs_assets_and_app_settings_crud() {
        let (_temp, _manager, mut conn) = init_test_db("aux_tables");
        seed_business(&mut conn, "biz_1");

        let log = repositories::activity_repository::create_activity_log(
            &mut conn,
            &dto::CreateActivityLogInput {
                id: "act_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                log_type: "quote_created".to_string(),
                title: "Quote Created".to_string(),
                description: "QUO-0001 created".to_string(),
                timestamp: Some("2026-10-01T08:30:00.000Z".to_string()),
                reference_id: Some("quo_1".to_string()),
                reference_type: Some("quotation".to_string()),
                actor_local_profile_id: None,
            },
        )
        .unwrap();
        assert_eq!(log.timestamp, "2026-10-01T08:30:00.000Z");
        assert_eq!(log.reference_type.as_deref(), Some("quotation"));
        assert_eq!(
            repositories::activity_repository::get_activity_logs_by_business(&conn, "biz_1", Some(10))
                .unwrap()
                .len(),
            1
        );

        let asset = repositories::asset_repository::create_asset(
            &mut conn,
            &dto::CreateBusinessAssetInput {
                id: "ast_1".to_string(),
                business_id: "biz_1".to_string(),
                content_hash: "sha_1".to_string(),
                source_type: "external_url".to_string(),
                mime_type: None,
                inline_data: None,
                file_path: None,
                external_url: Some("https://example.com/logo.png".to_string()),
                original_filename: None,
                byte_size: None,
                created_at: None,
            },
        )
        .unwrap();
        assert_eq!(
            repositories::asset_repository::get_assets_by_business(&conn, "biz_1")
                .unwrap()
                .len(),
            1
        );
        repositories::asset_repository::delete_asset(&mut conn, &asset.id).unwrap();
        assert!(
            repositories::asset_repository::get_asset_by_id(&conn, &asset.id)
                .unwrap()
                .is_none()
        );

        repositories::settings_repository::save_setting(
            &mut conn,
            &dto::SaveAppSettingInput {
                key: "active_business_id".to_string(),
                value_json: r#""biz_1""#.to_string(),
                updated_at: None,
            },
        )
        .unwrap();
        let saved_setting = repositories::settings_repository::save_setting(
            &mut conn,
            &dto::SaveAppSettingInput {
                key: "active_business_id".to_string(),
                value_json: r#""biz_updated""#.to_string(),
                updated_at: None,
            },
        )
        .unwrap();
        assert_eq!(saved_setting.value_json, r#""biz_updated""#);
        repositories::settings_repository::delete_setting(&mut conn, "active_business_id").unwrap();
        assert!(
            repositories::settings_repository::get_setting(&conn, "active_business_id")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn transaction_rollback_preserves_prior_state_and_enforces_nocase_uniqueness() {
        let (_temp, _manager, mut conn) = init_test_db("rollback_unique");
        seed_business(&mut conn, "biz_1");
        seed_business(&mut conn, "biz_2");

        repositories::quotation_repository::create_quotation(
            &mut conn,
            &dto::CreateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: None,
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                status: "draft".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![sample_item("qi_orig", Some(0), 1_000_000, 100_000_000, 10_000)],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        // Duplicate item ID causes update_quotation to fail and roll back completely
        let rollback_err = repositories::quotation_repository::update_quotation(
            &mut conn,
            &dto::UpdateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: None,
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(20_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(20_000),
                status: "sent".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![
                    sample_item("qi_dup", Some(0), 1_000_000, 100_000_000, 10_000),
                    sample_item("qi_dup", Some(1), 1_000_000, 100_000_000, 10_000),
                ],
            },
        )
        .expect_err("duplicate item id must roll back");
        assert!(matches!(rollback_err, DbError::DuplicateId(_)));

        let intact = repositories::quotation_repository::get_quotation_by_id(&conn, "quo_1")
            .unwrap()
            .unwrap();
        assert_eq!(intact.status, "draft");
        assert_eq!(intact.items.len(), 1);
        assert_eq!(intact.items[0].id, "qi_orig");

        // Case-insensitive duplicate number blocked in same business, allowed in biz_2
        let dup_num = repositories::quotation_repository::create_quotation(
            &mut conn,
            &dto::CreateQuotationInput {
                id: "quo_dup_num".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: None,
                quotation_number: "quo-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(0),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(0),
                status: "draft".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .expect_err("case-insensitive duplicate quotation_number must fail");
        assert!(matches!(dup_num, DbError::DuplicateDocumentNumber(_)));
    }

    #[test]
    fn precision_safe_i64_ipc_and_error_sanitization() {
        let large = precision::SafeI64(9_007_199_254_740_993);
        let serialized = serde_json::to_string(&large).unwrap();
        assert_eq!(serialized, "\"9007199254740993\"");
        let parsed: precision::SafeI64 = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed, large);

        assert!(serde_json::from_str::<precision::SafeI64>("12.34").is_err());
        assert!(serde_json::from_str::<precision::SafeI64>("9007199254740993").is_err());

        // Fixed-point math using i128 without overflow
        let line_total = precision::calculate_line_total_minor(2_500_000, 19_990_000).unwrap();
        assert_eq!(line_total, 4_998);
        let totals =
            precision::calculate_document_totals_minor(&[line_total], "percentage", 100_000, 0, 150_000)
                .unwrap();
        assert_eq!(totals.subtotal_minor, 4_998);
        assert_eq!(totals.discount_amount_minor, 500);
        assert_eq!(totals.tax_amount_minor, 675);
        assert_eq!(totals.grand_total_minor, 5_173);

        // Sanitized command errors never leak SQL or filesystem paths
        let uninit_temp = TempDirGuard::new("uninit_conn");
        let uninit_mgr = DatabaseManager::with_app_data_dir(&uninit_temp.path);
        let uninit_err = uninit_mgr
            .ensure_initialized_connection()
            .expect_err("uninitialized DB must fail");
        assert!(matches!(uninit_err, DbError::NotInitialized(_)));

        let open_err = DbError::Open {
            path: "/secret/user/path/bizora.db".to_string(),
            source: rusqlite::Error::InvalidQuery,
        };
        let cmd_err = CommandError::from(&open_err);
        assert_eq!(cmd_err.code, "DATABASE_UNAVAILABLE");
        assert!(!cmd_err.message.contains("/secret/"));

        // health_check uninitialized error must not reveal filesystem path
        let health_err = uninit_mgr
            .health_check()
            .expect_err("uninitialized health_check must fail");
        assert!(matches!(health_err, DbError::NotInitialized(_)));
        let health_cmd_err = CommandError::from(&health_err);
        assert_eq!(health_cmd_err.code, "NOT_INITIALIZED");
        assert!(!health_cmd_err
            .message
            .contains(&uninit_temp.path.display().to_string()));
    }

    #[test]
    fn date_validation_and_utf8_safety_regressions() {
        let (_temp, _manager, mut conn) = init_test_db("date_validation");
        seed_business(&mut conn, "biz_1");

        let today_local: String = conn
            .query_row("SELECT date('now', 'localtime');", [], |row| row.get(0))
            .unwrap();

        // 1. Valid dates before today
        assert!(repositories::is_date_before_local_today(&conn, Some("2000-01-01")).unwrap());
        // 2. Valid date equal to today
        assert!(!repositories::is_date_before_local_today(&conn, Some(&today_local)).unwrap());
        // 3. Valid dates after today
        assert!(!repositories::is_date_before_local_today(&conn, Some("2099-12-31")).unwrap());
        // None remains valid & false
        assert!(!repositories::is_date_before_local_today(&conn, None).unwrap());

        // 10. Leap-year dates
        assert_eq!(
            repositories::validate_iso_date("2024-02-29", "dueDate").unwrap(),
            "2024-02-29"
        );
        assert_eq!(
            repositories::validate_iso_date("2000-02-29", "dueDate").unwrap(),
            "2000-02-29"
        );
        assert!(matches!(
            repositories::validate_iso_date("2023-02-29", "dueDate"),
            Err(DbError::InvalidInput { .. })
        ));
        assert!(matches!(
            repositories::validate_iso_date("1900-02-29", "dueDate"),
            Err(DbError::InvalidInput { .. })
        ));

        // 4-9. Malformed, invalid month/day, bad separators, non-ISO, multi-byte UTF-8 >10 bytes, empty, short
        for bad_date in [
            "2026-00-10",       // invalid month 00
            "2026-13-10",       // invalid month 13
            "2026-04-31",       // invalid day for April
            "2026-01-00",       // invalid day 00
            "2026/11/16",       // invalid slash separators
            "2026.11.16",       // invalid dot separators
            "16/11/2026",       // non-ISO DD/MM/YYYY
            "2026-11-16T00:00", // trailing datetime
            "2026-11-1é",       // multi-byte UTF-8 crossing byte boundary 10
            "ééééééééééé",      // multi-byte UTF-8 > 10 bytes
            "📅📅📅📅",          // 16-byte emoji string
            "",                 // empty string
            "   ",              // whitespace-only
            "2026-1-1",         // shorter than 10 bytes
            "2026-11",          // shorter than 10 bytes
        ] {
            let err = repositories::is_date_before_local_today(&conn, Some(bad_date))
                .expect_err("malformed date must be rejected without panic");
            assert!(
                matches!(err, DbError::InvalidInput { .. }),
                "Expected InvalidInput for '{bad_date}', got {err:?}"
            );
        }

        // Repository create_invoice rejects multi-byte/non-ISO dueDate cleanly
        let inv_err = repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_bad_date".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: None,
                quotation_id: None,
                invoice_number: "INV-BAD-1".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2026-11-1é".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(1_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(1_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(1_000),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .expect_err("non-ASCII due_date must be rejected cleanly");
        assert!(matches!(inv_err, DbError::InvalidInput { .. }));
    }

    #[test]
    fn invoice_payment_state_reconciliation_and_rollback_regressions() {
        let (_temp, _manager, mut conn) = init_test_db("inv_reconcile");
        seed_business(&mut conn, "biz_1");
        seed_client(&mut conn, "biz_1", "cli_1");

        // 1. Reject creating an invoice with non-zero amount_paid_minor or paid status without payments
        let non_zero_paid_err = repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_bad_paid".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-ERR-1".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(2_000),
                outstanding_balance_minor: precision::SafeI64(8_000),
                status: "partially_paid".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .expect_err("non-zero amount_paid_minor on create must fail");
        assert!(matches!(non_zero_paid_err, DbError::InvalidInput { .. }));

        let bad_status_err = repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_bad_status".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-ERR-2".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "paid".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .expect_err("status='paid' with zero payments on create must fail");
        assert!(matches!(bad_status_err, DbError::InvalidInput { .. }));

        // 2. Create unpaid invoice -> initializes exact outstanding balance and status
        let created = repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "draft".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![sample_item("ii_1", Some(0), 1_000_000, 10_000_000, 10_000)],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();
        assert_eq!(created.amount_paid_minor.get(), 0);
        assert_eq!(created.outstanding_balance_minor.get(), 10_000);
        assert_eq!(created.status, "draft");

        // 7a. Unpaid update with caller trying to force status='paid' must NOT mark invoice paid
        let forced_paid_attempt = repositories::invoice_repository::update_invoice(
            &mut conn,
            &dto::UpdateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(10_000),
                outstanding_balance_minor: precision::SafeI64(0),
                status: "paid".to_string(),
                notes: Some("Unpaid edit".to_string()),
                terms: None,
                payment_instructions: None,
                items: vec![sample_item("ii_1", Some(0), 1_000_000, 10_000_000, 10_000)],
            },
        )
        .unwrap();
        assert_eq!(forced_paid_attempt.amount_paid_minor.get(), 0);
        assert_eq!(forced_paid_attempt.outstanding_balance_minor.get(), 10_000);
        assert_ne!(forced_paid_attempt.status, "paid");

        // Record a 40.00 partial payment
        repositories::payment_repository::create_payment(
            &mut conn,
            &dto::CreatePaymentInput {
                id: "pay_1".to_string(),
                business_id: "biz_1".to_string(),
                invoice_id: "inv_1".to_string(),
                legacy_id: None,
                amount_minor: precision::SafeI64(4_000),
                payment_date: "2026-11-16".to_string(),
                payment_method: "eft".to_string(),
                reference: None,
                notes: None,
                recorded_at: None,
            },
        )
        .unwrap();

        // 3, 4, 5, 7b. Edit invoice total upward to 150.00 while passing stale amount_paid=0 & status='draft'
        let edited_partial = repositories::invoice_repository::update_invoice(
            &mut conn,
            &dto::UpdateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(15_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(15_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(15_000),
                status: "draft".to_string(),
                notes: Some("Total updated".to_string()),
                terms: None,
                payment_instructions: None,
                items: vec![sample_item("ii_2", Some(0), 1_000_000, 15_000_000, 15_000)],
            },
        )
        .unwrap();
        assert_eq!(edited_partial.amount_paid_minor.get(), 4_000);
        assert_eq!(edited_partial.outstanding_balance_minor.get(), 11_000);
        assert_eq!(edited_partial.status, "partially_paid");

        // 6. Lower total to 39.99 -> existing 40.00 payment satisfies paid threshold (+0.01 uncapped)
        let edited_paid = repositories::invoice_repository::update_invoice(
            &mut conn,
            &dto::UpdateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(3_999),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(3_999),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(3_999),
                status: "sent".to_string(),
                notes: Some("Paid threshold met".to_string()),
                terms: None,
                payment_instructions: None,
                items: vec![sample_item("ii_3", Some(0), 1_000_000, 3_999_000, 3_999)],
            },
        )
        .unwrap();
        assert_eq!(edited_paid.amount_paid_minor.get(), 4_000);
        assert_eq!(edited_paid.outstanding_balance_minor.get(), 0);
        assert_eq!(edited_paid.status, "paid");

        // 8. Failed update (duplicate line item id) must roll back header, items & payment state
        let fail_err = repositories::invoice_repository::update_invoice(
            &mut conn,
            &dto::UpdateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(99_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(99_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(99_000),
                status: "sent".to_string(),
                notes: Some("Should rollback".to_string()),
                terms: None,
                payment_instructions: None,
                items: vec![
                    sample_item("dup_ii", Some(0), 1_000_000, 49_500_000, 49_500),
                    sample_item("dup_ii", Some(1), 1_000_000, 49_500_000, 49_500),
                ],
            },
        )
        .expect_err("duplicate item id must roll back invoice update");
        assert!(matches!(fail_err, DbError::DuplicateId(_)));

        let intact = repositories::invoice_repository::get_invoice_by_id(&conn, "inv_1")
            .unwrap()
            .unwrap();
        assert_eq!(intact.grand_total_minor.get(), 3_999);
        assert_eq!(intact.amount_paid_minor.get(), 4_000);
        assert_eq!(intact.outstanding_balance_minor.get(), 0);
        assert_eq!(intact.status, "paid");
        assert_eq!(intact.items.len(), 1);
        assert_eq!(intact.items[0].id, "ii_3");
        assert_eq!(intact.notes.as_deref(), Some("Paid threshold met"));
    }

    #[test]
    fn quotation_prevents_unilateral_conversion_link_mutation() {
        let (_temp, _manager, mut conn) = init_test_db("quote_link_guard");
        seed_business(&mut conn, "biz_1");
        seed_client(&mut conn, "biz_1", "cli_1");

        // 1. Creating a quotation with non-null converted_invoice_id is rejected
        let create_err = repositories::quotation_repository::create_quotation(
            &mut conn,
            &dto::CreateQuotationInput {
                id: "quo_bad".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-BAD".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                status: "accepted".to_string(),
                pre_conversion_status: Some("sent".to_string()),
                notes: None,
                terms: None,
                converted_invoice_id: Some("inv_fake".to_string()),
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .expect_err("create_quotation with converted_invoice_id must fail");
        assert!(matches!(create_err, DbError::InvalidInput { .. }));

        // Create normal quotation & link via invoice_repository
        repositories::quotation_repository::create_quotation(
            &mut conn,
            &dto::CreateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                status: "sent".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![sample_item("qi_1", Some(0), 1_000_000, 10_000_000, 10_000)],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: Some("quo_1".to_string()),
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        // Create second unlinked invoice so replacement target exists
        repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_2".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-0002".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        // 2. Updating unrelated quotation fields preserves existing invoice link & pre_conversion_status
        let updated = repositories::quotation_repository::update_quotation(
            &mut conn,
            &dto::UpdateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                status: "accepted".to_string(),
                pre_conversion_status: Some("sent".to_string()),
                notes: Some("Updated notes".to_string()),
                terms: None,
                converted_invoice_id: Some("inv_1".to_string()),
                items: vec![sample_item("qi_1", Some(0), 1_000_000, 10_000_000, 10_000)],
            },
        )
        .unwrap();
        assert_eq!(updated.converted_invoice_id.as_deref(), Some("inv_1"));
        assert_eq!(updated.pre_conversion_status.as_deref(), Some("sent"));
        assert_eq!(updated.notes.as_deref(), Some("Updated notes"));

        // 3. Clearing converted_invoice_id directly via update_quotation is rejected
        let clear_err = repositories::quotation_repository::update_quotation(
            &mut conn,
            &dto::UpdateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                status: "accepted".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![],
            },
        )
        .expect_err("clearing converted_invoice_id directly must fail");
        assert!(matches!(clear_err, DbError::InvalidInput { .. }));

        // 4. Replacing converted_invoice_id directly via update_quotation is rejected
        let replace_err = repositories::quotation_repository::update_quotation(
            &mut conn,
            &dto::UpdateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: Some("2099-12-31".to_string()),
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                status: "accepted".to_string(),
                pre_conversion_status: Some("sent".to_string()),
                notes: None,
                terms: None,
                converted_invoice_id: Some("inv_2".to_string()),
                items: vec![],
            },
        )
        .expect_err("replacing converted_invoice_id directly must fail");
        assert!(matches!(replace_err, DbError::InvalidInput { .. }));

        // Link remained completely untouched
        let intact = repositories::quotation_repository::get_quotation_by_id(&conn, "quo_1")
            .unwrap()
            .unwrap();
        assert_eq!(intact.converted_invoice_id.as_deref(), Some("inv_1"));
    }

    #[test]
    fn zero_total_invoice_payment_state_and_active_asset_delete_timestamp() {
        // 4A. Zero-total unit state checks
        assert_eq!(
            precision::recompute_invoice_payment_state("draft", 0, &[], false).unwrap(),
            (0, 0, "draft")
        );
        assert_eq!(
            precision::recompute_invoice_payment_state("sent", 0, &[], false).unwrap(),
            (0, 0, "sent")
        );
        assert_eq!(
            precision::recompute_invoice_payment_state("sent", 0, &[500], false).unwrap(),
            (500, 0, "paid")
        );
        assert_eq!(
            precision::recompute_invoice_payment_state("draft", 0, &[1], false).unwrap(),
            (1, 0, "paid")
        );

        let (_temp, _manager, mut conn) = init_test_db("zero_and_asset");
        let seeded_biz = seed_business(&mut conn, "biz_1");
        seed_client(&mut conn, "biz_1", "cli_1");

        // Zero-total invoice with payment transitions to 'paid' and reverts to 'sent' if deleted
        repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_zero".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "INV-ZERO".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(0),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(0),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(0),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        repositories::payment_repository::create_payment(
            &mut conn,
            &dto::CreatePaymentInput {
                id: "pay_zero".to_string(),
                business_id: "biz_1".to_string(),
                invoice_id: "inv_zero".to_string(),
                legacy_id: None,
                amount_minor: precision::SafeI64(250),
                payment_date: "2026-11-16".to_string(),
                payment_method: "cash".to_string(),
                reference: None,
                notes: None,
                recorded_at: None,
            },
        )
        .unwrap();

        let zero_paid = repositories::invoice_repository::get_invoice_by_id(&conn, "inv_zero")
            .unwrap()
            .unwrap();
        assert_eq!(zero_paid.amount_paid_minor.get(), 250);
        assert_eq!(zero_paid.outstanding_balance_minor.get(), 0);
        assert_eq!(zero_paid.status, "paid");

        repositories::payment_repository::delete_payment(&mut conn, "pay_zero").unwrap();
        let zero_unpaid = repositories::invoice_repository::get_invoice_by_id(&conn, "inv_zero")
            .unwrap()
            .unwrap();
        assert_eq!(zero_unpaid.amount_paid_minor.get(), 0);
        assert_eq!(zero_unpaid.status, "sent");

        // 4B. Active logo asset delete clears logo_asset_id AND updates businesses.updated_at
        let asset = repositories::asset_repository::create_asset(
            &mut conn,
            &dto::CreateBusinessAssetInput {
                id: "ast_logo".to_string(),
                business_id: "biz_1".to_string(),
                content_hash: "logo_hash".to_string(),
                source_type: "data_url".to_string(),
                mime_type: Some("image/png".to_string()),
                inline_data: Some("data:image/png;base64,AAAA".to_string()),
                file_path: None,
                external_url: None,
                original_filename: Some("logo.png".to_string()),
                byte_size: Some(precision::SafeI64(4)),
                created_at: None,
            },
        )
        .unwrap();

        conn.execute(
            "UPDATE businesses SET logo_asset_id = ?1, updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?2;",
            rusqlite::params![asset.id, seeded_biz.id],
        )
        .unwrap();

        repositories::asset_repository::delete_asset(&mut conn, &asset.id).unwrap();
        let after_asset_delete =
            repositories::business_repository::get_business_by_id(&conn, "biz_1")
                .unwrap()
                .unwrap();
        assert!(after_asset_delete.logo_asset_id.is_none());
        assert_ne!(after_asset_delete.updated_at, "2020-01-01T00:00:00.000Z");
    }

    #[test]
    fn full_business_graph_delete_and_cross_business_nocase_uniqueness() {
        let (_temp, _manager, mut conn) = init_test_db("graph_and_nocase");
        seed_business(&mut conn, "biz_1");
        seed_business(&mut conn, "biz_2");
        seed_client(&mut conn, "biz_1", "cli_1");
        seed_client(&mut conn, "biz_2", "cli_2");

        // Active logo asset on biz_1
        let asset = repositories::asset_repository::create_asset(
            &mut conn,
            &dto::CreateBusinessAssetInput {
                id: "ast_1".to_string(),
                business_id: "biz_1".to_string(),
                content_hash: "hash_1".to_string(),
                source_type: "external_url".to_string(),
                mime_type: None,
                inline_data: None,
                file_path: None,
                external_url: Some("https://example.com/logo.png".to_string()),
                original_filename: None,
                byte_size: None,
                created_at: None,
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE businesses SET logo_asset_id = ?1 WHERE id = 'biz_1';",
            rusqlite::params![asset.id],
        )
        .unwrap();

        // Quotation + converted invoice + items + payment + activity log on biz_1
        repositories::quotation_repository::create_quotation(
            &mut conn,
            &dto::CreateQuotationInput {
                id: "quo_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                status: "sent".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![sample_item("qi_1", Some(0), 1_000_000, 10_000_000, 10_000)],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: Some("quo_1".to_string()),
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(10_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(10_000),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(10_000),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![sample_item("ii_1", Some(0), 1_000_000, 10_000_000, 10_000)],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        repositories::payment_repository::create_payment(
            &mut conn,
            &dto::CreatePaymentInput {
                id: "pay_1".to_string(),
                business_id: "biz_1".to_string(),
                invoice_id: "inv_1".to_string(),
                legacy_id: None,
                amount_minor: precision::SafeI64(5_000),
                payment_date: "2026-11-16".to_string(),
                payment_method: "eft".to_string(),
                reference: None,
                notes: None,
                recorded_at: None,
            },
        )
        .unwrap();

        repositories::activity_repository::create_activity_log(
            &mut conn,
            &dto::CreateActivityLogInput {
                id: "act_1".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                log_type: "invoice_created".to_string(),
                title: "Invoice Created".to_string(),
                description: "INV-0001".to_string(),
                timestamp: None,
                reference_id: Some("inv_1".to_string()),
                reference_type: Some("invoice".to_string()),
                actor_local_profile_id: None,
            },
        )
        .unwrap();

        // Same-business invoice_number COLLATE NOCASE duplicate must fail
        let dup_inv_err = repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_dup".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_id: None,
                invoice_number: "inv-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(0),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(0),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(0),
                status: "draft".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .expect_err("COLLATE NOCASE duplicate invoice_number must fail in same business");
        assert!(matches!(dup_inv_err, DbError::DuplicateDocumentNumber(_)));

        // Cross-business reuse of QUO-0001 and INV-0001 in biz_2 must succeed
        repositories::quotation_repository::create_quotation(
            &mut conn,
            &dto::CreateQuotationInput {
                id: "quo_2".to_string(),
                business_id: "biz_2".to_string(),
                legacy_id: None,
                client_id: Some("cli_2".to_string()),
                quotation_number: "QUO-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(0),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(0),
                status: "draft".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        repositories::invoice_repository::create_invoice(
            &mut conn,
            &dto::CreateInvoiceInput {
                id: "inv_2".to_string(),
                business_id: "biz_2".to_string(),
                legacy_id: None,
                client_id: Some("cli_2".to_string()),
                quotation_id: Some("quo_2".to_string()),
                invoice_number: "INV-0001".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                due_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(0),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(0),
                amount_paid_minor: precision::SafeI64(0),
                outstanding_balance_minor: precision::SafeI64(0),
                status: "sent".to_string(),
                notes: None,
                terms: None,
                payment_instructions: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();

        // Delete biz_1 with full graph -> all biz_1 records removed, biz_2 untouched
        repositories::business_repository::delete_business(&mut conn, "biz_1").unwrap();

        for (table, expected) in [
            ("businesses", 1_i64),
            ("clients", 1_i64),
            ("quotations", 1_i64),
            ("invoices", 1_i64),
            ("quotation_items", 0_i64),
            ("invoice_items", 0_i64),
            ("payments", 0_i64),
            ("activity_logs", 0_i64),
            ("business_assets", 0_i64),
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table};"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, expected, "Unexpected remaining count in {table}");
        }
        verify_database_integrity(&conn).unwrap();
    }

    #[test]
    fn concurrent_quotation_conversion_link_allows_only_one_invoice() {
        let (_temp, manager, mut conn) = init_test_db("concurrent_link");
        seed_business(&mut conn, "biz_1");
        seed_client(&mut conn, "biz_1", "cli_1");

        repositories::quotation_repository::create_quotation(
            &mut conn,
            &dto::CreateQuotationInput {
                id: "quo_race".to_string(),
                business_id: "biz_1".to_string(),
                legacy_id: None,
                client_id: Some("cli_1".to_string()),
                quotation_number: "QUO-RACE".to_string(),
                client_snapshot_json: "{}".to_string(),
                business_snapshot_json: "{}".to_string(),
                issue_date: "2026-11-16".to_string(),
                expiry_date: None,
                currency: "NAD".to_string(),
                currency_symbol: "N$".to_string(),
                subtotal_minor: precision::SafeI64(5_000),
                discount_type: "percentage".to_string(),
                discount_percentage_ppm: precision::SafeI64(0),
                discount_fixed_minor: precision::SafeI64(0),
                discount_amount_minor: precision::SafeI64(0),
                tax_name: "VAT".to_string(),
                tax_rate_ppm: precision::SafeI64(0),
                tax_amount_minor: precision::SafeI64(0),
                grand_total_minor: precision::SafeI64(5_000),
                status: "sent".to_string(),
                pre_conversion_status: None,
                notes: None,
                terms: None,
                converted_invoice_id: None,
                items: vec![],
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();
        drop(conn);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for idx in 1..=2 {
            let mgr = manager.clone();
            let b = barrier.clone();
            handles.push(std::thread::spawn(move || {
                let mut thread_conn = mgr.ensure_initialized_connection().unwrap();
                b.wait();
                repositories::invoice_repository::create_invoice(
                    &mut thread_conn,
                    &dto::CreateInvoiceInput {
                        id: format!("inv_race_{idx}"),
                        business_id: "biz_1".to_string(),
                        legacy_id: None,
                        client_id: Some("cli_1".to_string()),
                        quotation_id: Some("quo_race".to_string()),
                        invoice_number: format!("INV-RACE-{idx}"),
                        client_snapshot_json: "{}".to_string(),
                        business_snapshot_json: "{}".to_string(),
                        issue_date: "2026-11-16".to_string(),
                        due_date: None,
                        currency: "NAD".to_string(),
                        currency_symbol: "N$".to_string(),
                        subtotal_minor: precision::SafeI64(5_000),
                        discount_type: "percentage".to_string(),
                        discount_percentage_ppm: precision::SafeI64(0),
                        discount_fixed_minor: precision::SafeI64(0),
                        discount_amount_minor: precision::SafeI64(0),
                        tax_name: "VAT".to_string(),
                        tax_rate_ppm: precision::SafeI64(0),
                        tax_amount_minor: precision::SafeI64(0),
                        grand_total_minor: precision::SafeI64(5_000),
                        amount_paid_minor: precision::SafeI64(0),
                        outstanding_balance_minor: precision::SafeI64(5_000),
                        status: "sent".to_string(),
                        notes: None,
                        terms: None,
                        payment_instructions: None,
                        items: vec![],
                        created_at: None,
                        updated_at: None,
                    },
                )
            }));
        }

        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let successes: Vec<_> = results.iter().filter(|r| r.is_ok()).collect();
        let failures: Vec<_> = results.iter().filter(|r| r.is_err()).collect();
        assert_eq!(successes.len(), 1, "exactly one concurrent invoice link must succeed");
        assert_eq!(failures.len(), 1, "conflicting concurrent invoice link must fail");
        assert!(matches!(failures[0], Err(DbError::UniqueConstraint(_))));
    }
}

