use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::db::dto::{
    CreateQuotationInput, LineItemInput, QuotationDto, QuotationItemDto, UpdateQuotationInput,
};
use crate::db::models::{QuotationItemRow, QuotationRow};
use crate::db::precision::require_non_negative;
use crate::db::repositories::{
    current_utc_iso, ensure_business_exists, map_rusqlite_error, normalize_discount_values,
    require_non_empty_id, require_trimmed_non_empty, resolve_timestamp_or_now, validate_enum,
    validate_iso_date, validate_json_text, validate_line_items, validate_optional_iso_date,
    validate_optional_non_empty, QUOTATION_STATUSES,
};
use crate::db::DbError;

pub fn create_quotation(
    conn: &mut Connection,
    input: &CreateQuotationInput,
) -> Result<QuotationDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let business_id = require_non_empty_id(&input.business_id, "businessId")?.to_string();
    let legacy_id = validate_optional_non_empty(&input.legacy_id, "legacyId")?;
    let client_id = validate_optional_non_empty(&input.client_id, "clientId")?;
    let quotation_number = require_trimmed_non_empty(&input.quotation_number, "quotationNumber")?;
    validate_json_text(&input.client_snapshot_json, "clientSnapshotJson")?;
    validate_json_text(&input.business_snapshot_json, "businessSnapshotJson")?;
    let issue_date = validate_iso_date(&input.issue_date, "issueDate")?;
    let expiry_date = validate_optional_iso_date(&input.expiry_date, "expiryDate")?;
    let currency = require_trimmed_non_empty(&input.currency, "currency")?;
    let currency_symbol = require_trimmed_non_empty(&input.currency_symbol, "currencySymbol")?;

    let subtotal_minor = require_non_negative(input.subtotal_minor.get(), "subtotalMinor")?;
    let (discount_percentage_ppm, discount_fixed_minor) = normalize_discount_values(
        &input.discount_type,
        input.discount_percentage_ppm.get(),
        input.discount_fixed_minor.get(),
    )?;
    let discount_amount_minor =
        require_non_negative(input.discount_amount_minor.get(), "discountAmountMinor")?;
    let tax_rate_ppm = require_non_negative(input.tax_rate_ppm.get(), "taxRatePpm")?;
    let tax_amount_minor = require_non_negative(input.tax_amount_minor.get(), "taxAmountMinor")?;
    let grand_total_minor = require_non_negative(input.grand_total_minor.get(), "grandTotalMinor")?;

    let status = validate_enum(&input.status, &QUOTATION_STATUSES, "status")?.to_string();
    let requested_converted_invoice_id =
        validate_optional_non_empty(&input.converted_invoice_id, "convertedInvoiceId")?;
    if requested_converted_invoice_id.is_some() {
        return Err(DbError::InvalidInput {
            field: Some("convertedInvoiceId".to_string()),
            message: "New quotations cannot specify convertedInvoiceId; link quotations through the invoice repository".to_string(),
        });
    }
    let converted_invoice_id: Option<String> = None;
    let pre_conversion_status: Option<String> = match &input.pre_conversion_status {
        Some(raw) => {
            let _ = validate_enum(raw, &QUOTATION_STATUSES, "preConversionStatus")?;
            None
        }
        None => None,
    };

    validate_line_items(&input.items)?;

    let created_at = resolve_timestamp_or_now(conn, &input.created_at, "createdAt")?;
    let updated_at = match &input.updated_at {
        Some(ts) => resolve_timestamp_or_now(conn, &Some(ts.clone()), "updatedAt")?,
        None => created_at.clone(),
    };

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    ensure_business_exists(&tx, &business_id)?;
    verify_quotation_foreign_keys(&tx, &business_id, &id, client_id.as_deref(), None)?;

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
            ?21, ?22, ?23, ?24, ?25,
            ?26, ?27
        );",
        params![
            id,
            business_id,
            legacy_id,
            client_id,
            quotation_number,
            input.client_snapshot_json,
            input.business_snapshot_json,
            issue_date,
            expiry_date,
            currency,
            currency_symbol,
            subtotal_minor,
            input.discount_type,
            discount_percentage_ppm,
            discount_fixed_minor,
            discount_amount_minor,
            input.tax_name.trim(),
            tax_rate_ppm,
            tax_amount_minor,
            grand_total_minor,
            status,
            pre_conversion_status,
            input.notes,
            input.terms,
            converted_invoice_id,
            created_at,
            updated_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "creating quotation"))?;

    insert_quotation_items(&tx, &business_id, &id, &input.items, &created_at)?;

    let row = query_quotation_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Created quotation could not be retrieved".to_string()))?;
    let items = query_quotation_items(&tx, &id)?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing quotation creation"))?;

    Ok(QuotationDto::from_parts(row, items))
}

