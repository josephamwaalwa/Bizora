use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::db::dto::{BusinessDto, CreateBusinessInput, UpdateBusinessInput};
use crate::db::models::BusinessRow;
use crate::db::precision::{require_non_negative, require_positive};
use crate::db::repositories::{
    current_utc_iso, map_rusqlite_error, require_non_empty_id, require_trimmed_non_empty,
    resolve_timestamp_or_now, validate_optional_non_empty,
};
use crate::db::DbError;

pub fn create_business(
    conn: &mut Connection,
    input: &CreateBusinessInput,
) -> Result<BusinessDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let legacy_id = validate_optional_non_empty(&input.legacy_id, "legacyId")?;
    let owner_profile_id =
        validate_optional_non_empty(&input.owner_profile_id, "ownerProfileId")?;
    let name = require_trimmed_non_empty(&input.name, "name")?;
    let logo_asset_id = validate_optional_non_empty(&input.logo_asset_id, "logoAssetId")?;
    let default_currency = require_trimmed_non_empty(&input.default_currency, "defaultCurrency")?;
    let currency_symbol = require_trimmed_non_empty(&input.currency_symbol, "currencySymbol")?;
    let default_tax_name = require_trimmed_non_empty(&input.default_tax_name, "defaultTaxName")?;
    let quote_prefix = require_trimmed_non_empty(&input.quote_prefix, "quotePrefix")?;
    let invoice_prefix = require_trimmed_non_empty(&input.invoice_prefix, "invoicePrefix")?;

    let default_tax_rate_ppm =
        require_non_negative(input.default_tax_rate_ppm.get(), "defaultTaxRatePpm")?;
    let next_quote_number = require_positive(input.next_quote_number.get(), "nextQuoteNumber")?;
    let next_invoice_number =
        require_positive(input.next_invoice_number.get(), "nextInvoiceNumber")?;

    let created_at = resolve_timestamp_or_now(conn, &input.created_at, "createdAt")?;
    let updated_at = match &input.updated_at {
        Some(ts) => resolve_timestamp_or_now(conn, &Some(ts.clone()), "updatedAt")?,
        None => created_at.clone(),
    };

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    tx.execute(
        "INSERT INTO businesses (
            id, legacy_id, owner_profile_id, name, tagline,
            logo_asset_id, logo_url_fallback, email, phone, address,
            city, country, postal_code, website, tax_number,
            registration_number, default_currency, currency_symbol,
            default_tax_name, default_tax_rate_ppm, is_tax_enabled,
            quote_prefix, invoice_prefix, next_quote_number, next_invoice_number,
            default_terms_quotation, default_terms_invoice, default_notes,
            bank_name, account_name, account_number, branch_code,
            account_type, swift_code, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14, ?15,
            ?16, ?17, ?18,
            ?19, ?20, ?21,
            ?22, ?23, ?24, ?25,
            ?26, ?27, ?28,
            ?29, ?30, ?31, ?32,
            ?33, ?34, ?35, ?36
        );",
        params![
            id,
            legacy_id,
            owner_profile_id,
            name,
            input.tagline,
            logo_asset_id,
            input.logo_url_fallback,
            input.email,
            input.phone,
            input.address,
            input.city,
            input.country,
            input.postal_code,
            input.website,
            input.tax_number,
            input.registration_number,
            default_currency,
            currency_symbol,
            default_tax_name,
            default_tax_rate_ppm,
            if input.is_tax_enabled { 1_i64 } else { 0_i64 },
            quote_prefix,
            invoice_prefix,
            next_quote_number,
            next_invoice_number,
            input.default_terms_quotation,
            input.default_terms_invoice,
            input.default_notes,
            input.bank_name,
            input.account_name,
            input.account_number,
            input.branch_code,
            input.account_type,
            input.swift_code,
            created_at,
            updated_at
        ],
    )
    .map_err(|err| map_rusqlite_error(err, "creating business"))?;

    let row = query_business_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Created business could not be retrieved".to_string()))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing business creation"))?;

    Ok(BusinessDto::from(row))
}

pub fn get_business_by_id(conn: &Connection, id: &str) -> Result<Option<BusinessDto>, DbError> {
    let id = require_non_empty_id(id, "id")?;
    Ok(query_business_by_id(conn, id)?.map(BusinessDto::from))
}

