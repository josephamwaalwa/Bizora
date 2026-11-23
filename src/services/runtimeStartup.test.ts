import test from 'node:test';
import assert from 'node:assert/strict';

import { coordinateRuntimeStartup } from './runtimeStartup';
import type { MigrationCountsDto, MigrationDiagnosticDto, MigrationStatusDto } from './database';
import type { PersistenceAdapter } from './persistence';
import type { RawLegacyStorageSnapshot } from './storage';
import { initialActivities, initialBusinessProfile, initialClients, initialInvoices, initialQuotations } from './seedData';
import type { BusinessProfile } from '../types';

function makeCounts(overrides?: Partial<MigrationCountsDto>): MigrationCountsDto {
  return {
    localProfiles: '0',
    businesses: '0',
    businessAssets: '0',
    clients: '0',
    quotations: '0',
    quotationItems: '0',
    invoices: '0',
    invoiceItems: '0',
    payments: '0',
    activityLogs: '0',
    appSettings: '0',
    ...overrides,
  };
}

function makeStatus(overrides?: Partial<MigrationStatusDto>): MigrationStatusDto {
  return {
    state: 'absent',
    markerVersion: null,
    migratedBusinessId: null,
    backupFilename: null,
    completedAt: null,
    lastError: null,
    existingCounts: makeCounts(),
    ...overrides,
  };
}

function makeRawSnapshot(entries: Array<{ key: RawLegacyStorageSnapshot['entries'][number]['key']; rawValue: string }> = []): RawLegacyStorageSnapshot {
  const byKey = new Map(entries.map((entry) => [entry.key, entry.rawValue]));
  const keys: RawLegacyStorageSnapshot['entries'][number]['key'][] = [
    'bizora_business_profile_v1',
    'bizora_clients_v1',
    'bizora_quotations_v1',
    'bizora_invoices_v1',
    'bizora_activities_v1',
    'bizora_has_initialized_v1',
    'bizora_logo_cache_v1',
    'bizora_theme_preference_v1',
  ];

  return {
    capturedAt: '2026-11-20T12:00:00Z',
    source: 'test_snapshot',
    entries: keys.map((key) => {
      const present = byKey.has(key);
      return {
        key,
        present,
        presentInLocalStorage: present,
        presentInMemoryFallback: false,
        rawValue: byKey.get(key) ?? null,
      };
    }),
  };
}

function makeFakeAdapter(
  backend: 'localStorage' | 'sqlite',
  profileOverride?: BusinessProfile,
  hasProfile = true
) {
  const calls: string[] = [];
  const savedSettings = new Map<string, unknown>();
  let currentProfile = profileOverride ?? initialBusinessProfile;

  const adapter: PersistenceAdapter = {
    backend,
    capabilities: {
      backend,
      isAsync: backend === 'sqlite',
      supportsStandaloneAssets: backend === 'sqlite',
      supportsArbitrarySettings: backend === 'sqlite',
      supportsAtomicWorkspaceReplace: backend === 'sqlite',
    },
    async hasBusinessProfile() {
      calls.push('hasBusinessProfile');
      return hasProfile;
    },
    async getBusinessProfile() {
      calls.push('getBusinessProfile');
      return currentProfile;
    },
    async saveBusinessProfile(profile) {
      currentProfile = profile;
      return profile;
    },
    async getBusinessAssets() { return []; },
    async getBusinessAssetById() { return null; },
    async saveBusinessAsset() { throw new Error('unused'); },
    async deleteBusinessAsset() {},
    async getClients() {
      calls.push('getClients');
      return initialClients;
    },
    async getClientById() { return null; },
    async saveClient() { throw new Error('unused'); },
    async deleteClient() { return false; },
    async getQuotations() {
      calls.push('getQuotations');
      return initialQuotations;
    },
    async getQuotationById() { return null; },
    async saveQuotation(q) { return q; },
    async deleteQuotation() { return false; },
    async isQuotationNumberTaken() { return false; },
    async getNextAvailableQuoteNumber() { return 1; },
    async commitUsedQuoteNumber() { return true; },
    async getInvoices() {
      calls.push('getInvoices');
      return initialInvoices;
    },
    async getInvoiceById() { return null; },
    async saveInvoice(inv) { return inv; },
    async deleteInvoice() { return false; },
    async isInvoiceNumberTaken() { return false; },
    async getNextAvailableInvoiceNumber() { return 1; },
    async commitUsedInvoiceNumber() { return true; },
    async getPaymentsByInvoice() { return []; },
    async getPaymentsByBusiness() { return []; },
    async recordPayment() { return undefined; },
    async deletePayment() {},
    async getActivities() {
      calls.push('getActivities');
      return initialActivities;
    },
    async addActivity() {},
    async getAppSetting<T = unknown>(key: string) {
      calls.push(`getAppSetting:${key}`);
      return (savedSettings.get(key) ?? null) as T | null;
    },
    async saveAppSetting(key: string, value: unknown) {
      calls.push(`saveAppSetting:${key}`);
      savedSettings.set(key, value);
    },
    async deleteAppSetting() {},
    async exportBackupJson() { return '{}'; },
    async importBackupJson() { return { ok: true, persisted: true }; },
    async resetToDemoData() {
      calls.push('resetToDemoData');
    },
    async clearAllData() {
      calls.push('clearAllData');
    },
  };

  return { adapter, calls, savedSettings };
}

