import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

import {
  BIZORA_PASSWORD_RECOVERY_REDIRECT_URI,
  createCloudAuthService,
  createMemoryAuthStorage,
  createSupabaseClientManager,
  validateSupabaseConfig,
  type CloudAuthStorage,
} from './index';
import { resolveAuthGateView } from '../../components/auth/authGateState';
import { BrowserPersistenceAdapter } from '../persistence';
import { initialClients, initialInvoices, initialQuotations } from '../seedData';

function makeValidAnonKey(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: 'supabase', ref: 'bizora-test-ref', role: 'anon' })
  ).toString('base64url');
  return `${header}.${payload}.test_sig_auth_gate_12345`;
}

function makeFakeSession(overrides?: Partial<Session>): Session {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    access_token: 'fake-access-token-secret',
    refresh_token: 'fake-refresh-token-secret',
    expires_in: 3600,
    expires_at: nowSec + 3600,
    token_type: 'bearer',
    user: {
      id: 'user-auth-gate-1',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'tomas@bizora.na',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { full_name: 'Tomas Amupanda' },
      created_at: '2026-11-20T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeFullAuthSupabaseHarness(options: {
  storage: CloudAuthStorage;
  storageKey?: string;
  initialSession?: Session | null;
  signInError?: string | null;
  signUpConfirmationRequired?: boolean;
  resetError?: string | null;
  updatePasswordError?: string | null;
  refreshSessionResult?: () => Promise<{
    data: { session: Session | null; user: Session['user'] | null };
    error: { message: string } | null;
  }>;
}) {
  const storageKey = options.storageKey ?? 'sb-bizora-project-auth-token';
  let currentSession: Session | null = options.initialSession ?? null;
  const authListeners = new Set<(event: string, session: Session | null) => void>();
  const resetCalls: Array<{ email: string; redirectTo?: string }> = [];
  const updateCalls: Array<{ password?: string }> = [];
  const signOutCalls: Array<{ scope?: string } | undefined> = [];

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
      async signInWithPassword(args: { email: string; password: string }) {
        if (options.signInError) {
          return {
            data: { session: null, user: null },
            error: { message: options.signInError },
          };
        }
        const session = makeFakeSession({
          user: {
            ...makeFakeSession().user,
            email: args.email,
          },
        });
        currentSession = session;
        await options.storage.setItem(storageKey, JSON.stringify(session));
        for (const listener of authListeners) {
          listener('SIGNED_IN', session);
        }
        return { data: { session, user: session.user }, error: null };
      },
      async signUp(args: {
        email: string;
        password: string;
        options?: { data?: { full_name?: string } };
      }) {
        const user = {
          ...makeFakeSession().user,
          id: 'user-new-1',
          email: args.email,
          user_metadata: { full_name: args.options?.data?.full_name ?? '' },
        };
        if (options.signUpConfirmationRequired) {
          return {
            data: { session: null, user },
            error: null,
          };
        }
        const session = makeFakeSession({ user });
        currentSession = session;
        await options.storage.setItem(storageKey, JSON.stringify(session));
        for (const listener of authListeners) {
          listener('SIGNED_IN', session);
        }
        return { data: { session, user }, error: null };
      },
      async resetPasswordForEmail(email: string, opts?: { redirectTo?: string }) {
        resetCalls.push({ email, redirectTo: opts?.redirectTo });
        if (options.resetError) {
          return { data: null, error: { message: options.resetError } };
        }
        return { data: {}, error: null };
      },
      async exchangeCodeForSession() {
        const session = makeFakeSession();
        currentSession = session;
        await options.storage.setItem(storageKey, JSON.stringify(session));
        for (const listener of authListeners) {
          listener('PASSWORD_RECOVERY', session);
        }
        return { data: { session, user: session.user, redirectType: 'recovery' }, error: null };
      },
      async updateUser(attrs: { password?: string }) {
        updateCalls.push(attrs);
        if (options.updatePasswordError) {
          return {
            data: { user: null },
            error: { message: options.updatePasswordError },
          };
        }
        const user = currentSession?.user ?? makeFakeSession().user;
        for (const listener of authListeners) {
          listener('USER_UPDATED', currentSession);
        }
        return { data: { user }, error: null };
      },
      async refreshSession() {
        if (options.refreshSessionResult) {
          const res = await options.refreshSessionResult();
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
              unsubscribe: () => authListeners.delete(cb),
            },
          },
        };
      },
    },
  } as unknown as SupabaseClient;

  return {
    client,
    getResetCalls: () => resetCalls,
    getUpdateCalls: () => updateCalls,
    getSignOutCalls: () => signOutCalls,
  };
}

