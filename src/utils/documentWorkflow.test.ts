import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BrowserPersistenceAdapter,
  SqlitePersistenceAdapter,
} from '../services/persistence';
import { initialBusinessProfile, initialClients } from '../services/seedData';
import type { BusinessProfile, Client, Invoice, Quotation } from '../types';
import { determineUpdatedInvoiceStatus, isDateBeforeLocalToday } from './calculations';
import {
  createInitialPaymentFormState,
  getInvoiceStatusOptionsForUi,
  getPaymentModalResetKey,
  resolveClientReferenceWithSnapshotFallback,
  validateConvertedQuotationEdit,
  validateManualInvoiceStatusChange,
  validateQuotationStatusChange,
} from './documentWorkflow';
import { DocumentSheet } from '../components/documents/DocumentSheet';

// Lightweight localStorage + bridge harness for adapter-level Stage 3.1 workflow regression tests
class MemoryLocalStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) ?? null) : null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

const mockStorage = new MemoryLocalStorage();
Object.defineProperty(globalThis, 'localStorage', {
  value: mockStorage,
  configurable: true,
});

function makeProfile(): BusinessProfile {
  return {
    ...initialBusinessProfile,
    id: 'biz_test',
    name: 'Okavango Engineering CC',
    logoUrl: '',
    nextQuoteNumber: 1,
    nextInvoiceNumber: 1,
  };
}

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    ...initialClients[0],
    id: 'cli_alpha',
    name: 'Alpha Mining Pty Ltd',
    companyName: 'Alpha Holdings',
    email: 'accounts@alpha.na',
    ...overrides,
  };
}

function makeQuote(profile: BusinessProfile, client: Client, overrides: Partial<Quotation> = {}): Quotation {
  return {
    id: 'quo_1',
    quotationNumber: 'QUO-0001',
    clientId: client.id,
    clientSnapshot: client,
    businessSnapshot: profile,
    issueDate: '2026-11-10',
    expiryDate: '2026-12-10',
    currency: 'NAD',
    currencySymbol: 'N$',
    items: [
      {
        id: 'item_q1',
        description: 'Pump Overhaul',
        quantity: 2,
        unitPrice: 1000,
        total: 2000,
      },
    ],
    subtotal: 2000,
    discountType: 'percentage',
    discountValue: 0,
    discountAmount: 0,
    taxName: 'VAT',
    taxRate: 15,
    taxAmount: 300,
    grandTotal: 2300,
    status: 'sent',
    notes: 'Original notes',
    terms: 'Valid for 30 days',
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...overrides,
  };
}

function makeInvoice(profile: BusinessProfile, client: Client, overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv_1',
    invoiceNumber: 'INV-0001',
    clientId: client.id,
    clientSnapshot: client,
    businessSnapshot: profile,
    issueDate: '2026-11-10',
    dueDate: '2026-12-10',
    currency: 'NAD',
    currencySymbol: 'N$',
    items: [
      {
        id: 'item_i1',
        description: 'Pump Overhaul',
        quantity: 2,
        unitPrice: 1000,
        total: 2000,
      },
    ],
    subtotal: 2000,
    discountType: 'percentage',
    discountValue: 0,
    discountAmount: 0,
    taxName: 'VAT',
    taxRate: 15,
    taxAmount: 300,
    grandTotal: 2300,
    amountPaid: 0,
    outstandingBalance: 2300,
    status: 'sent',
    payments: [],
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...overrides,
  };
}

// Minimal SQLite bridge spy focused on quotation/invoice/client/payment/activity flows
import type { WorkspaceLifecycleResultDto } from '../services/database';
import type { SqlitePersistenceBridge } from '../services/persistence/sqliteAdapter';