pub fn get_businesses(
    conn: &Connection,
    owner_profile_id: Option<&str>,
) -> Result<Vec<BusinessDto>, DbError> {
    if let Some(raw_owner) = owner_profile_id {
        let owner_id = require_non_empty_id(raw_owner, "ownerProfileId")?;
        let mut stmt = conn
            .prepare(&format!(
                "{BUSINESS_SELECT_SQL} WHERE owner_profile_id = ?1 ORDER BY created_at ASC, id ASC;"
            ))
            .map_err(|err| map_rusqlite_error(err, "preparing businesses by profile query"))?;

        let rows = stmt
            .query_map(params![owner_id], map_row)
            .map_err(|err| map_rusqlite_error(err, "querying businesses by profile"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| map_rusqlite_error(err, "reading business rows"))?;

        Ok(rows.into_iter().map(BusinessDto::from).collect())
    } else {
        let mut stmt = conn
            .prepare(&format!(
                "{BUSINESS_SELECT_SQL} ORDER BY created_at ASC, id ASC;"
            ))
            .map_err(|err| map_rusqlite_error(err, "preparing all businesses query"))?;

        let rows = stmt
            .query_map([], map_row)
            .map_err(|err| map_rusqlite_error(err, "querying businesses"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| map_rusqlite_error(err, "reading business rows"))?;

        Ok(rows.into_iter().map(BusinessDto::from).collect())
    }
}

pub fn update_business(
    conn: &mut Connection,
    input: &UpdateBusinessInput,
) -> Result<BusinessDto, DbError> {
    let id = require_non_empty_id(&input.id, "id")?.to_string();
    let owner_profile_id =
        validate_optional_non_empty(&input.owner_profile_id, "ownerProfileId")?;
    let name = require_trimmed_non_empty(&input.name, "name")?;
    let logo_asset_id = validate_optional_non_empty(&input.logo_asset_id, "logoAssetId")?;
    let default_currency = require_trimmed_non_empty(&input.default_currency, "defaultCurrency")?;
    let currency_symbol = require_trimmed_non_empty(&input.currency_symbol, "currencySymbol")?;
    let default_tax_name = require_trimmed_non_empty(&input.default_tax_name, "defaultTaxName")?;
    let quote_prefix = require_trimmed_non_empty(&input.quote_prefix, "quotePrefix")?;
    let invoice_prefix = require_trimmed_non_empty(&input.invoice_prefix, "invoicePrefix")?;

    let default_tax_rate_ppm =
        require_non_negative(input.default_tax_rate_ppm.get(), "defaultTaxRatePpm")?;
    let next_quote_number = require_positive(input.next_quote_number.get(), "nextQuoteNumber")?;
    let next_invoice_number =
        require_positive(input.next_invoice_number.get(), "nextInvoiceNumber")?;
    let updated_at = current_utc_iso(conn)?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    if let Some(ref asset_id) = logo_asset_id {
        let asset_exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM business_assets WHERE business_id = ?1 AND id = ?2;",
                params![id, asset_id],
                |row| row.get(0),
            )
            .map_err(|err| map_rusqlite_error(err, "verifying business logo asset"))?;
        if asset_exists == 0 {
            return Err(DbError::ForeignKeyViolation(
                "Referenced logo asset does not exist for this business".to_string(),
            ));
        }
    }

    let changed = tx
        .execute(
            "UPDATE businesses SET
                owner_profile_id = ?1,
                name = ?2,
                tagline = ?3,
                logo_asset_id = ?4,
                logo_url_fallback = ?5,
                email = ?6,
                phone = ?7,
                address = ?8,
                city = ?9,
                country = ?10,
                postal_code = ?11,
                website = ?12,
                tax_number = ?13,
                registration_number = ?14,
                default_currency = ?15,
                currency_symbol = ?16,
                default_tax_name = ?17,
                default_tax_rate_ppm = ?18,
                is_tax_enabled = ?19,
                quote_prefix = ?20,
                invoice_prefix = ?21,
                next_quote_number = ?22,
                next_invoice_number = ?23,
                default_terms_quotation = ?24,
                default_terms_invoice = ?25,
                default_notes = ?26,
                bank_name = ?27,
                account_name = ?28,
                account_number = ?29,
                branch_code = ?30,
                account_type = ?31,
                swift_code = ?32,
                updated_at = ?33
             WHERE id = ?34;",
            params![
                owner_profile_id,
                name,
                input.tagline,
                logo_asset_id,
                input.logo_url_fallback,
                input.email,
                input.phone,
                input.address,
                input.city,
                input.country,
                input.postal_code,
                input.website,
                input.tax_number,
                input.registration_number,
                default_currency,
                currency_symbol,
                default_tax_name,
                default_tax_rate_ppm,
                if input.is_tax_enabled { 1_i64 } else { 0_i64 },
                quote_prefix,
                invoice_prefix,
                next_quote_number,
                next_invoice_number,
                input.default_terms_quotation,
                input.default_terms_invoice,
                input.default_notes,
                input.bank_name,
                input.account_name,
                input.account_number,
                input.branch_code,
                input.account_type,
                input.swift_code,
                updated_at,
                id
            ],
        )
        .map_err(|err| map_rusqlite_error(err, "updating business"))?;

    if changed == 0 {
        return Err(DbError::NotFound("Business record was not found".to_string()));
    }

    let row = query_business_by_id(&tx, &id)?
        .ok_or_else(|| DbError::NotFound("Updated business was not found".to_string()))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing business update"))?;

    Ok(BusinessDto::from(row))
}

/// Safely deletes a business and its dependent records within an IMMEDIATE transaction
/// by breaking deferred circular references (`logo_asset_id`, `converted_invoice_id`,
/// `quotation_id`) before cascading the business row deletion.
pub fn delete_business(conn: &mut Connection, id: &str) -> Result<(), DbError> {
    let id = require_non_empty_id(id, "id")?.to_string();

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| DbError::TransactionFailed(format!("Failed to begin transaction: {err}")))?;

    let exists: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM businesses WHERE id = ?1;",
            params![id],
            |row| row.get(0),
        )
        .map_err(|err| map_rusqlite_error(err, "checking business existence"))?;

    if exists == 0 {
        return Err(DbError::NotFound("Business record was not found".to_string()));
    }

    tx.execute(
        "UPDATE businesses SET logo_asset_id = NULL WHERE id = ?1;",
        params![id],
    )
    .map_err(|err| map_rusqlite_error(err, "clearing business logo link"))?;

    tx.execute(
        "UPDATE quotations SET converted_invoice_id = NULL WHERE business_id = ?1;",
        params![id],
    )
    .map_err(|err| map_rusqlite_error(err, "clearing quotation conversion links"))?;

    tx.execute(
        "UPDATE invoices SET quotation_id = NULL WHERE business_id = ?1;",
        params![id],
    )
    .map_err(|err| map_rusqlite_error(err, "clearing invoice quotation links"))?;

    tx.execute("DELETE FROM businesses WHERE id = ?1;", params![id])
        .map_err(|err| map_rusqlite_error(err, "deleting business"))?;

    tx.commit()
        .map_err(|err| map_rusqlite_error(err, "committing business deletion"))?;

    Ok(())
}