test('Supabase config validation normalizes hosted /rest/v1 URL suffix and accepts VITE_SUPABASE_ANON_KEY fallback', () => {
  const key = makeValidAnonKey();
  const normalized = validateSupabaseConfig({
    VITE_SUPABASE_URL: 'https://bzkbczagkofsylbdqczf.supabase.co/rest/v1/',
    VITE_SUPABASE_ANON_KEY: key,
  });

  assert.equal(normalized.status, 'configured');
  assert.equal(normalized.isConfigured, true);
  assert.equal(normalized.url, 'https://bzkbczagkofsylbdqczf.supabase.co');
  assert.equal(normalized.publishableKey, key);
});

test('AuthGate resolver blocks workspace during restoration, unauthenticated state, and password recovery', () => {
  assert.equal(
    resolveAuthGateView(
      { status: 'unauthenticated', isAuthenticated: false, isPasswordRecovery: false },
      true
    ),
    'initializing'
  );

  assert.equal(
    resolveAuthGateView(
      { status: 'authenticated', isAuthenticated: true, isPasswordRecovery: false },
      true
    ),
    'initializing'
  );

  assert.equal(
    resolveAuthGateView(
      { status: 'unauthenticated', isAuthenticated: false, isPasswordRecovery: false },
      false
    ),
    'unauthenticated'
  );

  assert.equal(
    resolveAuthGateView(
      { status: 'recovery', isAuthenticated: false, isPasswordRecovery: true },
      false
    ),
    'recovery'
  );

  // Even if a temporary recovery session sets isAuthenticated true elsewhere, isPasswordRecovery keeps gate locked
  assert.equal(
    resolveAuthGateView(
      { status: 'authenticated', isAuthenticated: true, isPasswordRecovery: true },
      false
    ),
    'recovery'
  );

  assert.equal(
    resolveAuthGateView(
      { status: 'authenticated', isAuthenticated: true, isPasswordRecovery: false },
      false
    ),
    'authenticated'
  );
});

test('Email/password sign-in rejects invalid input, surfaces credential failures, and authenticates on valid login', async () => {
  const storage = createMemoryAuthStorage();
  const failHarness = makeFullAuthSupabaseHarness({
    storage,
    signInError: 'Invalid login credentials',
  });

  const failManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage,
    isOnline: () => true,
    createClientFn: () => failHarness.client,
  });

  const failAuth = createCloudAuthService(failManager, {
    isDesktopRuntime: () => true,
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });

  await failAuth.initialize();

  const badEmail = await failAuth.signInWithEmailPassword('not-an-email', 'secret123');
  assert.equal(badEmail.ok, false);
  assert.equal(badEmail.code, 'validation_error');
  assert.equal(failAuth.getSnapshot().isAuthenticated, false);

  const wrongCreds = await failAuth.signInWithEmailPassword('tomas@bizora.na', 'wrong-pass');
  assert.equal(wrongCreds.ok, false);
  assert.equal(wrongCreds.code, 'auth_failed');
  assert.match(wrongCreds.error ?? '', /Invalid login credentials/i);
  assert.equal(failAuth.getSnapshot().isAuthenticated, false);
  failAuth.dispose();

  const okHarness = makeFullAuthSupabaseHarness({ storage });
  const okManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage,
    isOnline: () => true,
    createClientFn: () => okHarness.client,
  });
  const okAuth = createCloudAuthService(okManager, {
    isDesktopRuntime: () => true,
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });

  await okAuth.initialize();
  const loginRes = await okAuth.signInWithEmailPassword('tomas@bizora.na', 'ValidPass123!');
  assert.equal(loginRes.ok, true);
  assert.equal(okAuth.getSnapshot().status, 'authenticated');
  assert.equal(okAuth.getSnapshot().isAuthenticated, true);
  assert.equal(okAuth.getSnapshot().session?.email, 'tomas@bizora.na');
  okAuth.dispose();
});

