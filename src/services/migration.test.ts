import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  strictDecimalToScaledInt64,
  type BackupLegacyStorageInput,
  type LegacyWorkspaceMigrationInput,
  type MigrationResultDto,
  type MigrationStatusDto,
} from './database';
import {
  buildRawBackupPayload,
  classifyWorkspace,
  prepareMigrationPayload,
  redactDiagnosticValue,
  runExplicitLocalStorageMigration,
  sha256Hex,
} from './migration';
import {
  initialActivities,
  initialBusinessProfile,
  initialClients,
  initialInvoices,
  initialQuotations,
} from './seedData';
import { LEGACY_STORAGE_KEYS, StorageService, type RawLegacyStorageSnapshot } from './storage';
import { THEME_STORAGE_KEY } from '../utils/theme';

class MockLocalStorage implements Storage {
  private store = new Map<string, string>();
  public readonly writeCalls: Array<{ op: 'setItem' | 'removeItem' | 'clear'; key?: string }> = [];

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.writeCalls.push({ op: 'clear' });
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.writeCalls.push({ op: 'removeItem', key });
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.writeCalls.push({ op: 'setItem', key });
    this.store.set(key, value);
  }

  seedDirect(key: string, value: string): void {
    this.store.set(key, value);
  }

  snapshotMap(): Record<string, string> {
    return Object.fromEntries(this.store.entries());
  }
}

let originalDescriptor: PropertyDescriptor | undefined;
let mockStorage: MockLocalStorage;

beforeEach(() => {
  originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  mockStorage = new MockLocalStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: mockStorage,
  });
});

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

function makeSnapshot(overrides: Partial<Record<string, string | null>> = {}): RawLegacyStorageSnapshot {
  return {
    capturedAt: '2026-11-19T10:00:00.000Z',
    source: 'localStorage',
    entries: LEGACY_STORAGE_KEYS.map((key) => {
      const rawValue = Object.prototype.hasOwnProperty.call(overrides, key) ? (overrides[key] ?? null) : null;
      return {
        key,
        present: rawValue !== null,
        presentInLocalStorage: rawValue !== null,
        presentInMemoryFallback: false,
        rawValue,
      };
    }),
  };
}

function makeBaseProfile(extra: Record<string, unknown> = {}) {
  return {
    id: 'biz_legacy_1',
    name: 'Desert Tech Solutions',
    tagline: 'Software & Design',
    logoUrl: '',
    email: 'info@deserttech.na',
    phone: '+264 61 111 2222',
    address: '10 Independence Ave',
    city: 'Windhoek',
    country: 'Namibia',
    defaultCurrency: 'NAD',
    currencySymbol: 'N$',
    defaultTaxName: 'VAT',
    defaultTaxRate: 15,
    isTaxEnabled: true,
    quotePrefix: 'QUO-',
    invoicePrefix: 'INV-',
    nextQuoteNumber: 2,
    nextInvoiceNumber: 2,
    defaultTermsQuotation: 'Valid 30 days',
    defaultTermsInvoice: 'Due 14 days',
    defaultNotes: 'Thank you',
    bankDetails: {
      bankName: 'FNB',
      accountName: 'Desert Tech',
      accountNumber: '123456',
      branchCode: '280172',
    },
    updatedAt: '2026-10-15T12:00:00.000Z',
    ...extra,
  };
}

function makeBaseClient(id = 'cli_1', name = 'Acme Client') {
  return {
    id,
    name,
    companyName: 'Acme Corp',
    email: 'acme@example.com',
    phone: '+264 61 000 0001',
    address: '1 Main Street',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  };
}

let mockItemSeq = 1;

function makeBaseQuote(overrides: Record<string, unknown> = {}) {
  const profile = makeBaseProfile();
  const client = makeBaseClient();
  const itemSeq = mockItemSeq++;
  return {
    id: 'quo_1',
    quotationNumber: 'QUO-0001',
    clientId: client.id,
    clientSnapshot: client,
    businessSnapshot: profile,
    issueDate: '2026-10-05',
    expiryDate: '2026-11-05',
    currency: 'NAD',
    currencySymbol: 'N$',
    items: [
      {
        id: `qitem_${itemSeq}`,
        description: 'Consulting',
        quantity: 2,
        unitPrice: 500,
        total: 1000,
      },
    ],
    subtotal: 1000,
    discountType: 'percentage',
    discountValue: 0,
    discountAmount: 0,
    taxName: 'VAT',
    taxRate: 15,
    taxAmount: 150,
    grandTotal: 1150,
    status: 'sent',
    createdAt: '2026-10-05T09:00:00.000Z',
    updatedAt: '2026-10-05T09:00:00.000Z',
    ...overrides,
  };
}