pub fn get_quotation_by_id(conn: &Connection, id: &str) -> Result<Option<QuotationDto>, DbError> {
    let id = require_non_empty_id(id, "id")?;
    let Some(row) = query_quotation_by_id(conn, id)? else {
        return Ok(None);
    };
    let items = query_quotation_items(conn, id)?;
    Ok(Some(QuotationDto::from_parts(row, items)))
}

pub fn get_quotations_by_business(
    conn: &Connection,
    business_id: &str,
) -> Result<Vec<QuotationDto>, DbError> {
    let business_id = require_non_empty_id(business_id, "businessId")?;
    let mut stmt = conn
        .prepare(&format!(
            "{QUOTATION_SELECT_SQL} WHERE business_id = ?1 ORDER BY issue_date DESC, created_at DESC, id ASC;"
        ))
        .map_err(|err| map_rusqlite_error(err, "preparing quotations query"))?;

    let rows = stmt
        .query_map(params![business_id], map_quotation_row)
        .map_err(|err| map_rusqlite_error(err, "querying quotations"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading quotation rows"))?;

    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let items = query_quotation_items(conn, &row.id)?;
        result.push(QuotationDto::from_parts(row, items));
    }

    Ok(result)
}

pub fn get_quotation_items(
    conn: &Connection,
    quotation_id: &str,
) -> Result<Vec<QuotationItemDto>, DbError> {
    let quotation_id = require_non_empty_id(quotation_id, "quotationId")?;
    let rows = query_quotation_items(conn, quotation_id)?;
    Ok(rows.into_iter().map(QuotationItemDto::from).collect())
}

pub fn update_quotation(
    conn: &mut Connection,
    input: &UpdateQuotationInput,
) -> Result<QuotationDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let business_id = require_non_empty_id(&input.business_id, "businessId")?.to_string();
    let client_id = validate_optional_non_empty(&input.client_id, "clientId")?;
    let quotation_number = require_trimmed_non_empty(&input.quotation_number, "quotationNumber")?;
    validate_json_text(&input.client_snapshot_json, "clientSnapshotJson")?;
    validate_json_text(&input.business_snapshot_json, "businessSnapshotJson")?;
    let issue_date = validate_iso_date(&input.issue_date, "issueDate")?;
    let expiry_date = validate_optional_iso_date(&input.expiry_date, "expiryDate")?;
    let currency = require_trimmed_non_empty(&input.currency, "currency")?;
    let currency_symbol = require_trimmed_non_empty(&input.currency_symbol, "currencySymbol")?;

    let subtotal_minor = require_non_negative(input.subtotal_minor.get(), "subtotalMinor")?;
    let (discount_percentage_ppm, discount_fixed_minor) = normalize_discount_values(
        &input.discount_type,
        input.discount_percentage_ppm.get(),
        input.discount_fixed_minor.get(),
    )?;
    let discount_amount_minor =
        require_non_negative(input.discount_amount_minor.get(), "discountAmountMinor")?;
    let tax_rate_ppm = require_non_negative(input.tax_rate_ppm.get(), "taxRatePpm")?;
    let tax_amount_minor = require_non_negative(input.tax_amount_minor.get(), "taxAmountMinor")?;
    let grand_total_minor = require_non_negative(input.grand_total_minor.get(), "grandTotalMinor")?;

    let status = validate_enum(&input.status, &QUOTATION_STATUSES, "status")?.to_string();
    let requested_converted_invoice_id =
        validate_optional_non_empty(&input.converted_invoice_id, "convertedInvoiceId")?;
    let validated_pre_conversion_status = match &input.pre_conversion_status {
        Some(raw) => Some(validate_enum(raw, &QUOTATION_STATUSES, "preConversionStatus")?.to_string()),
        None => None,
    };

    validate_line_items(&input.items)?;
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing = query_quotation_by_id(&tx, &id)?
        .filter(|q| q.business_id == business_id)
        .ok_or_else(|| DbError::NotFound("Quotation record was not found".to_string()))?;

    if requested_converted_invoice_id.as_deref() != existing.converted_invoice_id.as_deref() {
        return Err(DbError::InvalidInput {
            field: Some("convertedInvoiceId".to_string()),
            message: "convertedInvoiceId cannot be modified directly through quotation update; use invoice linking or unlinking instead".to_string(),
        });
    }

    let preserved_converted_invoice_id = existing.converted_invoice_id.clone();
    let pre_conversion_status = if preserved_converted_invoice_id.is_some() {
        validated_pre_conversion_status
    } else {
        None
    };

    verify_quotation_foreign_keys(
        &tx,
        &business_id,
        &id,
        client_id.as_deref(),
        preserved_converted_invoice_id.as_deref(),
    )?;

    let changed = tx
        .execute(
            "UPDATE quotations SET
                client_id = ?1,
                quotation_number = ?2,
                client_snapshot_json = ?3,
                business_snapshot_json = ?4,
                issue_date = ?5,
                expiry_date = ?6,
                currency = ?7,
                currency_symbol = ?8,
                subtotal_minor = ?9,
                discount_type = ?10,
                discount_percentage_ppm = ?11,
                discount_fixed_minor = ?12,
                discount_amount_minor = ?13,
                tax_name = ?14,
                tax_rate_ppm = ?15,
                tax_amount_minor = ?16,
                grand_total_minor = ?17,
                status = ?18,
                pre_conversion_status = ?19,
                notes = ?20,
                terms = ?21,
                converted_invoice_id = ?22,
                updated_at = ?23
             WHERE id = ?24 AND business_id = ?25;",
            params![
                client_id,
                quotation_number,
                input.client_snapshot_json,
                input.business_snapshot_json,
                issue_date,
                expiry_date,
                currency,
                currency_symbol,
                subtotal_minor,
                input.discount_type,
                discount_percentage_ppm,
                discount_fixed_minor,
                discount_amount_minor,
                input.tax_name.trim(),
                tax_rate_ppm,
                tax_amount_minor,
                grand_total_minor,
                status,
                pre_conversion_status,
                input.notes,
                input.terms,
                preserved_converted_invoice_id,
                updated_at,
                id,
                business_id
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "updating quotation"))?;

    if changed == 0 {
        return Err(DbError::NotFound("Quotation record was not found".to_string()));
    }

    tx.execute(
        "DELETE FROM quotation_items WHERE business_id = ?1 AND quotation_id = ?2;",
        params![business_id, id],
    )
    .map_err(|err| map_rusqlite_error(err, "clearing existing quotation items"))?;

    insert_quotation_items(&tx, &business_id, &id, &input.items, &existing.created_at)?;

    let row = query_quotation_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Updated quotation was not found".to_string()))?;
    let items = query_quotation_items(&tx, &id)?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing quotation update"))?;

    Ok(QuotationDto::from_parts(row, items))
}

