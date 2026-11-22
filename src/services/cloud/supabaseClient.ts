import {
  createClient,
  type SupabaseClient,
  type SupportedStorage,
} from '@supabase/supabase-js';
import {
  detectBrowserOnlineStatus,
  resolveCloudAvailabilityState,
  validateSupabaseConfig,
  type CloudAvailabilityState,
  type SupabaseConfigValidationResult,
  type SupabaseEnvInput,
} from './config';
import {
  createDefaultCloudAuthStorage,
  createMemoryAuthStorage,
  type CloudAuthStorage,
} from './secureStorage';

export type SupabaseClientFactory = (
  supabaseUrl: string,
  supabaseKey: string,
  options: {
    auth: {
      storage: SupportedStorage;
      persistSession: boolean;
      autoRefreshToken: boolean;
      detectSessionInUrl: boolean;
      flowType: 'pkce';
    };
  }
) => SupabaseClient;

export interface SupabaseClientManagerOptions {
  env?: SupabaseEnvInput;
  isOnline?: () => boolean;
  storage?: CloudAuthStorage;
  persistSession?: boolean;
  autoRefreshToken?: boolean;
  createClientFn?: SupabaseClientFactory;
  now?: () => string;
}

export interface SupabaseClientManager {
  getConfigStatus: () => SupabaseConfigValidationResult;
  getAuthStorage: () => CloudAuthStorage;
  getClient: () => SupabaseClient | null;
  getAvailability: () => CloudAvailabilityState;
  getInitError: () => string | null;
  subscribeAvailability: (listener: (state: CloudAvailabilityState) => void) => () => void;
}

function sanitizeClientInitError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return `Failed to initialize Supabase client: ${err.message.trim()}`;
  }
  return 'Failed to initialize Supabase client due to an unexpected runtime error.';
}

const defaultCreateSupabaseClient: SupabaseClientFactory = (url, key, options) =>
  createClient(url, key, options);

/**
 * Creates a centralized, singleton-enforcing Supabase client manager.
 * - Never throws when configuration is missing or invalid.
 * - Never instantiates more than one client per manager.
 * - Uses Tauri OS keyring storage on desktop and memory-only storage in browser/tests
 *   (never stores tokens in plaintext `localStorage` or `sessionStorage`).
 */
export function createSupabaseClientManager(
  options?: SupabaseClientManagerOptions
): SupabaseClientManager {
  let cachedConfig: SupabaseConfigValidationResult | null = null;
  let cachedClient: SupabaseClient | null = null;
  let clientInitAttempted = false;
  let clientInitError: string | null = null;

  const authStorage = options?.storage ?? createDefaultCloudAuthStorage();
  const isPersistentDesktopStorage = authStorage.kind === 'tauri_keyring';
  const persistSession = options?.persistSession ?? isPersistentDesktopStorage;
  const autoRefreshToken = options?.autoRefreshToken ?? isPersistentDesktopStorage;

  const resolveOnline = options?.isOnline ?? (() => detectBrowserOnlineStatus());
  const createClientFn = options?.createClientFn ?? defaultCreateSupabaseClient;
  const now = options?.now ?? (() => new Date().toISOString());

  const getConfigStatus = (): SupabaseConfigValidationResult => {
    if (!cachedConfig) {
      cachedConfig = validateSupabaseConfig(options?.env);
    }
    return cachedConfig;
  };

  const getClient = (): SupabaseClient | null => {
    const config = getConfigStatus();
    if (!config.isConfigured || !config.url || !config.publishableKey) {
      return null;
    }

    if (cachedClient) {
      return cachedClient;
    }

    if (clientInitAttempted) {
      return null;
    }

    clientInitAttempted = true;
    try {
      cachedClient = createClientFn(config.url, config.publishableKey, {
        auth: {
          storage: authStorage,
          persistSession,
          autoRefreshToken,
          detectSessionInUrl: false,
          flowType: 'pkce',
        },
      });
      clientInitError = null;
      return cachedClient;
    } catch (err) {
      cachedClient = null;
      clientInitError = sanitizeClientInitError(err);
      return null;
    }
  };

  const getAvailability = (): CloudAvailabilityState => {
    const config = getConfigStatus();
    if (config.isConfigured && !clientInitAttempted) {
      getClient();
    }

    return resolveCloudAvailabilityState({
      config,
      isOnline: resolveOnline(),
      clientInitError,
      checkedAt: now(),
    });
  };

  const subscribeAvailability = (
    listener: (state: CloudAvailabilityState) => void
  ): (() => void) => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return () => {};
    }

    const handleConnectivityChange = () => {
      listener(getAvailability());
    };

    window.addEventListener('online', handleConnectivityChange);
    window.addEventListener('offline', handleConnectivityChange);

    return () => {
      window.removeEventListener('online', handleConnectivityChange);
      window.removeEventListener('offline', handleConnectivityChange);
    };
  };

  return {
    getConfigStatus,
    getAuthStorage: () => authStorage,
    getClient,
    getAvailability,
    getInitError: () => clientInitError,
    subscribeAvailability,
  };
}

export const defaultSupabaseClientManager = createSupabaseClientManager();

export function getSupabaseClient(): SupabaseClient | null {
  return defaultSupabaseClientManager.getClient();
}

export function getSupabaseConfigStatus(): SupabaseConfigValidationResult {
  return defaultSupabaseClientManager.getConfigStatus();
}

export function getCloudAvailabilityState(): CloudAvailabilityState {
  return defaultSupabaseClientManager.getAvailability();
}

export function subscribeCloudAvailability(
  listener: (state: CloudAvailabilityState) => void
): () => void {
  return defaultSupabaseClientManager.subscribeAvailability(listener);
}

export { createMemoryAuthStorage };