class WorkflowSqliteBridgeSpy implements SqlitePersistenceBridge {
  localProfiles = new Map<string, any>();
  businesses = new Map<string, any>();
  assets = new Map<string, any>();
  clients = new Map<string, any>();
  quotations = new Map<string, any>();
  invoices = new Map<string, any>();
  payments = new Map<string, any>();
  activities: any[] = [];
  settings = new Map<string, any>();
  calls: string[] = [];
  private seq = 0;

  private tick(): string {
    this.seq += 1;
    return `2026-11-21T10:00:${String(this.seq).padStart(2, '0')}.000Z`;
  }

  async getLocalProfiles() { return Array.from(this.localProfiles.values()); }
  async createLocalProfile(input: any) {
    const dto = { ...input, createdAt: this.tick(), updatedAt: this.tick() };
    this.localProfiles.set(dto.id, dto);
    return dto;
  }
  async getBusinesses(ownerProfileId?: string | null) {
    const all = Array.from(this.businesses.values());
    return ownerProfileId ? all.filter((b) => b.ownerProfileId === ownerProfileId) : all;
  }
  async getBusinessById(id: string) { return this.businesses.get(id) ?? null; }
  async createBusiness(input: any) {
    const dto = { ...input, createdAt: input.createdAt ?? this.tick(), updatedAt: input.updatedAt ?? this.tick() };
    this.businesses.set(dto.id, dto);
    return dto;
  }
  async updateBusiness(input: any) {
    const updated = { ...this.businesses.get(input.id), ...input, updatedAt: this.tick() };
    this.businesses.set(input.id, updated);
    return updated;
  }
  async createBusinessAsset(input: any) {
    const dto = { ...input, createdAt: this.tick() };
    this.assets.set(dto.id, dto);
    return dto;
  }
  async getBusinessAssetById(id: string) { return this.assets.get(id) ?? null; }
  async getBusinessAssetsByBusiness(businessId: string) {
    return Array.from(this.assets.values()).filter((a) => a.businessId === businessId);
  }
  async deleteBusinessAsset(id: string) { this.assets.delete(id); }

  async createClient(input: any) {
    this.calls.push('createClient');
    const dto = { ...input, createdAt: input.createdAt ?? this.tick(), updatedAt: input.updatedAt ?? this.tick() };
    this.clients.set(dto.id, dto);
    return dto;
  }
  async getClientById(id: string) { return this.clients.get(id) ?? null; }
  async getClientsByBusiness(businessId: string) {
    return Array.from(this.clients.values()).filter((c) => c.businessId === businessId);
  }
  async updateClient(input: any) {
    const updated = { ...this.clients.get(input.id), ...input, updatedAt: this.tick() };
    this.clients.set(input.id, updated);
    return updated;
  }
  async deleteClient(id: string) {
    this.calls.push('deleteClient');
    // Mirrors SQLite client_repository::delete_client (detaches client_id, preserves snapshots)
    for (const [qid, q] of this.quotations.entries()) {
      if (q.clientId === id) this.quotations.set(qid, { ...q, clientId: null });
    }
    for (const [iid, inv] of this.invoices.entries()) {
      if (inv.clientId === id) this.invoices.set(iid, { ...inv, clientId: null });
    }
    this.clients.delete(id);
  }

  async createQuotation(input: any) {
    this.calls.push('createQuotation');
    if (input.clientId && !this.clients.has(input.clientId)) {
      throw new Error('Referenced client does not exist for this business');
    }
    const dto = {
      ...input,
      preConversionStatus: null,
      convertedInvoiceId: null,
      items: input.items.map((item: any, idx: number) => ({
        ...item,
        businessId: input.businessId,
        quotationId: input.id,
        sortOrder: String(item.sortOrder ?? idx),
        createdAt: this.tick(),
      })),
      createdAt: input.createdAt ?? this.tick(),
      updatedAt: input.updatedAt ?? this.tick(),
    };
    this.quotations.set(dto.id, dto);
    return dto;
  }
  async getQuotationById(id: string) { return this.quotations.get(id) ?? null; }
  async getQuotationsByBusiness(businessId: string) {
    return Array.from(this.quotations.values()).filter((q) => q.businessId === businessId);
  }
  async updateQuotation(input: any) {
    this.calls.push('updateQuotation');
    const existing = this.quotations.get(input.id);
    if (!existing) throw new Error('Quotation not found');
    const updated = {
      ...existing,
      ...input,
      items: input.items.map((item: any, idx: number) => ({
        ...item,
        businessId: input.businessId,
        quotationId: input.id,
        sortOrder: String(item.sortOrder ?? idx),
        createdAt: this.tick(),
      })),
      updatedAt: this.tick(),
    };
    this.quotations.set(updated.id, updated);
    return updated;
  }
  async deleteQuotation(id: string) { this.quotations.delete(id); }

