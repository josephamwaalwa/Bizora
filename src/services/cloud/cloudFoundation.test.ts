import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createCloudAuthService,
  createMemoryAuthStorage,
  createSupabaseClientManager,
  validateSupabaseConfig,
} from './index';
import { coordinateRuntimeStartup } from '../runtimeStartup';
import type { MigrationCountsDto, MigrationStatusDto } from '../database';
import type { PersistenceAdapter } from '../persistence';
import {
  initialActivities,
  initialBusinessProfile,
  initialClients,
  initialInvoices,
  initialQuotations,
} from '../seedData';

function makeValidFakePublishableKey(role = 'anon'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: 'supabase', ref: 'bizora-test-ref', role })
  ).toString('base64url');
  return `${header}.${payload}.test_signature_segment_123456`;
}

function makeStartupAdapter(backend: 'localStorage' | 'sqlite'): PersistenceAdapter {
  return {
    backend,
    capabilities: {
      backend,
      isAsync: backend === 'sqlite',
      supportsStandaloneAssets: backend === 'sqlite',
      supportsArbitrarySettings: backend === 'sqlite',
      supportsAtomicWorkspaceReplace: backend === 'sqlite',
    },
    async hasBusinessProfile() {
      return true;
    },
    async getBusinessProfile() {
      return initialBusinessProfile;
    },
    async saveBusinessProfile(profile) {
      return profile;
    },
    async getBusinessAssets() {
      return [];
    },
    async getBusinessAssetById() {
      return null;
    },
    async saveBusinessAsset() {
      throw new Error('unused');
    },
    async deleteBusinessAsset() {},
    async getClients() {
      return initialClients;
    },
    async getClientById() {
      return null;
    },
    async saveClient() {
      throw new Error('unused');
    },
    async deleteClient() {
      return false;
    },
    async getQuotations() {
      return initialQuotations;
    },
    async getQuotationById() {
      return null;
    },
    async saveQuotation(q) {
      return q;
    },
    async deleteQuotation() {
      return false;
    },
    async isQuotationNumberTaken() {
      return false;
    },
    async getNextAvailableQuoteNumber() {
      return 1;
    },
    async commitUsedQuoteNumber() {
      return true;
    },
    async getInvoices() {
      return initialInvoices;
    },
    async getInvoiceById() {
      return null;
    },
    async saveInvoice(inv) {
      return inv;
    },
    async deleteInvoice() {
      return false;
    },
    async isInvoiceNumberTaken() {
      return false;
    },
    async getNextAvailableInvoiceNumber() {
      return 1;
    },
    async commitUsedInvoiceNumber() {
      return true;
    },
    async recordPayment() {
      throw new Error('unused');
    },
    async getPaymentsByInvoice() {
      return [];
    },
    async getPaymentsByBusiness() {
      return [];
    },
    async deletePayment() {},
    async getActivities() {
      return initialActivities;
    },
    async addActivity() {},
    async getAppSetting() {
      return null;
    },
    async saveAppSetting() {},
    async deleteAppSetting() {},
    async exportBackupJson() {
      return '{}';
    },
    async importBackupJson() {
      return { ok: true };
    },
    async resetToDemoData() {},
    async clearAllData() {},
  };
}

function makeMigrationStatus(counts?: Partial<MigrationCountsDto>): MigrationStatusDto {
  return {
    state: 'completed',
    markerVersion: 1,
    migratedBusinessId: 'biz_main',
    backupFilename: null,
    completedAt: '2026-11-22T00:00:00.000Z',
    lastError: null,
    existingCounts: {
      localProfiles: '1',
      businesses: '1',
      businessAssets: '0',
      clients: '1',
      quotations: '1',
      quotationItems: '1',
      invoices: '1',
      invoiceItems: '1',
      payments: '0',
      activityLogs: '1',
      appSettings: '1',
      ...counts,
    },
  };
}

