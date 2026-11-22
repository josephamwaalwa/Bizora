import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

import {
  BIZORA_OAUTH_REDIRECT_URI,
  PENDING_OAUTH_STORAGE_KEY,
  buildOAuthRedirectUri,
  createCloudAuthService,
  createMemoryAuthStorage,
  createSupabaseClientManager,
  createTauriSecureStorage,
  generateOAuthStateNonce,
  isValidOAuthBrowserUrl,
  parseOAuthCallbackUrl,
  timingSafeEqualStrings,
  validateOAuthCallback,
  type CloudAuthStorage,
  type PendingOAuthFlow,
} from './index';

function makeValidAnonKey(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: 'supabase', ref: 'bizora-test-ref', role: 'anon' })
  ).toString('base64url');
  return `${header}.${payload}.test_sig_123456789`;
}

function makeFakeSession(overrides?: Partial<Session>): Session {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    access_token: 'fake-access-token-never-expose-in-ui',
    refresh_token: 'fake-refresh-token-never-expose-in-ui',
    expires_in: 3600,
    expires_at: nowSec + 3600,
    token_type: 'bearer',
    user: {
      id: 'user-123',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'elena@bizora.na',
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: {
        full_name: 'Elena Shikongo',
        avatar_url: 'https://lh3.googleusercontent.com/a/avatar-test',
      },
      created_at: '2026-11-20T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeFakeSupabaseHarness(options: {
  storage: CloudAuthStorage;
  storageKey?: string;
  initialSession?: Session | null;
  exchangeResult?: (
    code: string,
    opts?: { flowId?: string }
  ) => Promise<{ data: { session: Session | null; user: Session['user'] | null }; error: { message: string } | null }>;
  refreshResult?: () => Promise<{
    data: { session: Session | null; user: Session['user'] | null };
    error: { message: string } | null;
  }>;
}) {
  const storageKey = options.storageKey ?? 'sb-bizora-project-auth-token';
  let currentSession: Session | null = options.initialSession ?? null;
  const authListeners = new Set<(event: string, session: Session | null) => void>();
  const exchangeCalls: Array<{ code: string; flowId?: string }> = [];
  const signOutCalls: Array<{ scope?: string } | undefined> = [];
  let lastSignInOptions: Record<string, unknown> | null = null;

  const client = {
    auth: {
      async getSession() {
        if (!currentSession) {
          const raw = await options.storage.getItem(storageKey);
          if (raw) {
            currentSession = JSON.parse(raw) as Session;
          }
        }
        return { data: { session: currentSession }, error: null };
      },
      async signInWithOAuth(args: { provider: string; options?: Record<string, unknown> }) {
        lastSignInOptions = args.options ?? null;
        const redirectTo = String(args.options?.redirectTo ?? BIZORA_OAUTH_REDIRECT_URI);
        return {
          data: {
            provider: args.provider,
            url: `https://bizora-project.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`,
            flowId: 'pkce-flow-id-001',
          },
          error: null,
        };
      },
      async exchangeCodeForSession(code: string, opts?: { flowId?: string }) {
        exchangeCalls.push({ code, flowId: opts?.flowId });
        if (options.exchangeResult) {
          const res = await options.exchangeResult(code, opts);
          if (!res.error && res.data.session) {
            currentSession = res.data.session;
            await options.storage.setItem(storageKey, JSON.stringify(currentSession));
            for (const listener of authListeners) {
              listener('SIGNED_IN', currentSession);
            }
          }
          return res;
        }
        const session = makeFakeSession();
        currentSession = session;
        await options.storage.setItem(storageKey, JSON.stringify(session));
        for (const listener of authListeners) {
          listener('SIGNED_IN', session);
        }
        return { data: { session, user: session.user }, error: null };
      },
      async refreshSession() {
        if (options.refreshResult) {
          const res = await options.refreshResult();
          if (!res.error && res.data.session) {
            currentSession = res.data.session;
            await options.storage.setItem(storageKey, JSON.stringify(currentSession));
          }
          return res;
        }
        const refreshed = makeFakeSession();
        currentSession = refreshed;
        await options.storage.setItem(storageKey, JSON.stringify(refreshed));
        return { data: { session: refreshed, user: refreshed.user }, error: null };
      },
      async signOut(opts?: { scope?: string }) {
        signOutCalls.push(opts);
        currentSession = null;
        await options.storage.removeItem(storageKey);
        for (const listener of authListeners) {
          listener('SIGNED_OUT', null);
        }
        return { error: null };
      },
      onAuthStateChange(cb: (event: string, session: Session | null) => void) {
        authListeners.add(cb);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                authListeners.delete(cb);
              },
            },
          },
        };
      },
    },
  } as unknown as SupabaseClient;

  return {
    client,
    getExchangeCalls: () => exchangeCalls,
    getSignOutCalls: () => signOutCalls,
    getLastSignInOptions: () => lastSignInOptions,
    setCurrentSession: (next: Session | null) => {
      currentSession = next;
    },
  };
}