test('Account registration handles validation, confirmation-required (non-authenticated), and immediate session creation', async () => {
  const storage = createMemoryAuthStorage();
  const confirmHarness = makeFullAuthSupabaseHarness({
    storage,
    signUpConfirmationRequired: true,
  });

  const confirmManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage,
    isOnline: () => true,
    createClientFn: () => confirmHarness.client,
  });
  const confirmAuth = createCloudAuthService(confirmManager, {
    isDesktopRuntime: () => true,
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });
  await confirmAuth.initialize();

  const shortPass = await confirmAuth.signUpWithEmailPassword({
    fullName: 'Elena Shikongo',
    email: 'elena@bizora.na',
    password: 'short',
  });
  assert.equal(shortPass.ok, false);
  assert.equal(shortPass.code, 'validation_error');

  const confirmRes = await confirmAuth.signUpWithEmailPassword({
    fullName: 'Elena Shikongo',
    email: 'elena@bizora.na',
    password: 'StrongPassword123',
  });
  assert.equal(confirmRes.ok, true);
  assert.equal(confirmRes.data?.status, 'confirmation_required');
  assert.equal(confirmRes.data?.session, null);
  // Must NOT unlock workspace until email is confirmed and session exists
  assert.equal(confirmAuth.getSnapshot().isAuthenticated, false);
  assert.equal(confirmAuth.getSnapshot().status, 'unauthenticated');
  confirmAuth.dispose();

  const immediateHarness = makeFullAuthSupabaseHarness({
    storage: createMemoryAuthStorage(),
    signUpConfirmationRequired: false,
  });
  const immediateManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage: createMemoryAuthStorage(),
    isOnline: () => true,
    createClientFn: () => immediateHarness.client,
  });
  const immediateAuth = createCloudAuthService(immediateManager, {
    isDesktopRuntime: () => true,
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });
  await immediateAuth.initialize();

  const created = await immediateAuth.signUpWithEmailPassword({
    fullName: 'Elena Shikongo',
    email: 'elena@bizora.na',
    password: 'StrongPassword123',
  });
  assert.equal(created.ok, true);
  assert.equal(created.data?.status, 'authenticated');
  assert.equal(immediateAuth.getSnapshot().isAuthenticated, true);
  immediateAuth.dispose();
});