/// Safely deletes a quotation inside an IMMEDIATE transaction:
/// clears `invoices.quotation_id = NULL` on any linked invoices without deleting
/// the invoices or their snapshots, then deletes the quotation (cascading `quotation_items`).
pub fn delete_quotation(conn: &mut Connection, id: &str) -> Result<(), DbError> {
    let id = require_non_empty_id(id, "id")?.to_string();
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing = query_quotation_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Quotation record was not found".to_string()))?;

    tx.execute(
        "UPDATE invoices
         SET quotation_id = NULL, updated_at = ?1
         WHERE business_id = ?2 AND quotation_id = ?3;",
        params![updated_at, existing.business_id, id],
    )
    .map_err(|err| map_rusqlite_error(err, "detaching quotation from linked invoices"))?;

    tx.execute(
        "DELETE FROM quotations WHERE id = ?1 AND business_id = ?2;",
        params![id, existing.business_id],
    )
    .map_err(|err| map_rusqlite_error(err, "deleting quotation"))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing quotation deletion"))?;

    Ok(())
}

fn verify_quotation_foreign_keys(
    conn: &Connection,
    business_id: &str,
    quotation_id: &str,
    client_id: Option<&str>,
    converted_invoice_id: Option<&str>,
) -> Result<(), DbError> {
    if let Some(cid) = client_id {
        let client_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clients WHERE business_id = ?1 AND id = ?2;",
                params![business_id, cid],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying quotation client"))?;
        if client_exists == 0 {
            return Err(DbError::ForeignKeyViolation(
                "Referenced client does not exist for this business".to_string(),
            ));
        }
    }

    if let Some(inv_id) = converted_invoice_id {
        let inv_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM invoices WHERE business_id = ?1 AND id = ?2;",
                params![business_id, inv_id],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying converted invoice"))?;
        if inv_exists == 0 {
            return Err(DbError::ForeignKeyViolation(
                "Referenced converted invoice does not exist for this business".to_string(),
            ));
        }

        let claimed_by_other: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM quotations
                 WHERE business_id = ?1 AND converted_invoice_id = ?2 AND id != ?3;",
                params![business_id, inv_id, quotation_id],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying converted invoice uniqueness"))?;
        if claimed_by_other > 0 {
            return Err(DbError::UniqueConstraint(
                "This invoice is already assigned as convertedInvoiceId on another quotation"
                    .to_string(),
            ));
        }
    }

    Ok(())
}

