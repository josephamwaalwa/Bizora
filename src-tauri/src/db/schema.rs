pub const INITIAL_SCHEMA_VERSION: i64 = 1;
pub const INITIAL_SCHEMA_DESCRIPTION: &str = "Bizora Phase 2 Stage 2.1 SQLite schema Revision 2";

pub const EXPECTED_TABLES: [&str; 12] = [
    "schema_migrations",
    "local_profiles",
    "businesses",
    "clients",
    "quotations",
    "quotation_items",
    "invoices",
    "invoice_items",
    "payments",
    "activity_logs",
    "business_assets",
    "app_settings",
];

pub const SCHEMA_MIGRATIONS_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
"#;

/// Exact approved Phase 2 Stage 2.1 Revision 2 DDL (tables and indexes only).
/// PRAGMA statements are intentionally excluded because WAL must be configured
/// outside transactions and connection PRAGMAs must be applied on every connection.
pub const INITIAL_SCHEMA_SQL: &str = r#"
-- ============================================================
-- 1. SCHEMA MIGRATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
);


-- ============================================================
-- 2. LOCAL PROFILES
-- ============================================================

CREATE TABLE IF NOT EXISTS local_profiles (
    id TEXT PRIMARY KEY,

    display_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',

    supabase_user_id TEXT UNIQUE,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);


-- ============================================================
-- 3. BUSINESSES
-- ============================================================

CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,

    legacy_id TEXT UNIQUE,

    owner_profile_id TEXT,

    name TEXT NOT NULL
        CHECK (length(trim(name)) > 0),

    tagline TEXT NOT NULL DEFAULT '',

    logo_asset_id TEXT
        CHECK (
            logo_asset_id IS NULL
            OR length(trim(logo_asset_id)) > 0
        ),

    -- Used only as a fallback for legacy/external logo references.
    logo_url_fallback TEXT NOT NULL DEFAULT '',

    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    postal_code TEXT,

    website TEXT,
    tax_number TEXT,
    registration_number TEXT,

    default_currency TEXT NOT NULL DEFAULT 'NAD',
    currency_symbol TEXT NOT NULL DEFAULT 'N$',

    default_tax_name TEXT NOT NULL DEFAULT 'VAT',

    -- Percentage * 10,000.
    -- 15% = 150000.
    default_tax_rate_ppm INTEGER NOT NULL DEFAULT 150000,

    is_tax_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (is_tax_enabled IN (0, 1)),

    quote_prefix TEXT NOT NULL DEFAULT 'QUO-',
    invoice_prefix TEXT NOT NULL DEFAULT 'INV-',

    next_quote_number INTEGER NOT NULL DEFAULT 1
        CHECK (next_quote_number >= 1),

    next_invoice_number INTEGER NOT NULL DEFAULT 1
        CHECK (next_invoice_number >= 1),

    default_terms_quotation TEXT NOT NULL DEFAULT '',
    default_terms_invoice TEXT NOT NULL DEFAULT '',
    default_notes TEXT NOT NULL DEFAULT '',

    bank_name TEXT NOT NULL DEFAULT '',
    account_name TEXT NOT NULL DEFAULT '',
    account_number TEXT NOT NULL DEFAULT '',
    branch_code TEXT NOT NULL DEFAULT '',
    account_type TEXT,
    swift_code TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    CHECK (
        legacy_id IS NULL
        OR length(trim(legacy_id)) > 0
    ),

    FOREIGN KEY (owner_profile_id)
        REFERENCES local_profiles(id)
        ON DELETE SET NULL,

    FOREIGN KEY (id, logo_asset_id)
        REFERENCES business_assets(business_id, id)
        DEFERRABLE INITIALLY DEFERRED
);


-- ============================================================
-- 4. CLIENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,

    business_id TEXT NOT NULL,

    legacy_id TEXT,

    name TEXT NOT NULL
        CHECK (length(trim(name)) > 0),

    company_name TEXT,

    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',

    city TEXT,
    country TEXT,

    vat_number TEXT,
    notes TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    UNIQUE (business_id, id),
    UNIQUE (business_id, legacy_id),

    CHECK (
        legacy_id IS NULL
        OR length(trim(legacy_id)) > 0
    ),

    FOREIGN KEY (business_id)
        REFERENCES businesses(id)
        ON DELETE CASCADE
);