  async createInvoice(input: any) {
    this.calls.push('createInvoice');
    if (input.clientId && !this.clients.has(input.clientId)) {
      throw new Error('Referenced client does not exist for this business');
    }
    const dto = {
      ...input,
      amountPaidMinor: '0',
      outstandingBalanceMinor: input.grandTotalMinor,
      items: input.items.map((item: any, idx: number) => ({
        ...item,
        businessId: input.businessId,
        invoiceId: input.id,
        sortOrder: String(item.sortOrder ?? idx),
        createdAt: this.tick(),
      })),
      payments: [],
      createdAt: input.createdAt ?? this.tick(),
      updatedAt: input.updatedAt ?? this.tick(),
    };
    this.invoices.set(dto.id, dto);

    // Atomic conversion link inside create_invoice transaction
    if (dto.quotationId) {
      const q = this.quotations.get(dto.quotationId);
      if (q) {
        this.quotations.set(q.id, {
          ...q,
          convertedInvoiceId: dto.id,
          preConversionStatus: q.preConversionStatus ?? q.status,
          status: q.status === 'declined' ? 'declined' : 'accepted',
          updatedAt: this.tick(),
        });
      }
    }
    return dto;
  }
  async getInvoiceById(id: string) { return this.invoices.get(id) ?? null; }
  async getInvoicesByBusiness(businessId: string) {
    return Array.from(this.invoices.values()).filter((i) => i.businessId === businessId);
  }
  async updateInvoice(input: any) {
    this.calls.push('updateInvoice');
    const existing = this.invoices.get(input.id);
    if (!existing) throw new Error('Invoice not found');
    const paid = BigInt(existing.amountPaidMinor);
    const total = BigInt(input.grandTotalMinor);
    const coercedStatus =
      paid === 0n && (input.status === 'paid' || input.status === 'partially_paid')
        ? existing.status === 'draft'
          ? 'draft'
          : 'sent'
        : input.status;
    const updated = {
      ...existing,
      ...input,
      status: coercedStatus,
      amountPaidMinor: existing.amountPaidMinor,
      outstandingBalanceMinor: (total > paid ? total - paid : 0n).toString(),
      updatedAt: this.tick(),
    };
    this.invoices.set(updated.id, updated);
    return updated;
  }
  async deleteInvoice(id: string) { this.invoices.delete(id); }

  async createPayment(input: any) {
    const dto = { ...input, recordedAt: input.recordedAt ?? this.tick() };
    this.payments.set(dto.id, dto);
    const inv = this.invoices.get(dto.invoiceId);
    if (inv) {
      const totalPaid = Array.from(this.payments.values())
        .filter((p) => p.invoiceId === inv.id)
        .reduce((sum, p) => sum + BigInt(p.amountMinor), 0n);
      const grandTotal = BigInt(inv.grandTotalMinor);
      const balance = grandTotal > totalPaid ? grandTotal - totalPaid : 0n;
      this.invoices.set(inv.id, {
        ...inv,
        payments: Array.from(this.payments.values()).filter((p) => p.invoiceId === inv.id),
        amountPaidMinor: totalPaid.toString(),
        outstandingBalanceMinor: balance.toString(),
        status: totalPaid >= grandTotal ? 'paid' : totalPaid > 0n ? 'partially_paid' : inv.status,
      });
    }
    return dto;
  }
  async getPaymentsByInvoice(invoiceId: string) {
    return Array.from(this.payments.values()).filter((p) => p.invoiceId === invoiceId);
  }
  async getPaymentsByBusiness(businessId: string) {
    return Array.from(this.payments.values()).filter((p) => p.businessId === businessId);
  }
  async deletePayment(id: string) { this.payments.delete(id); }