test('OAuth callback parser and state validation enforce PKCE rules, constant-time state, expiry, and replay protection', () => {
  const nonce = generateOAuthStateNonce();
  assert.ok(nonce.length >= 32);

  const redirect = buildOAuthRedirectUri(nonce);
  assert.ok(redirect.startsWith(`${BIZORA_OAUTH_REDIRECT_URI}?bizora_state=`));
  assert.equal(isValidOAuthBrowserUrl('https://bizora-project.supabase.co/auth/v1/authorize'), true);
  assert.equal(isValidOAuthBrowserUrl('javascript:alert(1)'), false);
  assert.equal(timingSafeEqualStrings('abc123', 'abc123'), true);
  assert.equal(timingSafeEqualStrings('abc123', 'abc124'), false);

  const pendingFlow: PendingOAuthFlow = {
    nonce,
    createdAtMs: 1_000_000,
    expiresAtMs: 1_600_000,
    redirectUri: redirect,
    flowId: 'flow-abc',
  };

  // Non-callback URL ignored
  const ignored = validateOAuthCallback({
    rawUrl: 'bizora://invoice/123',
    pendingFlow,
    nowMs: 1_100_000,
    processedFingerprints: new Set(),
  });
  assert.equal(ignored.kind, 'ignored');

  // Implicit token grant rejected
  const unexpectedTokens = validateOAuthCallback({
    rawUrl: `bizora://auth/callback?access_token=secret&bizora_state=${nonce}`,
    pendingFlow,
    nowMs: 1_100_000,
    processedFingerprints: new Set(),
  });
  assert.equal(unexpectedTokens.kind, 'failed');

  // Mismatched state rejected
  const wrongState = validateOAuthCallback({
    rawUrl: 'bizora://auth/callback?code=auth-code-1&bizora_state=wrong-state',
    pendingFlow,
    nowMs: 1_100_000,
    processedFingerprints: new Set(),
  });
  assert.equal(wrongState.kind, 'failed');

  // Expired pending flow rejected
  const expired = validateOAuthCallback({
    rawUrl: `bizora://auth/callback?code=auth-code-1&bizora_state=${nonce}`,
    pendingFlow,
    nowMs: 1_700_000,
    processedFingerprints: new Set(),
  });
  assert.equal(expired.kind, 'failed');

  // Missing code rejected
  const missingParams = parseOAuthCallbackUrl(`bizora://auth/callback?bizora_state=${nonce}`);
  assert.equal(missingParams.isCallbackUrl, true);
  assert.equal(missingParams.code, null);
  const missingCodeRes = validateOAuthCallback({
    rawUrl: `bizora://auth/callback?bizora_state=${nonce}`,
    pendingFlow,
    nowMs: 1_100_000,
    processedFingerprints: new Set(),
  });
  assert.equal(missingCodeRes.kind, 'failed');

  // Valid PKCE callback succeeds and duplicate is blocked
  const processed = new Set<string>();
  const valid = validateOAuthCallback({
    rawUrl: `bizora://auth/callback?code=pkce-code-99&bizora_state=${nonce}`,
    pendingFlow,
    nowMs: 1_100_000,
    processedFingerprints: processed,
  });
  assert.equal(valid.kind, 'valid_code');
  if (valid.kind === 'valid_code') {
    assert.equal(valid.code, 'pkce-code-99');
    assert.equal(valid.flowId, 'flow-abc');
    processed.add(valid.fingerprint);
  }

  const duplicate = validateOAuthCallback({
    rawUrl: `bizora://auth/callback?code=pkce-code-99&bizora_state=${nonce}`,
    pendingFlow,
    nowMs: 1_100_001,
    processedFingerprints: processed,
  });
  assert.equal(duplicate.kind, 'duplicate');
});

