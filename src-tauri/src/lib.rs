mod db;

use db::dto::CommandError;
use db::{DatabaseManager, DatabaseStatus};
use tauri::Manager;

#[tauri::command]
async fn initialize_database(
    db_manager: tauri::State<'_, DatabaseManager>,
) -> Result<DatabaseStatus, CommandError> {
    let manager = db_manager.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || manager.initialize())
        .await
        .map_err(|_| CommandError {
            code: "INTERNAL_ERROR".to_string(),
            message: "Database initialization task failed unexpectedly".to_string(),
            field: None,
        })?;

    result.map_err(|err| CommandError::from(&err))
}

#[tauri::command]
async fn get_database_status(
    db_manager: tauri::State<'_, DatabaseManager>,
) -> Result<DatabaseStatus, CommandError> {
    let manager = db_manager.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || manager.health_check())
        .await
        .map_err(|_| CommandError {
            code: "INTERNAL_ERROR".to_string(),
            message: "Database status check task failed unexpectedly".to_string(),
            field: None,
        })?;

    result.map_err(|err| CommandError::from(&err))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let db_manager = match app.path().app_data_dir() {
                Ok(app_data_dir) => DatabaseManager::with_app_data_dir(&app_data_dir),
                Err(_) => DatabaseManager::with_resolution_error(
                    "Failed to resolve application data directory".to_string(),
                ),
            };

            app.manage(db_manager.clone());

            db_manager.mark_startup_in_progress();
            let startup_manager = db_manager;
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(err) = startup_manager.initialize() {
                    startup_manager.complete_startup(Err(CommandError::from(&err).message));
                    eprintln!("[Bizora DB] Startup SQLite initialization failed: {err}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize_database,
            get_database_status,
            db::commands::create_local_profile,
            db::commands::get_local_profile_by_id,
            db::commands::get_local_profiles,
            db::commands::update_local_profile,
            db::commands::create_business,
            db::commands::get_business_by_id,
            db::commands::get_businesses,
            db::commands::update_business,
            db::commands::delete_business,
            db::commands::create_client,
            db::commands::get_client_by_id,
            db::commands::get_clients_by_business,
            db::commands::update_client,
            db::commands::delete_client,
            db::commands::create_quotation,
            db::commands::get_quotation_by_id,
            db::commands::get_quotations_by_business,
            db::commands::get_quotation_items,
            db::commands::update_quotation,
            db::commands::delete_quotation,
            db::commands::create_invoice,
            db::commands::get_invoice_by_id,
            db::commands::get_invoices_by_business,
            db::commands::get_invoice_items,
            db::commands::update_invoice,
            db::commands::delete_invoice,
            db::commands::create_payment,
            db::commands::get_payments_by_invoice,
            db::commands::get_payments_by_business,
            db::commands::delete_payment,
            db::commands::create_activity_log,
            db::commands::get_activity_log_by_id,
            db::commands::get_activity_logs_by_business,
            db::commands::create_business_asset,
            db::commands::get_business_asset_by_id,
            db::commands::get_business_assets_by_business,
            db::commands::delete_business_asset,
            db::commands::get_app_setting,
            db::commands::save_app_setting,
            db::commands::delete_app_setting
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
