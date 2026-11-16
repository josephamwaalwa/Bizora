use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::db::dto::{
    CreateInvoiceInput, InvoiceDto, InvoiceItemDto, LineItemInput, UpdateInvoiceInput,
};
use crate::db::models::{InvoiceItemRow, InvoiceRow, PaymentRow};
use crate::db::precision::{recompute_invoice_payment_state, require_non_negative};
use crate::db::repositories::{
    current_utc_iso, ensure_business_exists, is_date_before_local_today, map_rusqlite_error,
    normalize_discount_values, require_non_empty_id, require_trimmed_non_empty,
    resolve_timestamp_or_now, validate_enum, validate_iso_date, validate_json_text,
    validate_line_items, validate_optional_iso_date, validate_optional_non_empty, INVOICE_STATUSES,
};
use crate::db::DbError;

pub fn create_invoice(
    conn: &mut Connection,
    input: &CreateInvoiceInput,
) -> Result<InvoiceDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let business_id = require_non_empty_id(&input.business_id, "businessId")?.to_string();
    let legacy_id = validate_optional_non_empty(&input.legacy_id, "legacyId")?;
    let client_id = validate_optional_non_empty(&input.client_id, "clientId")?;
    let quotation_id = validate_optional_non_empty(&input.quotation_id, "quotationId")?;
    let invoice_number = require_trimmed_non_empty(&input.invoice_number, "invoiceNumber")?;
    validate_json_text(&input.client_snapshot_json, "clientSnapshotJson")?;
    validate_json_text(&input.business_snapshot_json, "businessSnapshotJson")?;
    let issue_date = validate_iso_date(&input.issue_date, "issueDate")?;
    let due_date = validate_optional_iso_date(&input.due_date, "dueDate")?;
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

    let caller_paid_minor =
        require_non_negative(input.amount_paid_minor.get(), "amountPaidMinor")?;
    if caller_paid_minor != 0 {
        return Err(DbError::InvalidInput {
            field: Some("amountPaidMinor".to_string()),
            message: "New invoices cannot start with a non-zero amountPaidMinor without recorded payments".to_string(),
        });
    }

    let caller_outstanding_minor = require_non_negative(
        input.outstanding_balance_minor.get(),
        "outstandingBalanceMinor",
    )?;
    if caller_outstanding_minor != grand_total_minor {
        return Err(DbError::InvalidInput {
            field: Some("outstandingBalanceMinor".to_string()),
            message: "New invoice outstandingBalanceMinor must match grandTotalMinor".to_string(),
        });
    }

    let requested_status = validate_enum(&input.status, &INVOICE_STATUSES, "status")?;
    if requested_status == "paid" || requested_status == "partially_paid" {
        return Err(DbError::InvalidInput {
            field: Some("status".to_string()),
            message: "New invoices without recorded payments cannot have status 'paid' or 'partially_paid'".to_string(),
        });
    }

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
    verify_client_belongs_to_business(&tx, &business_id, client_id.as_deref())?;

    let is_past_due = is_date_before_local_today(&tx, due_date.as_deref())?;
    let (amount_paid_minor, outstanding_balance_minor, status) =
        recompute_invoice_payment_state(requested_status, grand_total_minor, &[], is_past_due)?;

    let target_quote = if let Some(ref qid) = quotation_id {
        let q = load_quotation_link_state(&tx, &business_id, qid)?.ok_or_else(|| {
            DbError::ForeignKeyViolation(
                "Referenced quotation does not exist for this business".to_string(),
            )
        })?;

        if q.status == "declined" {
            return Err(DbError::InvalidInput {
                field: Some("quotationId".to_string()),
                message: "Declined quotations cannot be linked to an invoice".to_string(),
            });
        }

        ensure_quotation_not_claimed_by_other_invoice(&tx, &business_id, &q, &id)?;
        Some(q)
    } else {
        None
    };

    tx.execute(
        "INSERT INTO invoices (
            id, business_id, legacy_id, client_id, quotation_id, invoice_number,
            client_snapshot_json, business_snapshot_json, issue_date, due_date,
            currency, currency_symbol, subtotal_minor, discount_type,
            discount_percentage_ppm, discount_fixed_minor, discount_amount_minor,
            tax_name, tax_rate_ppm, tax_amount_minor, grand_total_minor,
            amount_paid_minor, outstanding_balance_minor, status,
            notes, terms, payment_instructions, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14,
            ?15, ?16, ?17,
            ?18, ?19, ?20, ?21,
            ?22, ?23, ?24,
            ?25, ?26, ?27, ?28, ?29
        );",
        params![
            id,
            business_id,
            legacy_id,
            client_id,
            quotation_id,
            invoice_number,
            input.client_snapshot_json,
            input.business_snapshot_json,
            issue_date,
            due_date,
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
            amount_paid_minor,
            outstanding_balance_minor,
            status,
            input.notes,
            input.terms,
            input.payment_instructions,
            created_at,
            updated_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "creating invoice"))?;

    insert_invoice_items(&tx, &business_id, &id, &input.items, &created_at)?;

    if let Some(q) = target_quote {
        let next_pre = q.pre_conversion_status.unwrap_or(q.status);
        tx.execute(
            "UPDATE quotations
             SET converted_invoice_id = ?1,
                 pre_conversion_status = ?2,
                 status = 'accepted',
                 updated_at = ?3
             WHERE business_id = ?4 AND id = ?5;",
            params![id, next_pre, updated_at, business_id, q.id],
        )
        .map_err(|err| map_rusqlite_error(err, "synchronizing linked quotation"))?;
    }

    let row = query_invoice_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Created invoice could not be retrieved".to_string()))?;
    let items = query_invoice_items(&tx, &id)?;
    let payments = query_invoice_payments(&tx, &id)?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing invoice creation"))?;

    Ok(InvoiceDto::from_parts(row, items, payments))
}