fn insert_quotation_items(
    conn: &Connection,
    business_id: &str,
    quotation_id: &str,
    items: &[LineItemInput],
    default_created_at: &str,
) -> Result<(), DbError> {
    for (idx, item) in items.iter().enumerate() {
        let sort_order = item.sort_order.map(|v| v.get()).unwrap_or(idx as i64);
        if sort_order < 0 {
            return Err(DbError::InvalidInput {
                field: Some("items.sortOrder".to_string()),
                message: "Line item sortOrder must not be negative".to_string(),
            });
        }
        let item_created_at = match &item.created_at {
            Some(ts) => require_trimmed_non_empty(ts, "items.createdAt")?,
            None => default_created_at.to_string(),
        };

        conn.execute(
            "INSERT INTO quotation_items (
                id, business_id, quotation_id, legacy_id, sort_order,
                description, quantity_scaled, unit_price_scaled, total_minor, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
            params![
                item.id,
                business_id,
                quotation_id,
                item.legacy_id.as_deref().map(str::trim),
                sort_order,
                item.description,
                item.quantity_scaled.get(),
                item.unit_price_scaled.get(),
                item.total_minor.get(),
                item_created_at
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting quotation line item"))?;
    }

    Ok(())
}

const QUOTATION_SELECT_SQL: &str = "
SELECT
    id, business_id, legacy_id, client_id, quotation_number,
    client_snapshot_json, business_snapshot_json, issue_date, expiry_date,
    currency, currency_symbol, subtotal_minor, discount_type,
    discount_percentage_ppm, discount_fixed_minor, discount_amount_minor,
    tax_name, tax_rate_ppm, tax_amount_minor, grand_total_minor,
    status, pre_conversion_status, notes, terms, converted_invoice_id,
    created_at, updated_at
FROM quotations";

fn query_quotation_by_id(conn: &Connection, id: &str) -> Result<Option<QuotationRow>, DbError> {
    conn.query_row(
        &format!("{QUOTATION_SELECT_SQL} WHERE id = ?1;"),
        params![id],
        map_quotation_row,
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "fetching quotation by id"))
}

fn query_quotation_items(
    conn: &Connection,
    quotation_id: &str,
) -> Result<Vec<QuotationItemRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT
                id, business_id, quotation_id, legacy_id, sort_order,
                description, quantity_scaled, unit_price_scaled, total_minor, created_at
             FROM quotation_items
             WHERE quotation_id = ?1
             ORDER BY sort_order ASC, rowid ASC;",
        )
        .map_err(|err| map_rusqlite_error(err, "preparing quotation items query"))?;

    let rows = stmt
        .query_map(params![quotation_id], |row| {
            Ok(QuotationItemRow {
                id: row.get(0)?,
                business_id: row.get(1)?,
                quotation_id: row.get(2)?,
                legacy_id: row.get(3)?,
                sort_order: row.get(4)?,
                description: row.get(5)?,
                quantity_scaled: row.get(6)?,
                unit_price_scaled: row.get(7)?,
                total_minor: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|err| map_rusqlite_error(err, "querying quotation items"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading quotation item rows"))?;

    Ok(rows)
}

fn map_quotation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<QuotationRow> {
    Ok(QuotationRow {
        id: row.get(0)?,
        business_id: row.get(1)?,
        legacy_id: row.get(2)?,
        client_id: row.get(3)?,
        quotation_number: row.get(4)?,
        client_snapshot_json: row.get(5)?,
        business_snapshot_json: row.get(6)?,
        issue_date: row.get(7)?,
        expiry_date: row.get(8)?,
        currency: row.get(9)?,
        currency_symbol: row.get(10)?,
        subtotal_minor: row.get(11)?,
        discount_type: row.get(12)?,
        discount_percentage_ppm: row.get(13)?,
        discount_fixed_minor: row.get(14)?,
        discount_amount_minor: row.get(15)?,
        tax_name: row.get(16)?,
        tax_rate_ppm: row.get(17)?,
        tax_amount_minor: row.get(18)?,
        grand_total_minor: row.get(19)?,
        status: row.get(20)?,
        pre_conversion_status: row.get(21)?,
        notes: row.get(22)?,
        terms: row.get(23)?,
        converted_invoice_id: row.get(24)?,
        created_at: row.get(25)?,
        updated_at: row.get(26)?,
    })
}