test('Forgot password sends desktop deep-link redirect, enters gated recovery mode on callback, and unlocks workspace after password update', async () => {
  const storage = createMemoryAuthStorage();
  const harness = makeFullAuthSupabaseHarness({ storage });
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
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });
  await authService.initialize();

  const resetRes = await authService.requestPasswordReset('tomas@bizora.na');
  assert.equal(resetRes.ok, true);
  assert.equal(harness.getResetCalls().length, 1);
  assert.equal(harness.getResetCalls()[0]?.redirectTo, BIZORA_PASSWORD_RECOVERY_REDIRECT_URI);

  // User clicks reset email link -> opens bizora://auth/callback?flow=recovery&code=rec-123
  const callbackRes = await authService.handleOAuthCallbackUrl(
    'bizora://auth/callback?flow=recovery&code=recovery-code-123'
  );
  assert.equal(callbackRes.ok, true);
  assert.equal(authService.getSnapshot().status, 'recovery');
  assert.equal(authService.getSnapshot().isPasswordRecovery, true);
  // Gate MUST remain locked while password update is pending
  assert.equal(authService.getSnapshot().isAuthenticated, false);
  assert.equal(resolveAuthGateView(authService.getSnapshot(), false), 'recovery');

  // Duplicate recovery callback must be rejected
  const dupRes = await authService.handleOAuthCallbackUrl(
    'bizora://auth/callback?flow=recovery&code=recovery-code-123'
  );
  assert.equal(dupRes.ok, false);
  assert.equal(dupRes.code, 'duplicate_callback');

  // Completing password update unlocks the workspace
  const updateRes = await authService.updatePassword('NewSecurePass2026!');
  assert.equal(updateRes.ok, true);
  assert.equal(harness.getUpdateCalls()[0]?.password, 'NewSecurePass2026!');
  assert.equal(authService.getSnapshot().isPasswordRecovery, false);
  assert.equal(authService.getSnapshot().isAuthenticated, true);
  assert.equal(authService.getSnapshot().status, 'authenticated');
  assert.equal(resolveAuthGateView(authService.getSnapshot(), false), 'authenticated');
  authService.dispose();
});

test('Expired session refreshes on startup when online, offline startup without session stays locked, and logout preserves local workspace data', async () => {
  // 1. Offline startup WITHOUT stored session remains locked
  const emptyOfflineStorage = createMemoryAuthStorage();
  const offlineNoSessionManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage: emptyOfflineStorage,
    isOnline: () => false,
  });
  const offlineNoSessionAuth = createCloudAuthService(offlineNoSessionManager, {
    isDesktopRuntime: () => true,
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });
  const offlineState = await offlineNoSessionAuth.initialize();
  assert.equal(offlineState.isAuthenticated, false);
  assert.equal(resolveAuthGateView(offlineState, false), 'unauthenticated');
  offlineNoSessionAuth.dispose();

  // 2. Expired stored session refreshes automatically on startup when online
  const nowSec = Math.floor(Date.now() / 1000);
  const expiredSession = makeFakeSession({ expires_at: nowSec - 120 });
  const freshSession = makeFakeSession({ expires_at: nowSec + 3600 });
  const refreshStorage = createMemoryAuthStorage();
  await refreshStorage.setItem('sb-bizora-project-auth-token', JSON.stringify(expiredSession));

  const refreshHarness = makeFullAuthSupabaseHarness({
    storage: refreshStorage,
    initialSession: expiredSession,
    refreshSessionResult: async () => ({
      data: { session: freshSession, user: freshSession.user },
      error: null,
    }),
  });
  const refreshManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidAnonKey(),
    },
    storage: refreshStorage,
    isOnline: () => true,
    createClientFn: () => refreshHarness.client,
  });
  const refreshAuth = createCloudAuthService(refreshManager, {
    isDesktopRuntime: () => true,
    getCurrentDeepLinks: async () => null,
    subscribeDeepLinks: async () => () => {},
  });
  const restored = await refreshAuth.initialize();
  assert.equal(restored.isAuthenticated, true);
  assert.equal(restored.session?.isExpired, false);

  // 3. Local business data stays completely intact across sign-out
  const memoryLocalStorage = new Map<string, string>();
  const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: Storage }).localStorage = {
    get length() {
      return memoryLocalStorage.size;
    },
    clear() {
      memoryLocalStorage.clear();
    },
    getItem(key: string) {
      return memoryLocalStorage.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(memoryLocalStorage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      memoryLocalStorage.delete(key);
    },
    setItem(key: string, value: string) {
      memoryLocalStorage.set(key, value);
    },
  };

  try {
    const adapter = new BrowserPersistenceAdapter();
    await adapter.resetToDemoData();
    const beforeClients = await adapter.getClients();
    const beforeQuotes = await adapter.getQuotations();
    const beforeInvoices = await adapter.getInvoices();
    assert.equal(beforeClients.length, initialClients.length);
    assert.equal(beforeQuotes.length, initialQuotations.length);
    assert.equal(beforeInvoices.length, initialInvoices.length);

    const signOutRes = await refreshAuth.signOut();
    assert.equal(signOutRes.ok, true);
    assert.equal(refreshAuth.getSnapshot().isAuthenticated, false);
    assert.equal(resolveAuthGateView(refreshAuth.getSnapshot(), false), 'unauthenticated');

    // Local business data must be untouched by authentication logout
    assert.equal((await adapter.getClients()).length, initialClients.length);
    assert.equal((await adapter.getQuotations()).length, initialQuotations.length);
    assert.equal((await adapter.getInvoices()).length, initialInvoices.length);
  } finally {
    (globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage;
    refreshAuth.dispose();
  }
});

