import { invoke } from '@tauri-apps/api/core';
import type { SupportedStorage } from '@supabase/auth-js';
import { isDesktopTauriRuntime } from '../persistence';

export type AuthStorageKind = 'tauri_keyring' | 'memory';

export interface CloudAuthStorage extends SupportedStorage {
  readonly kind: AuthStorageKind;
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void | Promise<void>;
}

export type TauriInvokeFn = <T>(
  cmd: string,
  args?: Record<string, unknown>
) => Promise<T>;

/**
 * In-memory Auth storage adapter for non-desktop browser preview and unit tests.
 * Never writes authentication tokens to plaintext `localStorage` or `sessionStorage`.
 */
export function createMemoryAuthStorage(): CloudAuthStorage {
  const memoryStore = new Map<string, string>();
  return {
    kind: 'memory',
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStore.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStore.delete(key);
    },
  };
}

/**
 * OS-protected persistent credential storage adapter for Tauri desktop builds.
 * On Windows, delegates to the Rust `keyring` backend backed by Windows Credential Manager.
 * Never falls back to plaintext `localStorage` or plaintext disk files.
 */
export function createTauriSecureStorage(
  invoker: TauriInvokeFn = invoke
): CloudAuthStorage {
  return {
    kind: 'tauri_keyring',
    async getItem(key: string): Promise<string | null> {
      const normalized = key.trim();
      if (!normalized) return null;
      const result = await invoker<string | null>('secure_storage_get_item', {
        key: normalized,
      });
      return typeof result === 'string' ? result : null;
    },
    async setItem(key: string, value: string): Promise<void> {
      const normalized = key.trim();
      if (!normalized) {
        throw new Error('Secure storage key must not be empty.');
      }
      await invoker<void>('secure_storage_set_item', {
        key: normalized,
        value,
      });
    },
    async removeItem(key: string): Promise<void> {
      const normalized = key.trim();
      if (!normalized) return;
      await invoker<void>('secure_storage_remove_item', {
        key: normalized,
      });
    },
  };
}

export function createDefaultCloudAuthStorage(
  isDesktop: () => boolean = () => isDesktopTauriRuntime()
): CloudAuthStorage {
  if (isDesktop()) {
    return createTauriSecureStorage();
  }
  return createMemoryAuthStorage();
}