function makeBaseInvoice(overrides: Record<string, unknown> = {}) {
  const profile = makeBaseProfile();
  const client = makeBaseClient();
  const itemSeq = mockItemSeq++;
  return {
    id: 'inv_1',
    invoiceNumber: 'INV-0001',
    clientId: client.id,
    clientSnapshot: client,
    businessSnapshot: profile,
    issueDate: '2026-10-10',
    dueDate: '2026-10-24',
    currency: 'NAD',
    currencySymbol: 'N$',
    items: [
      {
        id: `iitem_${itemSeq}`,
        description: 'Consulting',
        quantity: 2,
        unitPrice: 500,
        total: 1000,
      },
    ],
    subtotal: 1000,
    discountType: 'percentage',
    discountValue: 0,
    discountAmount: 0,
    taxName: 'VAT',
    taxRate: 15,
    taxAmount: 150,
    grandTotal: 1150,
    amountPaid: 0,
    outstandingBalance: 1150,
    status: 'sent',
    payments: [],
    createdAt: '2026-10-10T09:00:00.000Z',
    updatedAt: '2026-10-10T09:00:00.000Z',
    ...overrides,
  };
}

function makeAbsentStatus(): MigrationStatusDto {
  return {
    state: 'absent',
    markerVersion: null,
    completedAt: null,
    migratedBusinessId: null,
    backupFilename: null,
    lastError: null,
    existingCounts: {
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
    },
  };
}

test('1. sha256Hex matches standard FIPS 180-4 test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  );
});

test('2. StorageService.getRawMigrationSnapshot is strictly read-only and distinguishes absent vs present keys', () => {
  const snapshotEmpty = StorageService.getRawMigrationSnapshot();
  assert.equal(snapshotEmpty.entries.length, LEGACY_STORAGE_KEYS.length);
  assert.equal(
    snapshotEmpty.entries.every((e) => !e.present && e.rawValue === null),
    true
  );
  assert.equal(mockStorage.writeCalls.length, 0);

  mockStorage.seedDirect('bizora_clients_v1', '[]');
  mockStorage.seedDirect('bizora_business_profile_v1', '{broken_json');
  mockStorage.seedDirect(THEME_STORAGE_KEY, 'dark');

  const before = mockStorage.snapshotMap();
  const snapshot = StorageService.getRawMigrationSnapshot();
  const after = mockStorage.snapshotMap();

  assert.deepEqual(after, before);
  assert.equal(mockStorage.writeCalls.length, 0);

  const clientsEntry = snapshot.entries.find((e) => e.key === 'bizora_clients_v1');
  assert.equal(clientsEntry?.present, true);
  assert.equal(clientsEntry?.rawValue, '[]');

  const quotesEntry = snapshot.entries.find((e) => e.key === 'bizora_quotations_v1');
  assert.equal(quotesEntry?.present, false);
  assert.equal(quotesEntry?.rawValue, null);

  const rawBackup = buildRawBackupPayload(snapshot);
  const brokenEntry = rawBackup.keys.find((k) => k.key === 'bizora_business_profile_v1');
  assert.equal(brokenEntry?.rawValue, '{broken_json');
});

test('3. classifyWorkspace accurately classifies empty, demo seed, initialized, missing init marker, and corrupted workspaces', () => {
  assert.equal(classifyWorkspace(makeSnapshot()), 'empty_fresh_install');

  const demoSnapshot = makeSnapshot({
    bizora_business_profile_v1: JSON.stringify({
      ...initialBusinessProfile,
      updatedAt: '2030-01-01T00:00:00.000Z',
    }),
    bizora_clients_v1: JSON.stringify(initialClients),
    bizora_quotations_v1: JSON.stringify(
      initialQuotations.map((q) => ({
        ...q,
        businessSnapshot: { ...q.businessSnapshot, updatedAt: '2025-05-05T00:00:00.000Z' },
      }))
    ),
    bizora_invoices_v1: JSON.stringify(
      initialInvoices.map((inv) => ({
        ...inv,
        businessSnapshot: { ...inv.businessSnapshot, updatedAt: '2025-05-05T00:00:00.000Z' },
      }))
    ),
    bizora_activities_v1: JSON.stringify(initialActivities),
    bizora_has_initialized_v1: 'true',
  });
  assert.equal(classifyWorkspace(demoSnapshot), 'demo_seed_only');

  const realSnapshot = makeSnapshot({
    bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
    bizora_clients_v1: JSON.stringify([makeBaseClient()]),
    bizora_quotations_v1: JSON.stringify([]),
    bizora_invoices_v1: JSON.stringify([]),
    bizora_activities_v1: JSON.stringify([]),
    bizora_has_initialized_v1: 'true',
  });
  assert.equal(classifyWorkspace(realSnapshot), 'existing_initialized');

  const missingInitSnapshot = makeSnapshot({
    bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
    bizora_clients_v1: JSON.stringify([makeBaseClient()]),
  });
  assert.equal(classifyWorkspace(missingInitSnapshot), 'existing_missing_init_marker');

  const corruptedSnapshot = makeSnapshot({
    bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
    bizora_clients_v1: 'not valid json',
    bizora_has_initialized_v1: 'true',
  });
  assert.equal(classifyWorkspace(corruptedSnapshot), 'partial_or_corrupted');
});