pub fn get_invoice_by_id(conn: &Connection, id: &str) -> Result<Option<InvoiceDto>, DbError> {
    let id = require_non_empty_id(id, "id")?;
    let Some(row) = query_invoice_by_id(conn, id)? else {
        return Ok(None);
    };
    let items = query_invoice_items(conn, id)?;
    let payments = query_invoice_payments(conn, id)?;
    Ok(Some(InvoiceDto::from_parts(row, items, payments)))
}

pub fn get_invoices_by_business(
    conn: &Connection,
    business_id: &str,
) -> Result<Vec<InvoiceDto>, DbError> {
    let business_id = require_non_empty_id(business_id, "businessId")?;
    let mut stmt = conn
        .prepare(&format!(
            "{INVOICE_SELECT_SQL} WHERE business_id = ?1 ORDER BY issue_date DESC, created_at DESC, id ASC;"
        ))
        .map_err(|err| map_rusqlite_error(err, "preparing invoices query"))?;

    let rows = stmt
        .query_map(params![business_id], map_invoice_row)
        .map_err(|err| map_rusqlite_error(err, "querying invoices"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading invoice rows"))?;

    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let items = query_invoice_items(conn, &row.id)?;
        let payments = query_invoice_payments(conn, &row.id)?;
        result.push(InvoiceDto::from_parts(row, items, payments));
    }

    Ok(result)
}

pub fn get_invoice_items(
    conn: &Connection,
    invoice_id: &str,
) -> Result<Vec<InvoiceItemDto>, DbError> {
    let invoice_id = require_non_empty_id(invoice_id, "invoiceId")?;
    let rows = query_invoice_items(conn, invoice_id)?;
    Ok(rows.into_iter().map(InvoiceItemDto::from).collect())
}

pub fn update_invoice(
    conn: &mut Connection,
    input: &UpdateInvoiceInput,
) -> Result<InvoiceDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let business_id = require_non_empty_id(&input.business_id, "businessId")?.to_string();
    let client_id = validate_optional_non_empty(&input.client_id, "clientId")?;
    let quotation_id = validate_optional_non_empty(&input.quotation_id, "quotationId")?;
    let invoice_number = require_trimmed_non_empty(&input.invoice_number, "invoiceNumber")?;
    validate_json_text(&input.client_snapshot_json, "clientSnapshotJson")?;
    validate_json_text(&input.business_snapshot_json, "businessSnapshotJson")?;
    let issue_date = validate_iso_date(&input.issue_date, "issueDate")?;
    let due_date = validate_optional_iso_date(&input.due_date, "dueDate")?;
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
    let _ = require_non_negative(input.amount_paid_minor.get(), "amountPaidMinor")?;
    let _ = require_non_negative(
        input.outstanding_balance_minor.get(),
        "outstandingBalanceMinor",
    )?;
    let requested_status = validate_enum(&input.status, &INVOICE_STATUSES, "status")?;

    validate_line_items(&input.items)?;
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing = query_invoice_by_id(&tx, &id)?
        .filter(|inv| inv.business_id == business_id)
        .ok_or_else(|| DbError::NotFound("Invoice record was not found".to_string()))?;

    verify_client_belongs_to_business(&tx, &business_id, client_id.as_deref())?;

    let payment_amounts = query_invoice_payment_amounts(&tx, &business_id, &id)?;
    let is_past_due = is_date_before_local_today(&tx, due_date.as_deref())?;
    let workflow_base_status = match requested_status {
        "draft" => "draft",
        "sent" | "overdue" => requested_status,
        _ => {
            if existing.status == "draft" {
                "draft"
            } else {
                "sent"
            }
        }
    };
    let (amount_paid_minor, outstanding_balance_minor, status) =
        recompute_invoice_payment_state(
            workflow_base_status,
            grand_total_minor,
            &payment_amounts,
            is_past_due,
        )?;

    let target_quote = if let Some(ref qid) = quotation_id {
        let q = load_quotation_link_state(&tx, &business_id, qid)?.ok_or_else(|| {
            DbError::ForeignKeyViolation(
                "Referenced quotation does not exist for this business".to_string(),
            )
        })?;

        let was_already_linked = existing.quotation_id.as_deref() == Some(qid.as_str())
            || q.converted_invoice_id.as_deref() == Some(id.as_str());

        if !was_already_linked && q.status == "declined" {
            return Err(DbError::InvalidInput {
                field: Some("quotationId".to_string()),
                message: "Declined quotations cannot be linked to an invoice".to_string(),
            });
        }

        ensure_quotation_not_claimed_by_other_invoice(&tx, &business_id, &q, &id)?;
        Some(q)
    } else {
        None
    };

    tx.execute(
        "UPDATE invoices SET
            client_id = ?1,
            quotation_id = ?2,
            invoice_number = ?3,
            client_snapshot_json = ?4,
            business_snapshot_json = ?5,
            issue_date = ?6,
            due_date = ?7,
            currency = ?8,
            currency_symbol = ?9,
            subtotal_minor = ?10,
            discount_type = ?11,
            discount_percentage_ppm = ?12,
            discount_fixed_minor = ?13,
            discount_amount_minor = ?14,
            tax_name = ?15,
            tax_rate_ppm = ?16,
            tax_amount_minor = ?17,
            grand_total_minor = ?18,
            amount_paid_minor = ?19,
            outstanding_balance_minor = ?20,
            status = ?21,
            notes = ?22,
            terms = ?23,
            payment_instructions = ?24,
            updated_at = ?25
         WHERE id = ?26 AND business_id = ?27;",
        params![
            client_id,
            quotation_id,
            invoice_number,
            input.client_snapshot_json,
            input.business_snapshot_json,
            issue_date,
            due_date,
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
            amount_paid_minor,
            outstanding_balance_minor,
            status,
            input.notes,
            input.terms,
            input.payment_instructions,
            updated_at,
            id,
            business_id
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "updating invoice"))?;

    tx.execute(
        "DELETE FROM invoice_items WHERE business_id = ?1 AND invoice_id = ?2;",
        params![business_id, id],
    )
    .map_err(|err| map_rusqlite_error(err, "clearing existing invoice items"))?;

    insert_invoice_items(&tx, &business_id, &id, &input.items, &existing.created_at)?;

    // Detach or re-link any quotation previously pointing to this invoice that is no longer linked
    reconcile_unlinked_quotations_for_invoice(
        &tx,
        &business_id,
        &id,
        existing.quotation_id.as_deref(),
        quotation_id.as_deref(),
        &updated_at,
    )?;

    if let Some(q) = target_quote {
        if q.status == "declined" {
            if q.converted_invoice_id.as_deref() != Some(id.as_str()) {
                tx.execute(
                    "UPDATE quotations
                     SET converted_invoice_id = ?1, updated_at = ?2
                     WHERE business_id = ?3 AND id = ?4;",
                    params![id, updated_at, business_id, q.id],
                )
                .map_err(|err| map_rusqlite_error(err, "linking quotation to invoice"))?;
            }
        } else {
            let next_pre = q.pre_conversion_status.unwrap_or_else(|| q.status.clone());
            tx.execute(
                "UPDATE quotations
                 SET converted_invoice_id = ?1,
                     pre_conversion_status = ?2,
                     status = 'accepted',
                     updated_at = ?3
                 WHERE business_id = ?4 AND id = ?5;",
                params![id, next_pre, updated_at, business_id, q.id],
            )
            .map_err(|err| map_rusqlite_error(err, "synchronizing quotation conversion state"))?;
        }
    }

    let row = query_invoice_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Updated invoice was not found".to_string()))?;
    let items = query_invoice_items(&tx, &id)?;
    let payments = query_invoice_payments(&tx, &id)?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing invoice update"))?;

    Ok(InvoiceDto::from_parts(row, items, payments))
}