test('Google PKCE OAuth flow opens system browser, validates callback, rejects duplicate delivery, and hides raw tokens', async () => {
  const storage = createMemoryAuthStorage();
  const harness = makeFakeSupabaseHarness({ storage });
  const openedUrls: string[] = [];
  let deepLinkHandler: ((urls: string[]) => void) | null = null;

  const manager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage,
    isOnline: () => true,
    createClientFn: () => harness.client,
  });

  const authService = createCloudAuthService(manager, {
    isDesktopRuntime: () => true,
    openExternalUrl: async (url) => {
      openedUrls.push(url);
    },
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async (handler) => {
      deepLinkHandler = handler;
      return () => {
        deepLinkHandler = null;
      };
    },
  });

  const initialState = await authService.initialize();
  assert.equal(initialState.status, 'unauthenticated');
  assert.equal(initialState.isAuthenticated, false);

  const startRes = await authService.signInWithGoogle();
  assert.equal(startRes.ok, true);
  assert.equal(openedUrls.length, 1);
  assert.equal(harness.getLastSignInOptions()?.skipBrowserRedirect, true);
  assert.equal(authService.getSnapshot().status, 'authenticating');

  // Pending state nonce was saved in secure storage
  const rawPending = await storage.getItem(PENDING_OAUTH_STORAGE_KEY);
  assert.ok(rawPending);
  const pending = JSON.parse(rawPending) as PendingOAuthFlow;

  const callbackUrl = `bizora://auth/callback?code=valid-oauth-code&bizora_state=${encodeURIComponent(pending.nonce)}`;
  const callbackRes = await authService.handleOAuthCallbackUrl(callbackUrl);
  assert.equal(callbackRes.ok, true);
  assert.equal(callbackRes.data?.email, 'elena@bizora.na');
  assert.equal('access_token' in (callbackRes.data ?? {}), false);
  assert.equal('refresh_token' in (callbackRes.data ?? {}), false);
  assert.equal(harness.getExchangeCalls().length, 1);
  assert.equal(harness.getExchangeCalls()[0]?.flowId, 'pkce-flow-id-001');

  // Pending state must be consumed after callback
  assert.equal(await storage.getItem(PENDING_OAUTH_STORAGE_KEY), null);

  // Duplicate callback delivery must be blocked without invoking exchangeCodeForSession again
  const duplicateRes = await authService.handleOAuthCallbackUrl(callbackUrl);
  assert.equal(duplicateRes.ok, false);
  assert.equal(duplicateRes.code, 'duplicate_callback');
  assert.equal(harness.getExchangeCalls().length, 1);

  assert.ok(deepLinkHandler !== null);
  authService.dispose();
  assert.equal(deepLinkHandler, null);
});

test('cancelled OAuth and expired authorization code failures never create an authenticated session', async () => {
  const storage = createMemoryAuthStorage();
  const harness = makeFakeSupabaseHarness({
    storage,
    exchangeResult: async () => ({
      data: { session: null, user: null },
      error: { message: 'Authorization code expired or already used' },
    }),
  });

  const manager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage,
    isOnline: () => true,
    createClientFn: () => harness.client,
  });

  const authService = createCloudAuthService(manager, {
    isDesktopRuntime: () => true,
    openExternalUrl: async () => {},
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });

  await authService.initialize();

  // 1. Cancelled in browser
  await authService.signInWithGoogle();
  const pendingCancel = JSON.parse((await storage.getItem(PENDING_OAUTH_STORAGE_KEY))!) as PendingOAuthFlow;
  const cancelRes = await authService.handleOAuthCallbackUrl(
    `bizora://auth/callback?error=access_denied&error_description=User+cancelled+login&bizora_state=${encodeURIComponent(pendingCancel.nonce)}`
  );
  assert.equal(cancelRes.ok, false);
  assert.equal(cancelRes.code, 'cancelled');
  assert.equal(authService.getSnapshot().isAuthenticated, false);
  assert.equal(authService.getSnapshot().status, 'unauthenticated');
  assert.equal(authService.getSnapshot().lastNotice?.kind, 'cancelled');

  // 2. Expired / failed code exchange
  await authService.signInWithGoogle();
  const pendingExpired = JSON.parse((await storage.getItem(PENDING_OAUTH_STORAGE_KEY))!) as PendingOAuthFlow;
  const failedRes = await authService.handleOAuthCallbackUrl(
    `bizora://auth/callback?code=expired-code&bizora_state=${encodeURIComponent(pendingExpired.nonce)}`
  );
  assert.equal(failedRes.ok, false);
  assert.equal(failedRes.code, 'auth_failed');
  assert.equal(authService.getSnapshot().isAuthenticated, false);
  assert.equal(authService.getSnapshot().session, null);
  assert.equal(authService.getSnapshot().lastNotice?.kind, 'error');

  authService.dispose();
});