test('4. runExplicitLocalStorageMigration captures verified backup BEFORE parsing/validation and aborts safely on errors or conflicts', async () => {
  const callOrder: string[] = [];
  let savedBackupInput: BackupLegacyStorageInput | null = null;
  let migrateCalled = false;

  const corruptedSnapshot = makeSnapshot({
    bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
    bizora_clients_v1: '{corrupted_clients',
    bizora_has_initialized_v1: 'true',
  });

  const outcomeCorrupt = await runExplicitLocalStorageMigration({
    deps: {
      getRawSnapshot: () => {
        callOrder.push('snapshot');
        return corruptedSnapshot;
      },
      getMigrationStatus: async () => {
        callOrder.push('status');
        return makeAbsentStatus();
      },
      backupLegacyLocalstorage: async (input) => {
        callOrder.push('backup');
        savedBackupInput = input;
        return {
          backupFilename: 'bizora-localstorage-pre-migration-test.json',
          byteSize: '123',
          sha256: 'abc',
          verified: true,
          capturedKeyCount: '3',
        };
      },
      migrateLegacyWorkspace: async (_input: LegacyWorkspaceMigrationInput): Promise<MigrationResultDto> => {
        migrateCalled = true;
        throw new Error('Must not be called when validation fails');
      },
    },
  });

  assert.deepEqual(callOrder, ['snapshot', 'status', 'backup']);
  assert.equal(outcomeCorrupt.outcome, 'validation_failed');
  assert.equal(migrateCalled, false);
  const clientBackupEntry = (savedBackupInput as BackupLegacyStorageInput | null)?.keys.find(
    (k) => k.key === 'bizora_clients_v1'
  );
  assert.equal(clientBackupEntry?.rawValue, '{corrupted_clients');
  assert.equal(
    outcomeCorrupt.diagnostics.some((d) => d.code === 'CORRUPTED_JSON' && d.severity === 'error'),
    true
  );

  // Backup unverified -> abort immediately
  const unverifiedOutcome = await runExplicitLocalStorageMigration({
    deps: {
      getRawSnapshot: () =>
        makeSnapshot({
          bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
          bizora_has_initialized_v1: 'true',
        }),
      getMigrationStatus: async () => makeAbsentStatus(),
      backupLegacyLocalstorage: async () => ({
        backupFilename: 'bad.json',
        byteSize: '10',
        sha256: '00',
        verified: false,
        capturedKeyCount: '2',
      }),
      migrateLegacyWorkspace: async () => {
        throw new Error('Must not run when backup verification is false');
      },
    },
  });
  assert.equal(unverifiedOutcome.outcome, 'backup_failed');

  // Completed status -> skip without backup or import
  let backupRanWhenCompleted = false;
  const completedOutcome = await runExplicitLocalStorageMigration({
    deps: {
      getRawSnapshot: () => corruptedSnapshot,
      getMigrationStatus: async () => ({
        ...makeAbsentStatus(),
        state: 'completed',
        markerVersion: 1,
      }),
      backupLegacyLocalstorage: async () => {
        backupRanWhenCompleted = true;
        throw new Error('Should not run');
      },
    },
  });
  assert.equal(completedOutcome.outcome, 'already_completed');
  assert.equal(backupRanWhenCompleted, false);

  // Conflict existing data -> abort without backup or import
  const conflictOutcome = await runExplicitLocalStorageMigration({
    deps: {
      getRawSnapshot: () => corruptedSnapshot,
      getMigrationStatus: async () => ({
        ...makeAbsentStatus(),
        state: 'conflict_existing_data',
      }),
    },
  });
  assert.equal(conflictOutcome.outcome, 'conflict_existing_data');
});

