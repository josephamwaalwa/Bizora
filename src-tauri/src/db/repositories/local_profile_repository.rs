use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::db::dto::{CreateLocalProfileInput, LocalProfileDto, UpdateLocalProfileInput};
use crate::db::models::LocalProfileRow;
use crate::db::repositories::{
    current_utc_iso, map_rusqlite_error, require_non_empty_id, resolve_timestamp_or_now,
    validate_optional_non_empty,
};
use crate::db::DbError;

pub fn create_local_profile(
    conn: &mut Connection,
    input: &CreateLocalProfileInput,
) -> Result<LocalProfileDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let supabase_user_id =
        validate_optional_non_empty(&input.supabase_user_id, "supabaseUserId")?;
    let created_at = resolve_timestamp_or_now(conn, &input.created_at, "createdAt")?;
    let updated_at = match &input.updated_at {
        Some(ts) => resolve_timestamp_or_now(conn, &Some(ts.clone()), "updatedAt")?,
        None => created_at.clone(),
    };

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    tx.execute(
        "INSERT INTO local_profiles (id, display_name, email, supabase_user_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
        params![
            id,
            input.display_name.trim(),
            input.email.trim(),
            supabase_user_id,
            created_at,
            updated_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "creating local profile"))?;

    let row = query_local_profile_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Created local profile could not be read".to_string()))?;

    tx.commit()
        .map_err(|err| DbError::TransactionFailed(format!("Failed to commit transaction: {err}")))?;

    Ok(LocalProfileDto::from(row))
}

pub fn get_local_profile_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<LocalProfileDto>, DbError> {
    let id = require_non_empty_id(id, "id")?;
    Ok(query_local_profile_by_id(conn, id)?.map(LocalProfileDto::from))
}

pub fn get_local_profiles(conn: &Connection) -> Result<Vec<LocalProfileDto>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, display_name, email, supabase_user_id, created_at, updated_at
             FROM local_profiles
             ORDER BY created_at ASC, id ASC;",
        )
        .map_err(|err| map_rusqlite_error(err, "preparing local profiles query"))?;

    let rows = stmt
        .query_map([], map_row)
        .map_err(|err| map_rusqlite_error(err, "querying local profiles"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading local profile rows"))?;

    Ok(rows.into_iter().map(LocalProfileDto::from).collect())
}

pub fn update_local_profile(
    conn: &mut Connection,
    input: &UpdateLocalProfileInput,
) -> Result<LocalProfileDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let supabase_user_id =
        validate_optional_non_empty(&input.supabase_user_id, "supabaseUserId")?;
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let changed = tx
        .execute(
            "UPDATE local_profiles
             SET display_name = ?1,
                 email = ?2,
                 supabase_user_id = ?3,
                 updated_at = ?4
             WHERE id = ?5;",
            params![
                input.display_name.trim(),
                input.email.trim(),
                supabase_user_id,
                updated_at,
                id
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "updating local profile"))?;

    if changed == 0 {
        return Err(DbError::NotFound("Local profile was not found".to_string()));
    }

    let row = query_local_profile_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Updated local profile was not found".to_string()))?;

    tx.commit()
        .map_err(|err| DbError::TransactionFailed(format!("Failed to commit transaction: {err}")))?;

    Ok(LocalProfileDto::from(row))
}

fn query_local_profile_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<LocalProfileRow>, DbError> {
    conn.query_row(
        "SELECT id, display_name, email, supabase_user_id, created_at, updated_at
         FROM local_profiles
         WHERE id = ?1;",
        params![id],
        map_row,
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "fetching local profile by id"))
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalProfileRow> {
    Ok(LocalProfileRow {
        id: row.get(0)?,
        display_name: row.get(1)?,
        email: row.get(2)?,
        supabase_user_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}
