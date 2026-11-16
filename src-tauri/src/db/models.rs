#![allow(dead_code)]

/// Internal Rust representations of SQLite database rows matching the Revision 2 DDL.

#[derive(Debug, Clone)]
pub struct LocalProfileRow {
    pub id: String,
    pub display_name: String,
    pub email: String,
    pub supabase_user_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct BusinessRow {
    pub id: String,
    pub legacy_id: Option<String>,
    pub owner_profile_id: Option<String>,
    pub name: String,
    pub tagline: String,
    pub logo_asset_id: Option<String>,
    pub logo_url_fallback: String,
    pub email: String,
    pub phone: String,
    pub address: String,
    pub city: String,
    pub country: String,
    pub postal_code: Option<String>,
    pub website: Option<String>,
    pub tax_number: Option<String>,
    pub registration_number: Option<String>,
    pub default_currency: String,
    pub currency_symbol: String,
    pub default_tax_name: String,
    pub default_tax_rate_ppm: i64,
    pub is_tax_enabled: i64,
    pub quote_prefix: String,
    pub invoice_prefix: String,
    pub next_quote_number: i64,
    pub next_invoice_number: i64,
    pub default_terms_quotation: String,
    pub default_terms_invoice: String,
    pub default_notes: String,
    pub bank_name: String,
    pub account_name: String,
    pub account_number: String,
    pub branch_code: String,
    pub account_type: Option<String>,
    pub swift_code: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct ClientRow {
    pub id: String,
    pub business_id: String,
    pub legacy_id: Option<String>,
    pub name: String,
    pub company_name: Option<String>,
    pub email: String,
    pub phone: String,
    pub address: String,
    pub city: Option<String>,
    pub country: Option<String>,
    pub vat_number: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct QuotationRow {
    pub id: String,
    pub business_id: String,
    pub legacy_id: Option<String>,
    pub client_id: Option<String>,
    pub quotation_number: String,
    pub client_snapshot_json: String,
    pub business_snapshot_json: String,
    pub issue_date: String,
    pub expiry_date: Option<String>,
    pub currency: String,
    pub currency_symbol: String,
    pub subtotal_minor: i64,
    pub discount_type: String,
    pub discount_percentage_ppm: i64,
    pub discount_fixed_minor: i64,
    pub discount_amount_minor: i64,
    pub tax_name: String,
    pub tax_rate_ppm: i64,
    pub tax_amount_minor: i64,
    pub grand_total_minor: i64,
    pub status: String,
    pub pre_conversion_status: Option<String>,
    pub notes: Option<String>,
    pub terms: Option<String>,
    pub converted_invoice_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct QuotationItemRow {
    pub id: String,
    pub business_id: String,
    pub quotation_id: String,
    pub legacy_id: Option<String>,
    pub sort_order: i64,
    pub description: String,
    pub quantity_scaled: i64,
    pub unit_price_scaled: i64,
    pub total_minor: i64,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct InvoiceRow {
    pub id: String,
    pub business_id: String,
    pub legacy_id: Option<String>,
    pub client_id: Option<String>,
    pub quotation_id: Option<String>,
    pub invoice_number: String,
    pub client_snapshot_json: String,
    pub business_snapshot_json: String,
    pub issue_date: String,
    pub due_date: Option<String>,
    pub currency: String,
    pub currency_symbol: String,
    pub subtotal_minor: i64,
    pub discount_type: String,
    pub discount_percentage_ppm: i64,
    pub discount_fixed_minor: i64,
    pub discount_amount_minor: i64,
    pub tax_name: String,
    pub tax_rate_ppm: i64,
    pub tax_amount_minor: i64,
    pub grand_total_minor: i64,
    pub amount_paid_minor: i64,
    pub outstanding_balance_minor: i64,
    pub status: String,
    pub notes: Option<String>,
    pub terms: Option<String>,
    pub payment_instructions: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct InvoiceItemRow {
    pub id: String,
    pub business_id: String,
    pub invoice_id: String,
    pub legacy_id: Option<String>,
    pub sort_order: i64,
    pub description: String,
    pub quantity_scaled: i64,
    pub unit_price_scaled: i64,
    pub total_minor: i64,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct PaymentRow {
    pub id: String,
    pub business_id: String,
    pub invoice_id: String,
    pub legacy_id: Option<String>,
    pub amount_minor: i64,
    pub payment_date: String,
    pub payment_method: String,
    pub reference: Option<String>,
    pub notes: Option<String>,
    pub recorded_at: String,
}

#[derive(Debug, Clone)]
pub struct ActivityLogRow {
    pub id: String,
    pub business_id: String,
    pub legacy_id: Option<String>,
    pub log_type: String,
    pub title: String,
    pub description: String,
    pub timestamp: String,
    pub reference_id: Option<String>,
    pub reference_type: Option<String>,
    pub actor_local_profile_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BusinessAssetRow {
    pub id: String,
    pub business_id: String,
    pub content_hash: String,
    pub source_type: String,
    pub mime_type: Option<String>,
    pub inline_data: Option<String>,
    pub file_path: Option<String>,
    pub external_url: Option<String>,
    pub original_filename: Option<String>,
    pub byte_size: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct AppSettingRow {
    pub key: String,
    pub value_json: String,
    pub updated_at: String,
}
