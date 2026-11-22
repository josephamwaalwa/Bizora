import type { Session, User } from '@supabase/supabase-js';
import { getCurrent as getCurrentDeepLinks, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import { isDesktopTauriRuntime } from '../persistence';
import type { CloudAvailabilityState } from './config';
import {
  buildOAuthRedirectUri,
  generateOAuthStateNonce,
  isValidOAuthBrowserUrl,
  OAUTH_STATE_TTL_MS,
  PENDING_OAUTH_STORAGE_KEY,
  validateOAuthCallback,
  type PendingOAuthFlow,
} from './oauthCallback';
import {
  defaultSupabaseClientManager,
  type SupabaseClientManager,
} from './supabaseClient';

export type CloudAuthStatus =
  | 'unconfigured'
  | 'unauthenticated'
  | 'authenticating'
  | 'authenticated'
  | 'unavailable';

export type CloudAuthErrorCode =
  | 'unconfigured'
  | 'offline'
  | 'unavailable'
  | 'validation_error'
  | 'unsupported_environment'
  | 'cancelled'
  | 'duplicate_callback'
  | 'invalid_callback'
  | 'auth_failed';

/**
 * Minimal, non-secret summary of an active cloud session.
 * Raw access/refresh tokens are intentionally excluded from UI/service state.
 */
export interface CloudAuthSession {
  userId: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  provider: string | null;
  expiresAt: number | null;
  isExpired: boolean;
}

export interface CloudAuthNotice {
  kind: 'cancelled' | 'error' | 'info';
  message: string;
}

export interface CloudAuthState {
  status: CloudAuthStatus;
  session: CloudAuthSession | null;
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  availability: CloudAvailabilityState;
  lastNotice: CloudAuthNotice | null;
  error: string | null;
}

export interface CloudAuthResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: CloudAuthErrorCode;
}

export interface CloudAuthServiceDeps {
  isDesktopRuntime?: () => boolean;
  openExternalUrl?: (url: string) => Promise<void>;
  getCurrentDeepLinks?: () => Promise<string[] | null>;
  subscribeDeepLinks?: (handler: (urls: string[]) => void) => Promise<() => void>;
  nowMs?: () => number;
}

export interface CloudAuthService {
  initialize: () => Promise<CloudAuthState>;
  getSnapshot: () => CloudAuthState;
  getAuthState: () => Promise<CloudAuthState>;
  getCurrentSession: () => Promise<CloudAuthSession | null>;
  signInWithGoogle: () => Promise<CloudAuthResult<{ authorizationUrl: string }>>;
  signInWithEmailPassword: (
    email: string,
    password: string
  ) => Promise<CloudAuthResult<CloudAuthSession>>;
  handleOAuthCallbackUrl: (rawUrl: string) => Promise<CloudAuthResult<CloudAuthSession>>;
  refreshSession: () => Promise<CloudAuthResult<CloudAuthSession>>;
  cancelPendingSignIn: () => Promise<void>;
  clearNotice: () => void;
  signOut: () => Promise<CloudAuthResult>;
  onAuthStateChange: (listener: (state: CloudAuthState) => void) => () => void;
  dispose: () => void;
}

function readOptionalMetadataString(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const val = metadata[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return null;
}

function mapSupabaseSession(
  session: Session | null | undefined,
  nowMs: number,
  userOverride?: User | null
): CloudAuthSession | null {
  const user = session?.user ?? userOverride ?? null;
  if (!session || !user?.id) {
    return null;
  }

  const expiresAt = typeof session.expires_at === 'number' ? session.expires_at : null;
  const nowSec = Math.floor(nowMs / 1000);
  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const appMetadata = user.app_metadata as Record<string, unknown> | undefined;

  return {
    userId: user.id,
    email: typeof user.email === 'string' ? user.email : null,
    fullName: readOptionalMetadataString(metadata, ['full_name', 'name']),
    avatarUrl: readOptionalMetadataString(metadata, ['avatar_url', 'picture']),
    provider:
      typeof appMetadata?.provider === 'string' && appMetadata.provider.trim()
        ? appMetadata.provider.trim()
        : null,
    expiresAt,
    isExpired: expiresAt !== null ? expiresAt <= nowSec : false,
  };
}

function sanitizeAuthMessage(err: unknown, fallback: string): string {
  let raw = '';
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) {
      raw = msg.trim();
    }
  } else if (err instanceof Error && err.message.trim()) {
    raw = err.message.trim();
  }

  if (!raw) return fallback;
  return raw
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s]*token=[^\s]+/gi, '[REDACTED_URL]');
}

