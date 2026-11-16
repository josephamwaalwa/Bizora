use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::db::dto::{AppSettingDto, SaveAppSettingInput};
use crate::db::models::AppSettingRow;
use crate::db::repositories::{
    map_rusqlite_error, require_trimmed_non_empty, resolve_timestamp_or_now, validate_json_text,
};
use crate::db::DbError;

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<AppSettingDto>, DbError> {
    let key = require_trimmed_non_empty(key, "key")?;
    Ok(query_setting_by_key(conn, &key)?.map(AppSettingDto::from))
}

pub fn save_setting(
    conn: &mut Connection,
    input: &SaveAppSettingInput,
) -> Result<AppSettingDto, DbError> {
    let key = require_trimmed_non_empty(&input.key, "key")?;
    validate_json_text(&input.value_json, "valueJson")?;
    let updated_at = resolve_timestamp_or_now(conn, &input.updated_at, "updatedAt")?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    tx.execute(
        "INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at;",
        params![key, input.value_json, updated_at],
    )
    .map_err(|err| map_rusqlite_error(err, "saving app setting"))?;

    let row = query_setting_by_key(&tx, &key)?
        .ok_or_else(|| DbError::NotFound("Saved setting could not be retrieved".to_string()))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing app setting save"))?;

    Ok(AppSettingDto::from(row))
}

pub fn delete_setting(conn: &mut Connection, key: &str) -> Result<(), DbError> {
    let key = require_trimmed_non_empty(key, "key")?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let changed = tx
        .execute("DELETE FROM app_settings WHERE key = ?1;", params![key])
        .map_err(|err| map_rusqlite_error(err, "deleting app setting"))?;

    if changed == 0 {
        return Err(DbError::NotFound("Application setting was not found".to_string()));
    }

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing app setting deletion"))?;

    Ok(())
}

fn query_setting_by_key(conn: &Connection, key: &str) -> Result<Option<AppSettingRow>, DbError> {
    conn.query_row(
        "SELECT key, value_json, updated_at FROM app_settings WHERE key = ?1;",
        params![key],
        |row| {
            Ok(AppSettingRow {
                key: row.get(0)?,
                value_json: row.get(1)?,
                updated_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "fetching app setting"))
}
