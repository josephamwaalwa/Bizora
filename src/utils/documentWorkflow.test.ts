import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BrowserPersistenceAdapter,
  PersistenceError,
  SqlitePersistenceAdapter,
} from '../services/persistence';
import { StorageService } from '../services/storage';
import { initialBusinessProfile, initialClients } from '../services/seedData';
import type { BusinessProfile, Client, Invoice, Quotation } from '../types';
import {
  determineUpdatedInvoiceStatus,
  getLocalTodayDateString,
  isDateBeforeLocalToday,
} from './calculations';
import {
  buildPaymentDeletionConfirmCopy,
  CANONICAL_PAYMENT_METHODS,
  createInitialPaymentFormState,
  executeDeletePaymentWorkflow,
  getInvoiceStatusOptionsForUi,
  getOverpaymentAdjustmentWarning,
  getPaymentModalResetKey,
  PAYMENT_METHOD_SELECT_OPTIONS,
  parseStrictPaymentAmount,
  resolveClientReferenceWithSnapshotFallback,
  sortPaymentsForDisplay,
  validateConvertedQuotationEdit,
  validateManualInvoiceStatusChange,
  validatePaymentDate,
  validatePaymentInput,
  validatePaymentMethodValue,
  validateQuotationStatusChange,
} from './documentWorkflow';
import { DocumentSheet } from '../components/documents/DocumentSheet';
import { InvoicePaymentsPanelContent } from '../components/documents/InvoicePaymentsPanel';

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
    this.calls.push('createPayment');
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
  async deletePayment(id: string) {
    this.calls.push('deletePayment');
    const existing = this.payments.get(id);
    if (!existing) throw new Error('Payment not found');
    this.payments.delete(id);
    const inv = this.invoices.get(existing.invoiceId);
    if (inv) {
      const remaining = Array.from(this.payments.values()).filter((p) => p.invoiceId === inv.id);
      const totalPaid = remaining.reduce((sum, p) => sum + BigInt(p.amountMinor), 0n);
      const grandTotal = BigInt(inv.grandTotalMinor);
      const balance = grandTotal > totalPaid ? grandTotal - totalPaid : 0n;
      const isPastDue = Boolean(inv.dueDate && isDateBeforeLocalToday(inv.dueDate));
      const nextStatus =
        totalPaid >= grandTotal && grandTotal > 0n
          ? 'paid'
          : totalPaid > 0n
            ? 'partially_paid'
            : isPastDue
              ? 'overdue'
              : 'sent';
      this.invoices.set(inv.id, {
        ...inv,
        payments: remaining,
        amountPaidMinor: totalPaid.toString(),
        outstandingBalanceMinor: balance.toString(),
        status: nextStatus,
        updatedAt: this.tick(),
      });
    }
  }

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

// ============================================================
// Stage 3.2.1: Payment History, Safe Deletion & Integrations
// ============================================================