function isPermanentRefreshTokenError(err: unknown): boolean {
  const message = sanitizeAuthMessage(err, '').toLowerCase();
  return (
    message.includes('invalid_grant') ||
    message.includes('refresh_token_not_found') ||
    message.includes('invalid refresh token') ||
    message.includes('already used') ||
    message.includes('session_not_found')
  );
}

function parsePendingOAuthFlow(raw: string | null): PendingOAuthFlow | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Partial<PendingOAuthFlow>;
    if (
      typeof candidate.nonce !== 'string' ||
      !candidate.nonce.trim() ||
      typeof candidate.createdAtMs !== 'number' ||
      typeof candidate.expiresAtMs !== 'number' ||
      typeof candidate.redirectUri !== 'string'
    ) {
      return null;
    }
    return {
      nonce: candidate.nonce,
      createdAtMs: candidate.createdAtMs,
      expiresAtMs: candidate.expiresAtMs,
      redirectUri: candidate.redirectUri,
      flowId: typeof candidate.flowId === 'string' ? candidate.flowId : null,
    };
  } catch {
    return null;
  }
}

function deriveSupabaseStorageKey(supabaseUrl: string | null): string | null {
  if (!supabaseUrl) return null;
  try {
    const host = new URL(supabaseUrl).hostname;
    const prefix = host.split('.')[0];
    if (!prefix) return null;
    return `sb-${prefix}-auth-token`;
  } catch {
    return null;
  }
}

async function readOfflineStoredSessionSummary(
  clientManager: SupabaseClientManager,
  nowMs: number
): Promise<CloudAuthSession | null> {
  const storageKey = deriveSupabaseStorageKey(clientManager.getConfigStatus().url);
  if (!storageKey) return null;

  try {
    const raw = await clientManager.getAuthStorage().getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Partial<Session>;
    return mapSupabaseSession(candidate as Session, nowMs, candidate.user ?? null);
  } catch {
    return null;
  }
}

/**
 * Isolated Supabase Auth service for desktop Google PKCE OAuth, OS keyring
 * session restoration, token refresh, and offline-resilient state tracking.
 */