test('Startup initialization resolves cleanly to unauthenticated even if desktop deep-link plugin calls reject', async () => {
  const storage = createMemoryAuthStorage();
  const harness = makeFullAuthSupabaseHarness({ storage });
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
    subscribeDeepLinks: async () => {
      throw new Error('Deep link listener unavailable');
    },
    getCurrentDeepLinks: async () => {
      throw new Error('Deep link query unavailable');
    },
  });

  const state = await authService.initialize();
  assert.equal(state.status, 'unauthenticated');
  assert.equal(state.isAuthenticated, false);
  assert.equal(resolveAuthGateView(state, false), 'unauthenticated');
  authService.dispose();
});

test('Windows UTF-8 BOM and UTF-16LE .env files parse cleanly and resolve client-safe Supabase keys without exposing secrets', async () => {
  const {
    decodeEnvFileBuffer,
    parseEnvContent,
    resolveSupabaseClientEnvFromSources,
  } = await import('./envParser');

  const key = makeValidAnonKey();
  const bomUtf8 = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(
      `VITE_SUPABASE_URL="https://bzkbczagkofsylbdqczf.supabase.co"\r\nVITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY='${key}'\r\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_never_expose_me\r\n`,
      'utf8'
    ),
  ]);
  const parsedUtf8 = parseEnvContent(decodeEnvFileBuffer(bomUtf8));
  assert.equal(parsedUtf8.VITE_SUPABASE_URL, 'https://bzkbczagkofsylbdqczf.supabase.co');
  assert.equal(parsedUtf8.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY, key);

  const utf16Le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(
      `SUPABASE_URL=https://bzkbczagkofsylbdqczf.supabase.co\r\nSUPABASE_PUBLISHABLE_KEY=sb_publishable_valid_windows_key_123456\r\nSUPABASE_SECRET_KEY=sb_secret_blocked\r\n`,
      'utf16le'
    ),
  ]);
  const parsedUtf16 = parseEnvContent(decodeEnvFileBuffer(utf16Le));
  const resolved = resolveSupabaseClientEnvFromSources([parsedUtf16]);
  assert.equal(resolved.VITE_SUPABASE_URL, 'https://bzkbczagkofsylbdqczf.supabase.co');
  assert.equal(
    resolved.VITE_SUPABASE_PUBLISHABLE_KEY,
    'sb_publishable_valid_windows_key_123456'
  );
  assert.equal('SUPABASE_SECRET_KEY' in resolved, false);
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in resolved, false);

  const validated = validateSupabaseConfig({
    VITE_SUPABASE_URL: `"${parsedUtf8.VITE_SUPABASE_URL}"`,
    VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY: parsedUtf8.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
  });
  assert.equal(validated.status, 'configured');
  assert.equal(validated.isConfigured, true);
  assert.equal(validated.url, 'https://bzkbczagkofsylbdqczf.supabase.co');
  assert.equal(validated.publishableKey, key);
});