const BUSINESS_SELECT_SQL: &str = "
SELECT
    id, legacy_id, owner_profile_id, name, tagline,
    logo_asset_id, logo_url_fallback, email, phone, address,
    city, country, postal_code, website, tax_number,
    registration_number, default_currency, currency_symbol,
    default_tax_name, default_tax_rate_ppm, is_tax_enabled,
    quote_prefix, invoice_prefix, next_quote_number, next_invoice_number,
    default_terms_quotation, default_terms_invoice, default_notes,
    bank_name, account_name, account_number, branch_code,
    account_type, swift_code, created_at, updated_at
FROM businesses";

fn query_business_by_id(conn: &Connection, id: &str) -> Result<Option<BusinessRow>, DbError> {
    conn.query_row(
        &format!("{BUSINESS_SELECT_SQL} WHERE id = ?1;"),
        params![id],
        map_row,
    )
    .optional()
    .map_err(|err| map_rusqlite_error(err, "fetching business by id"))
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BusinessRow> {
    Ok(BusinessRow {
        id: row.get(0)?,
        legacy_id: row.get(1)?,
        owner_profile_id: row.get(2)?,
        name: row.get(3)?,
        tagline: row.get(4)?,
        logo_asset_id: row.get(5)?,
        logo_url_fallback: row.get(6)?,
        email: row.get(7)?,
        phone: row.get(8)?,
        address: row.get(9)?,
        city: row.get(10)?,
        country: row.get(11)?,
        postal_code: row.get(12)?,
        website: row.get(13)?,
        tax_number: row.get(14)?,
        registration_number: row.get(15)?,
        default_currency: row.get(16)?,
        currency_symbol: row.get(17)?,
        default_tax_name: row.get(18)?,
        default_tax_rate_ppm: row.get(19)?,
        is_tax_enabled: row.get(20)?,
        quote_prefix: row.get(21)?,
        invoice_prefix: row.get(22)?,
        next_quote_number: row.get(23)?,
        next_invoice_number: row.get(24)?,
        default_terms_quotation: row.get(25)?,
        default_terms_invoice: row.get(26)?,
        default_notes: row.get(27)?,
        bank_name: row.get(28)?,
        account_name: row.get(29)?,
        account_number: row.get(30)?,
        branch_code: row.get(31)?,
        account_type: row.get(32)?,
        swift_code: row.get(33)?,
        created_at: row.get(34)?,
        updated_at: row.get(35)?,
    })
}