test('Stage 3.2.1: InvoicePaymentsPanelContent renders payment fields, empty state, paid-invoice controls, and confirmation copy', () => {
  const profile = makeProfile();
  const client = makeClient();

  const paidInvoice = makeInvoice(profile, client, {
    id: 'inv_paid_panel',
    invoiceNumber: 'INV-0099',
    grandTotal: 2300,
    amountPaid: 2300,
    outstandingBalance: 0,
    status: 'paid',
    payments: [
      {
        id: 'pay_old',
        invoiceId: 'inv_paid_panel',
        amount: 800,
        paymentDate: '2026-11-10',
        paymentMethod: 'cash',
        recordedAt: '2026-11-10T08:00:00.000Z',
      },
      {
        id: 'pay_new',
        invoiceId: 'inv_paid_panel',
        amount: 1500,
        paymentDate: '2026-11-18',
        paymentMethod: 'bank_transfer',
        reference: 'FNB-8821',
        notes: 'Final settlement tranche',
        recordedAt: '2026-11-18T11:30:00.000Z',
      },
    ],
  });

  const sorted = sortPaymentsForDisplay(paidInvoice.payments);
  assert.equal(sorted[0].id, 'pay_new');
  assert.equal(sorted[1].id, 'pay_old');

  const paidMarkup = renderToStaticMarkup(
    React.createElement(InvoicePaymentsPanelContent, {
      invoice: paidInvoice,
      onDeletePayment: async () => true,
      showConfirmDialog: () => {},
      onRecordPayment: () => {},
    })
  );

  // Payment details & formatters
  assert.equal(paidMarkup.includes('Payment History'), true);
  assert.equal(paidMarkup.includes('2 payments'), true);
  assert.equal(paidMarkup.includes('Bank Transfer / EFT'), true);
  assert.equal(paidMarkup.includes('Cash'), true);
  assert.equal(paidMarkup.includes('Ref: FNB-8821'), true);
  assert.equal(paidMarkup.includes('Final settlement tranche'), true);
  assert.equal(paidMarkup.includes('1,500.00'), true);
  assert.equal(paidMarkup.includes('800.00'), true);
  // Accessible even on paid invoice while Record Payment action stays hidden
  assert.equal(paidMarkup.includes('Remove payment of'), true);
  assert.equal(paidMarkup.includes('Record Payment'), false);

  // Empty unpaid invoice state
  const unpaidInvoice = makeInvoice(profile, client, {
    id: 'inv_empty_panel',
    invoiceNumber: 'INV-0100',
    amountPaid: 0,
    outstandingBalance: 2300,
    status: 'sent',
    payments: [],
  });
  const emptyMarkup = renderToStaticMarkup(
    React.createElement(InvoicePaymentsPanelContent, {
      invoice: unpaidInvoice,
      onDeletePayment: async () => true,
      showConfirmDialog: () => {},
      onRecordPayment: () => {},
    })
  );
  assert.equal(
    emptyMarkup.includes('No payments have been recorded for invoice INV-0100 yet.'),
    true
  );
  assert.equal(emptyMarkup.includes('Record Payment'), true);

  // Destructive confirmation copy
  const confirmCopy = buildPaymentDeletionConfirmCopy(paidInvoice, paidInvoice.payments[1]);
  assert.equal(confirmCopy.isDestructive, true);
  assert.equal(confirmCopy.message.includes('1,500.00'), true);
  assert.equal(confirmCopy.message.includes('INV-0099'), true);
  assert.equal(confirmCopy.message.includes('recalculated'), true);
});