-- ============================================================
-- 5. QUOTATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS quotations (
    id TEXT PRIMARY KEY,

    business_id TEXT NOT NULL,

    legacy_id TEXT,

    client_id TEXT
        CHECK (
            client_id IS NULL
            OR length(trim(client_id)) > 0
        ),

    quotation_number TEXT NOT NULL COLLATE NOCASE
        CHECK (
            quotation_number = trim(quotation_number)
            AND length(quotation_number) > 0
        ),

    client_snapshot_json TEXT NOT NULL,
    business_snapshot_json TEXT NOT NULL,

    issue_date TEXT NOT NULL,
    expiry_date TEXT,

    currency TEXT NOT NULL,
    currency_symbol TEXT NOT NULL,

    subtotal_minor INTEGER NOT NULL DEFAULT 0,

    discount_type TEXT NOT NULL DEFAULT 'percentage'
        CHECK (
            discount_type IN ('percentage', 'fixed')
        ),

    -- Percentage * 10,000.
    -- 12.5% = 125000.
    discount_percentage_ppm INTEGER NOT NULL DEFAULT 0,

    -- Fixed discount in minor currency units.
    discount_fixed_minor INTEGER NOT NULL DEFAULT 0,

    discount_amount_minor INTEGER NOT NULL DEFAULT 0,

    tax_name TEXT NOT NULL DEFAULT '',

    -- Percentage * 10,000.
    tax_rate_ppm INTEGER NOT NULL DEFAULT 0,

    tax_amount_minor INTEGER NOT NULL DEFAULT 0,
    grand_total_minor INTEGER NOT NULL DEFAULT 0,

    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (
            status IN (
                'draft',
                'sent',
                'accepted',
                'declined',
                'expired'
            )
        ),

    pre_conversion_status TEXT
        CHECK (
            pre_conversion_status IS NULL
            OR pre_conversion_status IN (
                'draft',
                'sent',
                'accepted',
                'declined',
                'expired'
            )
        ),

    notes TEXT,
    terms TEXT,

    converted_invoice_id TEXT
        CHECK (
            converted_invoice_id IS NULL
            OR length(trim(converted_invoice_id)) > 0
        ),

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    UNIQUE (business_id, id),
    UNIQUE (business_id, legacy_id),
    UNIQUE (business_id, quotation_number),

    CHECK (
        legacy_id IS NULL
        OR length(trim(legacy_id)) > 0
    ),

    FOREIGN KEY (business_id, client_id)
        REFERENCES clients(business_id, id)
        DEFERRABLE INITIALLY DEFERRED,

    FOREIGN KEY (business_id, converted_invoice_id)
        REFERENCES invoices(business_id, id)
        DEFERRABLE INITIALLY DEFERRED,

    FOREIGN KEY (business_id)
        REFERENCES businesses(id)
        ON DELETE CASCADE
);


-- ============================================================
-- 6. QUOTATION ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS quotation_items (
    id TEXT PRIMARY KEY,

    business_id TEXT NOT NULL,
    quotation_id TEXT NOT NULL,

    legacy_id TEXT,

    sort_order INTEGER NOT NULL DEFAULT 0,

    description TEXT NOT NULL,

    -- Quantity * 1,000,000.
    quantity_scaled INTEGER NOT NULL,

    -- Unit price * 1,000,000.
    unit_price_scaled INTEGER NOT NULL,

    -- Final line total in minor currency units.
    total_minor INTEGER NOT NULL,

    created_at TEXT NOT NULL,

    UNIQUE (quotation_id, legacy_id),

    CHECK (
        legacy_id IS NULL
        OR length(trim(legacy_id)) > 0
    ),

    FOREIGN KEY (business_id, quotation_id)
        REFERENCES quotations(business_id, id)
        ON DELETE CASCADE
);


-- ============================================================
-- 7. INVOICES
-- ============================================================

CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,

    business_id TEXT NOT NULL,

    legacy_id TEXT,

    client_id TEXT
        CHECK (
            client_id IS NULL
            OR length(trim(client_id)) > 0
        ),

    quotation_id TEXT
        CHECK (
            quotation_id IS NULL
            OR length(trim(quotation_id)) > 0
        ),

    invoice_number TEXT NOT NULL COLLATE NOCASE
        CHECK (
            invoice_number = trim(invoice_number)
            AND length(invoice_number) > 0
        ),

    client_snapshot_json TEXT NOT NULL,
    business_snapshot_json TEXT NOT NULL,

    issue_date TEXT NOT NULL,
    due_date TEXT,

    currency TEXT NOT NULL,
    currency_symbol TEXT NOT NULL,

    subtotal_minor INTEGER NOT NULL DEFAULT 0,

    discount_type TEXT NOT NULL DEFAULT 'percentage'
        CHECK (
            discount_type IN ('percentage', 'fixed')
        ),

    discount_percentage_ppm INTEGER NOT NULL DEFAULT 0,
    discount_fixed_minor INTEGER NOT NULL DEFAULT 0,

    discount_amount_minor INTEGER NOT NULL DEFAULT 0,

    tax_name TEXT NOT NULL DEFAULT '',
    tax_rate_ppm INTEGER NOT NULL DEFAULT 0,

    tax_amount_minor INTEGER NOT NULL DEFAULT 0,
    grand_total_minor INTEGER NOT NULL DEFAULT 0,

    amount_paid_minor INTEGER NOT NULL DEFAULT 0,
    outstanding_balance_minor INTEGER NOT NULL DEFAULT 0,

    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (
            status IN (
                'draft',
                'sent',
                'partially_paid',
                'paid',
                'overdue'
            )
        ),

    notes TEXT,
    terms TEXT,
    payment_instructions TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    UNIQUE (business_id, id),
    UNIQUE (business_id, legacy_id),
    UNIQUE (business_id, invoice_number),

    CHECK (
        legacy_id IS NULL
        OR length(trim(legacy_id)) > 0
    ),

    FOREIGN KEY (business_id, client_id)
        REFERENCES clients(business_id, id)
        DEFERRABLE INITIALLY DEFERRED,

    FOREIGN KEY (business_id, quotation_id)
        REFERENCES quotations(business_id, id)
        DEFERRABLE INITIALLY DEFERRED,

    FOREIGN KEY (business_id)
        REFERENCES businesses(id)
        ON DELETE CASCADE
);


-- ============================================================
-- 8. INVOICE ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS invoice_items (
    id TEXT PRIMARY KEY,

    business_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL,

    legacy_id TEXT,

    sort_order INTEGER NOT NULL DEFAULT 0,

    description TEXT NOT NULL,

    quantity_scaled INTEGER NOT NULL,
    unit_price_scaled INTEGER NOT NULL,

    total_minor INTEGER NOT NULL,

    created_at TEXT NOT NULL,

    UNIQUE (invoice_id, legacy_id),

    CHECK (
        legacy_id IS NULL
        OR length(trim(legacy_id)) > 0
    ),

    FOREIGN KEY (business_id, invoice_id)
        REFERENCES invoices(business_id, id)
        ON DELETE CASCADE
);


-- ============================================================
-- 9. PAYMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,

    business_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL,

    legacy_id TEXT,

    amount_minor INTEGER NOT NULL,

    payment_date TEXT NOT NULL,

    payment_method TEXT NOT NULL
        CHECK (
            payment_method IN (
                'bank_transfer',
                'cash',
                'credit_card',
                'eft',
                'mobile_money',
                'cheque',
                'other'
            )
        ),

    reference TEXT,
    notes TEXT,

    recorded_at TEXT NOT NULL,

    UNIQUE (invoice_id, legacy_id),

    CHECK (
        legacy_id IS NULL
        OR length(trim(legacy_id)) > 0
    ),

    FOREIGN KEY (business_id, invoice_id)
        REFERENCES invoices(business_id, id)
        ON DELETE CASCADE
);