test('5. UUID records are preserved verbatim while legacy IDs remap to UUID v4 with legacyId and activity log refs', () => {
  const validClientUuid = '11111111-1111-4111-8111-111111111111';
  const snapshot = makeSnapshot({
    bizora_business_profile_v1: JSON.stringify(makeBaseProfile({ id: 'biz_custom' })),
    bizora_clients_v1: JSON.stringify([makeBaseClient(validClientUuid, 'UUID Client')]),
    bizora_quotations_v1: JSON.stringify([
      makeBaseQuote({ id: 'quo_legacy_99', clientId: validClientUuid }),
    ]),
    bizora_invoices_v1: JSON.stringify([]),
    bizora_activities_v1: JSON.stringify([
      {
        id: 'act_legacy_1',
        type: 'quote_created',
        title: 'Quote created',
        description: 'Created quote',
        timestamp: '2026-10-05T09:05:00.000Z',
        referenceId: 'quo_legacy_99',
      },
    ]),
    bizora_has_initialized_v1: 'true',
  });

  const prepared = prepareMigrationPayload(snapshot);
  assert.equal(prepared.hasErrors, false);
  assert.ok(prepared.payload);
  assert.equal(prepared.payload.business.legacyId, 'biz_custom');
  assert.notEqual(prepared.payload.business.id, 'biz_custom');

  assert.equal(prepared.payload.clients[0].id, validClientUuid);
  assert.equal(prepared.payload.clients[0].legacyId, null);

  const migratedQuote = prepared.payload.quotations[0];
  assert.equal(migratedQuote.legacyId, 'quo_legacy_99');
  assert.notEqual(migratedQuote.id, 'quo_legacy_99');
  assert.equal(migratedQuote.clientId, validClientUuid);

  const act = prepared.payload.activityLogs[0];
  assert.equal(act.legacyId, 'act_legacy_1');
  assert.equal(act.referenceId, migratedQuote.id);
  assert.equal(act.referenceType, 'quotation');
});

test('6. Rejects duplicate IDs and case-insensitive duplicate document numbers without silent renaming', () => {
  const snapshot = makeSnapshot({
    bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
    bizora_clients_v1: JSON.stringify([
      makeBaseClient('cli_dup', 'Client A'),
      makeBaseClient('cli_dup', 'Client B'),
    ]),
    bizora_quotations_v1: JSON.stringify([
      makeBaseQuote({ id: 'quo_a', quotationNumber: 'QUO-0001' }),
      makeBaseQuote({ id: 'quo_b', quotationNumber: 'quo-0001' }),
    ]),
    bizora_invoices_v1: JSON.stringify([
      makeBaseInvoice({ id: 'inv_a', invoiceNumber: 'INV-0077' }),
      makeBaseInvoice({ id: 'inv_b', invoiceNumber: 'inv-0077' }),
    ]),
    bizora_activities_v1: JSON.stringify([]),
    bizora_has_initialized_v1: 'true',
  });

  const prepared = prepareMigrationPayload(snapshot);
  assert.equal(prepared.hasErrors, true);
  assert.equal(prepared.payload, null);
  assert.equal(
    prepared.diagnostics.some((d) => d.code === 'DUPLICATE_ID' && d.entityType === 'client'),
    true
  );
  assert.equal(
    prepared.diagnostics.some(
      (d) => d.code === 'DUPLICATE_DOCUMENT_NUMBER' && d.entityType === 'quotation'
    ),
    true
  );
  assert.equal(
    prepared.diagnostics.some(
      (d) => d.code === 'DUPLICATE_DOCUMENT_NUMBER' && d.entityType === 'invoice'
    ),
    true
  );
});