test('Stage 3.2.1: executeDeletePaymentWorkflow deletes from paid invoices, recalculates balance/status, logs safe invoice_status activity, refreshes preview, and preserves persistence warnings', async () => {
  // 1. Browser adapter flow: paid invoice -> delete 1 of 2 payments -> partially_paid -> delete last -> sent
  mockStorage.clear();
  const browser = new BrowserPersistenceAdapter();
  await browser.clearAllData();
  const bProfile = await browser.saveBusinessProfile(makeProfile());
  const bClient = await browser.saveClient(makeClient());
  const bInv = await browser.saveInvoice(
    makeInvoice(bProfile, bClient, {
      id: 'inv_del_flow_b',
      invoiceNumber: 'INV-3201',
      dueDate: '2099-12-31',
      grandTotal: 1000,
      subtotal: 1000,
      taxRate: 0,
      taxAmount: 0,
      outstandingBalance: 1000,
      status: 'sent',
    })
  );

  await browser.recordPayment(bInv.id, {
    amount: 400,
    paymentDate: '2026-11-15',
    paymentMethod: 'eft',
    reference: 'EFT-1',
  });
  const fullyPaidBrowser = await browser.recordPayment(bInv.id, {
    amount: 600,
    paymentDate: '2026-11-18',
    paymentMethod: 'cash',
    reference: 'CASH-2',
  });
  assert.equal(fullyPaidBrowser?.status, 'paid');
  assert.equal(fullyPaidBrowser?.outstandingBalance, 0);

  const previewRefreshes: Invoice[] = [];
  const toasts: Array<{ type: string; title: string; message?: string }> = [];
  let workspaceInvoices = await browser.getInvoices();

  const firstDeleteOk = await executeDeletePaymentWorkflow({
    adapter: browser,
    paymentId: fullyPaidBrowser!.payments[1].id,
    knownInvoices: workspaceInvoices,
    didPersistLastWrite: (a) => (a instanceof BrowserPersistenceAdapter ? a.lastWritePersisted : true),
    reloadWorkspace: async (a) => {
      workspaceInvoices = await a.getInvoices();
    },
    onInvoiceUpdated: (refreshed) => previewRefreshes.push(refreshed),
    onToast: (t) => toasts.push(t),
  });

  assert.equal(firstDeleteOk, true);
  assert.equal(previewRefreshes.length, 1);
  assert.equal(previewRefreshes[0].status, 'partially_paid');
  assert.equal(previewRefreshes[0].amountPaid, 400);
  assert.equal(previewRefreshes[0].outstandingBalance, 600);
  assert.equal(workspaceInvoices[0].status, 'partially_paid');
  assert.equal(toasts[0].type, 'success');

  const activitiesAfterFirst = await browser.getActivities();
  const removalActivity = activitiesAfterFirst.find((a) =>
    a.title.includes('Payment Removed from INV-3201')
  );
  assert.equal(removalActivity?.type, 'invoice_status');

  // Delete remaining payment -> reverts to sent (and preserves browser non-persisted warning if storage write fails)
  const secondDeleteOk = await executeDeletePaymentWorkflow({
    adapter: browser,
    paymentId: previewRefreshes[0].payments[0].id,
    knownInvoices: workspaceInvoices,
    didPersistLastWrite: () => false,
    reloadWorkspace: async (a) => {
      workspaceInvoices = await a.getInvoices();
    },
    onInvoiceUpdated: (refreshed) => previewRefreshes.push(refreshed),
    onToast: (t) => toasts.push(t),
  });

  assert.equal(secondDeleteOk, true);
  assert.equal(previewRefreshes[1].status, 'sent');
  assert.equal(previewRefreshes[1].amountPaid, 0);
  assert.equal(previewRefreshes[1].outstandingBalance, 1000);
  assert.equal(toasts[1].type, 'warning');
  assert.match(toasts[1].message || '', /browser storage could not persist/i);

  // 2. SQLite adapter flow + missing ID error handling + non-fatal activity failure
  const spy = new WorkflowSqliteBridgeSpy();
  const sqlite = new SqlitePersistenceAdapter({
    bridge: spy as any,
    now: () => '2026-11-21T10:00:00.000Z',
  });
  const sProfile = await sqlite.saveBusinessProfile(makeProfile());
  const sClient = await sqlite.saveClient(makeClient());
  const sInv = await sqlite.saveInvoice(
    makeInvoice(sProfile, sClient, {
      id: 'inv_del_flow_s',
      invoiceNumber: 'INV-3202',
      dueDate: '2026-11-01',
      grandTotal: 500,
      subtotal: 500,
      taxRate: 0,
      taxAmount: 0,
      outstandingBalance: 500,
      status: 'overdue',
    })
  );
  const sPaid = await sqlite.recordPayment(sInv.id, {
    amount: 500,
    paymentDate: '2026-11-19',
    paymentMethod: 'bank_transfer',
  });
  assert.equal(sPaid?.status, 'paid');

  // Unknown payment id exits cleanly without mutating
  const missingResult = await executeDeletePaymentWorkflow({
    adapter: sqlite,
    paymentId: 'pay_does_not_exist',
    knownInvoices: [sPaid!],
    didPersistLastWrite: () => true,
    reloadWorkspace: async () => {},
    onToast: (t) => toasts.push(t),
  });
  assert.equal(missingResult, false);
  assert.equal(toasts[toasts.length - 1].type, 'error');

  // Force addActivity to throw while deleting on SQLite -> deletion and refresh still succeed
  const originalAddActivity = sqlite.addActivity.bind(sqlite);
  sqlite.addActivity = async () => {
    throw new Error('simulated activity log failure');
  };
  let sqliteInvoices = await sqlite.getInvoices();
  const sqliteUpdates: Invoice[] = [];
  const warnings: string[] = [];

  const sqliteOk = await executeDeletePaymentWorkflow({
    adapter: sqlite,
    paymentId: sPaid!.payments[0].id,
    knownInvoices: sqliteInvoices,
    didPersistLastWrite: () => true,
    reloadWorkspace: async (a) => {
      sqliteInvoices = await a.getInvoices();
    },
    onInvoiceUpdated: (refreshed) => sqliteUpdates.push(refreshed),
    onToast: (t) => toasts.push(t),
    logWarn: (msg) => warnings.push(msg),
  });
  sqlite.addActivity = originalAddActivity;

  assert.equal(sqliteOk, true);
  assert.equal(warnings.length, 1);
  assert.equal(sqliteUpdates[0].amountPaid, 0);
  assert.equal(sqliteUpdates[0].outstandingBalance, 500);
  assert.equal(sqliteUpdates[0].status, 'overdue');
});

