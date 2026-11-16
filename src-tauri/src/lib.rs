mod db;

use db::{DatabaseManager, DatabaseStatus};
use tauri::Manager;

#[tauri::command]
async fn initialize_database(
    db_manager: tauri::State<'_, DatabaseManager>,
) -> Result<DatabaseStatus, String> {
    let manager = db_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.initialize())
        .await
        .map_err(|err| format!("Database initialization task failed: {err}"))?
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn get_database_status(
    db_manager: tauri::State<'_, DatabaseManager>,
) -> Result<DatabaseStatus, String> {
    let manager = db_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.health_check())
        .await
        .map_err(|err| format!("Database status task failed: {err}"))?
        .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let db_manager = match app.path().app_data_dir() {
                Ok(app_data_dir) => DatabaseManager::with_app_data_dir(&app_data_dir),
                Err(err) => DatabaseManager::with_resolution_error(format!(
                    "Failed to resolve Tauri application data directory: {err}"
                )),
            };

            app.manage(db_manager.clone());

            db_manager.mark_startup_in_progress();
            let startup_manager = db_manager;
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(err) = startup_manager.initialize() {
                    startup_manager.complete_startup(Err(err.to_string()));
                    eprintln!("[Bizora DB] Startup SQLite initialization failed: {err}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize_database,
            get_database_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
