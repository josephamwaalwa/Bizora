use std::fmt;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::ToSql;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::DbError;

#[allow(dead_code)]
pub const MONEY_SCALE: i128 = 100;
#[allow(dead_code)]
pub const QUANTITY_PRICE_SCALE: i128 = 1_000_000;
#[allow(dead_code)]
pub const RATE_PPM_SCALE: i128 = 10_000;
#[allow(dead_code)]
pub const LINE_TOTAL_DIVISOR: i128 = 10_000_000_000; // (10^6 * 10^6) / 10^2
#[allow(dead_code)]
pub const RATE_DIVISOR: i128 = 1_000_000; // (100% * 10^4)
#[allow(dead_code)]
pub const MAX_PERCENTAGE_PPM: i64 = 1_000_000; // 100.0000%
pub const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Signed 64-bit integer serialized as a base-10 string across Tauri JSON IPC so values
/// outside JavaScript's `Number.MAX_SAFE_INTEGER` (`2^53 - 1`) never silently lose precision.
///
/// Deserialization accepts either:
/// - a canonical base-10 integer string (e.g. `"9007199254740993"` or `"-100"`), or
/// - an exact JSON integer strictly within `[-JS_MAX_SAFE_INTEGER, JS_MAX_SAFE_INTEGER]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct SafeI64(pub i64);

impl SafeI64 {
    pub const fn new(value: i64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> i64 {
        self.0
    }
}

impl From<i64> for SafeI64 {
    fn from(value: i64) -> Self {
        Self(value)
    }
}

impl From<SafeI64> for i64 {
    fn from(value: SafeI64) -> Self {
        value.0
    }
}

impl fmt::Display for SafeI64 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for SafeI64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for SafeI64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct SafeI64Visitor;

        impl<'de> Visitor<'de> for SafeI64Visitor {
            type Value = SafeI64;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a base-10 integer string or a safe JavaScript integer")
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                if !(-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&value) {
                    return Err(E::custom(
                        "numeric JSON integer exceeds JavaScript MAX_SAFE_INTEGER; pass a string instead",
                    ));
                }
                Ok(SafeI64(value))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                if value > JS_MAX_SAFE_INTEGER as u64 {
                    return Err(E::custom(
                        "numeric JSON integer exceeds JavaScript MAX_SAFE_INTEGER; pass a string instead",
                    ));
                }
                Ok(SafeI64(value as i64))
            }

            fn visit_f64<E: de::Error>(self, _value: f64) -> Result<Self::Value, E> {
                Err(E::custom(
                    "floating-point numbers are not accepted for scaled integer fields",
                ))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                let trimmed = value.trim();
                if trimmed.is_empty() || trimmed != value {
                    return Err(E::custom(
                        "integer string must be non-empty without surrounding whitespace",
                    ));
                }
                if trimmed.starts_with('+') {
                    return Err(E::custom("integer string must not include a leading '+'"));
                }
                let parsed = trimmed
                    .parse::<i64>()
                    .map_err(|_| E::custom("invalid or overflowing 64-bit integer string"))?;
                Ok(SafeI64(parsed))
            }
        }

        deserializer.deserialize_any(SafeI64Visitor)
    }
}

impl ToSql for SafeI64 {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.0))
    }
}

impl FromSql for SafeI64 {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value {
            ValueRef::Integer(i) => Ok(SafeI64(i)),
            _ => Err(FromSqlError::InvalidType),
        }
    }
}

pub fn require_non_negative(value: i64, field: &'static str) -> Result<i64, DbError> {
    if value < 0 {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} must not be negative"),
        });
    }
    Ok(value)
}

pub fn require_positive(value: i64, field: &'static str) -> Result<i64, DbError> {
    if value <= 0 {
        return Err(DbError::InvalidInput {
            field: Some(field.to_string()),
            message: format!("{field} must be greater than zero"),
        });
    }
    Ok(value)
}

/// Converts `i128` result to `i64` with explicit overflow detection.
pub fn to_i64_checked(value: i128, context: &str) -> Result<i64, DbError> {
    i64::try_from(value).map_err(|_| {
        DbError::NumericOverflow(format!("Integer overflow while computing {context}"))
    })
}

/// Round-half-up integer division for non-negative `numerator` and positive `divisor`.
#[allow(dead_code)]
pub fn div_round_half_up_non_negative(
    numerator: i128,
    divisor: i128,
    context: &str,
) -> Result<i64, DbError> {
    if numerator < 0 || divisor <= 0 {
        return Err(DbError::NumericOverflow(format!(
            "Invalid operands for {context}"
        )));
    }
    let half = divisor / 2;
    let adjusted = numerator
        .checked_add(half)
        .ok_or_else(|| DbError::NumericOverflow(format!("Overflow rounding {context}")))?;
    to_i64_checked(adjusted / divisor, context)
}

/// Computes `round((quantity_scaled / 10^6) * (unit_price_scaled / 10^6) * 100)` using `i128`.
#[allow(dead_code)]
pub fn calculate_line_total_minor(
    quantity_scaled: i64,
    unit_price_scaled: i64,
) -> Result<i64, DbError> {
    require_non_negative(quantity_scaled, "quantityScaled")?;
    require_non_negative(unit_price_scaled, "unitPriceScaled")?;

    let product = (quantity_scaled as i128)
        .checked_mul(unit_price_scaled as i128)
        .ok_or_else(|| DbError::NumericOverflow("Line item multiplication overflow".to_string()))?;

    div_round_half_up_non_negative(product, LINE_TOTAL_DIVISOR, "line item total")
}