test('Stage 3.2.1: Overpayment warning and Preview/Editor/AppContext integration contracts', () => {
  assert.equal(getOverpaymentAdjustmentWarning(1000, 1000, 'NAD', 'N$'), null);
  assert.equal(getOverpaymentAdjustmentWarning(1000, 1000.01, 'NAD', 'N$'), null);
  const warning = getOverpaymentAdjustmentWarning(800, 1200, 'NAD', 'N$');
  assert.ok(warning);
  assert.equal(warning.includes('1,200.00'), true);
  assert.equal(warning.includes('800.00'), true);

  const appContextSrc = readFileSync(resolve('src/context/AppContext.tsx'), 'utf8');
  assert.equal(appContextSrc.includes('deletePayment: (paymentId: string) => Promise<boolean>;'), true);
  assert.equal(appContextSrc.includes('executeDeletePaymentWorkflow'), true);
  assert.equal(appContextSrc.includes('setPreviewDocument({ type: \'invoice\', data: refreshedInvoice })'), true);

  const previewSrc = readFileSync(resolve('src/components/documents/DocumentPreviewModal.tsx'), 'utf8');
  assert.equal(previewSrc.includes('<InvoicePaymentsPanel'), true);
  assert.equal(previewSrc.includes('isInvoice && invoice && showPaymentsPanel'), true);
  assert.equal(previewSrc.includes('no-print'), true);

  // Printable/PDF document templates remain free of payment management actions
  const sheetSrc = readFileSync(resolve('src/components/documents/DocumentSheet.tsx'), 'utf8');
  const pdfSrc = readFileSync(resolve('src/components/documents/BizoraPdfDocument.tsx'), 'utf8');
  assert.equal(sheetSrc.includes('InvoicePaymentsPanel'), false);
  assert.equal(pdfSrc.includes('InvoicePaymentsPanel'), false);

  const formSrc = readFileSync(resolve('src/pages/InvoiceFormPage.tsx'), 'utf8');
  assert.equal(formSrc.includes('<InvoicePaymentsPanel'), true);
  assert.equal(formSrc.includes('getOverpaymentAdjustmentWarning'), true);
  assert.equal(formSrc.includes('role="alert"'), true);
});

// ============================================================
// Stage 3.2.2: Payment Validation & Data Integrity Hardening
// ============================================================

test('Stage 3.2.2: parseStrictPaymentAmount rejects malformed/non-positive/over-precision values and accepts exact cents', () => {
  const invalidCases: Array<unknown> = [
    0,
    '0',
    '0.00',
    -1,
    -50.25,
    '-10',
    '-0.01',
    NaN,
    'NaN',
    Infinity,
    -Infinity,
    'Infinity',
    '100abc',
    'abc',
    '',
    '   ',
    '100.',
    '.',
    '1e-5',
    1e-5,
    1e-7,
    '1e+2',
    10.129,
    '10.129',
    '10.500',
    0.001,
    null,
    undefined,
  ];

  for (const bad of invalidCases) {
    const res = parseStrictPaymentAmount(bad);
    assert.equal(res.ok, false, `Expected invalid amount rejection for ${String(bad)}`);
    assert.ok(res.error);
  }

  assert.deepEqual(parseStrictPaymentAmount(250), {
    ok: true,
    amount: 250,
    amountMinor: 25000,
  });
  assert.deepEqual(parseStrictPaymentAmount('250'), {
    ok: true,
    amount: 250,
    amountMinor: 25000,
  });
  assert.deepEqual(parseStrictPaymentAmount(120.5), {
    ok: true,
    amount: 120.5,
    amountMinor: 12050,
  });
  assert.deepEqual(parseStrictPaymentAmount('120.5'), {
    ok: true,
    amount: 120.5,
    amountMinor: 12050,
  });
  // Verify exact integer cents without IEEE-754 float drift (19.99 * 100 === 1998.9999999999998)
  assert.deepEqual(parseStrictPaymentAmount(19.99), {
    ok: true,
    amount: 19.99,
    amountMinor: 1999,
  });
  assert.deepEqual(parseStrictPaymentAmount('19.99'), {
    ok: true,
    amount: 19.99,
    amountMinor: 1999,
  });
  assert.deepEqual(parseStrictPaymentAmount('.50'), {
    ok: true,
    amount: 0.5,
    amountMinor: 50,
  });
});

