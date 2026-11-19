use tauri::State;

use super::dto::{
    ActivityLogDto, AppSettingDto, BackupLegacyStorageInput, BackupLegacyStorageResult,
    BusinessAssetDto, BusinessDto, ClientDto, CommandError, CreateActivityLogInput,
    CreateBusinessAssetInput, CreateBusinessInput, CreateClientInput, CreateInvoiceInput,
    CreateLocalProfileInput, CreatePaymentInput, CreateQuotationInput, InvoiceDto, InvoiceItemDto,
    LegacyWorkspaceMigrationInput, LocalProfileDto, MigrationDiagnosticDto, MigrationResultDto,
    MigrationStatusDto, PaymentDto, QuotationDto, QuotationItemDto, SaveAppSettingInput,
    UpdateBusinessInput, UpdateClientInput, UpdateInvoiceInput, UpdateLocalProfileInput,
    UpdateQuotationInput,
};
use super::precision::SafeI64;
use super::repositories::{
    activity_repository, asset_repository, business_repository, client_repository,
    invoice_repository, local_profile_repository, migration_repository, payment_repository,
    quotation_repository, settings_repository,
};
use super::{DatabaseManager, DbError};

async fn run_db_task<T, F>(db_manager: State<'_, DatabaseManager>, work: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&mut rusqlite::Connection) -> Result<T, DbError> + Send + 'static,
{
    let manager = db_manager.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = manager.ensure_initialized_connection()?;
        work(&mut conn)
    })
    .await
    .map_err(|_| CommandError {
        code: "INTERNAL_ERROR".to_string(),
        message: "Database worker task failed unexpectedly".to_string(),
        field: None,
    })?;

    result.map_err(|err| CommandError::from(&err))
}

// ============================================================
// Local Profiles
// ============================================================

#[tauri::command]
pub async fn create_local_profile(
    db_manager: State<'_, DatabaseManager>,
    input: CreateLocalProfileInput,
) -> Result<LocalProfileDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        local_profile_repository::create_local_profile(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn get_local_profile_by_id(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<Option<LocalProfileDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        local_profile_repository::get_local_profile_by_id(conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn get_local_profiles(
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<LocalProfileDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        local_profile_repository::get_local_profiles(conn)
    })
    .await
}

#[tauri::command]
pub async fn update_local_profile(
    db_manager: State<'_, DatabaseManager>,
    input: UpdateLocalProfileInput,
) -> Result<LocalProfileDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        local_profile_repository::update_local_profile(conn, &input)
    })
    .await
}

// ============================================================
// Businesses
// ============================================================