test('missing environment configuration reports unconfigured without throwing and returns null client', () => {
  const config = validateSupabaseConfig({});
  assert.equal(config.status, 'unconfigured');
  assert.equal(config.isConfigured, false);
  assert.equal(config.url, null);
  assert.equal(config.publishableKey, null);
  assert.deepEqual(config.missingVars, [
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_PUBLISHABLE_KEY',
  ]);
  assert.equal(config.error, null);

  const blankConfig = validateSupabaseConfig({
    VITE_SUPABASE_URL: '   ',
    VITE_SUPABASE_PUBLISHABLE_KEY: '',
  });
  assert.equal(blankConfig.status, 'unconfigured');
  assert.equal(blankConfig.isConfigured, false);

  const manager = createSupabaseClientManager({
    env: {},
    now: () => '2026-11-22T02:00:00.000Z',
  });
  assert.equal(manager.getClient(), null);
  const availability = manager.getAvailability();
  assert.equal(availability.status, 'unconfigured');
  assert.equal(availability.isConfigured, false);
  assert.equal(availability.isCloudAvailable, false);
  assert.equal(availability.checkedAt, '2026-11-22T02:00:00.000Z');
});

test('partial environment configuration is flagged invalid with exact missing variable', () => {
  const missingKey = validateSupabaseConfig({
    VITE_SUPABASE_URL: 'https://bizora-cloud.supabase.co',
  });
  assert.equal(missingKey.status, 'invalid');
  assert.equal(missingKey.isConfigured, false);
  assert.deepEqual(missingKey.missingVars, ['VITE_SUPABASE_PUBLISHABLE_KEY']);
  assert.match(missingKey.error ?? '', /VITE_SUPABASE_PUBLISHABLE_KEY/);

  const missingUrl = validateSupabaseConfig({
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_valid_key_123456',
  });
  assert.equal(missingUrl.status, 'invalid');
  assert.equal(missingUrl.isConfigured, false);
  assert.deepEqual(missingUrl.missingVars, ['VITE_SUPABASE_URL']);
  assert.match(missingUrl.error ?? '', /VITE_SUPABASE_URL/);
});

test('valid configuration creates a singleton Supabase client with memory-only auth storage', () => {
  const key = 'sb_publishable_bizora_test_key_1234567890';
  const config = validateSupabaseConfig({
    VITE_SUPABASE_URL: ' https://bizora-project.supabase.co/ ',
    VITE_SUPABASE_PUBLISHABLE_KEY: ` ${key} `,
  });

  assert.equal(config.status, 'configured');
  assert.equal(config.isConfigured, true);
  assert.equal(config.url, 'https://bizora-project.supabase.co');
  assert.equal(config.publishableKey, key);
  assert.equal(config.error, null);

  let factoryCalls = 0;
  const manager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co/',
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    },
    isOnline: () => true,
    createClientFn: (url, publishableKey, options) => {
      factoryCalls += 1;
      assert.equal(url, 'https://bizora-project.supabase.co');
      assert.equal(publishableKey, key);
      assert.equal(options.auth.persistSession, false);
      assert.equal(options.auth.autoRefreshToken, false);
      assert.equal(options.auth.detectSessionInUrl, false);
      assert.equal(options.auth.flowType, 'pkce');
      return { fakeClientId: factoryCalls } as unknown as SupabaseClient;
    },
  });

  const first = manager.getClient();
  const second = manager.getClient();
  assert.ok(first !== null);
  assert.equal(first, second);
  assert.equal(factoryCalls, 1);

  const availability = manager.getAvailability();
  assert.equal(availability.status, 'ready');
  assert.equal(availability.isConfigured, true);
  assert.equal(availability.isOnline, true);
  assert.equal(availability.isCloudAvailable, true);
  assert.equal(availability.reason, null);
});