test('Stage 3.2.2: validatePaymentDate enforces strict YYYY-MM-DD calendar/leap-year rules and local-date fallback', () => {
  const invalidDates: Array<unknown> = [
    '',
    '   ',
    ' 2026-11-21 ',
    '2026/11/21',
    '21-11-2026',
    'not-a-date',
    '2026-11-21T10:00:00.000Z',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-02-30',
    '2025-02-29', // non-leap year
    '1900-02-29', // century non-leap year
    '0000-01-01',
  ];

  for (const bad of invalidDates) {
    const res = validatePaymentDate(bad);
    assert.equal(res.ok, false, `Expected invalid date rejection for ${String(bad)}`);
    assert.ok(res.error);
  }

  // Valid calendar and leap-year dates
  assert.deepEqual(validatePaymentDate('2024-02-29'), { ok: true, paymentDate: '2024-02-29' });
  assert.deepEqual(validatePaymentDate('2000-02-29'), { ok: true, paymentDate: '2000-02-29' });
  assert.deepEqual(validatePaymentDate('2026-11-21'), { ok: true, paymentDate: '2026-11-21' });

  // Omitted date falls back to local today (or provided today override), whereas explicit mode rejects omitted
  assert.deepEqual(validatePaymentDate(undefined, { today: '2026-11-21' }), {
    ok: true,
    paymentDate: '2026-11-21',
  });
  assert.deepEqual(validatePaymentDate(undefined), {
    ok: true,
    paymentDate: getLocalTodayDateString(),
  });
  assert.equal(validatePaymentDate(undefined, { allowOmittedFallback: false }).ok, false);
});

test('Stage 3.2.2: canonical 7 payment methods are enforced across validator and RecordPaymentModal UI options', () => {
  assert.equal(CANONICAL_PAYMENT_METHODS.length, 7);
  for (const method of CANONICAL_PAYMENT_METHODS) {
    const res = validatePaymentMethodValue(method);
    assert.equal(res.ok, true, `Expected payment method '${method}' to be valid`);
    assert.equal(res.paymentMethod, method);
  }

  for (const bad of ['wire', 'bitcoin', '', '   ', undefined, null]) {
    const res = validatePaymentMethodValue(bad);
    assert.equal(res.ok, false, `Expected invalid payment method rejection for ${String(bad)}`);
  }

  const uiValues = PAYMENT_METHOD_SELECT_OPTIONS.map((o) => o.value);
  assert.equal(uiValues.length, 7);
  assert.equal(uiValues.includes('bank_transfer'), true);
  assert.equal(uiValues.includes('eft'), true);
  const eftOpt = PAYMENT_METHOD_SELECT_OPTIONS.find((o) => o.value === 'eft');
  const bankOpt = PAYMENT_METHOD_SELECT_OPTIONS.find((o) => o.value === 'bank_transfer');
  assert.notEqual(eftOpt?.label, bankOpt?.label);

  const modalSrc = readFileSync(resolve('src/components/documents/RecordPaymentModal.tsx'), 'utf8');
  assert.equal(modalSrc.includes('validatePaymentInput'), true);
  assert.equal(modalSrc.includes('PAYMENT_METHOD_SELECT_OPTIONS'), true);
  assert.equal(modalSrc.includes('noValidate'), true);
  assert.equal(modalSrc.includes('parseFloat'), false);
});

test('Stage 3.2.2: balance & overpayment protection enforces +0.01 tolerance on positive balance and blocks zero-balance/paid invoices', () => {
  const profile = makeProfile();
  const client = makeClient();

  const openInvoice = makeInvoice(profile, client, {
    grandTotal: 100,
    amountPaid: 40,
    outstandingBalance: 60,
    status: 'partially_paid',
  });

  // Exact remaining balance -> ok
  assert.equal(
    validatePaymentInput(openInvoice, {
      amount: 60,
      paymentDate: '2026-11-21',
      paymentMethod: 'eft',
    }).ok,
    true
  );

  // Within +N$0.01 tolerance -> ok
  assert.equal(
    validatePaymentInput(openInvoice, {
      amount: 60.01,
      paymentDate: '2026-11-21',
      paymentMethod: 'bank_transfer',
    }).ok,
    true
  );

  // Exceeds +N$0.01 tolerance -> rejected
  const over = validatePaymentInput(openInvoice, {
    amount: 60.02,
    paymentDate: '2026-11-21',
    paymentMethod: 'eft',
  });
  assert.equal(over.ok, false);
  assert.ok(over.fieldErrors.amount);

  // Zero-balance unpaid (zero-total) invoice -> rejected even for 0.01
  const zeroInvoice = makeInvoice(profile, client, {
    grandTotal: 0,
    amountPaid: 0,
    outstandingBalance: 0,
    status: 'sent',
  });
  const zeroAttempt = validatePaymentInput(zeroInvoice, {
    amount: 0.01,
    paymentDate: '2026-11-21',
    paymentMethod: 'cash',
  });
  assert.equal(zeroAttempt.ok, false);
  assert.ok(zeroAttempt.fieldErrors.balance);

  // Paid invoice -> rejected even if outstandingBalance field were stale
  const paidInvoice = makeInvoice(profile, client, {
    grandTotal: 100,
    amountPaid: 100,
    outstandingBalance: 0,
    status: 'paid',
  });
  const paidAttempt = validatePaymentInput(paidInvoice, {
    amount: 0.01,
    paymentDate: '2026-11-21',
    paymentMethod: 'cash',
  });
  assert.equal(paidAttempt.ok, false);
  assert.ok(paidAttempt.fieldErrors.balance);
});

