pub mod activity_repository;
pub mod asset_repository;
pub mod business_repository;
pub mod client_repository;
pub mod invoice_repository;
pub mod local_profile_repository;
pub mod payment_repository;
pub mod quotation_repository;
pub mod settings_repository;

use std::collections::HashSet;

use rusqlite::{params, Connection, ErrorCode};

use super::dto::LineItemInput;
use super::precision::require_non_negative;
use super::DbError;

pub const QUOTATION_STATUSES: [&str; 5] = ["draft", "sent", "accepted", "declined", "expired"];
pub const INVOICE_STATUSES: [&str; 5] = ["draft", "sent", "partially_paid", "paid", "overdue"];
pub const DISCOUNT_TYPES: [&str; 2] = ["percentage", "fixed"];
pub const PAYMENT_METHODS: [&str; 7] = [
    "bank_transfer",
    "cash",
    "credit_card",
    "eft",
    "mobile_money",
    "cheque",
    "other",
];
pub const ACTIVITY_TYPES: [&str; 8] = [
    "quote_created",
    "quote_converted",
    "quote_status",
    "invoice_created",
    "payment_recorded",
    "invoice_status",
    "client_created",
    "settings_updated",
];
pub const ASSET_SOURCE_TYPES: [&str; 3] = ["data_url", "file", "external_url"];

pub fn require_non_empty_id<'a>(value: &'a str, field: &str) -> Result<&'a str, DbError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed != value {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} must be a non-empty identifier without surrounding spaces"),
        });
    }
    Ok(trimmed)
}

pub fn require_trimmed_non_empty(value: &str, field: &str) -> Result<String, DbError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} is required and cannot be blank"),
        });
    }
    Ok(trimmed.to_string())
}

pub fn validate_optional_non_empty(
    value: &Option<String>,
    field: &str,
) -> Result<Option<String>, DbError> {
    match value {
        None => Ok(None),
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(DbError::InvalidInput {
                    field: Some(field.to_string()),
                    message: format!("{field} must be null or non-empty"),
                });
            }
            Ok(Some(trimmed.to_string()))
        }
    }
}

pub fn validate_enum<'a>(
    value: &'a str,
    allowed: &[&str],
    field: &str,
) -> Result<&'a str, DbError> {
    if allowed.contains(&value) {
        Ok(value)
    } else {
        Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("Invalid {field} value '{value}'"),
        })
    }
}

pub fn validate_json_text(value: &str, field: &str) -> Result<(), DbError> {
    serde_json::from_str::<serde_json::Value>(value).map_err(|_| DbError::InvalidInput {
        field: Some(field.to_string()),
        message: format!("{field} must contain valid JSON"),
    })?;
    Ok(())
}

pub fn current_utc_iso(conn: &Connection) -> Result<String, DbError> {
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');", [], |row| {
        row.get(0)
    })
    .map_err(|err| map_rusqlite_error(err, "generating UTC timestamp"))
}

pub fn resolve_timestamp_or_now(
    conn: &Connection,
    provided: &Option<String>,
    field: &str,
) -> Result<String, DbError> {
    match provided {
        Some(raw) => require_trimmed_non_empty(raw, field),
        None => current_utc_iso(conn),
    }
}

fn is_leap_year(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn days_in_month(year: u32, month: u32) -> Option<u32> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 => Some(if is_leap_year(year) { 29 } else { 28 }),
        _ => None,
    }
}

fn parse_ascii_digits(bytes: &[u8]) -> Option<u32> {
    let mut acc: u32 = 0;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        acc = acc.checked_mul(10)?.checked_add((b - b'0') as u32)?;
    }
    Some(acc)
}

pub fn validate_iso_date(value: &str, field: &str) -> Result<String, DbError> {
    let trimmed = value.trim();
    if !trimmed.is_ascii() || trimmed.len() != 10 {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} must be a valid date in YYYY-MM-DD format"),
        });
    }

    let bytes = trimmed.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} must use '-' separators in YYYY-MM-DD format"),
        });
    }

    let year = parse_ascii_digits(&bytes[0..4]);
    let month = parse_ascii_digits(&bytes[5..7]);
    let day = parse_ascii_digits(&bytes[8..10]);

    let (Some(y), Some(m), Some(d)) = (year, month, day) else {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} must contain only ASCII digits in YYYY-MM-DD format"),
        });
    };

    if !(1..=9999).contains(&y) {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} has an out-of-range calendar year"),
        });
    }

    let Some(max_day) = days_in_month(y, m) else {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} has an invalid calendar month"),
        });
    };

    if !(1..=max_day).contains(&d) {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} has an invalid calendar day for the given month and year"),
        });
    }

    Ok(trimmed.to_string())
}