test('7. Lossless financial scaling rejects unrepresentable precision & overflow, preserves negative values and mismatched payment totals', () => {
  assert.equal(strictDecimalToScaledInt64(12.34, 2), '1234');
  assert.equal(strictDecimalToScaledInt64('1e-6', 6), '1');
  assert.throws(
    () => strictDecimalToScaledInt64(12.345, 2, 'amount'),
    (err: unknown) => err instanceof Error && 'code' in err && (err as { code: string }).code === 'UNREPRESENTABLE_FINANCIAL_PRECISION'
  );
  assert.throws(
    () => strictDecimalToScaledInt64('999999999999999999999', 2, 'amount'),
    (err: unknown) => err instanceof Error && 'code' in err && (err as { code: string }).code === 'NUMERIC_OVERFLOW'
  );

  // Unrepresentable precision in workspace aborts migration
  const precisionFail = prepareMigrationPayload(
    makeSnapshot({
      bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
      bizora_clients_v1: JSON.stringify([makeBaseClient()]),
      bizora_quotations_v1: JSON.stringify([makeBaseQuote({ grandTotal: 1150.129 })]),
      bizora_invoices_v1: JSON.stringify([]),
      bizora_activities_v1: JSON.stringify([]),
      bizora_has_initialized_v1: 'true',
    })
  );
  assert.equal(precisionFail.hasErrors, true);
  assert.equal(
    precisionFail.diagnostics.some((d) => d.code === 'UNREPRESENTABLE_FINANCIAL_PRECISION'),
    true
  );

  // Negative financial values and mismatched payment sums are preserved verbatim
  const negativeAndMismatch = prepareMigrationPayload(
    makeSnapshot({
      bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
      bizora_clients_v1: JSON.stringify([makeBaseClient()]),
      bizora_quotations_v1: JSON.stringify([
        makeBaseQuote({
          items: [{ id: 'qi_neg', description: 'Credit', quantity: -1, unitPrice: 100, total: -100 }],
          subtotal: -100,
          taxAmount: -15,
          grandTotal: -115,
        }),
      ]),
      bizora_invoices_v1: JSON.stringify([
        makeBaseInvoice({
          grandTotal: 1000,
          amountPaid: 400,
          outstandingBalance: 600,
          status: 'partially_paid',
          payments: [
            {
              id: 'pay_1',
              invoiceId: 'inv_1',
              amount: 250,
              paymentDate: '2026-10-12',
              paymentMethod: 'eft',
              recordedAt: '2026-10-12T10:00:00.000Z',
            },
          ],
        }),
      ]),
      bizora_activities_v1: JSON.stringify([]),
      bizora_has_initialized_v1: 'true',
    })
  );

  assert.equal(negativeAndMismatch.hasErrors, false);
  assert.ok(negativeAndMismatch.payload);
  assert.equal(negativeAndMismatch.payload.quotations[0].grandTotalMinor, '-11500');
  assert.equal(negativeAndMismatch.payload.invoices[0].amountPaidMinor, '40000');
  assert.equal(negativeAndMismatch.payload.payments[0].amountMinor, '25000');
  assert.equal(
    negativeAndMismatch.diagnostics.some((d) => d.code === 'NEGATIVE_FINANCIAL_VALUE_PRESERVED'),
    true
  );
  assert.equal(
    negativeAndMismatch.diagnostics.some((d) => d.code === 'INVOICE_PAYMENT_SUM_MISMATCH'),
    true
  );
  assert.deepEqual(negativeAndMismatch.payload.expectedFinancialSums, {
    quotationGrandTotalSumMinor: '-11500',
    invoiceGrandTotalSumMinor: '100000',
    invoiceAmountPaidSumMinor: '40000',
    paymentAmountSumMinor: '25000',
  });
});

test('8. Calendar date validation rejects invalid dates and falls back business createdAt safely', () => {
  const invalidDatePrepared = prepareMigrationPayload(
    makeSnapshot({
      bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
      bizora_clients_v1: JSON.stringify([makeBaseClient()]),
      bizora_quotations_v1: JSON.stringify([makeBaseQuote({ issueDate: '2026-02-30', expiryDate: '' })]),
      bizora_invoices_v1: JSON.stringify([]),
      bizora_activities_v1: JSON.stringify([]),
      bizora_has_initialized_v1: 'true',
    })
  );
  assert.equal(invalidDatePrepared.hasErrors, true);
  assert.equal(
    invalidDatePrepared.diagnostics.some(
      (d) => d.code === 'INVALID_DATE' && d.severity === 'error' && d.field === 'issueDate'
    ),
    true
  );

  // Business createdAt fallback + blank optional expiryDate -> null
  const validFallbackPrepared = prepareMigrationPayload(
    makeSnapshot({
      bizora_business_profile_v1: JSON.stringify(makeBaseProfile({ updatedAt: '2026-09-01T08:00:00.000Z' })),
      bizora_clients_v1: JSON.stringify([makeBaseClient()]),
      bizora_quotations_v1: JSON.stringify([makeBaseQuote({ expiryDate: '   ' })]),
      bizora_invoices_v1: JSON.stringify([]),
      bizora_activities_v1: JSON.stringify([]),
      bizora_has_initialized_v1: 'true',
    })
  );
  assert.equal(validFallbackPrepared.hasErrors, false);
  assert.equal(validFallbackPrepared.payload?.business.createdAt, '2026-09-01T08:00:00.000Z');
  assert.equal(validFallbackPrepared.payload?.quotations[0].expiryDate, null);
  assert.equal(
    validFallbackPrepared.diagnostics.some((d) => d.code === 'BUSINESS_CREATED_AT_FALLBACK'),
    true
  );
});

