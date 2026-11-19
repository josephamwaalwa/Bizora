use serde::{Deserialize, Serialize};

use super::models::{
    ActivityLogRow, AppSettingRow, BusinessAssetRow, BusinessRow, ClientRow, InvoiceItemRow,
    InvoiceRow, LocalProfileRow, PaymentRow, QuotationItemRow, QuotationRow,
};
use super::precision::SafeI64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

// ============================================================
// Local Profiles
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLocalProfileInput {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub supabase_user_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalProfileInput {
    pub id: String,
    pub display_name: String,
    pub email: String,
    #[serde(default)]
    pub supabase_user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProfileDto {
    pub id: String,
    pub display_name: String,
    pub email: String,
    pub supabase_user_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<LocalProfileRow> for LocalProfileDto {
    fn from(row: LocalProfileRow) -> Self {
        Self {
            id: row.id,
            display_name: row.display_name,
            email: row.email,
            supabase_user_id: row.supabase_user_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

// ============================================================
// Businesses
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBusinessInput {
    pub id: String,
    #[serde(default)]
    pub legacy_id: Option<String>,
    #[serde(default)]
    pub owner_profile_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub tagline: String,
    #[serde(default)]
    pub logo_asset_id: Option<String>,
    #[serde(default)]
    pub logo_url_fallback: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub postal_code: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub tax_number: Option<String>,
    #[serde(default)]
    pub registration_number: Option<String>,
    pub default_currency: String,
    pub currency_symbol: String,
    pub default_tax_name: String,
    pub default_tax_rate_ppm: SafeI64,
    pub is_tax_enabled: bool,
    pub quote_prefix: String,
    pub invoice_prefix: String,
    pub next_quote_number: SafeI64,
    pub next_invoice_number: SafeI64,
    #[serde(default)]
    pub default_terms_quotation: String,
    #[serde(default)]
    pub default_terms_invoice: String,
    #[serde(default)]
    pub default_notes: String,
    #[serde(default)]
    pub bank_name: String,
    #[serde(default)]
    pub account_name: String,
    #[serde(default)]
    pub account_number: String,
    #[serde(default)]
    pub branch_code: String,
    #[serde(default)]
    pub account_type: Option<String>,
    #[serde(default)]
    pub swift_code: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBusinessInput {
    pub id: String,
    #[serde(default)]
    pub owner_profile_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub tagline: String,
    #[serde(default)]
    pub logo_asset_id: Option<String>,
    #[serde(default)]
    pub logo_url_fallback: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub postal_code: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub tax_number: Option<String>,
    #[serde(default)]
    pub registration_number: Option<String>,
    pub default_currency: String,
    pub currency_symbol: String,
    pub default_tax_name: String,
    pub default_tax_rate_ppm: SafeI64,
    pub is_tax_enabled: bool,
    pub quote_prefix: String,
    pub invoice_prefix: String,
    pub next_quote_number: SafeI64,
    pub next_invoice_number: SafeI64,
    #[serde(default)]
    pub default_terms_quotation: String,
    #[serde(default)]
    pub default_terms_invoice: String,
    #[serde(default)]
    pub default_notes: String,
    #[serde(default)]
    pub bank_name: String,
    #[serde(default)]
    pub account_name: String,
    #[serde(default)]
    pub account_number: String,
    #[serde(default)]
    pub branch_code: String,
    #[serde(default)]
    pub account_type: Option<String>,
    #[serde(default)]
    pub swift_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessDto {
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
    pub default_tax_rate_ppm: SafeI64,
    pub is_tax_enabled: bool,
    pub quote_prefix: String,
    pub invoice_prefix: String,
    pub next_quote_number: SafeI64,
    pub next_invoice_number: SafeI64,
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

impl From<BusinessRow> for BusinessDto {
    fn from(row: BusinessRow) -> Self {
        Self {
            id: row.id,
            legacy_id: row.legacy_id,
            owner_profile_id: row.owner_profile_id,
            name: row.name,
            tagline: row.tagline,
            logo_asset_id: row.logo_asset_id,
            logo_url_fallback: row.logo_url_fallback,
            email: row.email,
            phone: row.phone,
            address: row.address,
            city: row.city,
            country: row.country,
            postal_code: row.postal_code,
            website: row.website,
            tax_number: row.tax_number,
            registration_number: row.registration_number,
            default_currency: row.default_currency,
            currency_symbol: row.currency_symbol,
            default_tax_name: row.default_tax_name,
            default_tax_rate_ppm: SafeI64(row.default_tax_rate_ppm),
            is_tax_enabled: row.is_tax_enabled != 0,
            quote_prefix: row.quote_prefix,
            invoice_prefix: row.invoice_prefix,
            next_quote_number: SafeI64(row.next_quote_number),
            next_invoice_number: SafeI64(row.next_invoice_number),
            default_terms_quotation: row.default_terms_quotation,
            default_terms_invoice: row.default_terms_invoice,
            default_notes: row.default_notes,
            bank_name: row.bank_name,
            account_name: row.account_name,
            account_number: row.account_number,
            branch_code: row.branch_code,
            account_type: row.account_type,
            swift_code: row.swift_code,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

// ============================================================
// Clients
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClientInput {
    pub id: String,
    pub business_id: String,
    #[serde(default)]
    pub legacy_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub vat_number: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateClientInput {
    pub id: String,
    pub business_id: String,
    pub name: String,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub vat_number: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDto {
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

impl From<ClientRow> for ClientDto {
    fn from(row: ClientRow) -> Self {
        Self {
            id: row.id,
            business_id: row.business_id,
            legacy_id: row.legacy_id,
            name: row.name,
            company_name: row.company_name,
            email: row.email,
            phone: row.phone,
            address: row.address,
            city: row.city,
            country: row.country,
            vat_number: row.vat_number,
            notes: row.notes,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

// ============================================================
// Line Items (Quotations & Invoices)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineItemInput {
    pub id: String,
    #[serde(default)]
    pub legacy_id: Option<String>,
    #[serde(default)]
    pub sort_order: Option<SafeI64>,
    pub description: String,
    pub quantity_scaled: SafeI64,
    pub unit_price_scaled: SafeI64,
    pub total_minor: SafeI64,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotationItemDto {
    pub id: String,
    pub business_id: String,
    pub quotation_id: String,
    pub legacy_id: Option<String>,
    pub sort_order: SafeI64,
    pub description: String,
    pub quantity_scaled: SafeI64,
    pub unit_price_scaled: SafeI64,
    pub total_minor: SafeI64,
    pub created_at: String,
}

impl From<QuotationItemRow> for QuotationItemDto {
    fn from(row: QuotationItemRow) -> Self {
        Self {
            id: row.id,
            business_id: row.business_id,
            quotation_id: row.quotation_id,
            legacy_id: row.legacy_id,
            sort_order: SafeI64(row.sort_order),
            description: row.description,
            quantity_scaled: SafeI64(row.quantity_scaled),
            unit_price_scaled: SafeI64(row.unit_price_scaled),
            total_minor: SafeI64(row.total_minor),
            created_at: row.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceItemDto {
    pub id: String,
    pub business_id: String,
    pub invoice_id: String,
    pub legacy_id: Option<String>,
    pub sort_order: SafeI64,
    pub description: String,
    pub quantity_scaled: SafeI64,
    pub unit_price_scaled: SafeI64,
    pub total_minor: SafeI64,
    pub created_at: String,
}

impl From<InvoiceItemRow> for InvoiceItemDto {
    fn from(row: InvoiceItemRow) -> Self {
        Self {
            id: row.id,
            business_id: row.business_id,
            invoice_id: row.invoice_id,
            legacy_id: row.legacy_id,
            sort_order: SafeI64(row.sort_order),
            description: row.description,
            quantity_scaled: SafeI64(row.quantity_scaled),
            unit_price_scaled: SafeI64(row.unit_price_scaled),
            total_minor: SafeI64(row.total_minor),
            created_at: row.created_at,
        }
    }
}

// ============================================================
// Quotations
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateQuotationInput {
    pub id: String,
    pub business_id: String,
    #[serde(default)]
    pub legacy_id: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    pub quotation_number: String,
    pub client_snapshot_json: String,
    pub business_snapshot_json: String,
    pub issue_date: String,
    #[serde(default)]
    pub expiry_date: Option<String>,
    pub currency: String,
    pub currency_symbol: String,
    pub subtotal_minor: SafeI64,
    pub discount_type: String,
    pub discount_percentage_ppm: SafeI64,
    pub discount_fixed_minor: SafeI64,
    pub discount_amount_minor: SafeI64,
    #[serde(default)]
    pub tax_name: String,
    pub tax_rate_ppm: SafeI64,
    pub tax_amount_minor: SafeI64,
    pub grand_total_minor: SafeI64,
    pub status: String,
    #[serde(default)]
    pub pre_conversion_status: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub terms: Option<String>,
    #[serde(default)]
    pub converted_invoice_id: Option<String>,
    pub items: Vec<LineItemInput>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateQuotationInput {
    pub id: String,
    pub business_id: String,
    #[serde(default)]
    pub client_id: Option<String>,
    pub quotation_number: String,
    pub client_snapshot_json: String,
    pub business_snapshot_json: String,
    pub issue_date: String,
    #[serde(default)]
    pub expiry_date: Option<String>,
    pub currency: String,
    pub currency_symbol: String,
    pub subtotal_minor: SafeI64,
    pub discount_type: String,
    pub discount_percentage_ppm: SafeI64,
    pub discount_fixed_minor: SafeI64,
    pub discount_amount_minor: SafeI64,
    #[serde(default)]
    pub tax_name: String,
    pub tax_rate_ppm: SafeI64,
    pub tax_amount_minor: SafeI64,
    pub grand_total_minor: SafeI64,
    pub status: String,
    #[serde(default)]
    pub pre_conversion_status: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub terms: Option<String>,
    #[serde(default)]
    pub converted_invoice_id: Option<String>,
    pub items: Vec<LineItemInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotationDto {
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
    pub subtotal_minor: SafeI64,
    pub discount_type: String,
    pub discount_percentage_ppm: SafeI64,
    pub discount_fixed_minor: SafeI64,
    pub discount_amount_minor: SafeI64,
    pub tax_name: String,
    pub tax_rate_ppm: SafeI64,
    pub tax_amount_minor: SafeI64,
    pub grand_total_minor: SafeI64,
    pub status: String,
    pub pre_conversion_status: Option<String>,
    pub notes: Option<String>,
    pub terms: Option<String>,
    pub converted_invoice_id: Option<String>,
    pub items: Vec<QuotationItemDto>,
    pub created_at: String,
    pub updated_at: String,
}

impl QuotationDto {
    pub fn from_parts(row: QuotationRow, items: Vec<QuotationItemRow>) -> Self {
        Self {
            id: row.id,
            business_id: row.business_id,
            legacy_id: row.legacy_id,
            client_id: row.client_id,
            quotation_number: row.quotation_number,
            client_snapshot_json: row.client_snapshot_json,
            business_snapshot_json: row.business_snapshot_json,
            issue_date: row.issue_date,
            expiry_date: row.expiry_date,
            currency: row.currency,
            currency_symbol: row.currency_symbol,
            subtotal_minor: SafeI64(row.subtotal_minor),
            discount_type: row.discount_type,
            discount_percentage_ppm: SafeI64(row.discount_percentage_ppm),
            discount_fixed_minor: SafeI64(row.discount_fixed_minor),
            discount_amount_minor: SafeI64(row.discount_amount_minor),
            tax_name: row.tax_name,
            tax_rate_ppm: SafeI64(row.tax_rate_ppm),
            tax_amount_minor: SafeI64(row.tax_amount_minor),
            grand_total_minor: SafeI64(row.grand_total_minor),
            status: row.status,
            pre_conversion_status: row.pre_conversion_status,
            notes: row.notes,
            terms: row.terms,
            converted_invoice_id: row.converted_invoice_id,
            items: items.into_iter().map(QuotationItemDto::from).collect(),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

// ============================================================
// Invoices & Payments
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInvoiceInput {
    pub id: String,
    pub business_id: String,
    #[serde(default)]
    pub legacy_id: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub quotation_id: Option<String>,
    pub invoice_number: String,
    pub client_snapshot_json: String,
    pub business_snapshot_json: String,
    pub issue_date: String,
    #[serde(default)]
    pub due_date: Option<String>,
    pub currency: String,
    pub currency_symbol: String,
    pub subtotal_minor: SafeI64,
    pub discount_type: String,
    pub discount_percentage_ppm: SafeI64,
    pub discount_fixed_minor: SafeI64,
    pub discount_amount_minor: SafeI64,
    #[serde(default)]
    pub tax_name: String,
    pub tax_rate_ppm: SafeI64,
    pub tax_amount_minor: SafeI64,
    pub grand_total_minor: SafeI64,
    pub amount_paid_minor: SafeI64,
    pub outstanding_balance_minor: SafeI64,
    pub status: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub terms: Option<String>,
    #[serde(default)]
    pub payment_instructions: Option<String>,
    pub items: Vec<LineItemInput>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInvoiceInput {
    pub id: String,
    pub business_id: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub quotation_id: Option<String>,
    pub invoice_number: String,
    pub client_snapshot_json: String,
    pub business_snapshot_json: String,
    pub issue_date: String,
    #[serde(default)]
    pub due_date: Option<String>,
    pub currency: String,
    pub currency_symbol: String,
    pub subtotal_minor: SafeI64,
    pub discount_type: String,
    pub discount_percentage_ppm: SafeI64,
    pub discount_fixed_minor: SafeI64,
    pub discount_amount_minor: SafeI64,
    #[serde(default)]
    pub tax_name: String,
    pub tax_rate_ppm: SafeI64,
    pub tax_amount_minor: SafeI64,
    pub grand_total_minor: SafeI64,
    pub amount_paid_minor: SafeI64,
    pub outstanding_balance_minor: SafeI64,
    pub status: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub terms: Option<String>,
    #[serde(default)]
    pub payment_instructions: Option<String>,
    pub items: Vec<LineItemInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentDto {
    pub id: String,
    pub business_id: String,
    pub invoice_id: String,
    pub legacy_id: Option<String>,
    pub amount_minor: SafeI64,
    pub payment_date: String,
    pub payment_method: String,
    pub reference: Option<String>,
    pub notes: Option<String>,
    pub recorded_at: String,
}

impl From<PaymentRow> for PaymentDto {
    fn from(row: PaymentRow) -> Self {
        Self {
            id: row.id,
            business_id: row.business_id,
            invoice_id: row.invoice_id,
            legacy_id: row.legacy_id,
            amount_minor: SafeI64(row.amount_minor),
            payment_date: row.payment_date,
            payment_method: row.payment_method,
            reference: row.reference,
            notes: row.notes,
            recorded_at: row.recorded_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceDto {
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
    pub subtotal_minor: SafeI64,
    pub discount_type: String,
    pub discount_percentage_ppm: SafeI64,
    pub discount_fixed_minor: SafeI64,
    pub discount_amount_minor: SafeI64,
    pub tax_name: String,
    pub tax_rate_ppm: SafeI64,
    pub tax_amount_minor: SafeI64,
    pub grand_total_minor: SafeI64,
    pub amount_paid_minor: SafeI64,
    pub outstanding_balance_minor: SafeI64,
    pub status: String,
    pub notes: Option<String>,
    pub terms: Option<String>,
    pub payment_instructions: Option<String>,
    pub items: Vec<InvoiceItemDto>,
    pub payments: Vec<PaymentDto>,
    pub created_at: String,
    pub updated_at: String,
}

impl InvoiceDto {
    pub fn from_parts(
        row: InvoiceRow,
        items: Vec<InvoiceItemRow>,
        payments: Vec<PaymentRow>,
    ) -> Self {
        Self {
            id: row.id,
            business_id: row.business_id,
            legacy_id: row.legacy_id,
            client_id: row.client_id,
            quotation_id: row.quotation_id,
            invoice_number: row.invoice_number,
            client_snapshot_json: row.client_snapshot_json,
            business_snapshot_json: row.business_snapshot_json,
            issue_date: row.issue_date,
            due_date: row.due_date,
            currency: row.currency,
            currency_symbol: row.currency_symbol,
            subtotal_minor: SafeI64(row.subtotal_minor),
            discount_type: row.discount_type,
            discount_percentage_ppm: SafeI64(row.discount_percentage_ppm),
            discount_fixed_minor: SafeI64(row.discount_fixed_minor),
            discount_amount_minor: SafeI64(row.discount_amount_minor),
            tax_name: row.tax_name,
            tax_rate_ppm: SafeI64(row.tax_rate_ppm),
            tax_amount_minor: SafeI64(row.tax_amount_minor),
            grand_total_minor: SafeI64(row.grand_total_minor),
            amount_paid_minor: SafeI64(row.amount_paid_minor),
            outstanding_balance_minor: SafeI64(row.outstanding_balance_minor),
            status: row.status,
            notes: row.notes,
            terms: row.terms,
            payment_instructions: row.payment_instructions,
            items: items.into_iter().map(InvoiceItemDto::from).collect(),
            payments: payments.into_iter().map(PaymentDto::from).collect(),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePaymentInput {
    pub id: String,
    pub business_id: String,
    pub invoice_id: String,
    #[serde(default)]
    pub legacy_id: Option<String>,
    pub amount_minor: SafeI64,
    pub payment_date: String,
    pub payment_method: String,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub recorded_at: Option<String>,
}

// ============================================================
// Activity Logs
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateActivityLogInput {
    pub id: String,
    pub business_id: String,
    #[serde(default)]
    pub legacy_id: Option<String>,
    #[serde(rename = "type")]
    pub log_type: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub reference_id: Option<String>,
    #[serde(default)]
    pub reference_type: Option<String>,
    #[serde(default)]
    pub actor_local_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLogDto {
    pub id: String,
    pub business_id: String,
    pub legacy_id: Option<String>,
    #[serde(rename = "type")]
    pub log_type: String,
    pub title: String,
    pub description: String,
    pub timestamp: String,
    pub reference_id: Option<String>,
    pub reference_type: Option<String>,
    pub actor_local_profile_id: Option<String>,
}

impl From<ActivityLogRow> for ActivityLogDto {
    fn from(row: ActivityLogRow) -> Self {
        Self {
            id: row.id,
            business_id: row.business_id,
            legacy_id: row.legacy_id,
            log_type: row.log_type,
            title: row.title,
            description: row.description,
            timestamp: row.timestamp,
            reference_id: row.reference_id,
            reference_type: row.reference_type,
            actor_local_profile_id: row.actor_local_profile_id,
        }
    }
}

// ============================================================
// Business Assets
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBusinessAssetInput {
    pub id: String,
    pub business_id: String,
    pub content_hash: String,
    pub source_type: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub inline_data: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub external_url: Option<String>,
    #[serde(default)]
    pub original_filename: Option<String>,
    #[serde(default)]
    pub byte_size: Option<SafeI64>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessAssetDto {
    pub id: String,
    pub business_id: String,
    pub content_hash: String,
    pub source_type: String,
    pub mime_type: Option<String>,
    pub inline_data: Option<String>,
    pub file_path: Option<String>,
    pub external_url: Option<String>,
    pub original_filename: Option<String>,
    pub byte_size: Option<SafeI64>,
    pub created_at: String,
}

impl From<BusinessAssetRow> for BusinessAssetDto {
    fn from(row: BusinessAssetRow) -> Self {
        Self {
            id: row.id,
            business_id: row.business_id,
            content_hash: row.content_hash,
            source_type: row.source_type,
            mime_type: row.mime_type,
            inline_data: row.inline_data,
            file_path: row.file_path,
            external_url: row.external_url,
            original_filename: row.original_filename,
            byte_size: row.byte_size.map(SafeI64),
            created_at: row.created_at,
        }
    }
}

// ============================================================
// App Settings
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAppSettingInput {
    pub key: String,
    pub value_json: String,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingDto {
    pub key: String,
    pub value_json: String,
    pub updated_at: String,
}

impl From<AppSettingRow> for AppSettingDto {
    fn from(row: AppSettingRow) -> Self {
        Self {
            key: row.key,
            value_json: row.value_json,
            updated_at: row.updated_at,
        }
    }
}

// ============================================================
// Legacy LocalStorage Migration (Phase 2, Stage 2.2.3)
// ============================================================

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationState {
    Absent,
    NotNeeded,
    Completed,
    ConflictExistingData,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCountsDto {
    pub local_profiles: SafeI64,
    pub businesses: SafeI64,
    pub business_assets: SafeI64,
    pub clients: SafeI64,
    pub quotations: SafeI64,
    pub quotation_items: SafeI64,
    pub invoices: SafeI64,
    pub invoice_items: SafeI64,
    pub payments: SafeI64,
    pub activity_logs: SafeI64,
    pub app_settings: SafeI64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationDiagnosticDto {
    pub code: String,
    pub severity: String,
    pub stage: String,
    pub entity_type: String,
    #[serde(default)]
    pub record_id: Option<String>,
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub original_value: Option<String>,
    pub message: String,
    pub suggested_action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatusDto {
    pub state: MigrationState,
    pub marker_version: Option<i64>,
    pub completed_at: Option<String>,
    pub migrated_business_id: Option<String>,
    pub backup_filename: Option<String>,
    pub last_error: Option<MigrationDiagnosticDto>,
    pub existing_counts: MigrationCountsDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLegacyKeyEntry {
    pub key: String,
    pub present: bool,
    #[serde(default)]
    pub present_in_local_storage: bool,
    #[serde(default)]
    pub present_in_memory_fallback: bool,
    #[serde(default)]
    pub raw_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupLegacyStorageInput {
    pub captured_at: String,
    #[serde(default)]
    pub source: String,
    pub keys: Vec<RawLegacyKeyEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupLegacyStorageResult {
    pub backup_filename: String,
    pub byte_size: SafeI64,
    pub sha256: String,
    pub verified: bool,
    pub captured_key_count: SafeI64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedFinancialSumsInput {
    pub quotation_grand_total_sum_minor: SafeI64,
    pub invoice_grand_total_sum_minor: SafeI64,
    pub invoice_amount_paid_sum_minor: SafeI64,
    pub payment_amount_sum_minor: SafeI64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyWorkspaceMigrationInput {
    pub backup_verification: BackupLegacyStorageResult,
    pub local_profile: CreateLocalProfileInput,
    pub business: CreateBusinessInput,
    #[serde(default)]
    pub assets: Vec<CreateBusinessAssetInput>,
    #[serde(default)]
    pub clients: Vec<CreateClientInput>,
    #[serde(default)]
    pub quotations: Vec<CreateQuotationInput>,
    #[serde(default)]
    pub invoices: Vec<CreateInvoiceInput>,
    #[serde(default)]
    pub payments: Vec<CreatePaymentInput>,
    #[serde(default)]
    pub activity_logs: Vec<CreateActivityLogInput>,
    #[serde(default)]
    pub settings: Vec<SaveAppSettingInput>,
    #[serde(default)]
    pub diagnostics: Vec<MigrationDiagnosticDto>,
    #[serde(default)]
    pub expected_financial_sums: Option<ExpectedFinancialSumsInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResultDto {
    pub state: MigrationState,
    pub migrated_business_id: String,
    pub local_profile_id: String,
    pub backup_filename: String,
    pub counts: MigrationCountsDto,
    pub diagnostics: Vec<MigrationDiagnosticDto>,
    pub completed_at: String,
}

// ============================================================
// Desktop Workspace Lifecycle (Stage 2.2.4, Step 1)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceDesktopWorkspaceInput {
    #[serde(default)]
    pub source: Option<String>,
    pub local_profile: CreateLocalProfileInput,
    pub business: CreateBusinessInput,
    #[serde(default)]
    pub assets: Vec<CreateBusinessAssetInput>,
    #[serde(default)]
    pub clients: Vec<CreateClientInput>,
    #[serde(default)]
    pub quotations: Vec<CreateQuotationInput>,
    #[serde(default)]
    pub invoices: Vec<CreateInvoiceInput>,
    #[serde(default)]
    pub payments: Vec<CreatePaymentInput>,
    #[serde(default)]
    pub activity_logs: Vec<CreateActivityLogInput>,
    #[serde(default)]
    pub settings: Vec<SaveAppSettingInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLifecycleResultDto {
    pub migration_state: MigrationState,
    pub business_id: Option<String>,
    pub local_profile_id: Option<String>,
    pub counts: MigrationCountsDto,
    pub completed_at: String,
}