/// Safely deletes an invoice inside an IMMEDIATE transaction:
/// clears/re-links `quotations.converted_invoice_id` and restores `pre_conversion_status`
/// before deleting the invoice (which cascades `invoice_items` and `payments`).
pub fn delete_invoice(conn: &mut Connection, id: &str) -> Result<(), DbError> {
    let id = require_non_empty_id(id, "id")?.to_string();
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let existing = query_invoice_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Invoice record was not found".to_string()))?;

    reconcile_unlinked_quotations_for_invoice(
        &tx,
        &existing.business_id,
        &id,
        existing.quotation_id.as_deref(),
        None,
        &updated_at,
    )?;

    tx.execute(
        "DELETE FROM invoices WHERE id = ?1 AND business_id = ?2;",
        params![id, existing.business_id],
    )
    .map_err(|err| map_rusqlite_error(err, "deleting invoice"))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing invoice deletion"))?;

    Ok(())
}

struct QuotationLinkState {
    id: String,
    status: String,
    expiry_date: Option<String>,
    pre_conversion_status: Option<String>,
    converted_invoice_id: Option<String>,
}

fn load_quotation_link_state(
    conn: &Connection,
    business_id: &str,
    quotation_id: &str,
) -> Result<Option<QuotationLinkState>, DbError> {
    conn.query_row(
        "SELECT id, status, expiry_date, pre_conversion_status, converted_invoice_id
         FROM quotations
         WHERE business_id = ?1 AND id = ?2;",
        params![business_id, quotation_id],
        |row| {
            Ok(QuotationLinkState {
                id: row.get(0)?,
                status: row.get(1)?,
                expiry_date: row.get(2)?,
                pre_conversion_status: row.get(3)?,
                converted_invoice_id: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "loading quotation link state"))
}

fn verify_client_belongs_to_business(
    conn: &Connection,
    business_id: &str,
    client_id: Option<&str>,
) -> Result<(), DbError> {
    if let Some(cid) = client_id {
        let client_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clients WHERE business_id = ?1 AND id = ?2;",
                params![business_id, cid],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying invoice client"))?;
        if client_exists == 0 {
            return Err(DbError::ForeignKeyViolation(
                "Referenced client does not exist for this business".to_string(),
            ));
        }
    }
    Ok(())
}

fn ensure_quotation_not_claimed_by_other_invoice(
    conn: &Connection,
    business_id: &str,
    quote: &QuotationLinkState,
    current_invoice_id: &str,
) -> Result<(), DbError> {
    let conflicting_invoice_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoices
             WHERE business_id = ?1 AND quotation_id = ?2 AND id != ?3;",
            params![business_id, quote.id, current_invoice_id],
            |row| row.get(0),
        )
        .map_err(|err| map_rusqlite_error(err, "checking quotation invoice conflict"))?;

    if conflicting_invoice_count > 0 {
        return Err(DbError::UniqueConstraint(
            "Selected quotation is already linked to another invoice".to_string(),
        ));
    }

    if let Some(ref converted_id) = quote.converted_invoice_id {
        if converted_id != current_invoice_id {
            let live_target_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM invoices
                     WHERE business_id = ?1 AND id = ?2 AND id != ?3;",
                    params![business_id, converted_id, current_invoice_id],
                    |row| row.get(0),
                )
                .map_err(|err| map_rusqlite_error(err, "checking converted invoice link"))?;
            if live_target_count > 0 {
                return Err(DbError::UniqueConstraint(
                    "Selected quotation is already linked to another invoice".to_string(),
                ));
            }
        }
    }

    Ok(())
}

