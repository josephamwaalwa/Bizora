use std::collections::HashSet;

use rusqlite::{params, Connection, TransactionBehavior};

use super::schema::{
    INITIAL_SCHEMA_DESCRIPTION, INITIAL_SCHEMA_SQL, INITIAL_SCHEMA_VERSION,
    SCHEMA_MIGRATIONS_TABLE_SQL,
};
use super::DbError;

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub description: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[Migration {
    version: INITIAL_SCHEMA_VERSION,
    description: INITIAL_SCHEMA_DESCRIPTION,
    sql: INITIAL_SCHEMA_SQL,
}];

/// Ensures `schema_migrations` exists and applies any pending migrations transactionally.
/// Safe to invoke repeatedly; already-applied versions are skipped without modifying existing data.
pub fn apply_migrations(conn: &mut Connection) -> Result<i64, DbError> {
    conn.execute_batch(SCHEMA_MIGRATIONS_TABLE_SQL)
        .map_err(|err| DbError::Migration {
            version: 0,
            message: format!("Failed to ensure schema_migrations table: {err}"),
        })?;

    let applied = load_applied_versions(conn)?;

    for migration in MIGRATIONS {
        if applied.contains(&migration.version) {
            continue;
        }
        apply_migration_step(conn, migration.version, migration.description, migration.sql)?;
    }

    current_schema_version(conn)
}

/// Applies a single migration version inside an IMMEDIATE transaction.
/// If any statement fails, the transaction drops without committing and rolls back completely.
pub fn apply_migration_step(
    conn: &mut Connection,
    version: i64,
    description: &str,
    sql: &str,
) -> Result<(), DbError> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::Migration {
            version,
            message: format!("Failed to start migration transaction: {err}"),
        })?;

    tx.execute_batch(sql).map_err(|err| DbError::Migration {
        version,
        message: format!("Failed to execute schema SQL for version {version}: {err}"),
    })?;

    tx.execute(
        "INSERT INTO schema_migrations (version, description, applied_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));",
        params![version, description],
    )
    .map_err(|err| DbError::Migration {
        version,
        message: format!("Failed to record schema_migrations entry for version {version}: {err}"),
    })?;

    tx.commit().map_err(|err| DbError::Migration {
        version,
        message: format!("Failed to commit migration transaction for version {version}: {err}"),
    })?;

    Ok(())
}

/// Returns the highest applied schema version, or 0 if no migrations have been applied.
pub fn current_schema_version(conn: &Connection) -> Result<i64, DbError> {
    let table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations';",
            [],
            |row| row.get(0),
        )
        .map_err(|source| DbError::Query {
            context: "checking schema_migrations existence".to_string(),
            source,
        })?;

    if table_exists == 0 {
        return Ok(0);
    }

    let max_version: Option<i64> = conn
        .query_row("SELECT MAX(version) FROM schema_migrations;", [], |row| {
            row.get(0)
        })
        .map_err(|source| DbError::Query {
            context: "querying current schema version".to_string(),
            source,
        })?;

    Ok(max_version.unwrap_or(0))
}

fn load_applied_versions(conn: &Connection) -> Result<HashSet<i64>, DbError> {
    let mut stmt = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC;")
        .map_err(|err| DbError::Migration {
            version: 0,
            message: format!("Failed to prepare applied versions query: {err}"),
        })?;

    let rows = stmt
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|err| DbError::Migration {
            version: 0,
            message: format!("Failed to query applied versions: {err}"),
        })?;

    let mut versions = HashSet::new();
    for row in rows {
        let version = row.map_err(|err| DbError::Migration {
            version: 0,
            message: format!("Failed to read applied version row: {err}"),
        })?;
        versions.insert(version);
    }

    Ok(versions)
}