test('browser runtime uses BrowserPersistenceAdapter, calls initBrowserStorage, and skips SQLite lifecycle', async () => {
  let browserInitCalls = 0;
  let desktopInitCalls = 0;
  const { adapter, calls } = makeFakeAdapter('localStorage');

  const result = await coordinateRuntimeStartup({
    detectBackend: () => 'localStorage',
    initBrowserStorage: () => {
      browserInitCalls += 1;
    },
    createAdapter: () => adapter,
    initializeDesktopDatabase: async () => {
      desktopInitCalls += 1;
      return null;
    },
  });

  assert.equal(browserInitCalls, 1);
  assert.equal(desktopInitCalls, 0);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.backend, 'localStorage');
  assert.equal(result.needsBusinessSetup, false);
  assert.equal(result.migrationNotice, null);
  assert.deepEqual(calls.slice(0, 6), [
    'hasBusinessProfile',
    'getBusinessProfile',
    'getClients',
    'getQuotations',
    'getInvoices',
    'getActivities',
  ]);
});

test('desktop already completed skips migration and hydrates SQLite workspace plus theme', async () => {
  let browserInitCalls = 0;
  let migrationRuns = 0;
  const { adapter, calls, savedSettings } = makeFakeAdapter('sqlite', {
    ...initialBusinessProfile,
    name: 'Okavango Studio SQLite',
  });
  savedSettings.set('theme_preference', 'dark');

  const result = await coordinateRuntimeStartup({
    detectBackend: () => 'sqlite',
    initBrowserStorage: () => {
      browserInitCalls += 1;
    },
    createAdapter: () => adapter,
    initializeDesktopDatabase: async () => ({
      initialized: true,
      databasePath: '/tmp/bizora.db',
      sqliteVersion: '3.46.0',
      schemaVersion: 2,
      integrityOk: true,
      foreignKeyCheckPassed: true,
      busyTimeoutMs: 5000,
      journalMode: 'wal',
      foreignKeysEnabled: true,
    }),
    getMigrationStatus: async () =>
      makeStatus({
        state: 'completed',
        markerVersion: 1,
        migratedBusinessId: 'biz-1',
        existingCounts: makeCounts({ businesses: '1', clients: '2' }),
      }),
    runMigration: async () => {
      migrationRuns += 1;
      throw new Error('Should not re-run migration');
    },
  });

  assert.equal(browserInitCalls, 0);
  assert.equal(migrationRuns, 0);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.backend, 'sqlite');
  assert.equal(result.needsBusinessSetup, false);
  assert.equal(result.businessProfile.name, 'Okavango Studio SQLite');
  assert.equal(result.themePreference, 'dark');
  assert.ok(calls.includes('getAppSetting:theme_preference'));
});

