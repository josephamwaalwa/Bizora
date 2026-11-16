use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::db::dto::{BusinessAssetDto, CreateBusinessAssetInput};
use crate::db::models::BusinessAssetRow;
use crate::db::precision::require_non_negative;
use crate::db::repositories::{
    current_utc_iso, ensure_business_exists, map_rusqlite_error, require_non_empty_id,
    require_trimmed_non_empty, resolve_timestamp_or_now, validate_enum,
    validate_optional_non_empty, ASSET_SOURCE_TYPES,
};
use crate::db::DbError;

pub fn create_asset(
    conn: &mut Connection,
    input: &CreateBusinessAssetInput,
) -> Result<BusinessAssetDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let business_id = require_non_empty_id(&input.business_id, "businessId")?.to_string();
    let content_hash = require_trimmed_non_empty(&input.content_hash, "contentHash")?;
    let source_type =
        validate_enum(&input.source_type, &ASSET_SOURCE_TYPES, "sourceType")?.to_string();
    let mime_type = validate_optional_non_empty(&input.mime_type, "mimeType")?;
    let inline_data = validate_optional_non_empty(&input.inline_data, "inlineData")?;
    let file_path = validate_optional_non_empty(&input.file_path, "filePath")?;
    let external_url = validate_optional_non_empty(&input.external_url, "externalUrl")?;
    let original_filename =
        validate_optional_non_empty(&input.original_filename, "originalFilename")?;
    let byte_size = match input.byte_size {
        Some(raw) => Some(require_non_negative(raw.get(), "byteSize")?),
        None => None,
    };

    match source_type.as_str() {
        "data_url" if inline_data.is_none() => {
            return Err(DbError::InvalidInput {
                field: Some("inlineData".to_string()),
                message: "inlineData is required when sourceType is 'data_url'".to_string(),
            });
        }
        "file" if file_path.is_none() => {
            return Err(DbError::InvalidInput {
                field: Some("filePath".to_string()),
                message: "filePath is required when sourceType is 'file'".to_string(),
            });
        }
        "external_url" if external_url.is_none() => {
            return Err(DbError::InvalidInput {
                field: Some("externalUrl".to_string()),
                message: "externalUrl is required when sourceType is 'external_url'".to_string(),
            });
        }
        _ => {}
    }

    let created_at = resolve_timestamp_or_now(conn, &input.created_at, "createdAt")?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    ensure_business_exists(&tx, &business_id)?;

    tx.execute(
        "INSERT INTO business_assets (
            id, business_id, content_hash, source_type, mime_type,
            inline_data, file_path, external_url, original_filename, byte_size, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);",
        params![
            id,
            business_id,
            content_hash,
            source_type,
            mime_type,
            inline_data,
            file_path,
            external_url,
            original_filename,
            byte_size,
            created_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "creating business asset"))?;

    let row = query_asset_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Created business asset could not be retrieved".to_string()))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing business asset creation"))?;

    Ok(BusinessAssetDto::from(row))
}

pub fn get_asset_by_id(conn: &Connection, id: &str) -> Result<Option<BusinessAssetDto>, DbError> {
    let id = require_non_empty_id(id, "id")?;
    Ok(query_asset_by_id(conn, id)?.map(BusinessAssetDto::from))
}

pub fn get_assets_by_business(
    conn: &Connection,
    business_id: &str,
) -> Result<Vec<BusinessAssetDto>, DbError> {
    let business_id = require_non_empty_id(business_id, "businessId")?;
    let mut stmt = conn
        .prepare(&format!(
            "{ASSET_SELECT_SQL} WHERE business_id = ?1 ORDER BY created_at DESC, id ASC;"
        ))
        .map_err(|err| map_rusqlite_error(err, "preparing business assets query"))?;

    let rows = stmt
        .query_map(params![business_id], map_asset_row)
        .map_err(|err| map_rusqlite_error(err, "querying business assets"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading business asset rows"))?;

    Ok(rows.into_iter().map(BusinessAssetDto::from).collect())
}

/// Safely deletes a business asset metadata record without modifying any disk files.
/// Clears `businesses.logo_asset_id = NULL` first if this asset is currently active.
pub fn delete_asset(conn: &mut Connection, id: &str) -> Result<(), DbError> {
    let id = require_non_empty_id(id, "id")?.to_string();
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing = query_asset_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Business asset record was not found".to_string()))?;

    tx.execute(
        "UPDATE businesses
         SET logo_asset_id = NULL,
             updated_at = ?1
         WHERE id = ?2 AND logo_asset_id = ?3;",
        params![updated_at, existing.business_id, id],
    )
    .map_err(|err| map_rusqlite_error(err, "clearing active business logo reference"))?;

    tx.execute(
        "DELETE FROM business_assets WHERE id = ?1 AND business_id = ?2;",
        params![id, existing.business_id],
    )
    .map_err(|err| map_rusqlite_error(err, "deleting business asset"))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing business asset deletion"))?;

    Ok(())
}

const ASSET_SELECT_SQL: &str = "
SELECT
    id, business_id, content_hash, source_type, mime_type,
    inline_data, file_path, external_url, original_filename, byte_size, created_at
FROM business_assets";

fn query_asset_by_id(conn: &Connection, id: &str) -> Result<Option<BusinessAssetRow>, DbError> {
    conn.query_row(
        &format!("{ASSET_SELECT_SQL} WHERE id = ?1;"),
        params![id],
        map_asset_row,
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "fetching business asset by id"))
}

fn map_asset_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BusinessAssetRow> {
    Ok(BusinessAssetRow {
        id: row.get(0)?,
        business_id: row.get(1)?,
        content_hash: row.get(2)?,
        source_type: row.get(3)?,
        mime_type: row.get(4)?,
        inline_data: row.get(5)?,
        file_path: row.get(6)?,
        external_url: row.get(7)?,
        original_filename: row.get(8)?,
        byte_size: row.get(9)?,
        created_at: row.get(10)?,
    })
}