test('Stage 3.2.2: BrowserPersistenceAdapter, StorageService, and SqlitePersistenceAdapter reject invalid payments pre-mutation and pre-IPC', async () => {
  // 1. Browser adapter & StorageService
  mockStorage.clear();
  const browser = new BrowserPersistenceAdapter();
  await browser.clearAllData();
  const bProfile = await browser.saveBusinessProfile(makeProfile());
  const bClient = await browser.saveClient(makeClient());
  const bInv = await browser.saveInvoice(
    makeInvoice(bProfile, bClient, {
      id: 'inv_b_val',
      invoiceNumber: 'INV-3220',
      grandTotal: 100,
      subtotal: 100,
      taxRate: 0,
      taxAmount: 0,
      outstandingBalance: 100,
      status: 'sent',
      payments: [],
    })
  );

  const invalidPayloads: Array<any> = [
    { amount: 0, paymentDate: '2026-11-21', paymentMethod: 'eft' },
    { amount: -25, paymentDate: '2026-11-21', paymentMethod: 'eft' },
    { amount: NaN, paymentDate: '2026-11-21', paymentMethod: 'eft' },
    { amount: Infinity, paymentDate: '2026-11-21', paymentMethod: 'eft' },
    { amount: '100abc', paymentDate: '2026-11-21', paymentMethod: 'eft' },
    { amount: '1e-5', paymentDate: '2026-11-21', paymentMethod: 'eft' },
    { amount: 10.129, paymentDate: '2026-11-21', paymentMethod: 'eft' },
    { amount: 10, paymentDate: '2025-02-29', paymentMethod: 'eft' },
    { amount: 10, paymentDate: '   ', paymentMethod: 'eft' },
    { amount: 10, paymentDate: '2026-11-21', paymentMethod: 'invalid_method' },
    { amount: 100.02, paymentDate: '2026-11-21', paymentMethod: 'eft' },
  ];

  for (const payload of invalidPayloads) {
    await assert.rejects(
      () => browser.recordPayment(bInv.id, payload),
      (err: unknown) => err instanceof PersistenceError && err.code === 'VALIDATION_ERROR'
    );
    assert.throws(
      () => StorageService.recordPayment(bInv.id, payload),
      (err: unknown) => err instanceof PersistenceError && err.code === 'VALIDATION_ERROR'
    );
  }

  // Confirm failed attempts left stored invoice, payments, and activities completely untouched
  const unchangedBrowser = await browser.getInvoiceById(bInv.id);
  assert.equal(unchangedBrowser?.amountPaid, 0);
  assert.equal(unchangedBrowser?.outstandingBalance, 100);
  assert.equal(unchangedBrowser?.payments.length, 0);
  assert.equal(unchangedBrowser?.status, 'sent');
  assert.equal(
    (await browser.getActivities()).some((a) => a.type === 'payment_recorded'),
    false
  );

  // Valid tolerance payment (+0.01) settles invoice, then further payment is rejected
  const settledBrowser = await browser.recordPayment(bInv.id, {
    amount: 100.01,
    paymentDate: undefined as unknown as string,
    paymentMethod: 'bank_transfer',
  });
  assert.equal(settledBrowser?.status, 'paid');
  assert.equal(settledBrowser?.outstandingBalance, 0);
  assert.equal(settledBrowser?.payments[0].paymentDate, getLocalTodayDateString());

  await assert.rejects(
    () =>
      browser.recordPayment(bInv.id, {
        amount: 0.01,
        paymentDate: '2026-11-21',
        paymentMethod: 'cash',
      }),
    (err: unknown) => err instanceof PersistenceError && err.code === 'VALIDATION_ERROR'
  );
  assert.equal((await browser.getInvoiceById(bInv.id))?.payments.length, 1);

  // 2. SQLite adapter: all invalid cases fail BEFORE Rust IPC bridge.createPayment is called
  const spy = new WorkflowSqliteBridgeSpy();
  const sqlite = new SqlitePersistenceAdapter({
    bridge: spy as any,
    now: () => '2026-11-21T23:55:00.000Z',
  });
  const sProfile = await sqlite.saveBusinessProfile(makeProfile());
  const sClient = await sqlite.saveClient(makeClient());
  const sInv = await sqlite.saveInvoice(
    makeInvoice(sProfile, sClient, {
      id: 'inv_s_val',
      invoiceNumber: 'INV-3221',
      grandTotal: 100,
      subtotal: 100,
      taxRate: 0,
      taxAmount: 0,
      outstandingBalance: 100,
      status: 'sent',
      payments: [],
    })
  );

  spy.calls.length = 0;
  for (const payload of invalidPayloads) {
    await assert.rejects(
      () => sqlite.recordPayment(sInv.id, payload),
      (err: unknown) => err instanceof PersistenceError && err.code === 'VALIDATION_ERROR'
    );
  }
  assert.equal(
    spy.calls.includes('createPayment'),
    false,
    'Invalid payments must never reach Rust createPayment IPC'
  );
  assert.equal(spy.payments.size, 0);

  // Valid SQLite payment with omitted date uses local date fallback (getLocalTodayDateString)
  const settledSqlite = await sqlite.recordPayment(sInv.id, {
    amount: 100.01,
    paymentDate: undefined as unknown as string,
    paymentMethod: 'bank_transfer',
  });
  assert.equal(settledSqlite?.status, 'paid');
  assert.equal(settledSqlite?.payments[0].paymentDate, getLocalTodayDateString());

  spy.calls.length = 0;
  await assert.rejects(
    () =>
      sqlite.recordPayment(sInv.id, {
        amount: 0.01,
        paymentDate: '2026-11-21',
        paymentMethod: 'cash',
      }),
    (err: unknown) => err instanceof PersistenceError && err.code === 'VALIDATION_ERROR'
  );
  assert.equal(spy.calls.includes('createPayment'), false);
  assert.equal(spy.payments.size, 1);

  // Confirm UTC date fallback is absent from storage.ts and sqliteAdapter.ts recordPayment paths
  const storageSrc = readFileSync(resolve('src/services/storage.ts'), 'utf8');
  const sqliteSrc = readFileSync(resolve('src/services/persistence/sqliteAdapter.ts'), 'utf8');
  assert.equal(storageSrc.includes("paymentData.paymentDate || new Date().toISOString().split('T')[0]"), false);
  assert.equal(sqliteSrc.includes("paymentData.paymentDate || this.now().split('T')[0]"), false);
});