#[tauri::command]
pub async fn create_business(
    db_manager: State<'_, DatabaseManager>,
    input: CreateBusinessInput,
) -> Result<BusinessDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        business_repository::create_business(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn get_business_by_id(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<Option<BusinessDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        business_repository::get_business_by_id(conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn get_businesses(
    db_manager: State<'_, DatabaseManager>,
    owner_profile_id: Option<String>,
) -> Result<Vec<BusinessDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        business_repository::get_businesses(conn, owner_profile_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn update_business(
    db_manager: State<'_, DatabaseManager>,
    input: UpdateBusinessInput,
) -> Result<BusinessDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        business_repository::update_business(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn delete_business(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<(), CommandError> {
    run_db_task(db_manager, move |conn| {
        business_repository::delete_business(conn, &id)
    })
    .await
}

// ============================================================
// Clients
// ============================================================

#[tauri::command]
pub async fn create_client(
    db_manager: State<'_, DatabaseManager>,
    input: CreateClientInput,
) -> Result<ClientDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        client_repository::create_client(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn get_client_by_id(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<Option<ClientDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        client_repository::get_client_by_id(conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn get_clients_by_business(
    db_manager: State<'_, DatabaseManager>,
    business_id: String,
) -> Result<Vec<ClientDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        client_repository::get_clients_by_business(conn, &business_id)
    })
    .await
}

#[tauri::command]
pub async fn update_client(
    db_manager: State<'_, DatabaseManager>,
    input: UpdateClientInput,
) -> Result<ClientDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        client_repository::update_client(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn delete_client(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<(), CommandError> {
    run_db_task(db_manager, move |conn| {
        client_repository::delete_client(conn, &id)
    })
    .await
}

// ============================================================
// Quotations
// ============================================================

#[tauri::command]
pub async fn create_quotation(
    db_manager: State<'_, DatabaseManager>,
    input: CreateQuotationInput,
) -> Result<QuotationDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        quotation_repository::create_quotation(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn get_quotation_by_id(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<Option<QuotationDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        quotation_repository::get_quotation_by_id(conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn get_quotations_by_business(
    db_manager: State<'_, DatabaseManager>,
    business_id: String,
) -> Result<Vec<QuotationDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        quotation_repository::get_quotations_by_business(conn, &business_id)
    })
    .await
}

#[tauri::command]
pub async fn get_quotation_items(
    db_manager: State<'_, DatabaseManager>,
    quotation_id: String,
) -> Result<Vec<QuotationItemDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        quotation_repository::get_quotation_items(conn, &quotation_id)
    })
    .await
}

#[tauri::command]
pub async fn update_quotation(
    db_manager: State<'_, DatabaseManager>,
    input: UpdateQuotationInput,
) -> Result<QuotationDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        quotation_repository::update_quotation(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn delete_quotation(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<(), CommandError> {
    run_db_task(db_manager, move |conn| {
        quotation_repository::delete_quotation(conn, &id)
    })
    .await
}

// ============================================================
// Invoices
// ============================================================

#[tauri::command]
pub async fn create_invoice(
    db_manager: State<'_, DatabaseManager>,
    input: CreateInvoiceInput,
) -> Result<InvoiceDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        invoice_repository::create_invoice(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn get_invoice_by_id(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<Option<InvoiceDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        invoice_repository::get_invoice_by_id(conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn get_invoices_by_business(
    db_manager: State<'_, DatabaseManager>,
    business_id: String,
) -> Result<Vec<InvoiceDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        invoice_repository::get_invoices_by_business(conn, &business_id)
    })
    .await
}

#[tauri::command]
pub async fn get_invoice_items(
    db_manager: State<'_, DatabaseManager>,
    invoice_id: String,
) -> Result<Vec<InvoiceItemDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        invoice_repository::get_invoice_items(conn, &invoice_id)
    })
    .await
}

#[tauri::command]
pub async fn update_invoice(
    db_manager: State<'_, DatabaseManager>,
    input: UpdateInvoiceInput,
) -> Result<InvoiceDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        invoice_repository::update_invoice(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn delete_invoice(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<(), CommandError> {
    run_db_task(db_manager, move |conn| {
        invoice_repository::delete_invoice(conn, &id)
    })
    .await
}

// ============================================================
// Payments
// ============================================================

#[tauri::command]
pub async fn create_payment(
    db_manager: State<'_, DatabaseManager>,
    input: CreatePaymentInput,
) -> Result<PaymentDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        payment_repository::create_payment(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn get_payments_by_invoice(
    db_manager: State<'_, DatabaseManager>,
    invoice_id: String,
) -> Result<Vec<PaymentDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        payment_repository::get_payments_by_invoice(conn, &invoice_id)
    })
    .await
}

#[tauri::command]
pub async fn get_payments_by_business(
    db_manager: State<'_, DatabaseManager>,
    business_id: String,
) -> Result<Vec<PaymentDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        payment_repository::get_payments_by_business(conn, &business_id)
    })
    .await
}

#[tauri::command]
pub async fn delete_payment(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<(), CommandError> {
    run_db_task(db_manager, move |conn| {
        payment_repository::delete_payment(conn, &id)
    })
    .await
}

// ============================================================
// Activity Logs
// ============================================================

#[tauri::command]
pub async fn create_activity_log(
    db_manager: State<'_, DatabaseManager>,
    input: CreateActivityLogInput,
) -> Result<ActivityLogDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        activity_repository::create_activity_log(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn get_activity_log_by_id(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<Option<ActivityLogDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        activity_repository::get_activity_log_by_id(conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn get_activity_logs_by_business(
    db_manager: State<'_, DatabaseManager>,
    business_id: String,
    limit: Option<SafeI64>,
) -> Result<Vec<ActivityLogDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        activity_repository::get_activity_logs_by_business(
            conn,
            &business_id,
            limit.map(SafeI64::get),
        )
    })
    .await
}

// ============================================================
// Business Assets
// ============================================================

#[tauri::command]
pub async fn create_business_asset(
    db_manager: State<'_, DatabaseManager>,
    input: CreateBusinessAssetInput,
) -> Result<BusinessAssetDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        asset_repository::create_asset(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn get_business_asset_by_id(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<Option<BusinessAssetDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        asset_repository::get_asset_by_id(conn, &id)
    })
    .await
}

#[tauri::command]
pub async fn get_business_assets_by_business(
    db_manager: State<'_, DatabaseManager>,
    business_id: String,
) -> Result<Vec<BusinessAssetDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        asset_repository::get_assets_by_business(conn, &business_id)
    })
    .await
}