test('Tauri OS secure storage persists sessions across simulated app restarts, cold-launch callbacks, offline preservation, and sign-out', async () => {
  // Simulate Windows Credential Manager store via Tauri IPC commands
  const osKeyringBackingStore = new Map<string, string>();
  const invokeCalls: string[] = [];

  const createDesktopStorage = () =>
    createTauriSecureStorage(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      invokeCalls.push(cmd);
      const key = String(args?.key ?? '');
      if (cmd === 'secure_storage_get_item') {
        return (osKeyringBackingStore.get(key) ?? null) as T;
      }
      if (cmd === 'secure_storage_set_item') {
        osKeyringBackingStore.set(key, String(args?.value ?? ''));
        return undefined as T;
      }
      if (cmd === 'secure_storage_remove_item') {
        osKeyringBackingStore.delete(key);
        return undefined as T;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

  // --- Launch 1: User starts Google sign-in, OS cold-launches with callback ---
  const storage1 = createDesktopStorage();
  const harness1 = makeFakeSupabaseHarness({ storage: storage1 });
  const manager1 = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage: storage1,
    isOnline: () => true,
    createClientFn: () => harness1.client,
  });

  const auth1 = createCloudAuthService(manager1, {
    isDesktopRuntime: () => true,
    openExternalUrl: async () => {},
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });

  await auth1.initialize();
  await auth1.signInWithGoogle();
  const pending = JSON.parse(
    (await storage1.getItem(PENDING_OAUTH_STORAGE_KEY))!
  ) as PendingOAuthFlow;
  auth1.dispose();

  // --- Launch 2: Cold launch via deep-link URL restores pending flow and completes login ---
  const storage2 = createDesktopStorage();
  const harness2 = makeFakeSupabaseHarness({ storage: storage2 });
  const manager2 = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage: storage2,
    isOnline: () => true,
    createClientFn: () => harness2.client,
  });

  const auth2 = createCloudAuthService(manager2, {
    isDesktopRuntime: () => true,
    openExternalUrl: async () => {},
    getCurrentDeepLinks: async () => [
      `bizora://auth/callback?code=cold-launch-code&bizora_state=${encodeURIComponent(pending.nonce)}`,
    ],
    subscribeDeepLinks: async () => () => {},
  });

  const coldLaunchState = await auth2.initialize();
  assert.equal(coldLaunchState.status, 'authenticated');
  assert.equal(coldLaunchState.session?.email, 'elena@bizora.na');
  assert.ok(osKeyringBackingStore.has('sb-bizora-project-auth-token'));
  assert.ok(invokeCalls.includes('secure_storage_set_item'));
  auth2.dispose();

  // --- Launch 3 (Scenario C): Previously signed in, now OFFLINE -> session preserved, NOT erased ---
  const storage3 = createDesktopStorage();
  const harness3 = makeFakeSupabaseHarness({ storage: storage3 });
  const manager3 = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage: storage3,
    isOnline: () => false,
    createClientFn: () => harness3.client,
  });

  const auth3 = createCloudAuthService(manager3, {
    isDesktopRuntime: () => true,
    openExternalUrl: async () => {},
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });

  const offlineRestored = await auth3.initialize();
  assert.equal(offlineRestored.availability.status, 'offline');
  assert.equal(offlineRestored.availability.isCloudAvailable, false);
  assert.equal(offlineRestored.isAuthenticated, true);
  assert.equal(offlineRestored.session?.email, 'elena@bizora.na');
  assert.ok(osKeyringBackingStore.has('sb-bizora-project-auth-token'));

  // Scenario E: Sign out offline cleans local keyring cleanly
  const signOutRes = await auth3.signOut();
  assert.equal(signOutRes.ok, true);
  assert.equal(harness3.getSignOutCalls()[0]?.scope, 'local');
  assert.equal(auth3.getSnapshot().isAuthenticated, false);
  assert.equal(auth3.getSnapshot().session, null);
  assert.equal(osKeyringBackingStore.has('sb-bizora-project-auth-token'), false);
  auth3.dispose();
});