test('Stage 3.2.2: zero-total invoice status matches Rust precision rules (draft/sent past due never overdue)', () => {
  assert.equal(determineUpdatedInvoiceStatus('draft', 0, 0, '2020-01-01', '2026-11-21'), 'draft');
  assert.equal(determineUpdatedInvoiceStatus('sent', 0, 0, '2020-01-01', '2026-11-21'), 'sent');
  assert.equal(determineUpdatedInvoiceStatus('overdue', 0, 0, '2020-01-01', '2026-11-21'), 'sent');
  assert.equal(determineUpdatedInvoiceStatus('overdue', 0, 0, '2099-01-01', '2026-11-21'), 'sent');
  assert.equal(determineUpdatedInvoiceStatus('paid', 0, 0, '2020-01-01', '2026-11-21'), 'sent');
  assert.equal(determineUpdatedInvoiceStatus('sent', 0, 50, '2020-01-01', '2026-11-21'), 'paid');
  assert.equal(determineUpdatedInvoiceStatus('draft', 0, 1, '2020-01-01', '2026-11-21'), 'paid');

  // Non-zero past-due unpaid invoice still becomes overdue
  assert.equal(determineUpdatedInvoiceStatus('sent', 100, 0, '2020-01-01', '2026-11-21'), 'overdue');
});

