use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::db::dto::{ClientDto, CreateClientInput, UpdateClientInput};
use crate::db::models::ClientRow;
use crate::db::repositories::{
    current_utc_iso, ensure_business_exists, map_rusqlite_error, require_non_empty_id,
    require_trimmed_non_empty, resolve_timestamp_or_now, validate_optional_non_empty,
};
use crate::db::DbError;

pub fn create_client(
    conn: &mut Connection,
    input: &CreateClientInput,
) -> Result<ClientDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let business_id = require_non_empty_id(&input.business_id, "businessId")?.to_string();
    let legacy_id = validate_optional_non_empty(&input.legacy_id, "legacyId")?;
    let name = require_trimmed_non_empty(&input.name, "name")?;
    let created_at = resolve_timestamp_or_now(conn, &input.created_at, "createdAt")?;
    let updated_at = match &input.updated_at {
        Some(ts) => resolve_timestamp_or_now(conn, &Some(ts.clone()), "updatedAt")?,
        None => created_at.clone(),
    };

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    ensure_business_exists(&tx, &business_id)?;

    tx.execute(
        "INSERT INTO clients (
            id, business_id, legacy_id, name, company_name,
            email, phone, address, city, country,
            vat_number, notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14);",
        params![
            id,
            business_id,
            legacy_id,
            name,
            input.company_name,
            input.email,
            input.phone,
            input.address,
            input.city,
            input.country,
            input.vat_number,
            input.notes,
            created_at,
            updated_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "creating client"))?;

    let row = query_client_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Created client could not be retrieved".to_string()))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing client creation"))?;

    Ok(ClientDto::from(row))
}

pub fn get_client_by_id(conn: &Connection, id: &str) -> Result<Option<ClientDto>, DbError> {
    let id = require_non_empty_id(id, "id")?;
    Ok(query_client_by_id(conn, id)?.map(ClientDto::from))
}

pub fn get_clients_by_business(
    conn: &Connection,
    business_id: &str,
) -> Result<Vec<ClientDto>, DbError> {
    let business_id = require_non_empty_id(business_id, "businessId")?;
    let mut stmt = conn
        .prepare(&format!(
            "{CLIENT_SELECT_SQL} WHERE business_id = ?1 ORDER BY created_at DESC, id ASC;"
        ))
        .map_err(|err| map_rusqlite_error(err, "preparing clients query"))?;

    let rows = stmt
        .query_map(params![business_id], map_row)
        .map_err(|err| map_rusqlite_error(err, "querying clients"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading client rows"))?;

    Ok(rows.into_iter().map(ClientDto::from).collect())
}

pub fn update_client(
    conn: &mut Connection,
    input: &UpdateClientInput,
) -> Result<ClientDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let business_id = require_non_empty_id(&input.business_id, "businessId")?.to_string();
    let name = require_trimmed_non_empty(&input.name, "name")?;
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let changed = tx
        .execute(
            "UPDATE clients SET
                name = ?1,
                company_name = ?2,
                email = ?3,
                phone = ?4,
                address = ?5,
                city = ?6,
                country = ?7,
                vat_number = ?8,
                notes = ?9,
                updated_at = ?10
             WHERE id = ?11 AND business_id = ?12;",
            params![
                name,
                input.company_name,
                input.email,
                input.phone,
                input.address,
                input.city,
                input.country,
                input.vat_number,
                input.notes,
                updated_at,
                id,
                business_id
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "updating client"))?;

    if changed == 0 {
        return Err(DbError::NotFound("Client record was not found".to_string()));
    }

    let row = query_client_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Updated client was not found".to_string()))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing client update"))?;

    Ok(ClientDto::from(row))
}

/// Safely deletes a client without deleting historical quotations or invoices:
/// detaches `client_id` (setting it to NULL while preserving `client_snapshot_json`
/// and `business_id` on historical documents) before deleting the client record.
pub fn delete_client(conn: &mut Connection, id: &str) -> Result<(), DbError> {
    let id = require_non_empty_id(id, "id")?.to_string();

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing = query_client_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Client record was not found".to_string()))?;

    tx.execute(
        "UPDATE quotations SET client_id = NULL WHERE business_id = ?1 AND client_id = ?2;",
        params![existing.business_id, id],
    )
    .map_err(|err| map_rusqlite_error(err, "detaching client from quotations"))?;

    tx.execute(
        "UPDATE invoices SET client_id = NULL WHERE business_id = ?1 AND client_id = ?2;",
        params![existing.business_id, id],
    )
    .map_err(|err| map_rusqlite_error(err, "detaching client from invoices"))?;

    tx.execute(
        "DELETE FROM clients WHERE id = ?1 AND business_id = ?2;",
        params![id, existing.business_id],
    )
    .map_err(|err| map_rusqlite_error(err, "deleting client"))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing client deletion"))?;

    Ok(())
}

const CLIENT_SELECT_SQL: &str = "
SELECT
    id, business_id, legacy_id, name, company_name,
    email, phone, address, city, country,
    vat_number, notes, created_at, updated_at
FROM clients";

fn query_client_by_id(conn: &Connection, id: &str) -> Result<Option<ClientRow>, DbError> {
    conn.query_row(
        &format!("{CLIENT_SELECT_SQL} WHERE id = ?1;"),
        params![id],
        map_row,
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "fetching client by id"))
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClientRow> {
    Ok(ClientRow {
        id: row.get(0)?,
        business_id: row.get(1)?,
        legacy_id: row.get(2)?,
        name: row.get(3)?,
        company_name: row.get(4)?,
        email: row.get(5)?,
        phone: row.get(6)?,
        address: row.get(7)?,
        city: row.get(8)?,
        country: row.get(9)?,
        vat_number: row.get(10)?,
        notes: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}