  async createActivityLog(input: any) {
    this.calls.push(`createActivity:${input.activityType}`);
    const dto = { ...input, timestamp: input.timestamp ?? this.tick() };
    this.activities.unshift(dto);
    return dto;
  }
  async getActivityLogsByBusiness(businessId: string) {
    return this.activities.filter((a) => a.businessId === businessId);
  }
  async getAppSetting(key: string) { return this.settings.get(key) ?? null; }
  async saveAppSetting(input: any) {
    const dto = { key: input.key, valueJson: input.valueJson, updatedAt: this.tick() };
    this.settings.set(dto.key, dto);
    return dto;
  }
  async deleteAppSetting(key: string) { this.settings.delete(key); }
  async replaceDesktopWorkspace(): Promise<WorkspaceLifecycleResultDto> {
    throw new Error('unused');
  }
  async clearDesktopWorkspace(): Promise<WorkspaceLifecycleResultDto> {
    throw new Error('unused');
  }
}

// ============================================================
// Task 1: RecordPaymentModal Reset & Initialization
// ============================================================

test('Task 1: RecordPaymentModal initial state and reset key reset stale amounts and fields', () => {
  const profile = makeProfile();
  const client = makeClient();
  const inv1 = makeInvoice(profile, client, {
    id: 'inv_1',
    outstandingBalance: 1500.5,
    updatedAt: '2026-11-21T08:00:00.000Z',
  });
  const inv2 = makeInvoice(profile, client, {
    id: 'inv_2',
    outstandingBalance: 420,
    updatedAt: '2026-11-21T08:05:00.000Z',
  });

  const s1 = createInitialPaymentFormState(inv1, '2026-11-21');
  assert.equal(s1.amount, 1500.5);
  assert.equal(s1.amountInput, '1500.50');
  assert.equal(s1.paymentDate, '2026-11-21');
  assert.equal(s1.paymentMethod, 'eft');
  assert.equal(s1.reference, '');
  assert.equal(s1.notes, '');
  assert.equal(s1.error, '');

  const s2 = createInitialPaymentFormState(inv2, '2026-11-21');
  assert.equal(s2.amount, 420);
  assert.equal(s2.amountInput, '420');

  assert.notEqual(getPaymentModalResetKey(inv1), getPaymentModalResetKey(inv2));

  // Same invoice reopened after partial payment updates balance & key
  const inv1AfterPartial = {
    ...inv1,
    outstandingBalance: 500.5,
    payments: [{ id: 'p1', invoiceId: 'inv_1', amount: 1000, paymentDate: '2026-11-21', paymentMethod: 'eft' as const, recordedAt: '2026-11-21T09:00:00.000Z' }],
    updatedAt: '2026-11-21T09:00:00.000Z',
  };
  assert.notEqual(getPaymentModalResetKey(inv1), getPaymentModalResetKey(inv1AfterPartial));
  assert.equal(createInitialPaymentFormState(inv1AfterPartial, '2026-11-21').amountInput, '500.50');
});

// ============================================================
// Task 2: Invoice Payment & Status Integrity
// ============================================================