test('desktop empty_fresh_install marks not_needed, enters business onboarding without demo seeding, never calls StorageService.init, and preserves theme', async () => {
  let browserInitCalls = 0;
  const markSources: Array<string | null | undefined> = [];
  const { adapter, calls, savedSettings } = makeFakeAdapter('sqlite', undefined, false);

  const result = await coordinateRuntimeStartup({
    detectBackend: () => 'sqlite',
    initBrowserStorage: () => {
      browserInitCalls += 1;
    },
    createAdapter: () => adapter,
    initializeDesktopDatabase: async () => null,
    getMigrationStatus: async () => makeStatus({ state: 'absent', existingCounts: makeCounts() }),
    getRawSnapshot: () =>
      makeRawSnapshot([{ key: 'bizora_theme_preference_v1', rawValue: 'dark' }]),
    classifySnapshot: () => 'empty_fresh_install',
    markMigrationNotNeeded: async (source) => {
      markSources.push(source);
      return makeStatus({ state: 'not_needed' });
    },
  });

  assert.equal(browserInitCalls, 0);
  assert.deepEqual(markSources, ['desktop_fresh_install']);
  assert.equal(calls.includes('resetToDemoData'), false);
  assert.equal(calls.includes('getBusinessProfile'), false);
  assert.equal(savedSettings.get('theme_preference'), 'dark');
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.needsBusinessSetup, true);
  assert.equal(result.businessProfile.defaultCurrency, 'NAD');
  assert.deepEqual(result.clients, []);
  assert.equal(result.themePreference, 'dark');
  assert.equal(result.migrationNotice, null);
});

test('desktop demo_seed_only marks not_needed(demo_seed_only) and opens onboarding without importing or reseeding demo data', async () => {
  const markSources: Array<string | null | undefined> = [];
  const { adapter, calls, savedSettings } = makeFakeAdapter('sqlite', undefined, false);

  const result = await coordinateRuntimeStartup({
    detectBackend: () => 'sqlite',
    createAdapter: () => adapter,
    initializeDesktopDatabase: async () => null,
    getMigrationStatus: async () => makeStatus({ state: 'absent', existingCounts: makeCounts() }),
    getRawSnapshot: () =>
      makeRawSnapshot([
        { key: 'bizora_has_initialized_v1', rawValue: 'true' },
        { key: 'bizora_theme_preference_v1', rawValue: 'light' },
      ]),
    classifySnapshot: () => 'demo_seed_only',
    runMigration: async () => ({
      outcome: 'demo_seed_only',
      classification: 'demo_seed_only',
      backup: {
        backupFilename: 'bizora_backup.json',
        byteSize: '100',
        sha256: 'abc',
        verified: true,
        capturedKeyCount: '2',
      },
      diagnostics: [],
    }),
    markMigrationNotNeeded: async (source) => {
      markSources.push(source);
      return makeStatus({ state: 'not_needed' });
    },
  });

  assert.deepEqual(markSources, ['demo_seed_only']);
  assert.equal(calls.includes('resetToDemoData'), false);
  assert.equal(calls.includes('getBusinessProfile'), false);
  assert.equal(savedSettings.get('theme_preference'), 'light');
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.needsBusinessSetup, true);
  assert.equal(result.businessProfile.defaultCurrency, 'NAD');
  assert.equal(result.migrationNotice, null);
});

test('desktop completed state with zero businesses enters onboarding without clearing or seeding', async () => {
  const { adapter, calls } = makeFakeAdapter('sqlite', undefined, false);

  const result = await coordinateRuntimeStartup({
    detectBackend: () => 'sqlite',
    createAdapter: () => adapter,
    initializeDesktopDatabase: async () => null,
    getMigrationStatus: async () =>
      makeStatus({
        state: 'completed',
        markerVersion: 1,
        existingCounts: makeCounts({ businesses: '0' }),
      }),
  });

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.needsBusinessSetup, true);
  assert.equal(result.businessProfile.defaultCurrency, 'NAD');
  assert.equal(calls.includes('clearAllData'), false);
  assert.equal(calls.includes('resetToDemoData'), false);
  assert.equal(calls.includes('getBusinessProfile'), false);
});