/// Computes `round(base_minor * (rate_ppm / 1_000_000))` using `i128`.
#[allow(dead_code)]
pub fn calculate_percentage_of_minor(base_minor: i64, rate_ppm: i64) -> Result<i64, DbError> {
    require_non_negative(base_minor, "baseMinor")?;
    require_non_negative(rate_ppm, "ratePpm")?;

    let product = (base_minor as i128)
        .checked_mul(rate_ppm as i128)
        .ok_or_else(|| DbError::NumericOverflow("Percentage calculation overflow".to_string()))?;

    div_round_half_up_non_negative(product, RATE_DIVISOR, "percentage amount")
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocumentTotalsMinor {
    pub subtotal_minor: i64,
    pub discount_amount_minor: i64,
    pub taxable_amount_minor: i64,
    pub tax_amount_minor: i64,
    pub grand_total_minor: i64,
}

/// Integer-only fixed-point calculation matching `src/utils/calculations.ts`.
#[allow(dead_code)]
pub fn calculate_document_totals_minor(
    line_totals_minor: &[i64],
    discount_type: &str,
    discount_percentage_ppm: i64,
    discount_fixed_minor: i64,
    tax_rate_ppm: i64,
) -> Result<DocumentTotalsMinor, DbError> {
    let mut subtotal: i128 = 0;
    for &item_total in line_totals_minor {
        require_non_negative(item_total, "totalMinor")?;
        subtotal = subtotal
            .checked_add(item_total as i128)
            .ok_or_else(|| DbError::NumericOverflow("Document subtotal overflow".to_string()))?;
    }
    let subtotal_minor = to_i64_checked(subtotal, "document subtotal")?;

    let discount_amount_minor = match discount_type {
        "percentage" => {
            require_non_negative(discount_percentage_ppm, "discountPercentagePpm")?;
            let clamped_ppm = discount_percentage_ppm.min(MAX_PERCENTAGE_PPM);
            calculate_percentage_of_minor(subtotal_minor, clamped_ppm)?
        }
        "fixed" => {
            require_non_negative(discount_fixed_minor, "discountFixedMinor")?;
            discount_fixed_minor.min(subtotal_minor)
        }
        _ => {
            return Err(DbError::InvalidInput {
                field: Some("discountType".to_string()),
                message: "discountType must be 'percentage' or 'fixed'".to_string(),
            })
        }
    };

    let taxable_amount_minor = subtotal_minor.saturating_sub(discount_amount_minor).max(0);

    require_non_negative(tax_rate_ppm, "taxRatePpm")?;
    let tax_amount_minor = if tax_rate_ppm > 0 {
        calculate_percentage_of_minor(taxable_amount_minor, tax_rate_ppm)?
    } else {
        0
    };

    let grand_total_128 = (taxable_amount_minor as i128)
        .checked_add(tax_amount_minor as i128)
        .ok_or_else(|| DbError::NumericOverflow("Document grand total overflow".to_string()))?;
    let grand_total_minor = to_i64_checked(grand_total_128, "document grand total")?;

    Ok(DocumentTotalsMinor {
        subtotal_minor,
        discount_amount_minor,
        taxable_amount_minor,
        tax_amount_minor,
        grand_total_minor,
    })
}

/// Recomputes `amount_paid_minor`, `outstanding_balance_minor`, and `status` when payments change.
/// Never enforces `amount_paid_minor <= grand_total_minor`, preserving the +0.01 payment tolerance.
pub fn recompute_invoice_payment_state(
    current_status: &str,
    grand_total_minor: i64,
    payment_amounts_minor: &[i64],
    is_past_due: bool,
) -> Result<(i64, i64, &'static str), DbError> {
    require_non_negative(grand_total_minor, "grandTotalMinor")?;

    let mut sum_paid: i128 = 0;
    for &amt in payment_amounts_minor {
        require_positive(amt, "amountMinor")?;
        sum_paid = sum_paid
            .checked_add(amt as i128)
            .ok_or_else(|| DbError::NumericOverflow("Invoice payment sum overflow".to_string()))?;
    }
    let amount_paid_minor = to_i64_checked(sum_paid, "invoice amount paid")?;
    let outstanding_balance_minor = if grand_total_minor > amount_paid_minor {
        to_i64_checked(
            (grand_total_minor as i128) - (amount_paid_minor as i128),
            "invoice outstanding balance",
        )?
    } else {
        0
    };

    let next_status = if current_status == "draft" && amount_paid_minor == 0 {
        "draft"
    } else if (grand_total_minor > 0 && amount_paid_minor >= grand_total_minor)
        || (grand_total_minor == 0 && amount_paid_minor > 0)
    {
        "paid"
    } else if amount_paid_minor > 0 && amount_paid_minor < grand_total_minor {
        "partially_paid"
    } else if grand_total_minor == 0 {
        match current_status {
            "draft" => "draft",
            _ => "sent",
        }
    } else if is_past_due && amount_paid_minor < grand_total_minor {
        "overdue"
    } else if current_status == "overdue" && !is_past_due {
        "sent"
    } else {
        match current_status {
            "draft" => "draft",
            "sent" => "sent",
            "partially_paid" | "paid" => "sent",
            "overdue" => "overdue",
            _ => "sent",
        }
    };

    Ok((amount_paid_minor, outstanding_balance_minor, next_status))
}
