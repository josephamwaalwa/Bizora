pub mod connection;
pub mod migrations;
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
            return Err(DbError::Integrity(format!(
                "Database file '{}' has not been initialized yet",
                db_path.display()
            )));
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
}