test('invalid configuration rejects malformed URLs, non-HTTPS remote URLs, placeholders, and secret keys without leaking values', () => {
  const invalidUrl = validateSupabaseConfig({
    VITE_SUPABASE_URL: 'not-a-valid-url',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_bizora_test_key_1234567890',
  });
  assert.equal(invalidUrl.status, 'invalid');
  assert.equal(invalidUrl.isConfigured, false);

  const insecureRemoteUrl = validateSupabaseConfig({
    VITE_SUPABASE_URL: 'http://bizora-project.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_bizora_test_key_1234567890',
  });
  assert.equal(insecureRemoteUrl.status, 'invalid');
  assert.match(insecureRemoteUrl.error ?? '', /https:\/\//);

  const localhostHttpUrl = validateSupabaseConfig({
    VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_bizora_test_key_1234567890',
  });
  assert.equal(localhostHttpUrl.status, 'configured');

  const placeholderEnv = validateSupabaseConfig({
    VITE_SUPABASE_URL: 'https://your-project-ref.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_your_publishable_key_here',
  });
  assert.equal(placeholderEnv.status, 'invalid');
  assert.equal(placeholderEnv.issues.length, 2);

  const secretKeyPrefix = 'sb_secret_never_expose_this_value_123456';
  const rejectedSecretPrefix = validateSupabaseConfig({
    VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: secretKeyPrefix,
  });
  assert.equal(rejectedSecretPrefix.status, 'invalid');
  assert.match(rejectedSecretPrefix.error ?? '', /forbidden/i);
  assert.equal((rejectedSecretPrefix.error ?? '').includes(secretKeyPrefix), false);

  const serviceRoleJwt = makeValidFakePublishableKey('service_role');
  const rejectedServiceRole = validateSupabaseConfig({
    VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: serviceRoleJwt,
  });
  assert.equal(rejectedServiceRole.status, 'invalid');
  assert.match(rejectedServiceRole.error ?? '', /service_role/i);
  assert.equal((rejectedServiceRole.error ?? '').includes(serviceRoleJwt), false);

  const invalidManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://user:pass@bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'short',
    },
  });
  assert.equal(invalidManager.getClient(), null);
  assert.equal(invalidManager.getAvailability().status, 'unavailable');
});

test('cloud unavailable, offline, and client initialization failures degrade gracefully', async () => {
  const offlineManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidFakePublishableKey('anon'),
    },
    isOnline: () => false,
  });

  const offlineAvailability = offlineManager.getAvailability();
  assert.equal(offlineAvailability.status, 'offline');
  assert.equal(offlineAvailability.isConfigured, true);
  assert.equal(offlineAvailability.isOnline, false);
  assert.equal(offlineAvailability.isCloudAvailable, false);

  const offlineAuth = createCloudAuthService(offlineManager);
  assert.equal(await offlineAuth.getCurrentSession(), null);

  const offlineAuthState = await offlineAuth.getAuthState();
  assert.equal(offlineAuthState.status, 'unavailable');
  assert.equal(offlineAuthState.isAuthenticated, false);
  assert.equal(offlineAuthState.session, null);
  assert.equal(offlineAuthState.availability.status, 'offline');

  const signInWhileOffline = await offlineAuth.signInWithEmailPassword('user@example.com', 'secret');
  assert.equal(signInWhileOffline.ok, false);
  assert.equal(signInWhileOffline.code, 'offline');

  const signOutWhileOffline = await offlineAuth.signOut();
  assert.equal(signOutWhileOffline.ok, true);

  const throwingManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidFakePublishableKey('anon'),
    },
    isOnline: () => true,
    createClientFn: () => {
      throw new Error('Runtime fetch implementation unavailable');
    },
  });

  assert.equal(throwingManager.getClient(), null);
  const errorAvailability = throwingManager.getAvailability();
  assert.equal(errorAvailability.status, 'error');
  assert.equal(errorAvailability.isCloudAvailable, false);
  assert.match(errorAvailability.reason ?? '', /Runtime fetch implementation unavailable/);

  const errorAuth = createCloudAuthService(throwingManager);
  const errorAuthState = await errorAuth.getAuthState();
  assert.equal(errorAuthState.status, 'unavailable');
  assert.equal(errorAuthState.isAuthenticated, false);
  assert.equal(errorAuthState.session, null);
});

