import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ActivityLogDto,
  AppSettingDto,
  BusinessAssetDto,
  BusinessDto,
  ClientDto,
  CreateActivityLogInput,
  CreateBusinessAssetInput,
  CreateBusinessInput,
  CreateClientInput,
  CreateInvoiceInput,
  CreateLocalProfileInput,
  CreatePaymentInput,
  CreateQuotationInput,
  InvoiceDto,
  LocalProfileDto,
  PaymentDto,
  QuotationDto,
  ReplaceDesktopWorkspaceInput,
  SafeInt64,
  SaveAppSettingInput,
  UpdateBusinessInput,
  UpdateClientInput,
  UpdateInvoiceInput,
  UpdateQuotationInput,
  WorkspaceLifecycleResultDto,
} from './database';
import {
  BrowserPersistenceAdapter,
  createPersistenceAdapter,
  detectPersistenceBackend,
  isDesktopTauriRuntime,
  PersistenceError,
  SqlitePersistenceAdapter,
  type SqlitePersistenceBridge,
} from './persistence';
import { initialBusinessProfile, initialClients } from './seedData';
import type { BusinessProfile, Invoice, Quotation } from '../types';
import { THEME_STORAGE_KEY } from '../utils/theme';

class MockLocalStorage implements Storage {
  private readonly store = new Map<string, string>();
  public readonly accessLog: Array<{ op: 'getItem' | 'setItem' | 'removeItem' | 'clear'; key?: string }> = [];

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.accessLog.push({ op: 'clear' });
    this.store.clear();
  }

  getItem(key: string): string | null {
    this.accessLog.push({ op: 'getItem', key });
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.accessLog.push({ op: 'removeItem', key });
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.accessLog.push({ op: 'setItem', key });
    this.store.set(key, value);
  }
}

class InMemorySqliteBridgeMock implements SqlitePersistenceBridge {
  public readonly calls: string[] = [];
  public localProfiles = new Map<string, LocalProfileDto>();
  public businesses = new Map<string, BusinessDto>();
  public assets = new Map<string, BusinessAssetDto>();
  public clients = new Map<string, ClientDto>();
  public quotations = new Map<string, QuotationDto>();
  public invoices = new Map<string, InvoiceDto>();
  public payments = new Map<string, PaymentDto>();
  public activities: ActivityLogDto[] = [];
  public settings = new Map<string, AppSettingDto>();
  private clock = 0;

  private tick(): string {
    this.clock += 1;
    return `2026-11-19T12:00:${String(this.clock).padStart(2, '0')}.000Z`;
  }

  async getLocalProfiles(): Promise<LocalProfileDto[]> {
    this.calls.push('getLocalProfiles');
    return Array.from(this.localProfiles.values());
  }