#[tauri::command]
pub async fn delete_business_asset(
    db_manager: State<'_, DatabaseManager>,
    id: String,
) -> Result<(), CommandError> {
    run_db_task(db_manager, move |conn| {
        asset_repository::delete_asset(conn, &id)
    })
    .await
}

// ============================================================
// App Settings
// ============================================================

#[tauri::command]
pub async fn get_app_setting(
    db_manager: State<'_, DatabaseManager>,
    key: String,
) -> Result<Option<AppSettingDto>, CommandError> {
    run_db_task(db_manager, move |conn| {
        settings_repository::get_setting(conn, &key)
    })
    .await
}

#[tauri::command]
pub async fn save_app_setting(
    db_manager: State<'_, DatabaseManager>,
    input: SaveAppSettingInput,
) -> Result<AppSettingDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        settings_repository::save_setting(conn, &input)
    })
    .await
}

#[tauri::command]
pub async fn delete_app_setting(
    db_manager: State<'_, DatabaseManager>,
    key: String,
) -> Result<(), CommandError> {
    run_db_task(db_manager, move |conn| {
        settings_repository::delete_setting(conn, &key)
    })
    .await
}

// ============================================================
// Legacy LocalStorage Migration (Stage 2.2.3)
// ============================================================

#[tauri::command]
pub async fn get_migration_status(
    db_manager: State<'_, DatabaseManager>,
) -> Result<MigrationStatusDto, CommandError> {
    run_db_task(db_manager, move |conn| {
        migration_repository::get_migration_status(conn)
    })
    .await
}

#[tauri::command]
pub async fn backup_legacy_localstorage(
    db_manager: State<'_, DatabaseManager>,
    input: BackupLegacyStorageInput,
) -> Result<BackupLegacyStorageResult, CommandError> {
    let manager = db_manager.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager.wait_for_startup_if_running()?;
        let db_path = manager.db_path()?.to_path_buf();
        migration_repository::backup_legacy_localstorage(&db_path, &input)
    })
    .await
    .map_err(|_| CommandError {
        code: "INTERNAL_ERROR".to_string(),
        message: "Backup worker task failed unexpectedly".to_string(),
        field: None,
    })?;

    result.map_err(|err| CommandError::from(&err))
}

#[tauri::command]
pub async fn migrate_legacy_workspace(
    db_manager: State<'_, DatabaseManager>,
    input: LegacyWorkspaceMigrationInput,
) -> Result<MigrationResultDto, CommandError> {
    let manager = db_manager.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = manager.ensure_initialized_connection()?;
        let db_path = manager.db_path()?.to_path_buf();
        match migration_repository::migrate_legacy_workspace(&mut conn, &db_path, &input) {
            Ok(res) => Ok(res),
            Err(err) => {
                let cmd_err = CommandError::from(&err);
                let diag = MigrationDiagnosticDto {
                    code: cmd_err.code.clone(),
                    severity: "error".to_string(),
                    stage: "sqlite_import".to_string(),
                    entity_type: "workspace".to_string(),
                    record_id: Some(input.business.id.clone()),
                    field: cmd_err.field.clone(),
                    original_value: None,
                    message: cmd_err.message.clone(),
                    suggested_action: "Original LocalStorage and verified backup were preserved. Resolve reported issue before retrying.".to_string(),
                };
                let _ = migration_repository::record_migration_error(&mut conn, &diag);
                Err(err)
            }
        }
    })
    .await
    .map_err(|_| CommandError {
        code: "INTERNAL_ERROR".to_string(),
        message: "Migration worker task failed unexpectedly".to_string(),
        field: None,
    })?;

    result.map_err(|err| CommandError::from(&err))
}