test('desktop real LocalStorage migration succeeds cleanly and surfaces migrationNotice', async () => {
  const { adapter } = makeFakeAdapter('sqlite');

  const result = await coordinateRuntimeStartup({
    detectBackend: () => 'sqlite',
    createAdapter: () => adapter,
    initializeDesktopDatabase: async () => null,
    getMigrationStatus: async () => makeStatus({ state: 'absent', existingCounts: makeCounts() }),
    getRawSnapshot: () =>
      makeRawSnapshot([
        { key: 'bizora_has_initialized_v1', rawValue: 'true' },
        { key: 'bizora_business_profile_v1', rawValue: '{"name":"User Co"}' },
      ]),
    classifySnapshot: () => 'existing_initialized',
    runMigration: async () => ({
      outcome: 'completed',
      classification: 'existing_initialized',
      backup: {
        backupFilename: 'bizora_legacy_backup_1.json',
        byteSize: '2048',
        sha256: 'deadbeef',
        verified: true,
        capturedKeyCount: '5',
      },
      result: {
        state: 'completed',
        migratedBusinessId: 'biz-99',
        localProfileId: 'prof-1',
        backupFilename: 'bizora_legacy_backup_1.json',
        counts: makeCounts({
          businesses: '1',
          clients: '4',
          quotations: '3',
          invoices: '2',
        }),
        diagnostics: [
          {
            code: 'UNLINKED_QUOTATION_RESTORED',
            severity: 'warning',
            stage: 'relationship',
            entityType: 'quotation',
            recordId: 'q-1',
            field: 'convertedInvoiceId',
            originalValue: 'inv-missing',
            message: 'Restored stale conversion link',
            suggestedAction: 'Review quotation status.',
          },
        ],
        completedAt: '2026-11-20T12:00:01Z',
      },
      diagnostics: [
        {
          code: 'UNLINKED_QUOTATION_RESTORED',
          severity: 'warning',
          stage: 'relationship',
          entityType: 'quotation',
          recordId: 'q-1',
          field: 'convertedInvoiceId',
          originalValue: 'inv-missing',
          message: 'Restored stale conversion link',
          suggestedAction: 'Review quotation status.',
        },
      ],
    }),
  });

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.ok(result.migrationNotice);
  assert.equal(result.migrationNotice.tone, 'warning');
  assert.equal(result.migrationNotice.backupFilename, 'bizora_legacy_backup_1.json');
  assert.equal(result.migrationNotice.diagnosticsCount, 1);
});

test('desktop migration validation failure blocks cutover, records diagnostic safely, and preserves backup info', async () => {
  const recordedErrors: MigrationDiagnosticDto[] = [];
  const { adapter } = makeFakeAdapter('sqlite');

  const validationDiag: MigrationDiagnosticDto = {
    code: 'CORRUPTED_JSON',
    severity: 'error',
    stage: 'extract',
    entityType: 'client',
    recordId: null,
    field: 'bizora_clients_v1',
    originalValue: null,
    message: 'Legacy clients JSON could not be parsed.',
    suggestedAction: 'Repair corrupted backup file before retrying.',
  };

  const result = await coordinateRuntimeStartup({
    detectBackend: () => 'sqlite',
    createAdapter: () => adapter,
    initializeDesktopDatabase: async () => null,
    getMigrationStatus: async () => makeStatus({ state: 'absent', existingCounts: makeCounts() }),
    getRawSnapshot: () =>
      makeRawSnapshot([{ key: 'bizora_clients_v1', rawValue: '{broken-json' }]),
    classifySnapshot: () => 'partial_or_corrupted',
    runMigration: async () => ({
      outcome: 'validation_failed',
      classification: 'partial_or_corrupted',
      backup: {
        backupFilename: 'bizora_backup_corrupt.json',
        byteSize: '512',
        sha256: 'cafe',
        verified: true,
        capturedKeyCount: '1',
      },
      diagnostics: [validationDiag],
    }),
    recordMigrationError: async (diag) => {
      recordedErrors.push(diag);
      return diag;
    },
  });

  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  assert.equal(result.reason, 'validation_failed');
  assert.equal(result.backupFilename, 'bizora_backup_corrupt.json');
  assert.equal(result.diagnostics.length, 1);
  assert.equal(recordedErrors.length, 1);
  assert.equal(recordedErrors[0].code, 'CORRUPTED_JSON');
});

test('desktop unmarked existing SQLite data refuses overwrite and surfaces conflict_existing_data', async () => {
  const recordedErrors: MigrationDiagnosticDto[] = [];
  const { adapter, calls } = makeFakeAdapter('sqlite');

  const result = await coordinateRuntimeStartup({
    detectBackend: () => 'sqlite',
    createAdapter: () => adapter,
    initializeDesktopDatabase: async () => null,
    getMigrationStatus: async () =>
      makeStatus({
        state: 'absent',
        existingCounts: makeCounts({ businesses: '1', invoices: '2' }),
      }),
    recordMigrationError: async (diag) => {
      recordedErrors.push(diag);
      return diag;
    },
  });

  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') return;
  assert.equal(result.reason, 'conflict_existing_data');
  assert.equal(recordedErrors.length, 1);
  assert.equal(calls.includes('resetToDemoData'), false);
  assert.equal(calls.includes('clearAllData'), false);
});