test('9. Revision 3 relationship resolution is order-independent, preserves multi-invoice history, handles competing claims, declined links, and dangling refs', () => {
  const qStaleUuid = '20000000-0000-4000-8000-000000000001';
  const qTrueUuid = '20000000-0000-4000-8000-000000000002';
  const qDeclinedUuid = '20000000-0000-4000-8000-000000000003';
  const qOrphanStaleUuid = '20000000-0000-4000-8000-000000000004';
  const qFwdOlderUuid = '20000000-0000-4000-8000-000000000005';
  const qFwdNewerUuid = '20000000-0000-4000-8000-000000000006';

  const invOwned1Uuid = '30000000-0000-4000-8000-000000000001';
  const invOwned2Uuid = '30000000-0000-4000-8000-000000000002';
  const invDeclinedUuid = '30000000-0000-4000-8000-000000000003';
  const invForwardOnlyUuid = '30000000-0000-4000-8000-000000000004';
  const invDanglingRefUuid = '30000000-0000-4000-8000-000000000005';

  const quotes = [
    // Claims invOwned1Uuid forward-only, but invOwned1Uuid explicitly belongs to qTrueUuid!
    makeBaseQuote({
      id: qStaleUuid,
      quotationNumber: 'QUO-1001',
      convertedInvoiceId: invOwned1Uuid,
      expiryDate: '2099-12-31',
      status: 'accepted',
      preConversionStatus: 'sent',
    }),
    // Explicitly linked by two invoices; has stale convertedInvoiceId pointing elsewhere
    makeBaseQuote({
      id: qTrueUuid,
      quotationNumber: 'QUO-1002',
      convertedInvoiceId: 'NON_EXISTENT_INV',
      status: 'sent',
    }),
    // Declined quote linked to invDeclinedUuid -> must keep status = 'declined'
    makeBaseQuote({
      id: qDeclinedUuid,
      quotationNumber: 'QUO-1003',
      status: 'declined',
    }),
    // Orphan stale convertedInvoiceId -> must clear and restore preConversionStatus
    makeBaseQuote({
      id: qOrphanStaleUuid,
      quotationNumber: 'QUO-1004',
      convertedInvoiceId: 'INV-DOES-NOT-EXIST',
      status: 'accepted',
      preConversionStatus: 'draft',
    }),
    // Competing orphan forward claimants for invForwardOnlyUuid
    makeBaseQuote({
      id: qFwdOlderUuid,
      quotationNumber: 'QUO-1005',
      convertedInvoiceId: invForwardOnlyUuid,
      expiryDate: '2020-01-01',
      status: 'sent',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }),
    makeBaseQuote({
      id: qFwdNewerUuid,
      quotationNumber: 'QUO-1006',
      convertedInvoiceId: invForwardOnlyUuid,
      status: 'sent',
      updatedAt: '2026-10-20T00:00:00.000Z',
    }),
  ];

  const invoices = [
    makeBaseInvoice({
      id: invOwned2Uuid,
      invoiceNumber: 'INV-2002',
      quotationId: 'quo-1002', // legacy quotationNumber match (case-insensitive)
      createdAt: '2026-10-15T10:00:00.000Z',
    }),
    makeBaseInvoice({
      id: invOwned1Uuid,
      invoiceNumber: 'INV-2001',
      quotationId: qTrueUuid,
      createdAt: '2026-10-12T10:00:00.000Z',
    }),
    makeBaseInvoice({
      id: invDeclinedUuid,
      invoiceNumber: 'INV-2003',
      quotationId: qDeclinedUuid,
    }),
    makeBaseInvoice({
      id: invForwardOnlyUuid,
      invoiceNumber: 'INV-2004',
      quotationId: undefined, // forward-only target -> must stay null
    }),
    makeBaseInvoice({
      id: invDanglingRefUuid,
      invoiceNumber: 'INV-2005',
      quotationId: 'QUO-DELETED-999',
    }),
  ];

  const forwardRun = prepareMigrationPayload(
    makeSnapshot({
      bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
      bizora_clients_v1: JSON.stringify([makeBaseClient()]),
      bizora_quotations_v1: JSON.stringify(quotes),
      bizora_invoices_v1: JSON.stringify(invoices),
      bizora_activities_v1: JSON.stringify([]),
      bizora_has_initialized_v1: 'true',
    })
  );

  const reversedRun = prepareMigrationPayload(
    makeSnapshot({
      bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
      bizora_clients_v1: JSON.stringify([makeBaseClient()]),
      bizora_quotations_v1: JSON.stringify([...quotes].reverse()),
      bizora_invoices_v1: JSON.stringify([...invoices].reverse()),
      bizora_activities_v1: JSON.stringify([]),
      bizora_has_initialized_v1: 'true',
    })
  );

  assert.equal(forwardRun.hasErrors, false);
  assert.equal(reversedRun.hasErrors, false);
  assert.ok(forwardRun.payload && reversedRun.payload);

  const getMap = (payload: NonNullable<typeof forwardRun.payload>) => ({
    q: Object.fromEntries(payload.quotations.map((x) => [x.id, x])),
    i: Object.fromEntries(payload.invoices.map((x) => [x.id, x])),
  });

  const f = getMap(forwardRun.payload);
  const r = getMap(reversedRun.payload);

  // Order-independence across all quotations & invoices
  for (const id of Object.keys(f.q)) {
    assert.equal(f.q[id].convertedInvoiceId, r.q[id].convertedInvoiceId);
    assert.equal(f.q[id].status, r.q[id].status);
  }
  for (const id of Object.keys(f.i)) {
    assert.equal(f.i[id].quotationId, r.i[id].quotationId);
  }

  // Explicit invoice link wins over stale forward claim on qStaleUuid
  assert.equal(f.q[qStaleUuid].convertedInvoiceId, null);
  assert.equal(f.q[qStaleUuid].status, 'sent');

  // qTrueUuid preserves BOTH invoices via quotationId and picks earliest createdAt (invOwned1Uuid)
  assert.equal(f.i[invOwned1Uuid].quotationId, qTrueUuid);
  assert.equal(f.i[invOwned2Uuid].quotationId, qTrueUuid);
  assert.equal(f.q[qTrueUuid].convertedInvoiceId, invOwned1Uuid);
  assert.equal(f.q[qTrueUuid].status, 'accepted');
  assert.equal(f.q[qTrueUuid].preConversionStatus, 'sent');

  // Declined linked quote preserves declined status
  assert.equal(f.q[qDeclinedUuid].convertedInvoiceId, invDeclinedUuid);
  assert.equal(f.q[qDeclinedUuid].status, 'declined');

  // Orphan stale quote restored to preConversionStatus 'draft'
  assert.equal(f.q[qOrphanStaleUuid].convertedInvoiceId, null);
  assert.equal(f.q[qOrphanStaleUuid].status, 'draft');
  assert.equal(f.q[qOrphanStaleUuid].preConversionStatus, null);

  // Competing orphan forward claimants: newer updatedAt wins, invoice.quotationId stays null
  assert.equal(f.q[qFwdNewerUuid].convertedInvoiceId, invForwardOnlyUuid);
  assert.equal(f.q[qFwdOlderUuid].convertedInvoiceId, null);
  assert.equal(f.i[invForwardOnlyUuid].quotationId, null);

  // Dangling invoice.quotationId cleared
  assert.equal(f.i[invDanglingRefUuid].quotationId, null);
  assert.equal(
    forwardRun.diagnostics.some((d) => d.code === 'DANGLING_INVOICE_QUOTATION_REF'),
    true
  );
  assert.equal(
    forwardRun.diagnostics.some((d) => d.code === 'DECLINED_LINKED_QUOTATION'),
    true
  );
  assert.equal(
    forwardRun.diagnostics.some((d) => d.code === 'DUPLICATE_CONVERTED_INVOICE_CLAIM'),
    true
  );
  assert.equal(
    forwardRun.diagnostics.some((d) => d.code === 'UNLINKED_QUOTATION_RESTORED'),
    true
  );

  // Unlinked accepted quote with past expiryDate restores to 'expired'
  const expiredUnlinked = prepareMigrationPayload(
    makeSnapshot({
      bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
      bizora_clients_v1: JSON.stringify([makeBaseClient()]),
      bizora_quotations_v1: JSON.stringify([
        makeBaseQuote({
          id: 'quo_expired_stale',
          convertedInvoiceId: 'INV-MISSING',
          expiryDate: '2020-01-01',
          status: 'accepted',
          preConversionStatus: 'sent',
        }),
      ]),
      bizora_invoices_v1: JSON.stringify([]),
      bizora_activities_v1: JSON.stringify([]),
      bizora_has_initialized_v1: 'true',
    })
  );
  assert.equal(expiredUnlinked.payload?.quotations[0].status, 'expired');
  assert.equal(expiredUnlinked.payload?.quotations[0].convertedInvoiceId, null);
});

