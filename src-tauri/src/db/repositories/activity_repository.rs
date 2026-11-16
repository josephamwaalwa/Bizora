use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::db::dto::{ActivityLogDto, CreateActivityLogInput};
use crate::db::models::ActivityLogRow;
use crate::db::precision::require_positive;
use crate::db::repositories::{
    ensure_business_exists, map_rusqlite_error, require_non_empty_id, require_trimmed_non_empty,
    resolve_timestamp_or_now, validate_enum, validate_optional_non_empty, ACTIVITY_TYPES,
};
use crate::db::DbError;

pub fn create_activity_log(
    conn: &mut Connection,
    input: &CreateActivityLogInput,
) -> Result<ActivityLogDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let business_id = require_non_empty_id(&input.business_id, "businessId")?.to_string();
    let legacy_id = validate_optional_non_empty(&input.legacy_id, "legacyId")?;
    let log_type = validate_enum(&input.log_type, &ACTIVITY_TYPES, "type")?.to_string();
    let title = require_trimmed_non_empty(&input.title, "title")?;
    let timestamp = resolve_timestamp_or_now(conn, &input.timestamp, "timestamp")?;
    let reference_id = validate_optional_non_empty(&input.reference_id, "referenceId")?;
    let reference_type = validate_optional_non_empty(&input.reference_type, "referenceType")?;
    let actor_local_profile_id =
        validate_optional_non_empty(&input.actor_local_profile_id, "actorLocalProfileId")?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    ensure_business_exists(&tx, &business_id)?;

    if let Some(ref actor_id) = actor_local_profile_id {
        let actor_exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM local_profiles WHERE id = ?1;",
                params![actor_id],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying activity log actor profile"))?;
        if actor_exists == 0 {
            return Err(DbError::ForeignKeyViolation(
                "Referenced actor local profile does not exist".to_string(),
            ));
        }
    }

    tx.execute(
        "INSERT INTO activity_logs (
            id, business_id, legacy_id, type, title, description,
            timestamp, reference_id, reference_type, actor_local_profile_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
        params![
            id,
            business_id,
            legacy_id,
            log_type,
            title,
            input.description,
            timestamp,
            reference_id,
            reference_type,
            actor_local_profile_id
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "creating activity log"))?;

    let row = query_activity_log_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Created activity log could not be retrieved".to_string()))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing activity log creation"))?;

    Ok(ActivityLogDto::from(row))
}

pub fn get_activity_log_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<ActivityLogDto>, DbError> {
    let id = require_non_empty_id(id, "id")?;
    Ok(query_activity_log_by_id(conn, id)?.map(ActivityLogDto::from))
}

pub fn get_activity_logs_by_business(
    conn: &Connection,
    business_id: &str,
    limit: Option<i64>,
) -> Result<Vec<ActivityLogDto>, DbError> {
    let business_id = require_non_empty_id(business_id, "businessId")?;

    let rows = if let Some(raw_limit) = limit {
        let limit = require_positive(raw_limit, "limit")?;
        let mut stmt = conn
            .prepare(&format!(
                "{ACTIVITY_SELECT_SQL}
                 WHERE business_id = ?1
                 ORDER BY timestamp DESC, id ASC
                 LIMIT ?2;"
            ))
            .map_err(|err| map_rusqlite_error(err, "preparing limited activity logs query"))?;

        stmt.query_map(params![business_id, limit], map_activity_row)
            .map_err(|err| map_rusqlite_error(err, "querying limited activity logs"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| map_rusqlite_error(err, "reading limited activity log rows"))?
    } else {
        let mut stmt = conn
            .prepare(&format!(
                "{ACTIVITY_SELECT_SQL}
                 WHERE business_id = ?1
                 ORDER BY timestamp DESC, id ASC;"
            ))
            .map_err(|err| map_rusqlite_error(err, "preparing activity logs query"))?;

        stmt.query_map(params![business_id], map_activity_row)
            .map_err(|err| map_rusqlite_error(err, "querying activity logs"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| map_rusqlite_error(err, "reading activity log rows"))?
    };

    Ok(rows.into_iter().map(ActivityLogDto::from).collect())
}

const ACTIVITY_SELECT_SQL: &str = "
SELECT
    id, business_id, legacy_id, type, title, description,
    timestamp, reference_id, reference_type, actor_local_profile_id
FROM activity_logs";

fn query_activity_log_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<ActivityLogRow>, DbError> {
    conn.query_row(
        &format!("{ACTIVITY_SELECT_SQL} WHERE id = ?1;"),
        params![id],
        map_activity_row,
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "fetching activity log by id"))
}

fn map_activity_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActivityLogRow> {
    Ok(ActivityLogRow {
        id: row.get(0)?,
        business_id: row.get(1)?,
        legacy_id: row.get(2)?,
        log_type: row.get(3)?,
        title: row.get(4)?,
        description: row.get(5)?,
        timestamp: row.get(6)?,
        reference_id: row.get(7)?,
        reference_type: row.get(8)?,
        actor_local_profile_id: row.get(9)?,
    })
}