pub fn validate_optional_iso_date(
    value: &Option<String>,
    field: &str,
) -> Result<Option<String>, DbError> {
    match value {
        None => Ok(None),
        Some(raw) => validate_iso_date(raw, field).map(Some),
    }
}

pub fn is_date_before_local_today(
    conn: &Connection,
    date_str: Option<&str>,
) -> Result<bool, DbError> {
    let Some(raw) = date_str else {
        return Ok(false);
    };
    let validated = validate_iso_date(raw, "date")?;
    let is_before: i64 = conn
        .query_row(
            "SELECT CASE WHEN ?1 < date('now', 'localtime') THEN 1 ELSE 0 END;",
            params![validated],
            |row| row.get(0),
        )
        .map_err(|err| map_rusqlite_error(err, "comparing local date"))?;
    Ok(is_before == 1)
}

pub fn normalize_discount_values(
    discount_type: &str,
    discount_percentage_ppm: i64,
    discount_fixed_minor: i64,
) -> Result<(i64, i64), DbError> {
    validate_enum(discount_type, &DISCOUNT_TYPES, "discountType")?;
    if discount_type == "percentage" {
        require_non_negative(discount_percentage_ppm, "discountPercentagePpm")?;
        Ok((discount_percentage_ppm, 0))
    } else {
        require_non_negative(discount_fixed_minor, "discountFixedMinor")?;
        Ok((0, discount_fixed_minor))
    }
}

pub fn validate_line_items(items: &[LineItemInput]) -> Result<(), DbError> {
    let mut seen_ids = HashSet::with_capacity(items.len());
    for (idx, item) in items.iter().enumerate() {
        let id = require_non_empty_id(&item.id, "items.id")?;
        if !seen_ids.insert(id.to_string()) {
            return Err(DbError::DuplicateId(format!(
                "Duplicate line item identifier at position {idx}"
            )));
        }
        let _ = validate_optional_non_empty(&item.legacy_id, "items.legacyId")?;
        require_non_negative(item.quantity_scaled.get(), "items.quantityScaled")?;
        require_non_negative(item.unit_price_scaled.get(), "items.unitPriceScaled")?;
        require_non_negative(item.total_minor.get(), "items.totalMinor")?;
    }
    Ok(())
}

pub fn ensure_business_exists(conn: &Connection, business_id: &str) -> Result<(), DbError> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM businesses WHERE id = ?1;",
            params![business_id],
            |row| row.get(0),
        )
        .map_err(|err| map_rusqlite_error(err, "verifying parent business"))?;
    if exists == 0 {
        return Err(DbError::ForeignKeyViolation(
            "Referenced business record does not exist".to_string(),
        ));
    }
    Ok(())
}

pub fn map_rusqlite_error(err: rusqlite::Error, context: &str) -> DbError {
    if let rusqlite::Error::SqliteFailure(ffi_err, ref msg_opt) = err {
        let detail = msg_opt.as_deref().unwrap_or("");
        match ffi_err.code {
            ErrorCode::ConstraintViolation => {
                if detail.contains("quotation_number") || detail.contains("invoice_number") {
                    return DbError::DuplicateDocumentNumber(
                        "A document with this number already exists for the business".to_string(),
                    );
                }
                if detail.contains("PRIMARY KEY constraint failed")
                    || detail.ends_with(".id")
                    || detail.contains(".id,")
                {
                    return DbError::DuplicateId(
                        "A record with this identifier already exists".to_string(),
                    );
                }
                if detail.contains("UNIQUE constraint failed") {
                    return DbError::UniqueConstraint(
                        "A record with a conflicting unique value already exists".to_string(),
                    );
                }
                if detail.contains("FOREIGN KEY constraint failed") {
                    return DbError::ForeignKeyViolation(
                        "Referenced parent record does not exist or child records prevent deletion"
                            .to_string(),
                    );
                }
                if detail.contains("CHECK constraint failed") {
                    return DbError::InvalidInput {
                        field: None,
                        message: "One or more values violate database validation constraints"
                            .to_string(),
                    };
                }
                if detail.contains("NOT NULL constraint failed") {
                    return DbError::InvalidInput {
                        field: None,
                        message: "A required field is missing".to_string(),
                    };
                }
                return DbError::UniqueConstraint("Database constraint violation".to_string());
            }
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => {
                return DbError::TransactionFailed(
                    "Database is temporarily busy; please retry".to_string(),
                );
            }
            _ => {}
        }
    }

    DbError::Query {
        context: context.to_string(),
        source: err,
    }
}