test('Task 2: unpaid 0-payment invoices cannot become paid/partially_paid and UI guards options consistently', async () => {
  // Local YYYY-MM-DD date comparison & unpaid status clamping
  assert.equal(isDateBeforeLocalToday('2026-11-20', '2026-11-21'), true);
  assert.equal(isDateBeforeLocalToday('2026-11-21', '2026-11-21'), false);

  assert.equal(
    determineUpdatedInvoiceStatus('paid', 1000, 0, '2026-12-30', '2026-11-21'),
    'sent'
  );
  assert.equal(
    determineUpdatedInvoiceStatus('partially_paid', 1000, 0, '2026-12-30', '2026-11-21'),
    'sent'
  );
  assert.equal(
    determineUpdatedInvoiceStatus('paid', 1000, 0, '2026-11-10', '2026-11-21'),
    'overdue'
  );
  assert.equal(
    determineUpdatedInvoiceStatus('sent', 0, 50, '2026-12-30', '2026-11-21'),
    'paid'
  );
  assert.equal(
    determineUpdatedInvoiceStatus('sent', 1000, 400, '2026-12-30', '2026-11-21'),
    'partially_paid'
  );
  assert.equal(
    determineUpdatedInvoiceStatus('partially_paid', 1000, 1000, '2026-12-30', '2026-11-21'),
    'paid'
  );

  // Manual status change validation
  const unpaidInvoice = makeInvoice(makeProfile(), makeClient(), { amountPaid: 0, payments: [], status: 'sent' });
  assert.equal(validateManualInvoiceStatusChange(unpaidInvoice, 'paid').valid, false);
  assert.equal(validateManualInvoiceStatusChange(unpaidInvoice, 'partially_paid').valid, false);
  assert.equal(validateManualInvoiceStatusChange(unpaidInvoice, 'draft').valid, true);
  assert.equal(validateManualInvoiceStatusChange(unpaidInvoice, 'overdue').valid, true);

  const unpaidOptions = getInvoiceStatusOptionsForUi(unpaidInvoice);
  assert.equal(unpaidOptions.find((o) => o.value === 'paid')?.disabled, true);
  assert.equal(unpaidOptions.find((o) => o.value === 'partially_paid')?.disabled, true);
  assert.equal(unpaidOptions.find((o) => o.value === 'sent')?.disabled, false);

  const partialInvoice = makeInvoice(makeProfile(), makeClient(), {
    amountPaid: 500,
    outstandingBalance: 1800,
    status: 'partially_paid',
    payments: [{ id: 'p1', invoiceId: 'inv_1', amount: 500, paymentDate: '2026-11-21', paymentMethod: 'eft', recordedAt: '2026-11-21T09:00:00.000Z' }],
  });
  assert.equal(validateManualInvoiceStatusChange(partialInvoice, 'draft').valid, false);
  assert.equal(validateManualInvoiceStatusChange(partialInvoice, 'paid').valid, false);
  const partialOptions = getInvoiceStatusOptionsForUi(partialInvoice);
  assert.equal(partialOptions.find((o) => o.value === 'partially_paid')?.disabled, false);
  assert.equal(partialOptions.find((o) => o.value === 'paid')?.disabled, true);

  // Browser adapter enforcement
  mockStorage.clear();
  const browser = new BrowserPersistenceAdapter();
  await browser.resetToDemoData();
  const profile = await browser.getBusinessProfile();
  const clients = await browser.getClients();
  const savedUnpaid = await browser.saveInvoice(
    makeInvoice(profile, clients[0], { id: 'inv_guard_browser', invoiceNumber: 'INV-8801', status: 'paid', payments: [] })
  );
  assert.equal(savedUnpaid.status, 'sent');
});

// ============================================================
// Task 3 & Task 4: Conversion Integrity & Converted Quotation Protection
// ============================================================