test('10. Deleted clients preserve snapshots with clientId = null and never create synthetic clients', () => {
  const deletedClientSnap = makeBaseClient('cli_deleted', 'Former Client');
  const prepared = prepareMigrationPayload(
    makeSnapshot({
      bizora_business_profile_v1: JSON.stringify(makeBaseProfile()),
      bizora_clients_v1: JSON.stringify([]),
      bizora_quotations_v1: JSON.stringify([
        makeBaseQuote({ clientId: 'cli_deleted', clientSnapshot: deletedClientSnap }),
      ]),
      bizora_invoices_v1: JSON.stringify([
        makeBaseInvoice({ clientId: 'cli_deleted', clientSnapshot: deletedClientSnap }),
      ]),
      bizora_activities_v1: JSON.stringify([]),
      bizora_has_initialized_v1: 'true',
    })
  );

  assert.equal(prepared.hasErrors, false);
  assert.ok(prepared.payload);
  assert.equal(prepared.payload.clients.length, 0);
  assert.equal(prepared.payload.quotations[0].clientId, null);
  assert.equal(prepared.payload.invoices[0].clientId, null);
  assert.equal(JSON.parse(prepared.payload.quotations[0].clientSnapshotJson).name, 'Former Client');
  assert.equal(
    prepared.diagnostics.some((d) => d.code === 'DELETED_CLIENT_PRESERVED'),
    true
  );
});