  async createLocalProfile(input: CreateLocalProfileInput): Promise<LocalProfileDto> {
    this.calls.push('createLocalProfile');
    const now = this.tick();
    const dto: LocalProfileDto = {
      id: input.id,
      displayName: input.displayName ?? '',
      email: input.email ?? '',
      supabaseUserId: input.supabaseUserId ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.localProfiles.set(dto.id, dto);
    return dto;
  }

  async getBusinesses(ownerProfileId?: string | null): Promise<BusinessDto[]> {
    this.calls.push('getBusinesses');
    const list = Array.from(this.businesses.values());
    if (!ownerProfileId) return list;
    return list.filter((b) => b.ownerProfileId === ownerProfileId);
  }

  async getBusinessById(id: string): Promise<BusinessDto | null> {
    this.calls.push('getBusinessById');
    return this.businesses.get(id) ?? null;
  }

  async createBusiness(input: CreateBusinessInput): Promise<BusinessDto> {
    this.calls.push('createBusiness');
    const now = this.tick();
    const dto: BusinessDto = {
      id: input.id,
      legacyId: input.legacyId ?? null,
      ownerProfileId: input.ownerProfileId ?? null,
      name: input.name,
      tagline: input.tagline ?? '',
      logoAssetId: input.logoAssetId ?? null,
      logoUrlFallback: input.logoUrlFallback ?? '',
      email: input.email ?? '',
      phone: input.phone ?? '',
      address: input.address ?? '',
      city: input.city ?? '',
      country: input.country ?? '',
      postalCode: input.postalCode ?? null,
      website: input.website ?? null,
      taxNumber: input.taxNumber ?? null,
      registrationNumber: input.registrationNumber ?? null,
      defaultCurrency: input.defaultCurrency,
      currencySymbol: input.currencySymbol,
      defaultTaxName: input.defaultTaxName,
      defaultTaxRatePpm: input.defaultTaxRatePpm,
      isTaxEnabled: input.isTaxEnabled,
      quotePrefix: input.quotePrefix,
      invoicePrefix: input.invoicePrefix,
      nextQuoteNumber: input.nextQuoteNumber,
      nextInvoiceNumber: input.nextInvoiceNumber,
      defaultTermsQuotation: input.defaultTermsQuotation ?? '',
      defaultTermsInvoice: input.defaultTermsInvoice ?? '',
      defaultNotes: input.defaultNotes ?? '',
      bankName: input.bankName ?? '',
      accountName: input.accountName ?? '',
      accountNumber: input.accountNumber ?? '',
      branchCode: input.branchCode ?? '',
      accountType: input.accountType ?? null,
      swiftCode: input.swiftCode ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.businesses.set(dto.id, dto);
    return dto;
  }

  async updateBusiness(input: UpdateBusinessInput): Promise<BusinessDto> {
    this.calls.push('updateBusiness');
    const existing = this.businesses.get(input.id);
    if (!existing) throw new Error(`Business not found: ${input.id}`);
    const updated: BusinessDto = {
      ...existing,
      ownerProfileId: input.ownerProfileId ?? null,
      name: input.name,
      tagline: input.tagline ?? '',
      logoAssetId: input.logoAssetId ?? null,
      logoUrlFallback: input.logoUrlFallback ?? '',
      email: input.email ?? '',
      phone: input.phone ?? '',
      address: input.address ?? '',
      city: input.city ?? '',
      country: input.country ?? '',
      postalCode: input.postalCode ?? null,
      website: input.website ?? null,
      taxNumber: input.taxNumber ?? null,
      registrationNumber: input.registrationNumber ?? null,
      defaultCurrency: input.defaultCurrency,
      currencySymbol: input.currencySymbol,
      defaultTaxName: input.defaultTaxName,
      defaultTaxRatePpm: input.defaultTaxRatePpm,
      isTaxEnabled: input.isTaxEnabled,
      quotePrefix: input.quotePrefix,
      invoicePrefix: input.invoicePrefix,
      nextQuoteNumber: input.nextQuoteNumber,
      nextInvoiceNumber: input.nextInvoiceNumber,
      defaultTermsQuotation: input.defaultTermsQuotation ?? '',
      defaultTermsInvoice: input.defaultTermsInvoice ?? '',
      defaultNotes: input.defaultNotes ?? '',
      bankName: input.bankName ?? '',
      accountName: input.accountName ?? '',
      accountNumber: input.accountNumber ?? '',
      branchCode: input.branchCode ?? '',
      accountType: input.accountType ?? null,
      swiftCode: input.swiftCode ?? null,
      updatedAt: this.tick(),
    };
    this.businesses.set(updated.id, updated);
    return updated;
  }

  async createBusinessAsset(input: CreateBusinessAssetInput): Promise<BusinessAssetDto> {
    this.calls.push('createBusinessAsset');
    const dto: BusinessAssetDto = {
      id: input.id,
      businessId: input.businessId,
      contentHash: input.contentHash,
      sourceType: input.sourceType,
      mimeType: input.mimeType ?? null,
      inlineData: input.inlineData ?? null,
      filePath: input.filePath ?? null,
      externalUrl: input.externalUrl ?? null,
      originalFilename: input.originalFilename ?? null,
      byteSize: input.byteSize ?? null,
      createdAt: input.createdAt ?? this.tick(),
    };
    this.assets.set(dto.id, dto);
    return dto;
  }

  async getBusinessAssetById(id: string): Promise<BusinessAssetDto | null> {
    this.calls.push('getBusinessAssetById');
    return this.assets.get(id) ?? null;
  }

  async getBusinessAssetsByBusiness(businessId: string): Promise<BusinessAssetDto[]> {
    this.calls.push('getBusinessAssetsByBusiness');
    return Array.from(this.assets.values()).filter((a) => a.businessId === businessId);
  }

  async deleteBusinessAsset(id: string): Promise<void> {
    this.calls.push('deleteBusinessAsset');
    this.assets.delete(id);
  }

  async createClient(input: CreateClientInput): Promise<ClientDto> {
    this.calls.push('createClient');
    const now = this.tick();
    const dto: ClientDto = {
      id: input.id,
      businessId: input.businessId,
      legacyId: input.legacyId ?? null,
      name: input.name,
      companyName: input.companyName ?? null,
      email: input.email ?? '',
      phone: input.phone ?? '',
      address: input.address ?? '',
      city: input.city ?? null,
      country: input.country ?? null,
      vatNumber: input.vatNumber ?? null,
      notes: input.notes ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.clients.set(dto.id, dto);
    return dto;
  }

  async getClientById(id: string): Promise<ClientDto | null> {
    this.calls.push('getClientById');
    return this.clients.get(id) ?? null;
  }

  async getClientsByBusiness(businessId: string): Promise<ClientDto[]> {
    this.calls.push('getClientsByBusiness');
    return Array.from(this.clients.values()).filter((c) => c.businessId === businessId);
  }

  async updateClient(input: UpdateClientInput): Promise<ClientDto> {
    this.calls.push('updateClient');
    const existing = this.clients.get(input.id);
    if (!existing) throw new Error(`Client not found: ${input.id}`);
    const updated: ClientDto = {
      ...existing,
      name: input.name,
      companyName: input.companyName ?? null,
      email: input.email ?? '',
      phone: input.phone ?? '',
      address: input.address ?? '',
      city: input.city ?? null,
      country: input.country ?? null,
      vatNumber: input.vatNumber ?? null,
      notes: input.notes ?? null,
      updatedAt: this.tick(),
    };
    this.clients.set(updated.id, updated);
    return updated;
  }

  async deleteClient(id: string): Promise<void> {
    this.calls.push('deleteClient');
    this.clients.delete(id);
  }

  async createQuotation(input: CreateQuotationInput): Promise<QuotationDto> {
    this.calls.push('createQuotation');
    if (input.convertedInvoiceId) {
      throw new Error('New quotations cannot specify convertedInvoiceId');
    }
    const now = this.tick();
    const dto: QuotationDto = {
      id: input.id,
      businessId: input.businessId,
      legacyId: input.legacyId ?? null,
      clientId: input.clientId ?? null,
      quotationNumber: input.quotationNumber,
      clientSnapshotJson: input.clientSnapshotJson,
      businessSnapshotJson: input.businessSnapshotJson,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate ?? null,
      currency: input.currency,
      currencySymbol: input.currencySymbol,
      subtotalMinor: input.subtotalMinor,
      discountType: input.discountType,
      discountPercentagePpm: input.discountPercentagePpm,
      discountFixedMinor: input.discountFixedMinor,
      discountAmountMinor: input.discountAmountMinor,
      taxName: input.taxName ?? 'VAT',
      taxRatePpm: input.taxRatePpm,
      taxAmountMinor: input.taxAmountMinor,
      grandTotalMinor: input.grandTotalMinor,
      status: input.status,
      preConversionStatus: null,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      convertedInvoiceId: null,
      items: input.items.map((item, idx) => ({
        id: item.id,
        businessId: input.businessId,
        quotationId: input.id,
        legacyId: item.legacyId ?? null,
        sortOrder: String(item.sortOrder ?? idx),
        description: item.description,
        quantityScaled: item.quantityScaled,
        unitPriceScaled: item.unitPriceScaled,
        totalMinor: item.totalMinor,
        createdAt: item.createdAt ?? now,
      })),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.quotations.set(dto.id, dto);
    return dto;
  }

  async getQuotationById(id: string): Promise<QuotationDto | null> {
    this.calls.push('getQuotationById');
    return this.quotations.get(id) ?? null;
  }

  async getQuotationsByBusiness(businessId: string): Promise<QuotationDto[]> {
    this.calls.push('getQuotationsByBusiness');
    return Array.from(this.quotations.values()).filter((q) => q.businessId === businessId);
  }

  async updateQuotation(input: UpdateQuotationInput): Promise<QuotationDto> {
    this.calls.push('updateQuotation');
    const existing = this.quotations.get(input.id);
    if (!existing) throw new Error(`Quotation not found: ${input.id}`);
    if ((input.convertedInvoiceId ?? null) !== existing.convertedInvoiceId) {
      throw new Error('convertedInvoiceId cannot be modified directly through quotation update');
    }
    const now = this.tick();
    const updated: QuotationDto = {
      ...existing,
      clientId: input.clientId ?? null,
      quotationNumber: input.quotationNumber,
      clientSnapshotJson: input.clientSnapshotJson,
      businessSnapshotJson: input.businessSnapshotJson,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate ?? null,
      currency: input.currency,
      currencySymbol: input.currencySymbol,
      subtotalMinor: input.subtotalMinor,
      discountType: input.discountType,
      discountPercentagePpm: input.discountPercentagePpm,
      discountFixedMinor: input.discountFixedMinor,
      discountAmountMinor: input.discountAmountMinor,
      taxName: input.taxName ?? 'VAT',
      taxRatePpm: input.taxRatePpm,
      taxAmountMinor: input.taxAmountMinor,
      grandTotalMinor: input.grandTotalMinor,
      status: input.status,
      preConversionStatus: existing.convertedInvoiceId
        ? (input.preConversionStatus ?? existing.preConversionStatus)
        : null,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      items: input.items.map((item, idx) => ({
        id: item.id,
        businessId: input.businessId,
        quotationId: input.id,
        legacyId: item.legacyId ?? null,
        sortOrder: String(item.sortOrder ?? idx),
        description: item.description,
        quantityScaled: item.quantityScaled,
        unitPriceScaled: item.unitPriceScaled,
        totalMinor: item.totalMinor,
        createdAt: item.createdAt ?? now,
      })),
      updatedAt: now,
    };
    this.quotations.set(updated.id, updated);
    return updated;
  }

  async deleteQuotation(id: string): Promise<void> {
    this.calls.push('deleteQuotation');
    this.quotations.delete(id);
  }

  async createInvoice(input: CreateInvoiceInput): Promise<InvoiceDto> {
    this.calls.push('createInvoice');
    if (input.amountPaidMinor !== '0') {
      throw new Error('New invoices cannot start with non-zero amountPaidMinor');
    }
    const now = this.tick();
    const dto: InvoiceDto = {
      id: input.id,
      businessId: input.businessId,
      legacyId: input.legacyId ?? null,
      clientId: input.clientId ?? null,
      quotationId: input.quotationId ?? null,
      invoiceNumber: input.invoiceNumber,
      clientSnapshotJson: input.clientSnapshotJson,
      businessSnapshotJson: input.businessSnapshotJson,
      issueDate: input.issueDate,
      dueDate: input.dueDate ?? null,
      currency: input.currency,
      currencySymbol: input.currencySymbol,
      subtotalMinor: input.subtotalMinor,
      discountType: input.discountType,
      discountPercentagePpm: input.discountPercentagePpm,
      discountFixedMinor: input.discountFixedMinor,
      discountAmountMinor: input.discountAmountMinor,
      taxName: input.taxName ?? 'VAT',
      taxRatePpm: input.taxRatePpm,
      taxAmountMinor: input.taxAmountMinor,
      grandTotalMinor: input.grandTotalMinor,
      amountPaidMinor: '0',
      outstandingBalanceMinor: input.grandTotalMinor,
      status: input.status,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      paymentInstructions: input.paymentInstructions ?? null,
      items: input.items.map((item, idx) => ({
        id: item.id,
        businessId: input.businessId,
        invoiceId: input.id,
        legacyId: item.legacyId ?? null,
        sortOrder: String(item.sortOrder ?? idx),
        description: item.description,
        quantityScaled: item.quantityScaled,
        unitPriceScaled: item.unitPriceScaled,
        totalMinor: item.totalMinor,
        createdAt: item.createdAt ?? now,
      })),
      payments: [],
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.invoices.set(dto.id, dto);

    if (dto.quotationId) {
      const q = this.quotations.get(dto.quotationId);
      if (q) {
        this.quotations.set(q.id, {
          ...q,
          convertedInvoiceId: dto.id,
          preConversionStatus: q.preConversionStatus ?? q.status,
          status: q.status === 'declined' ? 'declined' : 'accepted',
          updatedAt: now,
        });
      }
    }

    return dto;
  }

  async getInvoiceById(id: string): Promise<InvoiceDto | null> {
    this.calls.push('getInvoiceById');
    return this.invoices.get(id) ?? null;
  }

  async getInvoicesByBusiness(businessId: string): Promise<InvoiceDto[]> {
    this.calls.push('getInvoicesByBusiness');
    return Array.from(this.invoices.values()).filter((inv) => inv.businessId === businessId);
  }

  async updateInvoice(input: UpdateInvoiceInput): Promise<InvoiceDto> {
    this.calls.push('updateInvoice');
    const existing = this.invoices.get(input.id);
    if (!existing) throw new Error(`Invoice not found: ${input.id}`);
    const now = this.tick();
    const updated: InvoiceDto = {
      ...existing,
      clientId: input.clientId ?? null,
      quotationId: input.quotationId ?? null,
      invoiceNumber: input.invoiceNumber,
      clientSnapshotJson: input.clientSnapshotJson,
      businessSnapshotJson: input.businessSnapshotJson,
      issueDate: input.issueDate,
      dueDate: input.dueDate ?? null,
      currency: input.currency,
      currencySymbol: input.currencySymbol,
      subtotalMinor: input.subtotalMinor,
      discountType: input.discountType,
      discountPercentagePpm: input.discountPercentagePpm,
      discountFixedMinor: input.discountFixedMinor,
      discountAmountMinor: input.discountAmountMinor,
      taxName: input.taxName ?? 'VAT',
      taxRatePpm: input.taxRatePpm,
      taxAmountMinor: input.taxAmountMinor,
      grandTotalMinor: input.grandTotalMinor,
      status: input.status,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      paymentInstructions: input.paymentInstructions ?? null,
      items: input.items.map((item, idx) => ({
        id: item.id,
        businessId: input.businessId,
        invoiceId: input.id,
        legacyId: item.legacyId ?? null,
        sortOrder: String(item.sortOrder ?? idx),
        description: item.description,
        quantityScaled: item.quantityScaled,
        unitPriceScaled: item.unitPriceScaled,
        totalMinor: item.totalMinor,
        createdAt: item.createdAt ?? now,
      })),
      updatedAt: now,
    };
    this.invoices.set(updated.id, updated);
    return updated;
  }

  async deleteInvoice(id: string): Promise<void> {
    this.calls.push('deleteInvoice');
    this.invoices.delete(id);
  }

  private recomputeInvoicePayments(invoiceId: string): void {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) return;
    const invoicePayments = Array.from(this.payments.values()).filter(
      (p) => p.invoiceId === invoiceId
    );
    const totalPaid = invoicePayments.reduce((sum, p) => sum + BigInt(p.amountMinor), 0n);
    const grandTotal = BigInt(invoice.grandTotalMinor);
    const outstanding = grandTotal > totalPaid ? grandTotal - totalPaid : 0n;
    const nextStatus =
      grandTotal > 0n && totalPaid >= grandTotal
        ? 'paid'
        : totalPaid > 0n
          ? 'partially_paid'
          : invoice.status === 'paid' || invoice.status === 'partially_paid'
            ? 'sent'
            : invoice.status;

    this.invoices.set(invoiceId, {
      ...invoice,
      payments: invoicePayments,
      amountPaidMinor: totalPaid.toString(),
      outstandingBalanceMinor: outstanding.toString(),
      status: nextStatus,
      updatedAt: this.tick(),
    });
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentDto> {
    this.calls.push('createPayment');
    const dto: PaymentDto = {
      id: input.id,
      businessId: input.businessId,
      invoiceId: input.invoiceId,
      legacyId: input.legacyId ?? null,
      amountMinor: input.amountMinor,
      paymentDate: input.paymentDate,
      paymentMethod: input.paymentMethod,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      recordedAt: input.recordedAt ?? this.tick(),
    };
    this.payments.set(dto.id, dto);
    this.recomputeInvoicePayments(dto.invoiceId);
    return dto;
  }

  async getPaymentsByInvoice(invoiceId: string): Promise<PaymentDto[]> {
    this.calls.push('getPaymentsByInvoice');
    return Array.from(this.payments.values()).filter((p) => p.invoiceId === invoiceId);
  }

  async getPaymentsByBusiness(businessId: string): Promise<PaymentDto[]> {
    this.calls.push('getPaymentsByBusiness');
    return Array.from(this.payments.values()).filter((p) => p.businessId === businessId);
  }

  async deletePayment(id: string): Promise<void> {
    this.calls.push('deletePayment');
    const existing = this.payments.get(id);
    if (!existing) return;
    this.payments.delete(id);
    this.recomputeInvoicePayments(existing.invoiceId);
  }

  async createActivityLog(input: CreateActivityLogInput): Promise<ActivityLogDto> {
    this.calls.push('createActivityLog');
    const dto: ActivityLogDto = {
      id: input.id,
      businessId: input.businessId,
      legacyId: input.legacyId ?? null,
      type: input.type,
      title: input.title,
      description: input.description,
      timestamp: input.timestamp ?? this.tick(),
      referenceId: input.referenceId ?? null,
      referenceType: input.referenceType ?? null,
      actorLocalProfileId: input.actorLocalProfileId ?? null,
    };
    this.activities.unshift(dto);
    return dto;
  }

  async getActivityLogsByBusiness(
    businessId: string,
    limit?: SafeInt64 | number | null
  ): Promise<ActivityLogDto[]> {
    this.calls.push('getActivityLogsByBusiness');
    const matching = this.activities.filter((a) => a.businessId === businessId);
    if (typeof limit === 'number' && limit > 0) {
      return matching.slice(0, limit);
    }
    return matching;
  }

  async getAppSetting(key: string): Promise<AppSettingDto | null> {
    this.calls.push('getAppSetting');
    return this.settings.get(key) ?? null;
  }

  async saveAppSetting(input: SaveAppSettingInput): Promise<AppSettingDto> {
    this.calls.push('saveAppSetting');
    const dto: AppSettingDto = {
      key: input.key,
      valueJson: input.valueJson,
      updatedAt: input.updatedAt ?? this.tick(),
    };
    this.settings.set(dto.key, dto);
    return dto;
  }

  async deleteAppSetting(key: string): Promise<void> {
    this.calls.push('deleteAppSetting');
    this.settings.delete(key);
  }

  async replaceDesktopWorkspace(
    input: ReplaceDesktopWorkspaceInput
  ): Promise<WorkspaceLifecycleResultDto> {
    this.calls.push(`replaceDesktopWorkspace:${input.source ?? 'default'}`);
    this.localProfiles.clear();
    this.businesses.clear();
    this.assets.clear();
    this.clients.clear();
    this.quotations.clear();
    this.invoices.clear();
    this.payments.clear();
    this.activities = [];

    await this.createLocalProfile(input.localProfile);
    await this.createBusiness(input.business);
    for (const a of input.assets) await this.createBusinessAsset(a);
    for (const c of input.clients) await this.createClient(c);
    for (const q of input.quotations) {
      await this.createQuotation({ ...q, convertedInvoiceId: null });
    }
    for (const inv of input.invoices) {
      await this.createInvoice({
        ...inv,
        amountPaidMinor: '0',
        outstandingBalanceMinor: inv.grandTotalMinor,
        status:
          inv.status === 'paid' || inv.status === 'partially_paid' ? 'sent' : inv.status,
      });
    }
    for (const p of input.payments) await this.createPayment(p);
    for (const act of input.activityLogs) await this.createActivityLog(act);
    for (const s of input.settings) await this.saveAppSetting(s);

    return {
      migrationState: 'not_needed',
      businessId: input.business.id,
      localProfileId: input.localProfile.id,
      counts: {
        localProfiles: String(this.localProfiles.size),
        businesses: String(this.businesses.size),
        businessAssets: String(this.assets.size),
        clients: String(this.clients.size),
        quotations: String(this.quotations.size),
        quotationItems: '0',
        invoices: String(this.invoices.size),
        invoiceItems: '0',
        payments: String(this.payments.size),
        activityLogs: String(this.activities.length),
        appSettings: String(this.settings.size),
      },
      completedAt: this.tick(),
    };
  }

  async clearDesktopWorkspace(source?: string | null): Promise<WorkspaceLifecycleResultDto> {
    this.calls.push(`clearDesktopWorkspace:${source ?? 'default'}`);
    this.localProfiles.clear();
    this.businesses.clear();
    this.assets.clear();
    this.clients.clear();
    this.quotations.clear();
    this.invoices.clear();
    this.payments.clear();
    this.activities = [];

    return {
      migrationState: 'not_needed',
      businessId: null,
      localProfileId: null,
      counts: {
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
        appSettings: String(this.settings.size),
      },
      completedAt: this.tick(),
    };
  }
}

let originalStorageDescriptor: PropertyDescriptor | undefined;
let mockStorage: MockLocalStorage;

beforeEach(() => {
  originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  mockStorage = new MockLocalStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: mockStorage,
  });
});

afterEach(() => {
  if (originalStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

function makeTestProfile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  return {
    ...initialBusinessProfile,
    id: '2f1c7a10-2a6b-4b32-89b5-951e4309d601',
    name: 'Namib Engineering Works',
    email: 'accounts@namibeng.na',
    defaultTaxRate: 15,
    nextQuoteNumber: 10,
    nextInvoiceNumber: 20,
    ...overrides,
  };
}

function makeTestQuotation(
  profile: BusinessProfile,
  client: typeof initialClients[number],
  overrides: Partial<Quotation> = {}
): Quotation {
  return {
    id: '4820c99e-0e2a-49b7-a03b-83b5f4fd3910',
    quotationNumber: 'QUO-0010',
    clientId: client.id,
    clientSnapshot: client,
    businessSnapshot: profile,
    issueDate: '2026-11-18',
    expiryDate: '2026-12-18',
    items: [
      {
        id: '8a0f6609-c68e-4d5e-b5a2-2af7d40a8a11',
        description: 'Architectural Retainer',
        quantity: 2.5,
        unitPrice: 1200.5,
        total: 3001.25,
      },
    ],
    subtotal: 3001.25,
    discountType: 'percentage',
    discountValue: 10,
    discountAmount: 300.13,
    taxName: 'VAT',
    taxRate: 15,
    taxAmount: 405.17,
    grandTotal: 3106.29,
    currency: 'NAD',
    currencySymbol: 'N$',
    status: 'sent',
    notes: 'Valid 30 days',
    terms: 'Standard terms',
    createdAt: '2026-11-18T08:00:00.000Z',
    updatedAt: '2026-11-18T08:00:00.000Z',
    ...overrides,
  };
}

function makeTestInvoice(
  profile: BusinessProfile,
  client: typeof initialClients[number],
  overrides: Partial<Invoice> = {}
): Invoice {
  return {
    id: '69c18a3f-9d1a-4781-9f3a-9cf29812be22',
    invoiceNumber: 'INV-0020',
    clientId: client.id,
    clientSnapshot: client,
    businessSnapshot: profile,
    issueDate: '2026-11-19',
    dueDate: '2026-12-19',
    items: [
      {
        id: '7d2fd223-9e4b-45bf-a8ce-9d884122d111',
        description: 'Control Panel Upgrade',
        quantity: 1,
        unitPrice: 500,
        total: 500,
      },
    ],
    subtotal: 500,
    discountType: 'fixed',
    discountValue: 0,
    discountAmount: 0,
    taxName: 'VAT',
    taxRate: 15,
    taxAmount: 75,
    grandTotal: 575,
    amountPaid: 0,
    outstandingBalance: 575,
    currency: 'NAD',
    currencySymbol: 'N$',
    status: 'sent',
    notes: 'Thank you',
    terms: 'Due within 30 days',
    paymentInstructions: 'EFT to FNB',
    payments: [],
    createdAt: '2026-11-19T08:00:00.000Z',
    updatedAt: '2026-11-19T08:00:00.000Z',
    ...overrides,
  };
}

// ============================================================
// 1. Environment Selector & Side-Effect Isolation
// ============================================================

test('environment selector chooses backend cleanly with zero side effects', () => {
  const bridge = new InMemorySqliteBridgeMock();

  assert.equal(isDesktopTauriRuntime(() => false), false);
  assert.equal(isDesktopTauriRuntime(() => true), true);
  assert.equal(isDesktopTauriRuntime(() => { throw new Error('boom'); }), false);

  assert.equal(detectPersistenceBackend(() => false), 'localStorage');
  assert.equal(detectPersistenceBackend(() => true), 'sqlite');

  const browserAdapter = createPersistenceAdapter({
    isDesktopRuntime: () => false,
  });
  assert.equal(browserAdapter.backend, 'localStorage');
  assert.equal(browserAdapter.capabilities.isAsync, false);
  assert.ok(browserAdapter instanceof BrowserPersistenceAdapter);

  const sqliteAdapter = createPersistenceAdapter({
    isDesktopRuntime: () => true,
    sqliteOptions: { bridge },
  });
  assert.equal(sqliteAdapter.backend, 'sqlite');
  assert.equal(sqliteAdapter.capabilities.isAsync, true);
  assert.ok(sqliteAdapter instanceof SqlitePersistenceAdapter);

  // Zero side effects: no localStorage calls and no bridge/SQLite calls on selection or construction
  assert.equal(mockStorage.accessLog.length, 0);
  assert.equal(bridge.calls.length, 0);
});

// ============================================================
// 2. Browser Adapter Behavior (Delegates to StorageService)
// ============================================================

test('BrowserPersistenceAdapter delegates workspace, settings, and payments cleanly', async () => {
  const adapter = new BrowserPersistenceAdapter();

  await adapter.resetToDemoData();
  const profile = await adapter.getBusinessProfile();
  assert.equal(profile.name, initialBusinessProfile.name);

  const savedClient = await adapter.saveClient({
    name: 'Okavango Supplies',
    email: 'billing@okavango.na',
    phone: '+264 61 555 0199',
    address: '5 Sam Nujoma Dr',
  });
  assert.ok(savedClient.id);
  const fetchedClient = await adapter.getClientById(savedClient.id);
  assert.equal(fetchedClient?.name, 'Okavango Supplies');

  const inv = makeTestInvoice(profile, savedClient, {
    id: 'inv-browser-1',
    invoiceNumber: 'INV-9001',
  });
  await adapter.saveInvoice(inv);
  assert.equal(await adapter.isInvoiceNumberTaken('inv-9001'), true);
  assert.equal(await adapter.isInvoiceNumberTaken('INV-9001', 'inv-browser-1'), false);

  const paidInvoice = await adapter.recordPayment('inv-browser-1', {
    amount: 200,
    paymentDate: '2026-11-19',
    paymentMethod: 'eft',
    reference: 'EFT-881',
  });
  assert.equal(paidInvoice?.amountPaid, 200);
  assert.equal(paidInvoice?.outstandingBalance, 375);
  assert.equal(paidInvoice?.status, 'partially_paid');

  const invPayments = await adapter.getPaymentsByInvoice('inv-browser-1');
  assert.equal(invPayments.length, 1);
  await adapter.deletePayment(invPayments[0].id);
  const afterDeletePay = await adapter.getInvoiceById('inv-browser-1');
  assert.equal(afterDeletePay?.amountPaid, 0);
  assert.equal(afterDeletePay?.status, 'sent');

  // Theme setting uses existing THEME_STORAGE_KEY
  await adapter.saveAppSetting('theme_preference', 'dark');
  assert.equal(mockStorage.getItem(THEME_STORAGE_KEY), 'dark');
  assert.equal(await adapter.getAppSetting('theme_preference'), 'dark');
  await adapter.deleteAppSetting('theme_preference');
  assert.equal(mockStorage.getItem(THEME_STORAGE_KEY), null);

  // Arbitrary SQLite settings and standalone asset writes are rejected cleanly
  await assert.rejects(
    () => adapter.saveAppSetting('custom_desktop_key', { enabled: true }),
    (err: unknown) => err instanceof PersistenceError && err.code === 'UNSUPPORTED_OPERATION'
  );
  await assert.rejects(
    () =>
      adapter.saveBusinessAsset({
        id: 'ast-1',
        contentHash: 'abc',
        sourceType: 'external_url',
        externalUrl: 'https://example.com/logo.png',
      }),
    (err: unknown) => err instanceof PersistenceError && err.code === 'UNSUPPORTED_OPERATION'
  );

  // Backup export & invalid JSON import reporting
  const backupJson = await adapter.exportBackupJson();
  assert.equal((await adapter.importBackupJson('not json')).ok, false);
  const okImport = await adapter.importBackupJson(backupJson);
  assert.equal(okImport.ok, true);
});

// ============================================================
// 3. Desktop SQLite Adapter Behavior
// ============================================================

test('SqlitePersistenceAdapter throws WORKSPACE_NOT_INITIALIZED before business exists and never touches localStorage', async () => {
  const bridge = new InMemorySqliteBridgeMock();
  const adapter = new SqlitePersistenceAdapter({ bridge });

  await assert.rejects(
    () => adapter.getBusinessProfile(),
    (err: unknown) => err instanceof PersistenceError && err.code === 'WORKSPACE_NOT_INITIALIZED'
  );
  assert.deepEqual(await adapter.getClients(), []);
  assert.deepEqual(await adapter.getQuotations(), []);
  assert.deepEqual(await adapter.getInvoices(), []);
  assert.deepEqual(await adapter.getActivities(), []);

  assert.equal(mockStorage.accessLog.length, 0);
});

test('SqlitePersistenceAdapter persists profile, logo asset deduplication, scaled math, payments, and quotation linkage without touching localStorage', async () => {
  const bridge = new InMemorySqliteBridgeMock();
  const adapter = new SqlitePersistenceAdapter({
    bridge,
    now: () => '2026-11-19T09:00:00.000Z',
  });

  const dataLogo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const savedProfile = await adapter.saveBusinessProfile(
    makeTestProfile({
      logoUrl: dataLogo,
      defaultTaxRate: 15,
    })
  );

  assert.equal(savedProfile.name, 'Namib Engineering Works');
  assert.equal(savedProfile.logoUrl, dataLogo);
  assert.equal(savedProfile.defaultTaxRate, 15);
  assert.equal(bridge.assets.size, 1);

  const storedBusiness = bridge.businesses.get(savedProfile.id);
  assert.ok(storedBusiness?.logoAssetId);
  assert.equal(storedBusiness?.logoUrlFallback, '');
  assert.equal(storedBusiness?.defaultTaxRatePpm, '150000');

  // Re-saving identical logo reuses existing asset instead of duplicating
  await adapter.saveBusinessProfile(savedProfile);
  assert.equal(bridge.assets.size, 1);

  const client = await adapter.saveClient({
    name: 'Etosha Logistics',
    email: 'ops@etosha.na',
    phone: '+264 61 200 3000',
    address: 'Plot 12, Prosperita',
  });
  assert.equal((await adapter.getClients()).length, 1);

  const quote = makeTestQuotation(savedProfile, client);
  await adapter.saveQuotation(quote);
  const storedQuoteDto = bridge.quotations.get(quote.id);
  assert.equal(storedQuoteDto?.items[0].quantityScaled, '2500000');
  assert.equal(storedQuoteDto?.items[0].unitPriceScaled, '1200500000');
  assert.equal(storedQuoteDto?.items[0].totalMinor, '300125');
  assert.equal(storedQuoteDto?.discountPercentagePpm, '100000');
  assert.equal(storedQuoteDto?.grandTotalMinor, '310629');

  const fetchedQuote = await adapter.getQuotationById(quote.id);
  assert.equal(fetchedQuote?.items[0].quantity, 2.5);
  assert.equal(fetchedQuote?.items[0].unitPrice, 1200.5);
  assert.equal(fetchedQuote?.grandTotal, 3106.29);

  // Numbering helpers
  assert.equal(await adapter.isQuotationNumberTaken('quo-0010'), true);
  assert.equal(await adapter.getNextAvailableQuoteNumber(), 11);
  await adapter.commitUsedQuoteNumber('QUO-0015');
  assert.equal((await adapter.getBusinessProfile()).nextQuoteNumber, 16);

  // Invoice linked to quotation + payment lifecycle
  const inv = makeTestInvoice(savedProfile, client, {
    quotationId: quote.id,
  });
  await adapter.saveInvoice(inv);
  assert.equal((await adapter.getQuotationById(quote.id))?.convertedInvoiceId, inv.id);
  assert.equal((await adapter.getQuotationById(quote.id))?.status, 'accepted');

  const afterPay = await adapter.recordPayment(inv.id, {
    amount: 575,
    paymentDate: '2026-11-19',
    paymentMethod: 'bank_transfer',
    reference: 'TX-99',
  });
  assert.equal(afterPay?.amountPaid, 575);
  assert.equal(afterPay?.outstandingBalance, 0);
  assert.equal(afterPay?.status, 'paid');
  assert.equal((await adapter.getPaymentsByBusiness()).length, 1);

  await adapter.deletePayment((afterPay?.payments ?? [])[0].id);
  const afterRefund = await adapter.getInvoiceById(inv.id);
  assert.equal(afterRefund?.amountPaid, 0);
  assert.equal(afterRefund?.outstandingBalance, 575);

  // Zero localStorage calls during all SQLite adapter operations
  assert.equal(mockStorage.accessLog.length, 0);
});

test('SqlitePersistenceAdapter protects migration keys and handles atomic backup import, reset, and clear', async () => {
  const bridge = new InMemorySqliteBridgeMock();
  const adapter = new SqlitePersistenceAdapter({
    bridge,
    now: () => '2026-11-19T10:00:00.000Z',
  });

  // Protected migration marker keys cannot be overwritten or deleted via app settings API
  await assert.rejects(
    () => adapter.saveAppSetting('migration.localstorage_v1', { status: 'completed' }),
    (err: unknown) => err instanceof PersistenceError && err.code === 'PROTECTED_SETTING'
  );
  await assert.rejects(
    () => adapter.deleteAppSetting('migration.localstorage_v1_last_error'),
    (err: unknown) => err instanceof PersistenceError && err.code === 'PROTECTED_SETTING'
  );

  // Standard setting round-trip
  await adapter.saveAppSetting('theme_preference', 'dark');
  assert.equal(await adapter.getAppSetting('theme_preference'), 'dark');
  await adapter.deleteAppSetting('theme_preference');
  assert.equal(await adapter.getAppSetting('theme_preference'), null);

  // Reset to demo data via atomic workspace replace
  await adapter.resetToDemoData();
  const demoProfile = await adapter.getBusinessProfile();
  assert.equal(demoProfile.name, initialBusinessProfile.name);
  assert.ok((await adapter.getClients()).length >= 1);

  // Export & atomic re-import
  const exported = await adapter.exportBackupJson();
  assert.equal((await adapter.importBackupJson('{bad')).ok, false);
  assert.equal((await adapter.importBackupJson(exported)).ok, true);

  // Clear all data creates clean starter business row atomically
  await adapter.clearAllData();
  const cleanProfile = await adapter.getBusinessProfile();
  assert.equal(cleanProfile.name, 'My Business');
  assert.deepEqual(await adapter.getClients(), []);
  assert.deepEqual(await adapter.getQuotations(), []);
  assert.deepEqual(await adapter.getInvoices(), []);
  assert.equal((await adapter.getActivities()).length, 1);

  // Wipe raw workspace tables clears business rows cleanly
  const wiped = await adapter.wipeWorkspaceTables('test_wipe');
  assert.equal(wiped.businessId, null);
  await assert.rejects(
    () => adapter.getBusinessProfile(),
    (err: unknown) => err instanceof PersistenceError && err.code === 'WORKSPACE_NOT_INITIALIZED'
  );

  assert.equal(mockStorage.accessLog.length, 0);
});