test('Task 3 & 4: SqlitePersistenceAdapter links quotation atomically inside createInvoice without extra updateQuotation, and converted quotations reject unsafe mutations', async () => {
  const spy = new WorkflowSqliteBridgeSpy();
  const sqlite = new SqlitePersistenceAdapter({ bridge: spy as any, now: () => '2026-11-21T10:00:00.000Z' });

  const profile = await sqlite.saveBusinessProfile(makeProfile());
  const client = await sqlite.saveClient(makeClient());
  const quote = await sqlite.saveQuotation(makeQuote(profile, client));

  spy.calls.length = 0;
  const convertedInv = await sqlite.saveInvoice(
    makeInvoice(profile, client, {
      id: 'inv_conv_1',
      invoiceNumber: 'INV-0001',
      quotationId: quote.id,
    })
  );

  assert.ok(spy.calls.includes('createInvoice'));
  assert.equal(spy.calls.includes('updateQuotation'), false);

  const reloadedQuote = await sqlite.getQuotationById(quote.id);
  assert.equal(reloadedQuote?.status, 'accepted');
  assert.equal(reloadedQuote?.convertedInvoiceId, convertedInv.id);

  // Converted quotation protection rules
  assert.equal(validateQuotationStatusChange(reloadedQuote!, 'declined', convertedInv.invoiceNumber).valid, false);
  assert.equal(validateQuotationStatusChange(reloadedQuote!, 'draft', convertedInv.invoiceNumber).valid, false);
  assert.equal(validateQuotationStatusChange(reloadedQuote!, 'expired', convertedInv.invoiceNumber).valid, false);
  assert.equal(validateQuotationStatusChange(reloadedQuote!, 'accepted', convertedInv.invoiceNumber).valid, true);

  // Unsafe financial mutation blocked
  const editedFinancialQuote: Quotation = {
    ...reloadedQuote!,
    items: [{ ...reloadedQuote!.items[0], unitPrice: 9999, total: 19998 }],
    subtotal: 19998,
    grandTotal: 22997.7,
  };
  assert.equal(
    validateConvertedQuotationEdit(reloadedQuote!, editedFinancialQuote, convertedInv.invoiceNumber).valid,
    false
  );

  // Safe notes/terms edit allowed
  const editedNotesQuote: Quotation = {
    ...reloadedQuote!,
    notes: 'Updated follow-up notes',
  };
  assert.equal(
    validateConvertedQuotationEdit(reloadedQuote!, editedNotesQuote, convertedInv.invoiceNumber).valid,
    true
  );
});

// ============================================================
// Task 5: Deleted-Client Duplication & Conversion Edge Cases
// ============================================================