fn reconcile_unlinked_quotations_for_invoice(
    conn: &Connection,
    business_id: &str,
    invoice_id: &str,
    previous_quotation_id: Option<&str>,
    keep_quotation_id: Option<&str>,
    updated_at: &str,
) -> Result<(), DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, status, expiry_date, pre_conversion_status, converted_invoice_id
             FROM quotations
             WHERE business_id = ?1
               AND (converted_invoice_id = ?2 OR (?3 IS NOT NULL AND id = ?3));",
        )
        .map_err(|err| map_rusqlite_error(err, "preparing affected quotations query"))?;

    let affected = stmt
        .query_map(
            params![business_id, invoice_id, previous_quotation_id],
            |row| {
                Ok(QuotationLinkState {
                    id: row.get(0)?,
                    status: row.get(1)?,
                    expiry_date: row.get(2)?,
                    pre_conversion_status: row.get(3)?,
                    converted_invoice_id: row.get(4)?,
                })
            },
        )
        .map_err(|err| map_rusqlite_error(err, "querying affected quotations"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading affected quotation rows"))?;

    for quote in affected {
        if keep_quotation_id == Some(quote.id.as_str()) {
            continue;
        }

        // Preserve historical multi-invoice tolerance from Revision 2: if another remaining
        // invoice still references this quotation, re-point converted_invoice_id to it.
        let other_invoice_id: Option<String> = conn
            .query_row(
                "SELECT id FROM invoices
                 WHERE business_id = ?1 AND quotation_id = ?2 AND id != ?3
                 ORDER BY created_at DESC, id ASC
                 LIMIT 1;",
                params![business_id, quote.id, invoice_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| map_rusqlite_error(err, "checking remaining quotation invoices"))?;

        if let Some(other_id) = other_invoice_id {
            conn.execute(
                "UPDATE quotations
                 SET converted_invoice_id = ?1, updated_at = ?2
                 WHERE business_id = ?3 AND id = ?4;",
                params![other_id, updated_at, business_id, quote.id],
            )
            .map_err(|err| map_rusqlite_error(err, "repointing quotation converted_invoice_id"))?;
        } else {
            let restored_status = restore_unlinked_quotation_status(
                conn,
                &quote.status,
                quote.expiry_date.as_deref(),
                quote.pre_conversion_status.as_deref(),
            )?;

            conn.execute(
                "UPDATE quotations
                 SET converted_invoice_id = NULL,
                     pre_conversion_status = NULL,
                     status = ?1,
                     updated_at = ?2
                 WHERE business_id = ?3 AND id = ?4;",
                params![restored_status, updated_at, business_id, quote.id],
            )
            .map_err(|err| map_rusqlite_error(err, "restoring quotation status on unlink"))?;
        }
    }

    Ok(())
}

pub fn restore_unlinked_quotation_status(
    conn: &Connection,
    status: &str,
    expiry_date: Option<&str>,
    pre_conversion_status: Option<&str>,
) -> Result<&'static str, DbError> {
    if status == "declined" {
        return Ok("declined");
    }
    if status != "accepted" {
        return Ok(match status {
            "draft" => "draft",
            "sent" => "sent",
            "expired" => "expired",
            _ => "sent",
        });
    }

    if let Some(pre) = pre_conversion_status {
        return match pre {
            "declined" => Ok("declined"),
            "draft" => Ok("draft"),
            "accepted" => Ok("accepted"),
            _ => {
                if is_date_before_local_today(conn, expiry_date)? {
                    Ok("expired")
                } else {
                    Ok("sent")
                }
            }
        };
    }

    if is_date_before_local_today(conn, expiry_date)? {
        Ok("expired")
    } else {
        Ok("sent")
    }
}

fn insert_invoice_items(
    conn: &Connection,
    business_id: &str,
    invoice_id: &str,
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
            "INSERT INTO invoice_items (
                id, business_id, invoice_id, legacy_id, sort_order,
                description, quantity_scaled, unit_price_scaled, total_minor, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
            params![
                item.id,
                business_id,
                invoice_id,
                item.legacy_id.as_deref().map(str::trim),
                sort_order,
                item.description,
                item.quantity_scaled.get(),
                item.unit_price_scaled.get(),
                item.total_minor.get(),
                item_created_at
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "inserting invoice line item"))?;
    }

    Ok(())
}