test('auth service behavior when no session exists never mocks authentication and never uses localStorage', async () => {
  const unconfiguredManager = createSupabaseClientManager({ env: {} });
  const unconfiguredAuth = createCloudAuthService(unconfiguredManager);

  assert.equal(await unconfiguredAuth.getCurrentSession(), null);
  const unconfiguredState = await unconfiguredAuth.getAuthState();
  assert.equal(unconfiguredState.status, 'unconfigured');
  assert.equal(unconfiguredState.isAuthenticated, false);
  assert.equal(unconfiguredState.session, null);

  const signInUnconfigured = await unconfiguredAuth.signInWithEmailPassword(
    'owner@bizora.na',
    'password123'
  );
  assert.equal(signInUnconfigured.ok, false);
  assert.equal(signInUnconfigured.code, 'unconfigured');
  assert.equal((await unconfiguredAuth.signOut()).ok, true);
  const noopUnsubscribe = unconfiguredAuth.onAuthStateChange(() => {});
  assert.doesNotThrow(() => noopUnsubscribe());

  // Real @supabase/supabase-js client instantiated with memory-only storage and no active session
  const configuredManager = createSupabaseClientManager({
    env: {
      VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: makeValidFakePublishableKey('anon'),
    },
    isOnline: () => true,
  });

  const realClient = configuredManager.getClient();
  assert.ok(realClient !== null);
  assert.equal(configuredManager.getClient(), realClient);

  const authService = createCloudAuthService(configuredManager);
  assert.equal(await authService.getCurrentSession(), null);

  const authState = await authService.getAuthState();
  assert.equal(authState.status, 'unauthenticated');
  assert.equal(authState.isAuthenticated, false);
  assert.equal(authState.session, null);
  assert.equal(authState.availability.status, 'ready');
  assert.equal(authState.error, null);

  const unsubscribe = authService.onAuthStateChange(() => {});
  assert.doesNotThrow(() => unsubscribe());

  // Verify in-memory storage adapter works in isolation without touching window.localStorage
  const memoryStorage = createMemoryAuthStorage();
  assert.equal(memoryStorage.getItem('sb-test-auth-token'), null);
  memoryStorage.setItem('sb-test-auth-token', 'transient-in-memory');
  assert.equal(memoryStorage.getItem('sb-test-auth-token'), 'transient-in-memory');
  memoryStorage.removeItem('sb-test-auth-token');
  assert.equal(memoryStorage.getItem('sb-test-auth-token'), null);
});

test('local SQLite and Browser workspace startup remain completely unaffected by missing, invalid, or offline cloud config', async () => {
  // Prime cloud managers in missing, invalid, and offline states first
  const missingCloud = createCloudAuthService(createSupabaseClientManager({ env: {} }));
  const invalidCloud = createCloudAuthService(
    createSupabaseClientManager({
      env: { VITE_SUPABASE_URL: 'invalid-url', VITE_SUPABASE_PUBLISHABLE_KEY: 'bad' },
    })
  );
  const offlineCloud = createCloudAuthService(
    createSupabaseClientManager({
      env: {
        VITE_SUPABASE_URL: 'https://bizora-project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: makeValidFakePublishableKey('anon'),
      },
      isOnline: () => false,
    })
  );

  assert.equal((await missingCloud.getAuthState()).isAuthenticated, false);
  assert.equal((await invalidCloud.getAuthState()).isAuthenticated, false);
  assert.equal((await offlineCloud.getAuthState()).isAuthenticated, false);

  const sqliteResult = await coordinateRuntimeStartup({
    detectBackend: () => 'sqlite',
    createAdapter: () => makeStartupAdapter('sqlite'),
    initializeDesktopDatabase: async () => ({
      initialized: true,
      databasePath: 'C:/Users/Test/AppData/Roaming/Bizora/bizora.db',
      schemaVersion: 1,
      sqliteVersion: '3.46.0',
      journalMode: 'wal',
      foreignKeysEnabled: true,
      busyTimeoutMs: 5000,
      integrityOk: true,
      foreignKeyCheckPassed: true,
    }),
    getMigrationStatus: async () => makeMigrationStatus(),
  });

  assert.equal(sqliteResult.status, 'ready');
  assert.equal(sqliteResult.backend, 'sqlite');
  assert.equal(sqliteResult.clients.length, initialClients.length);
  assert.equal(sqliteResult.invoices.length, initialInvoices.length);
  assert.equal(sqliteResult.quotations.length, initialQuotations.length);

  let browserInitCalls = 0;
  const browserResult = await coordinateRuntimeStartup({
    detectBackend: () => 'localStorage',
    initBrowserStorage: () => {
      browserInitCalls += 1;
    },
    createAdapter: () => makeStartupAdapter('localStorage'),
  });

  assert.equal(browserInitCalls, 1);
  assert.equal(browserResult.status, 'ready');
  assert.equal(browserResult.backend, 'localStorage');
  assert.equal(browserResult.clients.length, initialClients.length);
});