test('Task 5: duplicating and converting documents with deleted clients preserves snapshots on Browser and SQLite', async () => {
  // 1. Resolution helper handles both detached (clientId: '') and stale deleted clientId
  const snapshotClient = makeClient({ id: 'cli_deleted', name: 'Deleted Co' });
  const staleRes = resolveClientReferenceWithSnapshotFallback(
    { clientId: 'cli_deleted', clientSnapshot: snapshotClient },
    [],
    'duplicate'
  );
  assert.equal(staleRes.ok, true);
  assert.equal(staleRes.clientId, '');
  assert.equal(staleRes.clientSnapshot.name, 'Deleted Co');

  const detachedRes = resolveClientReferenceWithSnapshotFallback(
    { clientId: '', clientSnapshot: snapshotClient },
    [],
    'convert'
  );
  assert.equal(detachedRes.ok, true);
  assert.equal(detachedRes.clientId, '');
  assert.equal(detachedRes.clientSnapshot.name, 'Deleted Co');

  // 2. Browser adapter: delete client -> duplicate quote -> convert duplicated quote -> duplicate invoice
  mockStorage.clear();
  const browser = new BrowserPersistenceAdapter();
  await browser.clearAllData();
  const bProfile = await browser.saveBusinessProfile(makeProfile());
  const bClient = await browser.saveClient(makeClient({ id: undefined as any }));
  const bQuote = await browser.saveQuotation(makeQuote(bProfile, bClient, { id: 'quo_del_b' }));
  const bInv = await browser.saveInvoice(makeInvoice(bProfile, bClient, { id: 'inv_del_b' }));

  assert.equal(await browser.deleteClient(bClient.id), true);
  const bClientsAfterDelete = await browser.getClients();

  const bQuoteAfterDelete = await browser.getQuotationById(bQuote.id);
  const bDupRef = resolveClientReferenceWithSnapshotFallback(bQuoteAfterDelete!, bClientsAfterDelete, 'duplicate');
  assert.equal(bDupRef.ok, true);
  assert.equal(bDupRef.clientId, '');

  const bDuplicatedQuote = await browser.saveQuotation({
    ...bQuoteAfterDelete!,
    id: 'quo_dup_b',
    quotationNumber: 'QUO-0002',
    clientId: bDupRef.clientId,
    clientSnapshot: bDupRef.clientSnapshot,
    status: 'draft',
    convertedInvoiceId: undefined,
  });
  assert.equal(bDuplicatedQuote.clientId, '');
  assert.equal(bDuplicatedQuote.clientSnapshot.name, bClient.name);

  const bConvRef = resolveClientReferenceWithSnapshotFallback(bDuplicatedQuote, bClientsAfterDelete, 'convert');
  assert.equal(bConvRef.ok, true);
  const bConvertedInvoice = await browser.saveInvoice({
    ...makeInvoice(bProfile, bConvRef.clientSnapshot, {
      id: 'inv_from_dup_b',
      invoiceNumber: 'INV-0002',
      quotationId: bDuplicatedQuote.id,
      clientId: bConvRef.clientId,
      clientSnapshot: bConvRef.clientSnapshot,
    }),
  });
  assert.equal(bConvertedInvoice.clientSnapshot.name, bClient.name);
  assert.equal((await browser.getQuotationById(bDuplicatedQuote.id))?.convertedInvoiceId, bConvertedInvoice.id);

  // Duplicate invoice whose client was deleted
  const bInvAfterDelete = await browser.getInvoiceById(bInv.id);
  const bInvDupRef = resolveClientReferenceWithSnapshotFallback(bInvAfterDelete!, bClientsAfterDelete, 'duplicate');
  const bDuplicatedInvoice = await browser.saveInvoice({
    ...bInvAfterDelete!,
    id: 'inv_dup_b',
    invoiceNumber: 'INV-0003',
    clientId: bInvDupRef.clientId,
    clientSnapshot: bInvDupRef.clientSnapshot,
    status: 'draft',
    payments: [],
  });
  assert.equal(bDuplicatedInvoice.clientSnapshot.name, bClient.name);

  // 3. SQLite adapter: delete client -> duplicate quote -> convert duplicated quote -> duplicate invoice
  const spy = new WorkflowSqliteBridgeSpy();
  const sqlite = new SqlitePersistenceAdapter({ bridge: spy as any, now: () => '2026-11-21T10:00:00.000Z' });
  const sProfile = await sqlite.saveBusinessProfile(makeProfile());
  const sClient = await sqlite.saveClient(makeClient());
  const sQuote = await sqlite.saveQuotation(makeQuote(sProfile, sClient, { id: 'quo_del_s' }));
  await sqlite.deleteClient(sClient.id);
  const sClientsAfterDelete = await sqlite.getClients();
  const sQuoteAfterDelete = await sqlite.getQuotationById(sQuote.id);
  const sDupRef = resolveClientReferenceWithSnapshotFallback(sQuoteAfterDelete!, sClientsAfterDelete, 'duplicate');

  const sDupQuote = await sqlite.saveQuotation({
    ...sQuoteAfterDelete!,
    id: 'quo_dup_s',
    quotationNumber: 'QUO-0002',
    clientId: sDupRef.clientId,
    clientSnapshot: sDupRef.clientSnapshot,
    status: 'draft',
    convertedInvoiceId: undefined,
  });
  assert.equal(sDupQuote.clientId, '');
  assert.equal(sDupQuote.clientSnapshot.name, sClient.name);

  const sConvRef = resolveClientReferenceWithSnapshotFallback(sDupQuote, sClientsAfterDelete, 'convert');
  const sConvertedInv = await sqlite.saveInvoice(
    makeInvoice(sProfile, sConvRef.clientSnapshot, {
      id: 'inv_from_dup_s',
      invoiceNumber: 'INV-0002',
      quotationId: sDupQuote.id,
      clientId: sConvRef.clientId,
      clientSnapshot: sConvRef.clientSnapshot,
    })
  );
  assert.equal(sConvertedInv.clientSnapshot.name, sClient.name);
  assert.equal((await sqlite.getQuotationById(sDupQuote.id))?.convertedInvoiceId, sConvertedInv.id);
});