const INVOICE_SELECT_SQL: &str = "
SELECT
    id, business_id, legacy_id, client_id, quotation_id, invoice_number,
    client_snapshot_json, business_snapshot_json, issue_date, due_date,
    currency, currency_symbol, subtotal_minor, discount_type,
    discount_percentage_ppm, discount_fixed_minor, discount_amount_minor,
    tax_name, tax_rate_ppm, tax_amount_minor, grand_total_minor,
    amount_paid_minor, outstanding_balance_minor, status,
    notes, terms, payment_instructions, created_at, updated_at
FROM invoices";

fn query_invoice_by_id(conn: &Connection, id: &str) -> Result<Option<InvoiceRow>, DbError> {
    conn.query_row(
        &format!("{INVOICE_SELECT_SQL} WHERE id = ?1;"),
        params![id],
        map_invoice_row,
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "fetching invoice by id"))
}

fn query_invoice_items(conn: &Connection, invoice_id: &str) -> Result<Vec<InvoiceItemRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT
                id, business_id, invoice_id, legacy_id, sort_order,
                description, quantity_scaled, unit_price_scaled, total_minor, created_at
             FROM invoice_items
             WHERE invoice_id = ?1
             ORDER BY sort_order ASC, rowid ASC;",
        )
        .map_err(|err| map_rusqlite_error(err, "preparing invoice items query"))?;

    let rows = stmt
        .query_map(params![invoice_id], |row| {
            Ok(InvoiceItemRow {
                id: row.get(0)?,
                business_id: row.get(1)?,
                invoice_id: row.get(2)?,
                legacy_id: row.get(3)?,
                sort_order: row.get(4)?,
                description: row.get(5)?,
                quantity_scaled: row.get(6)?,
                unit_price_scaled: row.get(7)?,
                total_minor: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|err| map_rusqlite_error(err, "querying invoice items"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading invoice item rows"))?;

    Ok(rows)
}

fn query_invoice_payment_amounts(
    conn: &Connection,
    business_id: &str,
    invoice_id: &str,
) -> Result<Vec<i64>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT amount_minor FROM payments
             WHERE business_id = ?1 AND invoice_id = ?2
             ORDER BY payment_date ASC, recorded_at ASC, id ASC;",
        )
        .map_err(|err| map_rusqlite_error(err, "preparing invoice payment amounts query"))?;

    let amounts = stmt
        .query_map(params![business_id, invoice_id], |row| row.get::<_, i64>(0))
        .map_err(|err| map_rusqlite_error(err, "querying invoice payment amounts"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading invoice payment amounts"))?;

    Ok(amounts)
}

fn query_invoice_payments(conn: &Connection, invoice_id: &str) -> Result<Vec<PaymentRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT
                id, business_id, invoice_id, legacy_id, amount_minor,
                payment_date, payment_method, reference, notes, recorded_at
             FROM payments
             WHERE invoice_id = ?1
             ORDER BY payment_date ASC, recorded_at ASC, id ASC;",
        )
        .map_err(|err| map_rusqlite_error(err, "preparing invoice payments query"))?;

    let rows = stmt
        .query_map(params![invoice_id], |row| {
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
        })
        .map_err(|err| map_rusqlite_error(err, "querying invoice payments"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_rusqlite_error(err, "reading invoice payment rows"))?;

    Ok(rows)
}

fn map_invoice_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InvoiceRow> {
    Ok(InvoiceRow {
        id: row.get(0)?,
        business_id: row.get(1)?,
        legacy_id: row.get(2)?,
        client_id: row.get(3)?,
        quotation_id: row.get(4)?,
        invoice_number: row.get(5)?,
        client_snapshot_json: row.get(6)?,
        business_snapshot_json: row.get(7)?,
        issue_date: row.get(8)?,
        due_date: row.get(9)?,
        currency: row.get(10)?,
        currency_symbol: row.get(11)?,
        subtotal_minor: row.get(12)?,
        discount_type: row.get(13)?,
        discount_percentage_ppm: row.get(14)?,
        discount_fixed_minor: row.get(15)?,
        discount_amount_minor: row.get(16)?,
        tax_name: row.get(17)?,
        tax_rate_ppm: row.get(18)?,
        tax_amount_minor: row.get(19)?,
        grand_total_minor: row.get(20)?,
        amount_paid_minor: row.get(21)?,
        outstanding_balance_minor: row.get(22)?,
        status: row.get(23)?,
        notes: row.get(24)?,
        terms: row.get(25)?,
        payment_instructions: row.get(26)?,
        created_at: row.get(27)?,
        updated_at: row.get(28)?,
    })
}