test('11. Logo hydration and SHA-256 asset deduplication occur in payload only without touching LocalStorage', () => {
  const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const cachedDataUrl = 'data:image/svg+xml;base64,PHN2Zy8+';

  mockStorage.seedDirect(
    'bizora_business_profile_v1',
    JSON.stringify(makeBaseProfile({ logoUrl: pngDataUrl }))
  );
  mockStorage.seedDirect('bizora_clients_v1', JSON.stringify([makeBaseClient()]));
  mockStorage.seedDirect(
    'bizora_quotations_v1',
    JSON.stringify([
      makeBaseQuote({
        businessSnapshot: makeBaseProfile({ logoUrl: '__BIZORA_PROFILE_LOGO__' }),
      }),
    ])
  );
  mockStorage.seedDirect(
    'bizora_invoices_v1',
    JSON.stringify([
      makeBaseInvoice({
        id: 'inv_a',
        invoiceNumber: 'INV-0001',
        businessSnapshot: makeBaseProfile({ logoUrl: '__BIZORA_LOGO__:logo_123' }),
      }),
      makeBaseInvoice({
        id: 'inv_b',
        invoiceNumber: 'INV-0002',
        businessSnapshot: makeBaseProfile({ logoUrl: cachedDataUrl }),
      }),
    ])
  );
  mockStorage.seedDirect('bizora_logo_cache_v1', JSON.stringify({ logo_123: cachedDataUrl }));
  mockStorage.seedDirect('bizora_activities_v1', JSON.stringify([]));
  mockStorage.seedDirect('bizora_has_initialized_v1', 'true');
  mockStorage.seedDirect(THEME_STORAGE_KEY, 'dark');

  const snapshot = StorageService.getRawMigrationSnapshot();
  const prepared = prepareMigrationPayload(snapshot);

  assert.equal(mockStorage.writeCalls.length, 0);
  assert.equal(prepared.hasErrors, false);
  assert.ok(prepared.payload);

  // Two distinct logos (pngDataUrl and cachedDataUrl deduplicated across inv_a and inv_b)
  assert.equal(prepared.payload.assets.length, 2);
  assert.equal(
    prepared.payload.business.logoAssetId,
    prepared.payload.assets.find((a) => a.inlineData === pngDataUrl)?.id
  );
  assert.equal(
    JSON.parse(prepared.payload.quotations[0].businessSnapshotJson).logoUrl,
    pngDataUrl
  );
  assert.equal(
    JSON.parse(prepared.payload.invoices[0].businessSnapshotJson).logoUrl,
    cachedDataUrl
  );
  assert.deepEqual(prepared.payload.settings, [
    {
      key: 'theme_preference',
      valueJson: '"dark"',
      updatedAt: prepared.payload.settings[0].updatedAt,
    },
  ]);

  // Relative paths stay in logoUrlFallback
  const relPrepared = prepareMigrationPayload(
    makeSnapshot({
      bizora_business_profile_v1: JSON.stringify(makeBaseProfile({ logoUrl: '/assets/logo.png' })),
      bizora_clients_v1: JSON.stringify([]),
      bizora_quotations_v1: JSON.stringify([]),
      bizora_invoices_v1: JSON.stringify([]),
      bizora_activities_v1: JSON.stringify([]),
      bizora_has_initialized_v1: 'true',
    })
  );
  assert.equal(relPrepared.payload?.assets.length, 0);
  assert.equal(relPrepared.payload?.business.logoAssetId, null);
  assert.equal(relPrepared.payload?.business.logoUrlFallback, '/assets/logo.png');
});

test('12. redactDiagnosticValue sanitizes data URIs, tokens, control chars, and caps length <= 120', () => {
  const bigDataUri = `data:image/png;base64,${'A'.repeat(500)}`;
  const redactedUri = redactDiagnosticValue(bigDataUri);
  assert.ok(redactedUri);
  assert.equal(redactedUri.includes('AAAA'), false);
  assert.equal(redactedUri.startsWith('[data:image/png;'), true);
  assert.equal(redactedUri.length <= 120, true);

  const secretText = `Bearer super_secret_token_123456\n\t${'x'.repeat(200)}`;
  const redactedSecret = redactDiagnosticValue(secretText);
  assert.ok(redactedSecret);
  assert.equal(redactedSecret.includes('super_secret_token_123456'), false);
  assert.equal(redactedSecret.includes('\n'), false);
  assert.equal(redactedSecret.length <= 120, true);
});