// ============================================================
// Task 6: Status Activity Logging (quote_status & invoice_status)
// ============================================================

test('Task 6: quote_status and invoice_status activity logs persist cleanly on Browser and SQLite adapters', async () => {
  mockStorage.clear();
  const browser = new BrowserPersistenceAdapter();
  await browser.clearAllData();
  await browser.saveBusinessProfile(makeProfile());

  await browser.addActivity({
    type: 'quote_status',
    title: 'Quotation QUO-0001 Status Updated',
    description: 'Status changed from draft to sent.',
    referenceId: 'quo_1',
  });
  await browser.addActivity({
    type: 'invoice_status',
    title: 'Invoice INV-0001 Status Updated',
    description: 'Status changed from draft to sent.',
    referenceId: 'inv_1',
  });

  const browserActivities = await browser.getActivities();
  assert.ok(browserActivities.some((a) => a.type === 'quote_status' && a.referenceId === 'quo_1'));
  assert.ok(browserActivities.some((a) => a.type === 'invoice_status' && a.referenceId === 'inv_1'));

  const spy = new WorkflowSqliteBridgeSpy();
  const sqlite = new SqlitePersistenceAdapter({ bridge: spy as any, now: () => '2026-11-21T10:00:00.000Z' });
  await sqlite.saveBusinessProfile(makeProfile());

  await sqlite.addActivity({
    type: 'quote_status',
    title: 'Quotation QUO-0001 Status Updated',
    description: 'Status changed from draft to sent.',
    referenceId: 'quo_1',
  });
  await sqlite.addActivity({
    type: 'invoice_status',
    title: 'Invoice INV-0001 Status Updated',
    description: 'Status changed from draft to sent.',
    referenceId: 'inv_1',
  });

  const sqliteActivities = await sqlite.getActivities();
  assert.ok(sqliteActivities.some((a) => a.type === 'quote_status' && a.referenceId === 'quo_1'));
  assert.ok(sqliteActivities.some((a) => a.type === 'invoice_status' && a.referenceId === 'inv_1'));
});

// ============================================================
// Task 7: Quotation Print & PDF Label ("Quoted Total")
// ============================================================

test('Task 7: DocumentSheet and BizoraPdfDocument use "Quoted Total" for quotations instead of "Total Amount Due"', () => {
  const profile = makeProfile();
  const client = makeClient();
  const quote = makeQuote(profile, client);
  const invoice = makeInvoice(profile, client);

  const quoteMarkup = renderToStaticMarkup(
    React.createElement(DocumentSheet, { type: 'quote', document: quote })
  );
  assert.equal(quoteMarkup.includes('Quoted Total'), true);
  assert.equal(quoteMarkup.includes('Total Amount Due'), false);

  const invoiceMarkup = renderToStaticMarkup(
    React.createElement(DocumentSheet, { type: 'invoice', document: invoice })
  );
  assert.equal(invoiceMarkup.includes('Balance Due'), true);
  assert.equal(invoiceMarkup.includes('Quoted Total'), false);

  const pdfSource = readFileSync(resolve('src/components/documents/BizoraPdfDocument.tsx'), 'utf8');
  assert.equal(pdfSource.includes("isInvoice ? 'Total' : 'Quoted Total'"), true);
  assert.equal(pdfSource.includes('Total Amount Due'), false);
});
