import { invoke, isTauri } from '@tauri-apps/api/core';

export interface DatabaseStatus {
  initialized: boolean;
  databasePath: string;
  schemaVersion: number;
  sqliteVersion: string;
  journalMode: string;
  foreignKeysEnabled: boolean;
  busyTimeoutMs: number;
  integrityOk: boolean;
  foreignKeyCheckPassed: boolean;
}

/**
 * Ensures the desktop SQLite database (`bizora.db`) is initialized in the Tauri
 * application data directory and returns structured status/configuration info.
 */
export async function initializeDesktopDatabase(): Promise<DatabaseStatus | null> {
  if (!isTauri()) {
    return null;
  }
  return invoke<DatabaseStatus>('initialize_database');
}

/**
 * Requests a read/verify health check of the desktop SQLite database without
 * replacing existing LocalStorage persistence.
 */
export async function getDesktopDatabaseStatus(): Promise<DatabaseStatus | null> {
  if (!isTauri()) {
    return null;
  }
  return invoke<DatabaseStatus>('get_database_status');
}