export function createCloudAuthService(
  clientManager: SupabaseClientManager = defaultSupabaseClientManager,
  deps?: CloudAuthServiceDeps
): CloudAuthService {
  const isDesktopRuntime = deps?.isDesktopRuntime ?? (() => isDesktopTauriRuntime());
  const openExternalUrl =
    deps?.openExternalUrl ??
    (async (url: string) => {
      await openUrl(url);
    });
  const getInitialDeepLinks =
    deps?.getCurrentDeepLinks ??
    (async () => {
      if (!isDesktopRuntime()) return null;
      return getCurrentDeepLinks();
    });
  const subscribeDeepLinks =
    deps?.subscribeDeepLinks ??
    (async (handler: (urls: string[]) => void) => {
      if (!isDesktopRuntime()) return () => {};
      return onOpenUrl(handler);
    });
  const nowMs = deps?.nowMs ?? (() => Date.now());

  const listeners = new Set<(state: CloudAuthState) => void>();
  const processedFingerprints = new Set<string>();
  const inFlightUrls = new Set<string>();

  let isAuthenticating = false;
  let lastNotice: CloudAuthNotice | null = null;
  let lastError: string | null = null;
  let cachedSession: CloudAuthSession | null = null;
  let initPromise: Promise<CloudAuthState> | null = null;
  let disposed = false;

  let unsubscribeSupabaseAuth: (() => void) | null = null;
  let unsubscribeAvailability: (() => void) | null = null;
  let unsubscribeDeepLink: (() => void) | null = null;

  const computeState = (
    availability: CloudAvailabilityState = clientManager.getAvailability()
  ): CloudAuthState => {
    if (availability.status === 'unconfigured') {
      return {
        status: 'unconfigured',
        session: null,
        isAuthenticated: false,
        isAuthenticating: false,
        availability,
        lastNotice,
        error: lastError,
      };
    }

    if (availability.status === 'unavailable' || availability.status === 'error') {
      return {
        status: 'unavailable',
        session: null,
        isAuthenticated: false,
        isAuthenticating: false,
        availability,
        lastNotice,
        error: lastError ?? availability.reason,
      };
    }

    if (isAuthenticating) {
      return {
        status: 'authenticating',
        session: cachedSession,
        isAuthenticated: cachedSession !== null,
        isAuthenticating: true,
        availability,
        lastNotice,
        error: lastError,
      };
    }

    if (cachedSession) {
      return {
        status: 'authenticated',
        session: cachedSession,
        isAuthenticated: true,
        isAuthenticating: false,
        availability,
        lastNotice,
        error: lastError,
      };
    }

    return {
      status: availability.status === 'offline' ? 'unavailable' : 'unauthenticated',
      session: null,
      isAuthenticated: false,
      isAuthenticating: false,
      availability,
      lastNotice,
      error: lastError,
    };
  };

  const emitState = () => {
    if (disposed) return;
    const next = computeState();
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // Isolate subscriber errors
      }
    }
  };

  const readPendingFlow = async (): Promise<PendingOAuthFlow | null> => {
    try {
      const raw = await clientManager.getAuthStorage().getItem(PENDING_OAUTH_STORAGE_KEY);
      return parsePendingOAuthFlow(raw);
    } catch {
      return null;
    }
  };

  const writePendingFlow = async (flow: PendingOAuthFlow): Promise<void> => {
    await clientManager
      .getAuthStorage()
      .setItem(PENDING_OAUTH_STORAGE_KEY, JSON.stringify(flow));
  };

  const clearPendingFlow = async (): Promise<void> => {
    try {
      await clientManager.getAuthStorage().removeItem(PENDING_OAUTH_STORAGE_KEY);
    } catch {
      // Best-effort cleanup
    }
  };

  const getCurrentSession = async (): Promise<CloudAuthSession | null> => {
    const availability = clientManager.getAvailability();
    const client = clientManager.getClient();
    if (!client) {
      cachedSession = null;
      return null;
    }

    if (!availability.isOnline) {
      cachedSession = await readOfflineStoredSessionSummary(clientManager, nowMs());
      return cachedSession;
    }

    try {
      const { data, error } = await client.auth.getSession();
      if (error) {
        if (!clientManager.getAvailability().isOnline) {
          cachedSession = await readOfflineStoredSessionSummary(clientManager, nowMs());
          return cachedSession;
        }
        cachedSession = null;
        return null;
      }
      if (!data.session) {
        cachedSession = null;
        return null;
      }
      cachedSession = mapSupabaseSession(data.session, nowMs());
      return cachedSession;
    } catch {
      return cachedSession;
    }
  };

  const refreshSession = async (): Promise<CloudAuthResult<CloudAuthSession>> => {
    const availability = clientManager.getAvailability();
    if (availability.status === 'unconfigured') {
      return {
        ok: false,
        code: 'unconfigured',
        error: availability.reason ?? 'Cloud authentication is not configured.',
      };
    }
    if (availability.status === 'offline') {
      return {
        ok: false,
        code: 'offline',
        error: 'Device is offline. Your saved session was preserved and will refresh when reconnected.',
      };
    }

    const client = clientManager.getClient();
    if (!client || availability.status === 'unavailable' || availability.status === 'error') {
      return {
        ok: false,
        code: 'unavailable',
        error: availability.reason ?? 'Cloud authentication service is unavailable.',
      };
    }

    try {
      const { data, error } = await client.auth.refreshSession();
      if (error) {
        if (isPermanentRefreshTokenError(error)) {
          cachedSession = null;
          lastError = 'Your cloud session expired. Please sign in with Google again.';
          lastNotice = { kind: 'error', message: lastError };
          try {
            await client.auth.signOut({ scope: 'local' });
          } catch {
            // Ignore local cleanup errors
          }
          emitState();
        }
        return {
          ok: false,
          code: 'auth_failed',
          error: sanitizeAuthMessage(error, 'Failed to refresh cloud session.'),
        };
      }

      const mapped = mapSupabaseSession(data.session, nowMs(), data.user);
      if (!mapped) {
        return {
          ok: false,
          code: 'auth_failed',
          error: 'No active session available to refresh.',
        };
      }

      cachedSession = mapped;
      lastError = null;
      emitState();
      return {
        ok: true,
        data: mapped,
      };
    } catch (err) {
      return {
        ok: false,
        code: 'auth_failed',
        error: sanitizeAuthMessage(err, 'Unable to refresh cloud session right now.'),
      };
    }
  };

  const getAuthState = async (): Promise<CloudAuthState> => {
    const availability = clientManager.getAvailability();

    if (availability.status === 'unconfigured') {
      cachedSession = null;
      return computeState(availability);
    }

    if (availability.status === 'unavailable' || availability.status === 'error') {
      cachedSession = null;
      return computeState(availability);
    }

    const client = clientManager.getClient();
    if (!client) {
      cachedSession = null;
      return computeState(availability);
    }

    if (!availability.isOnline) {
      cachedSession = await readOfflineStoredSessionSummary(clientManager, nowMs());
      return computeState(availability);
    }

    try {
      const { data, error } = await client.auth.getSession();
      if (error) {
        const storedFallback = await readOfflineStoredSessionSummary(clientManager, nowMs());
        if (storedFallback && isPermanentRefreshTokenError(error) === false) {
          // Preserve stored session summary if refresh failed transiently while offline/unreachable
          cachedSession = storedFallback;
        }
        lastError = sanitizeAuthMessage(error, 'Unable to read cloud authentication session.');
        return computeState(availability);
      }

      cachedSession = mapSupabaseSession(data.session, nowMs());
      return computeState(availability);
    } catch (err) {
      lastError = sanitizeAuthMessage(err, 'Unable to check cloud authentication status.');
      return computeState(availability);
    }
  };

  const handleOAuthCallbackUrl = async (
    rawUrl: string
  ): Promise<CloudAuthResult<CloudAuthSession>> => {
    const trimmedUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!trimmedUrl) {
      return { ok: false, code: 'invalid_callback', error: 'Empty callback URL.' };
    }

    if (inFlightUrls.has(trimmedUrl)) {
      return {
        ok: false,
        code: 'duplicate_callback',
        error: 'Duplicate OAuth callback ignored while processing.',
      };
    }

    inFlightUrls.add(trimmedUrl);
    try {
      const pendingFlow = await readPendingFlow();
      const validation = validateOAuthCallback({
        rawUrl: trimmedUrl,
        pendingFlow,
        nowMs: nowMs(),
        processedFingerprints,
      });

      if (validation.kind === 'ignored') {
        return {
          ok: false,
          code: 'invalid_callback',
          error: 'Ignored non-authentication deep link.',
        };
      }

      if (validation.kind === 'duplicate') {
        return {
          ok: false,
          code: 'duplicate_callback',
          error: 'Duplicate OAuth callback was already processed.',
        };
      }

      processedFingerprints.add(validation.fingerprint);

      if (validation.kind === 'cancelled') {
        await clearPendingFlow();
        isAuthenticating = false;
        lastError = null;
        lastNotice = { kind: 'cancelled', message: validation.reason };
        emitState();
        return {
          ok: false,
          code: 'cancelled',
          error: validation.reason,
        };
      }

      if (validation.kind === 'failed') {
        await clearPendingFlow();
        isAuthenticating = false;
        lastError = validation.reason;
        lastNotice = { kind: 'error', message: validation.reason };
        emitState();
        return {
          ok: false,
          code: 'invalid_callback',
          error: validation.reason,
        };
      }

      // Consume pending OAuth state immediately so the code/nonce cannot be replayed
      await clearPendingFlow();

      const availability = clientManager.getAvailability();
      if (availability.status === 'offline') {
        isAuthenticating = false;
        lastError = 'Cannot complete Google sign-in while offline.';
        lastNotice = { kind: 'error', message: lastError };
        emitState();
        return {
          ok: false,
          code: 'offline',
          error: lastError,
        };
      }

      const client = clientManager.getClient();
      if (!client || availability.status === 'unconfigured' || availability.status === 'unavailable' || availability.status === 'error') {
        isAuthenticating = false;
        lastError = availability.reason ?? 'Cloud authentication client is unavailable.';
        lastNotice = { kind: 'error', message: lastError };
        emitState();
        return {
          ok: false,
          code: availability.status === 'unconfigured' ? 'unconfigured' : 'unavailable',
          error: lastError,
        };
      }

      const { data, error } = await client.auth.exchangeCodeForSession(
        validation.code,
        validation.flowId ? { flowId: validation.flowId } : undefined
      );

      if (error) {
        isAuthenticating = false;
        lastError = sanitizeAuthMessage(
          error,
          'Could not complete Google sign-in. Please try again.'
        );
        lastNotice = { kind: 'error', message: lastError };
        emitState();
        return {
          ok: false,
          code: 'auth_failed',
          error: lastError,
        };
      }

      const mapped = mapSupabaseSession(data.session, nowMs(), data.user);
      if (!mapped) {
        isAuthenticating = false;
        lastError = 'Google sign-in did not return a valid session.';
        lastNotice = { kind: 'error', message: lastError };
        emitState();
        return {
          ok: false,
          code: 'auth_failed',
          error: lastError,
        };
      }

      cachedSession = mapped;
      isAuthenticating = false;
      lastError = null;
      lastNotice = null;
      emitState();

      return {
        ok: true,
        data: mapped,
      };
    } catch (err) {
      await clearPendingFlow();
      isAuthenticating = false;
      lastError = sanitizeAuthMessage(err, 'Unexpected error while completing Google sign-in.');
      lastNotice = { kind: 'error', message: lastError };
      emitState();
      return {
        ok: false,
        code: 'auth_failed',
        error: lastError,
      };
    } finally {
      inFlightUrls.delete(trimmedUrl);
    }
  };

  const signInWithGoogle = async (): Promise<
    CloudAuthResult<{ authorizationUrl: string }>
  > => {
    const availability = clientManager.getAvailability();

    if (availability.status === 'unconfigured') {
      return {
        ok: false,
        code: 'unconfigured',
        error: availability.reason ?? 'Cloud authentication is not configured.',
      };
    }

    if (availability.status === 'offline') {
      return {
        ok: false,
        code: 'offline',
        error: 'Cannot sign in with Google while offline. Reconnect to the internet and try again.',
      };
    }

    const client = clientManager.getClient();
    if (!client || availability.status === 'unavailable' || availability.status === 'error') {
      return {
        ok: false,
        code: 'unavailable',
        error: availability.reason ?? 'Cloud authentication service is unavailable.',
      };
    }

    if (!isDesktopRuntime() && !deps?.openExternalUrl) {
      return {
        ok: false,
        code: 'unsupported_environment',
        error:
          'Google desktop sign-in requires the Bizora Windows desktop app for deep-link callbacks.',
      };
    }

    lastError = null;
    lastNotice = null;
    isAuthenticating = true;
    emitState();

    try {
      const nonce = generateOAuthStateNonce();
      const redirectTo = buildOAuthRedirectUri(nonce);
      const createdAtMs = nowMs();

      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: true,
          queryParams: {
            access_type: 'offline',
            prompt: 'select_account',
          },
        },
      });

      if (error || !data?.url || !isValidOAuthBrowserUrl(data.url)) {
        await clearPendingFlow();
        isAuthenticating = false;
        lastError = error
          ? sanitizeAuthMessage(error, 'Failed to start Google sign-in.')
          : 'Received an invalid authorization URL from cloud authentication.';
        lastNotice = { kind: 'error', message: lastError };
        emitState();
        return {
          ok: false,
          code: 'auth_failed',
          error: lastError,
        };
      }

      const flowId =
        'flowId' in data && typeof (data as { flowId?: unknown }).flowId === 'string'
          ? (data as { flowId: string }).flowId
          : null;

      await writePendingFlow({
        nonce,
        createdAtMs,
        expiresAtMs: createdAtMs + OAUTH_STATE_TTL_MS,
        redirectUri: redirectTo,
        flowId,
      });

      await openExternalUrl(data.url);

      return {
        ok: true,
        data: { authorizationUrl: data.url },
      };
    } catch (err) {
      await clearPendingFlow();
      isAuthenticating = false;
      lastError = sanitizeAuthMessage(
        err,
        'Unable to open your system browser for Google sign-in.'
      );
      lastNotice = { kind: 'error', message: lastError };
      emitState();
      return {
        ok: false,
        code: 'auth_failed',
        error: lastError,
      };
    }
  };

  const signInWithEmailPassword = async (
    email: string,
    password: string
  ): Promise<CloudAuthResult<CloudAuthSession>> => {
    const trimmedEmail = typeof email === 'string' ? email.trim() : '';
    if (!trimmedEmail || !password) {
      return {
        ok: false,
        code: 'validation_error',
        error: 'Email and password are required to sign in.',
      };
    }

    const availability = clientManager.getAvailability();
    if (availability.status === 'unconfigured') {
      return {
        ok: false,
        code: 'unconfigured',
        error: availability.reason ?? 'Cloud authentication is not configured.',
      };
    }
    if (availability.status === 'offline') {
      return {
        ok: false,
        code: 'offline',
        error: availability.reason ?? 'Cannot sign in while offline.',
      };
    }

    const client = clientManager.getClient();
    if (!client || availability.status === 'unavailable' || availability.status === 'error') {
      return {
        ok: false,
        code: 'unavailable',
        error: availability.reason ?? 'Cloud authentication service is unavailable.',
      };
    }

    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });

      if (error) {
        return {
          ok: false,
          code: 'auth_failed',
          error: sanitizeAuthMessage(error, 'Cloud sign-in failed.'),
        };
      }

      const mapped = mapSupabaseSession(data.session, nowMs(), data.user);
      if (!mapped) {
        return {
          ok: false,
          code: 'auth_failed',
          error: 'Sign-in did not produce an active session.',
        };
      }

      cachedSession = mapped;
      lastError = null;
      lastNotice = null;
      emitState();

      return {
        ok: true,
        data: mapped,
      };
    } catch (err) {
      return {
        ok: false,
        code: 'auth_failed',
        error: sanitizeAuthMessage(err, 'Cloud sign-in failed unexpectedly.'),
      };
    }
  };

  const cancelPendingSignIn = async (): Promise<void> => {
    await clearPendingFlow();
    if (isAuthenticating) {
      isAuthenticating = false;
      lastNotice = {
        kind: 'cancelled',
        message: 'Google sign-in was cancelled.',
      };
      emitState();
    }
  };

  const clearNotice = (): void => {
    if (lastNotice !== null || lastError !== null) {
      lastNotice = null;
      lastError = null;
      emitState();
    }
  };

  const signOut = async (): Promise<CloudAuthResult> => {
    await clearPendingFlow();
    isAuthenticating = false;
    lastNotice = null;
    lastError = null;

    const client = clientManager.getClient();
    if (!client) {
      cachedSession = null;
      emitState();
      return { ok: true };
    }

    const availability = clientManager.getAvailability();
    try {
      const { error } = await client.auth.signOut(
        availability.status === 'offline' ? { scope: 'local' } : undefined
      );
      if (error) {
        lastError = sanitizeAuthMessage(error, 'Failed to sign out of cloud session.');
        emitState();
        return {
          ok: false,
          code: 'auth_failed',
          error: lastError,
        };
      }

      cachedSession = null;
      emitState();
      return { ok: true };
    } catch (err) {
      lastError = sanitizeAuthMessage(err, 'Failed to sign out of cloud session.');
      emitState();
      return {
        ok: false,
        code: 'auth_failed',
        error: lastError,
      };
    }
  };

  const initialize = async (): Promise<CloudAuthState> => {
    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      if (!unsubscribeAvailability) {
        unsubscribeAvailability = clientManager.subscribeAvailability((nextAvailability) => {
          emitState();
          if (nextAvailability.isOnline && cachedSession?.isExpired) {
            void refreshSession();
          }
        });
      }

      const client = clientManager.getClient();
      if (client && !unsubscribeSupabaseAuth) {
        const { data } = client.auth.onAuthStateChange((_event, session) => {
          cachedSession = mapSupabaseSession(session, nowMs());
          if (cachedSession) {
            isAuthenticating = false;
            lastError = null;
          }
          emitState();
        });
        unsubscribeSupabaseAuth = () => {
          data.subscription.unsubscribe();
        };
      }

      if (!unsubscribeDeepLink) {
        try {
          unsubscribeDeepLink = await subscribeDeepLinks((urls) => {
            for (const url of urls) {
              void handleOAuthCallbackUrl(url);
            }
          });
        } catch {
          unsubscribeDeepLink = () => {};
        }
      }

      // Restore any persisted OS keyring session cleanly without blocking or erasing when offline
      await getAuthState();

      if (cachedSession && cachedSession.isExpired && clientManager.getAvailability().isOnline) {
        await refreshSession();
      }

      // Process any cold-launch deep-link URLs delivered via OS protocol invocation
      let initialUrls: string[] | null = null;
      try {
        initialUrls = await getInitialDeepLinks();
      } catch {
        initialUrls = null;
      }

      if (initialUrls && initialUrls.length > 0) {
        for (const url of initialUrls) {
          await handleOAuthCallbackUrl(url);
        }
      } else {
        const pending = await readPendingFlow();
        if (pending && nowMs() > pending.expiresAtMs) {
          await clearPendingFlow();
        }
      }

      const finalState = computeState();
      emitState();
      return finalState;
    })();

    return initPromise;
  };

  const onAuthStateChange = (listener: (state: CloudAuthState) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const dispose = (): void => {
    disposed = true;
    listeners.clear();
    if (unsubscribeSupabaseAuth) {
      unsubscribeSupabaseAuth();
      unsubscribeSupabaseAuth = null;
    }
    if (unsubscribeAvailability) {
      unsubscribeAvailability();
      unsubscribeAvailability = null;
    }
    if (unsubscribeDeepLink) {
      unsubscribeDeepLink();
      unsubscribeDeepLink = null;
    }
  };

  return {
    initialize,
    getSnapshot: () => computeState(),
    getAuthState,
    getCurrentSession,
    signInWithGoogle,
    signInWithEmailPassword,
    handleOAuthCallbackUrl,
    refreshSession,
    cancelPendingSignIn,
    clearNotice,
    signOut,
    onAuthStateChange,
    dispose,
  };
}

export const cloudAuthService = createCloudAuthService();