-- ============================================================
-- 10. ACTIVITY LOGS
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,

    business_id TEXT NOT NULL,

    legacy_id TEXT,

    type TEXT NOT NULL
        CHECK (
            type IN (
                'quote_created',
                'quote_converted',
                'quote_status',
                'invoice_created',
                'payment_recorded',
                'invoice_status',
                'client_created',
                'settings_updated'
            )
        ),

    title TEXT NOT NULL,
    description TEXT NOT NULL,

    timestamp TEXT NOT NULL,

    reference_id TEXT,
    reference_type TEXT,

    actor_local_profile_id TEXT,

    UNIQUE (business_id, legacy_id),

    CHECK (
        legacy_id IS NULL
        OR length(trim(legacy_id)) > 0
    ),

    FOREIGN KEY (business_id)
        REFERENCES businesses(id)
        ON DELETE CASCADE,

    FOREIGN KEY (actor_local_profile_id)
        REFERENCES local_profiles(id)
        ON DELETE SET NULL
);


-- ============================================================
-- 11. BUSINESS ASSETS
-- ============================================================

CREATE TABLE IF NOT EXISTS business_assets (
    id TEXT PRIMARY KEY,

    business_id TEXT NOT NULL,

    content_hash TEXT NOT NULL,

    source_type TEXT NOT NULL
        CHECK (
            source_type IN (
                'data_url',
                'file',
                'external_url'
            )
        ),

    mime_type TEXT,

    inline_data TEXT,
    file_path TEXT,
    external_url TEXT,

    original_filename TEXT,

    byte_size INTEGER,

    created_at TEXT NOT NULL,

    UNIQUE (business_id, id),
    UNIQUE (business_id, content_hash),

    FOREIGN KEY (business_id)
        REFERENCES businesses(id)
        ON DELETE CASCADE,

    CHECK (
        (
            source_type = 'data_url'
            AND inline_data IS NOT NULL
        )
        OR
        (
            source_type = 'file'
            AND file_path IS NOT NULL
        )
        OR
        (
            source_type = 'external_url'
            AND external_url IS NOT NULL
        )
    )
);


-- ============================================================
-- 12. APP SETTINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,

    value_json TEXT NOT NULL,

    updated_at TEXT NOT NULL
);


-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_businesses_owner
    ON businesses(owner_profile_id);


CREATE INDEX IF NOT EXISTS idx_clients_business
    ON clients(business_id);


CREATE INDEX IF NOT EXISTS idx_quotations_business
    ON quotations(business_id);

CREATE INDEX IF NOT EXISTS idx_quotations_client
    ON quotations(business_id, client_id);

CREATE INDEX IF NOT EXISTS idx_quotations_converted_invoice
    ON quotations(business_id, converted_invoice_id);

CREATE INDEX IF NOT EXISTS idx_quotations_issue_date
    ON quotations(business_id, issue_date DESC);


CREATE INDEX IF NOT EXISTS idx_quotation_items_parent_order
    ON quotation_items(quotation_id, sort_order);


CREATE INDEX IF NOT EXISTS idx_invoices_business
    ON invoices(business_id);

CREATE INDEX IF NOT EXISTS idx_invoices_client
    ON invoices(business_id, client_id);

CREATE INDEX IF NOT EXISTS idx_invoices_quotation
    ON invoices(business_id, quotation_id);

CREATE INDEX IF NOT EXISTS idx_invoices_issue_date
    ON invoices(business_id, issue_date DESC);


CREATE INDEX IF NOT EXISTS idx_invoice_items_parent_order
    ON invoice_items(invoice_id, sort_order);


CREATE INDEX IF NOT EXISTS idx_payments_invoice
    ON payments(invoice_id);

CREATE INDEX IF NOT EXISTS idx_payments_invoice_date
    ON payments(invoice_id, payment_date);


CREATE INDEX IF NOT EXISTS idx_activity_logs_business_time
    ON activity_logs(business_id, timestamp DESC);


CREATE INDEX IF NOT EXISTS idx_business_assets_business
    ON business_assets(business_id);


-- ============================================================
-- ONE-TO-ONE CONVERSION REFERENCE
--
-- A quotation can point to one converted invoice.
-- Historical invoices may share quotation_id during migration.
-- New duplicate links must be prevented by application logic.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS
    idx_quotations_unique_converted_invoice
ON quotations(business_id, converted_invoice_id)
WHERE converted_invoice_id IS NOT NULL;
"#;
