import { isTauri } from '@tauri-apps/api/core';

import {
  BrowserPersistenceAdapter,
  type BrowserPersistenceAdapterOptions,
} from './browserAdapter';
import {
  SqlitePersistenceAdapter,
  type SqlitePersistenceAdapterOptions,
} from './sqliteAdapter';
import type { PersistenceAdapter, PersistenceBackend } from './types';

export interface PersistenceSelectorOptions {
  isDesktopRuntime?: () => boolean;
  browserOptions?: BrowserPersistenceAdapterOptions;
  sqliteOptions?: SqlitePersistenceAdapterOptions;
}

/**
 * Side-effect-free runtime detection using the project's established `@tauri-apps/api/core` `isTauri()` pattern.
 */
export function isDesktopTauriRuntime(detector: () => boolean = isTauri): boolean {
  try {
    return Boolean(detector());
  } catch {
    return false;
  }
}

/**
 * Resolves the target persistence backend (`'sqlite'` in Tauri desktop, `'localStorage'` in browser)
 * without triggering database initialization, migrations, or storage reads/writes.
 */
export function detectPersistenceBackend(
  detector: () => boolean = isTauri
): PersistenceBackend {
  return isDesktopTauriRuntime(detector) ? 'sqlite' : 'localStorage';
}

/**
 * Creates the environment-appropriate persistence adapter without executing any startup initialization,
 * migration checks, or storage writes.
 */
export function createPersistenceAdapter(
  options?: PersistenceSelectorOptions
): PersistenceAdapter {
  const backend = detectPersistenceBackend(options?.isDesktopRuntime);
  if (backend === 'sqlite') {
    return new SqlitePersistenceAdapter(options?.sqliteOptions);
  }
  return new BrowserPersistenceAdapter(options?.browserOptions);
}

export * from './types';
export {
  BrowserPersistenceAdapter,
  type BrowserPersistenceAdapterOptions,
  type BrowserStorageBackend,
  type BrowserThemeStore,
} from './browserAdapter';
export {
  SqlitePersistenceAdapter,
  type SqlitePersistenceAdapterOptions,
  type SqlitePersistenceBridge,
} from './sqliteAdapter';
