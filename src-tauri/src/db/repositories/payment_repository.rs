use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::db::dto::{CreatePaymentInput, PaymentDto};
use crate::db::models::PaymentRow;
use crate::db::precision::{recompute_invoice_payment_state, require_positive};
use crate::db::repositories::{
    current_utc_iso, is_date_before_local_today, map_rusqlite_error, require_non_empty_id,
    resolve_timestamp_or_now, validate_enum, validate_iso_date, validate_optional_non_empty,
    PAYMENT_METHODS,
};
use crate::db::DbError;

pub fn create_payment(
    conn: &mut Connection,
    input: &CreatePaymentInput,
) -> Result<PaymentDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let business_id = require_non_empty_id(&input.business_id, "businessId")?.to_string();
    let invoice_id = require_non_empty_id(&input.invoice_id, "invoiceId")?.to_string();
    let legacy_id = validate_optional_non_empty(&input.legacy_id, "legacyId")?;
    let amount_minor = require_positive(input.amount_minor.get(), "amountMinor")?;
    let payment_date = validate_iso_date(&input.payment_date, "paymentDate")?;
    let payment_method =
        validate_enum(&input.payment_method, &PAYMENT_METHODS, "paymentMethod")?.to_string();
    let recorded_at = resolve_timestamp_or_now(conn, &input.recorded_at, "recordedAt")?;
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let invoice_exists: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM invoices WHERE business_id = ?1 AND id = ?2;",
            params![business_id, invoice_id],
            |row| row.get(0),
        )
        .map_err(|err| map_rusqlite_error(err, "verifying payment parent invoice"))?;

    if invoice_exists == 0 {
        return Err(DbError::ForeignKeyViolation(
            "Referenced invoice does not exist for this business".to_string(),
        ));
    }

    tx.execute(
        "INSERT INTO payments (
            id, business_id, invoice_id, legacy_id, amount_minor,
            payment_date, payment_method, reference, notes, recorded_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
        params![
            id,
            business_id,
            invoice_id,
            legacy_id,
            amount_minor,
            payment_date,
            payment_method,
            input.reference,
            input.notes,
            recorded_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "recording payment"))?;

    recalculate_invoice_after_payment_change(&tx, &business_id, &invoice_id, &updated_at)?;

    let row = query_payment_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Created payment could not be retrieved".to_string()))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing payment creation"))?;

    Ok(PaymentDto::from(row))
}

pub fn get_payments_by_invoice(
    conn: &Connection,
    invoice_id: &str,
) -> Result<Vec<PaymentDto>, DbError> {
    let invoice_id = require_non_empty_id(invoice_id, "invoiceId")?;
    let mut stmt = conn
        .prepare(&format!(
            "{PAYMENT_SELECT_SQL} WHERE invoice_id = ?1 ORDER BY payment_date ASC, recorded_at ASC, id ASC;"
        ))
        .map_err(|err| map_rusqlite_error(err, "preparing payments by invoice query"))?;

    let rows = stmt
        .query_map(params![invoice_id], map_payment_row)
        .map_err(|err| map_rusqlite_error(err, "querying payments by invoice"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading payment rows"))?;

    Ok(rows.into_iter().map(PaymentDto::from).collect())
}

pub fn get_payments_by_business(
    conn: &Connection,
    business_id: &str,
) -> Result<Vec<PaymentDto>, DbError> {
    let business_id = require_non_empty_id(business_id, "businessId")?;
    let mut stmt = conn
        .prepare(&format!(
            "{PAYMENT_SELECT_SQL} WHERE business_id = ?1 ORDER BY payment_date DESC, recorded_at DESC, id ASC;"
        ))
        .map_err(|err| map_rusqlite_error(err, "preparing payments by business query"))?;

    let rows = stmt
        .query_map(params![business_id], map_payment_row)
        .map_err(|err| map_rusqlite_error(err, "querying payments by business"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading payment rows"))?;

    Ok(rows.into_iter().map(PaymentDto::from).collect())
}

pub fn delete_payment(conn: &mut Connection, id: &str) -> Result<(), DbError> {
    let id = require_non_empty_id(id, "id")?.to_string();
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing = query_payment_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Payment record was not found".to_string()))?;

    tx.execute(
        "DELETE FROM payments WHERE id = ?1 AND business_id = ?2;",
        params![id, existing.business_id],
    )
    .map_err(|err| map_rusqlite_error(err, "deleting payment"))?;

    recalculate_invoice_after_payment_change(
        &tx,
        &existing.business_id,
        &existing.invoice_id,
        &updated_at,
    )?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing payment deletion"))?;

    Ok(())
}

fn recalculate_invoice_after_payment_change(
    conn: &Connection,
    business_id: &str,
    invoice_id: &str,
    updated_at: &str,
) -> Result<(), DbError> {
    let (current_status, grand_total_minor, due_date): (String, i64, Option<String>) = conn
        .query_row(
            "SELECT status, grand_total_minor, due_date
             FROM invoices
             WHERE business_id = ?1 AND id = ?2;",
            params![business_id, invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| map_rusqlite_error(err, "reading parent invoice for payment sync"))?
        .ok_or_else(|| DbError::NotFound("Parent invoice record was not found".to_string()))?;

    let mut stmt = conn
        .prepare(
            "SELECT amount_minor FROM payments
             WHERE business_id = ?1 AND invoice_id = ?2
             ORDER BY payment_date ASC, recorded_at ASC, id ASC;",
        )
        .map_err(|err| map_rusqlite_error(err, "preparing invoice payment amounts query"))?;

    let payment_amounts = stmt
        .query_map(params![business_id, invoice_id], |row| row.get::<_, i64>(0))
        .map_err(|err| map_rusqlite_error(err, "querying invoice payment amounts"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading invoice payment amounts"))?;

    let is_past_due = is_date_before_local_today(conn, due_date.as_deref())?;
    let (amount_paid_minor, outstanding_balance_minor, next_status) =
        recompute_invoice_payment_state(
            &current_status,
            grand_total_minor,
            &payment_amounts,
            is_past_due,
        )?;

    conn.execute(
        "UPDATE invoices
         SET amount_paid_minor = ?1,
             outstanding_balance_minor = ?2,
             status = ?3,
             updated_at = ?4
         WHERE business_id = ?5 AND id = ?6;",
        params![
            amount_paid_minor,
            outstanding_balance_minor,
            next_status,
            updated_at,
            business_id,
            invoice_id
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "updating invoice payment balances"))?;

    Ok(())
}

const PAYMENT_SELECT_SQL: &str = "
SELECT
    id, business_id, invoice_id, legacy_id, amount_minor,
    payment_date, payment_method, reference, notes, recorded_at
FROM payments";

fn query_payment_by_id(conn: &Connection, id: &str) -> Result<Option<PaymentRow>, DbError> {
    conn.query_row(
        &format!("{PAYMENT_SELECT_SQL} WHERE id = ?1;"),
        params![id],
        map_payment_row,
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "fetching payment by id"))
}

fn map_payment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PaymentRow> {
    Ok(PaymentRow {
        id: row.get(0)?,
        business_id: row.get(1)?,
        invoice_id: row.get(2)?,
        legacy_id: row.get(3)?,
        amount_minor: row.get(4)?,
        payment_date: row.get(5)?,
        payment_method: row.get(6)?,
        reference: row.get(7)?,
        notes: row.get(8)?,
        recorded_at: row.get(9)?,
    })
}
