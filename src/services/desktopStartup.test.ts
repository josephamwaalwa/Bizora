import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ActivityLogDto,
  AppSettingDto,
  BackupLegacyStorageInput,
  BackupLegacyStorageResult,
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
  DatabaseStatus,
  InvoiceDto,
  LegacyWorkspaceMigrationInput,
  LocalProfileDto,
  MigrationCountsDto,
  MigrationDiagnosticDto,
  MigrationResultDto,
  MigrationState,
  MigrationStatusDto,
  PaymentDto,
  QuotationDto,
  ReplaceDesktopWorkspaceInput,
  SaveAppSettingInput,
  UpdateBusinessInput,
  UpdateClientInput,
  UpdateInvoiceInput,
  UpdateQuotationInput,
  WorkspaceLifecycleResultDto,
} from './database';
import {
  runDesktopStartupGate,
  type DesktopStartupDeps,
} from './desktopStartup';
import { runExplicitLocalStorageMigration } from './migration';
import {
  SqlitePersistenceAdapter,
  type SqlitePersistenceBridge,
} from './persistence';
import {
  initialActivities,
  initialBusinessProfile,
  initialClients,
  initialInvoices,
  initialQuotations,
} from './seedData';
import { LEGACY_STORAGE_KEYS, StorageService } from './storage';
import { THEME_STORAGE_KEY } from '../utils/theme';

class MockLocalStorage implements Storage {
  private readonly store = new Map<string, string>();
  public readonly accessLog: Array<{
    op: 'getItem' | 'setItem' | 'removeItem' | 'clear';
    key?: string;
  }> = [];

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

  seedRaw(key: string, value: string): void {
    this.store.set(key, value);
  }

  snapshotMap(): Record<string, string> {
    return Object.fromEntries(this.store.entries());
  }

  writeCount(): number {
    return this.accessLog.filter(
      (entry) => entry.op === 'setItem' || entry.op === 'removeItem' || entry.op === 'clear'
    ).length;
  }
}

class DesktopStartupSqliteHarness implements SqlitePersistenceBridge {
  public localProfiles = new Map<string, LocalProfileDto>();
  public businesses = new Map<string, BusinessDto>();
  public assets = new Map<string, BusinessAssetDto>();
  public clients = new Map<string, ClientDto>();
  public quotations = new Map<string, QuotationDto>();
  public invoices = new Map<string, InvoiceDto>();
  public payments = new Map<string, PaymentDto>();
  public activities: ActivityLogDto[] = [];
  public settings = new Map<string, AppSettingDto>();

  public markerState: MigrationState = 'absent';
  public markerSource: string | null = null;
  public migratedBusinessId: string | null = null;
  public completedAt: string | null = null;
  public backupFilename: string | null = null;
  public lastError: MigrationDiagnosticDto | null = null;

  public eventSequence: string[] = [];
  public savedBackups: Array<{ input: BackupLegacyStorageInput; result: BackupLegacyStorageResult }> = [];
  public recordedErrors: MigrationDiagnosticDto[] = [];

  private clock = 0;

  private tick(): string {
    this.clock += 1;
    return `2026-11-19T14:00:${String(this.clock).padStart(2, '0')}.000Z`;
  }

  private countQuoteItems(): number {
    let total = 0;
    for (const q of this.quotations.values()) total += q.items.length;
    return total;
  }

  private countInvoiceItems(): number {
    let total = 0;
    for (const i of this.invoices.values()) total += i.items.length;
    return total;
  }

  public getCounts(): MigrationCountsDto {
    return {
      localProfiles: String(this.localProfiles.size),
      businesses: String(this.businesses.size),
      businessAssets: String(this.assets.size),
      clients: String(this.clients.size),
      quotations: String(this.quotations.size),
      quotationItems: String(this.countQuoteItems()),
      invoices: String(this.invoices.size),
      invoiceItems: String(this.countInvoiceItems()),
      payments: String(this.payments.size),
      activityLogs: String(this.activities.length),
      appSettings: String(this.settings.size),
    };
  }

  public hasBusinessRows(): boolean {
    return (
      this.localProfiles.size > 0 ||
      this.businesses.size > 0 ||
      this.assets.size > 0 ||
      this.clients.size > 0 ||
      this.quotations.size > 0 ||
      this.invoices.size > 0 ||
      this.payments.size > 0 ||
      this.activities.length > 0
    );
  }

  getHealthyDbStatus(): DatabaseStatus {
    return {
      initialized: true,
      databasePath: '/mock/app-data/bizora.db',
      schemaVersion: 1,
      sqliteVersion: '3.46.0',
      journalMode: 'wal',
      foreignKeysEnabled: true,
      busyTimeoutMs: 5000,
      integrityOk: true,
      foreignKeyCheckPassed: true,
    };
  }

  async getMigrationStatus(): Promise<MigrationStatusDto> {
    this.eventSequence.push('getMigrationStatus');
    const existingCounts = this.getCounts();
    let effectiveState = this.markerState;
    if (effectiveState === 'absent' && this.hasBusinessRows()) {
      effectiveState = 'conflict_existing_data';
    }
    return {
      state: effectiveState,
      markerVersion: effectiveState === 'absent' ? null : 1,
      completedAt: this.completedAt,
      migratedBusinessId: this.migratedBusinessId,
      backupFilename: this.backupFilename,
      lastError: this.lastError,
      existingCounts,
    };
  }

  async markMigrationNotNeeded(source?: string | null): Promise<MigrationStatusDto> {
    this.eventSequence.push(`markMigrationNotNeeded:${source ?? 'default'}`);
    if (this.hasBusinessRows() || this.markerState === 'completed' || this.markerState === 'conflict_existing_data') {
      throw new Error('Cannot mark migration not needed when business rows or completed/conflict marker exist.');
    }
    this.markerState = 'not_needed';
    this.markerSource = source ?? 'desktop_fresh_install';
    this.completedAt = this.tick();
    return this.getMigrationStatus();
  }

  async recordMigrationError(diagnostic: MigrationDiagnosticDto): Promise<MigrationDiagnosticDto> {
    this.eventSequence.push(`recordMigrationError:${diagnostic.code}`);
    this.lastError = diagnostic;
    this.recordedErrors.push(diagnostic);
    return diagnostic;
  }

  async backupLegacyLocalstorage(input: BackupLegacyStorageInput): Promise<BackupLegacyStorageResult> {
    this.eventSequence.push('backupLegacyLocalstorage');
    const serialized = JSON.stringify(input);
    const result: BackupLegacyStorageResult = {
      backupFilename: `bizora-localstorage-backup-${this.savedBackups.length + 1}.json`,
      byteSize: String(serialized.length),
      sha256: 'abc123verifiedhash',
      verified: true,
      capturedKeyCount: String(input.keys.length),
    };
    this.savedBackups.push({ input, result });
    return result;
  }

  async migrateLegacyWorkspace(input: LegacyWorkspaceMigrationInput): Promise<MigrationResultDto> {
    this.eventSequence.push('migrateLegacyWorkspace');
    if (this.hasBusinessRows() || this.markerState !== 'absent') {
      throw new Error('Conflict: SQLite already contains records or migration marker.');
    }
    const now = this.tick();
    await this.applyWorkspaceInput(input);
    this.markerState = 'completed';
    this.migratedBusinessId = input.business.id;
    this.backupFilename = input.backupVerification.backupFilename;
    this.completedAt = now;
    return {
      state: 'completed',
      migratedBusinessId: input.business.id,
      localProfileId: input.localProfile.id,
      backupFilename: input.backupVerification.backupFilename,
      counts: this.getCounts(),
      diagnostics: input.diagnostics,
      completedAt: now,
    };
  }

  private async applyWorkspaceInput(input: ReplaceDesktopWorkspaceInput): Promise<void> {
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
    for (const q of input.quotations) await this.createQuotation(q);
    for (const inv of input.invoices) await this.createInvoice(inv);
    for (const p of input.payments) await this.createPayment(p);
    for (const act of input.activityLogs) await this.createActivityLog(act);
    for (const s of input.settings) {
      if (!s.key.startsWith('migration.localstorage_v1')) {
        await this.saveAppSetting(s);
      }
    }
  }

  // SqlitePersistenceBridge implementation
  async getLocalProfiles(): Promise<LocalProfileDto[]> {
    return Array.from(this.localProfiles.values());
  }

  async createLocalProfile(input: CreateLocalProfileInput): Promise<LocalProfileDto> {
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
    const list = Array.from(this.businesses.values());
    return ownerProfileId ? list.filter((b) => b.ownerProfileId === ownerProfileId) : list;
  }

  async getBusinessById(id: string): Promise<BusinessDto | null> {
    return this.businesses.get(id) ?? null;
  }

  async createBusiness(input: CreateBusinessInput): Promise<BusinessDto> {
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
    const existing = this.businesses.get(input.id);
    if (!existing) throw new Error('Business not found');
    const updated: BusinessDto = {
      ...existing,
      ...input,
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
    return this.assets.get(id) ?? null;
  }

  async getBusinessAssetsByBusiness(businessId: string): Promise<BusinessAssetDto[]> {
    return Array.from(this.assets.values()).filter((a) => a.businessId === businessId);
  }

  async deleteBusinessAsset(id: string): Promise<void> {
    this.assets.delete(id);
  }

  async createClient(input: CreateClientInput): Promise<ClientDto> {
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
    return this.clients.get(id) ?? null;
  }

  async getClientsByBusiness(businessId: string): Promise<ClientDto[]> {
    return Array.from(this.clients.values()).filter((c) => c.businessId === businessId);
  }

  async updateClient(input: UpdateClientInput): Promise<ClientDto> {
    const existing = this.clients.get(input.id);
    if (!existing) throw new Error('Client not found');
    const updated: ClientDto = {
      ...existing,
      ...input,
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
    this.clients.delete(id);
  }

  async createQuotation(input: CreateQuotationInput): Promise<QuotationDto> {
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
      preConversionStatus: input.preConversionStatus ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      convertedInvoiceId: input.convertedInvoiceId ?? null,
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
    return this.quotations.get(id) ?? null;
  }

  async getQuotationsByBusiness(businessId: string): Promise<QuotationDto[]> {
    return Array.from(this.quotations.values()).filter((q) => q.businessId === businessId);
  }

  async updateQuotation(input: UpdateQuotationInput): Promise<QuotationDto> {
    const existing = this.quotations.get(input.id);
    if (!existing) throw new Error('Quotation not found');
    const updated: QuotationDto = {
      ...existing,
      ...input,
      clientId: input.clientId ?? null,
      expiryDate: input.expiryDate ?? null,
      taxName: input.taxName ?? 'VAT',
      preConversionStatus: input.preConversionStatus ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      convertedInvoiceId: input.convertedInvoiceId ?? null,
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
        createdAt: item.createdAt ?? existing.createdAt,
      })),
      updatedAt: this.tick(),
    };
    this.quotations.set(updated.id, updated);
    return updated;
  }

  async deleteQuotation(id: string): Promise<void> {
    this.quotations.delete(id);
  }

  async createInvoice(input: CreateInvoiceInput): Promise<InvoiceDto> {
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
      amountPaidMinor: input.amountPaidMinor,
      outstandingBalanceMinor: input.outstandingBalanceMinor,
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
    return dto;
  }

  async getInvoiceById(id: string): Promise<InvoiceDto | null> {
    const inv = this.invoices.get(id);
    if (!inv) return null;
    return {
      ...inv,
      payments: Array.from(this.payments.values()).filter((p) => p.invoiceId === inv.id),
    };
  }

  async getInvoicesByBusiness(businessId: string): Promise<InvoiceDto[]> {
    return Array.from(this.invoices.values())
      .filter((inv) => inv.businessId === businessId)
      .map((inv) => ({
        ...inv,
        payments: Array.from(this.payments.values()).filter((p) => p.invoiceId === inv.id),
      }));
  }

  async updateInvoice(input: UpdateInvoiceInput): Promise<InvoiceDto> {
    const existing = this.invoices.get(input.id);
    if (!existing) throw new Error('Invoice not found');
    const updated: InvoiceDto = {
      ...existing,
      ...input,
      clientId: input.clientId ?? null,
      quotationId: input.quotationId ?? null,
      dueDate: input.dueDate ?? null,
      taxName: input.taxName ?? 'VAT',
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
        createdAt: item.createdAt ?? existing.createdAt,
      })),
      payments: Array.from(this.payments.values()).filter((p) => p.invoiceId === input.id),
      updatedAt: this.tick(),
    };
    this.invoices.set(updated.id, updated);
    return updated;
  }

  async deleteInvoice(id: string): Promise<void> {
    this.invoices.delete(id);
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentDto> {
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
    return dto;
  }

  async getPaymentsByInvoice(invoiceId: string): Promise<PaymentDto[]> {
    return Array.from(this.payments.values()).filter((p) => p.invoiceId === invoiceId);
  }

  async getPaymentsByBusiness(businessId: string): Promise<PaymentDto[]> {
    return Array.from(this.payments.values()).filter((p) => p.businessId === businessId);
  }

  async deletePayment(id: string): Promise<void> {
    this.payments.delete(id);
  }

  async createActivityLog(input: CreateActivityLogInput): Promise<ActivityLogDto> {
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

  async getActivityLogsByBusiness(businessId: string): Promise<ActivityLogDto[]> {
    return this.activities.filter((a) => a.businessId === businessId);
  }

  async getAppSetting(key: string): Promise<AppSettingDto | null> {
    return this.settings.get(key) ?? null;
  }

  async saveAppSetting(input: SaveAppSettingInput): Promise<AppSettingDto> {
    const dto: AppSettingDto = {
      key: input.key,
      valueJson: input.valueJson,
      updatedAt: input.updatedAt ?? this.tick(),
    };
    this.settings.set(dto.key, dto);
    return dto;
  }

  async deleteAppSetting(key: string): Promise<void> {
    this.settings.delete(key);
  }

  async replaceDesktopWorkspace(
    input: ReplaceDesktopWorkspaceInput
  ): Promise<WorkspaceLifecycleResultDto> {
    this.eventSequence.push(`replaceDesktopWorkspace:${input.source ?? 'unknown'}`);
    if (this.markerState === 'conflict_existing_data') {
      throw new Error('Refusing replaceDesktopWorkspace while conflict exists.');
    }
    await this.applyWorkspaceInput(input);
    return {
      migrationState: this.markerState,
      businessId: input.business.id,
      localProfileId: input.localProfile.id,
      counts: this.getCounts(),
      completedAt: this.tick(),
    };
  }

  async clearDesktopWorkspace(source?: string | null): Promise<WorkspaceLifecycleResultDto> {
    this.eventSequence.push(`clearDesktopWorkspace:${source ?? 'unknown'}`);
    this.localProfiles.clear();
    this.businesses.clear();
    this.assets.clear();
    this.clients.clear();
    this.quotations.clear();
    this.invoices.clear();
    this.payments.clear();
    this.activities = [];
    return {
      migrationState: this.markerState,
      businessId: null,
      localProfileId: null,
      counts: this.getCounts(),
      completedAt: this.tick(),
    };
  }
}

let originalLocalStorage: Storage | undefined;
let mockStorage: MockLocalStorage;

beforeEach(() => {
  originalLocalStorage = globalThis.localStorage;
  mockStorage = new MockLocalStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: originalLocalStorage,
    configurable: true,
    writable: true,
  });
});

function createStartupDeps(
  harness: DesktopStartupSqliteHarness,
  overrides?: Partial<DesktopStartupDeps>
): { adapter: SqlitePersistenceAdapter; deps: DesktopStartupDeps } {
  const adapter = new SqlitePersistenceAdapter({
    bridge: harness,
    now: () => '2026-11-19T14:00:00.000Z',
  });

  const deps: DesktopStartupDeps = {
    initializeDatabase: async () => harness.getHealthyDbStatus(),
    getDatabaseStatus: async () => harness.getHealthyDbStatus(),
    getMigrationStatus: () => harness.getMigrationStatus(),
    markMigrationNotNeeded: (source) => harness.markMigrationNotNeeded(source),
    recordMigrationError: (diagnostic) => harness.recordMigrationError(diagnostic),
    getRawSnapshot: () => StorageService.getRawMigrationSnapshot(),
    runMigration: (opts) =>
      runExplicitLocalStorageMigration({
        nowIso: opts?.nowIso,
        deps: {
          getRawSnapshot: () => StorageService.getRawMigrationSnapshot(),
          getMigrationStatus: () => harness.getMigrationStatus(),
          backupLegacyLocalstorage: (input) => harness.backupLegacyLocalstorage(input),
          migrateLegacyWorkspace: (input) => harness.migrateLegacyWorkspace(input),
        },
      }),
    adapter,
    now: () => '2026-11-19T14:00:00.000Z',
    ...overrides,
  };

  return { adapter, deps };
}

test('Scenario 1: Fresh desktop install marks migration not_needed first, initializes empty workspace without demo data, and never mutates LocalStorage', async () => {
  const harness = new DesktopStartupSqliteHarness();
  const { adapter, deps } = createStartupDeps(harness);

  const result = await runDesktopStartupGate(adapter, { deps });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;

  assert.equal(result.startupMode, 'fresh_install');
  assert.equal(result.migrationStatus.state, 'not_needed');
  assert.equal(harness.markerState, 'not_needed');
  assert.equal(harness.markerSource, 'desktop_fresh_install');

  // Ordered sequence: marker recorded BEFORE clean workspace creation
  const markIdx = harness.eventSequence.indexOf('markMigrationNotNeeded:desktop_fresh_install');
  const replaceIdx = harness.eventSequence.indexOf('replaceDesktopWorkspace:clear_all_data');
  assert.ok(markIdx !== -1 && replaceIdx !== -1 && markIdx < replaceIdx);

  // Clean starter business without demo records
  assert.equal(result.hydrated.businessProfile.name, 'My Business');
  assert.equal(result.hydrated.clients.length, 0);
  assert.equal(result.hydrated.quotations.length, 0);
  assert.equal(result.hydrated.invoices.length, 0);
  assert.equal(result.hydrated.activities.length, 1);

  // Zero writes to LocalStorage
  assert.equal(mockStorage.writeCount(), 0);
  assert.equal(harness.savedBackups.length, 0);
});

test('Scenario 2: Legacy LocalStorage data triggers verified raw backup, atomic SQLite migration, completed marker, theme migration, and leaves LocalStorage untouched', async () => {
  const harness = new DesktopStartupSqliteHarness();

  // Seed legacy browser workspace + theme
  const legacyProfile = {
    ...initialBusinessProfile,
    id: 'biz_legacy_1',
    name: 'Namib Engineering CC',
    nextQuoteNumber: 42,
  };
  const legacyClient = {
    ...initialClients[0],
    id: 'cli_legacy_1',
    name: 'Erongo Mining Co',
  };
  const legacyQuote = {
    ...initialQuotations[0],
    id: 'quo_legacy_1',
    quotationNumber: 'QUO-0041',
    clientId: legacyClient.id,
    clientSnapshot: legacyClient,
  };
  const legacyInvoice = {
    ...initialInvoices[0],
    id: 'inv_legacy_1',
    invoiceNumber: 'INV-0099',
    clientId: legacyClient.id,
    clientSnapshot: legacyClient,
    quotationId: legacyQuote.id,
  };

  mockStorage.seedRaw('bizora_business_profile_v1', JSON.stringify(legacyProfile));
  mockStorage.seedRaw('bizora_clients_v1', JSON.stringify([legacyClient]));
  mockStorage.seedRaw('bizora_quotations_v1', JSON.stringify([legacyQuote]));
  mockStorage.seedRaw('bizora_invoices_v1', JSON.stringify([legacyInvoice]));
  mockStorage.seedRaw('bizora_activities_v1', JSON.stringify(initialActivities.slice(0, 1)));
  mockStorage.seedRaw('bizora_has_initialized_v1', 'true');
  mockStorage.seedRaw(THEME_STORAGE_KEY, 'dark');

  const snapshotBefore = mockStorage.snapshotMap();
  const { adapter, deps } = createStartupDeps(harness);

  const result = await runDesktopStartupGate(adapter, { deps });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;

  assert.equal(result.startupMode, 'migrated_from_localstorage');
  assert.equal(result.migrationStatus.state, 'completed');
  assert.equal(harness.savedBackups.length, 1);

  // Ordered sequence: raw backup happened BEFORE atomic SQLite migration
  const backupIdx = harness.eventSequence.indexOf('backupLegacyLocalstorage');
  const migrateIdx = harness.eventSequence.indexOf('migrateLegacyWorkspace');
  assert.ok(backupIdx !== -1 && migrateIdx !== -1 && backupIdx < migrateIdx);

  // Hydrated records come from SQLite
  assert.equal(result.hydrated.businessProfile.name, 'Namib Engineering CC');
  assert.equal(result.hydrated.clients.length, 1);
  assert.equal(result.hydrated.clients[0].name, 'Erongo Mining Co');
  assert.equal(result.hydrated.quotations.length, 1);
  assert.equal(result.hydrated.invoices.length, 1);
  assert.equal(result.hydrated.themePreference, 'dark');

  // Original LocalStorage completely preserved and zero writes performed
  assert.equal(mockStorage.writeCount(), 0);
  assert.deepEqual(mockStorage.snapshotMap(), snapshotBefore);
});

test('Scenario 3: Already completed migration skips backup/migration, leaves LocalStorage untouched, and hydrates from SQLite', async () => {
  const harness = new DesktopStartupSqliteHarness();
  const adapter = new SqlitePersistenceAdapter({
    bridge: harness,
    now: () => '2026-11-19T14:00:00.000Z',
  });

  // Pre-populate SQLite as an already-migrated desktop workspace
  await adapter.resetToDemoData();
  await adapter.saveBusinessProfile({
    ...(await adapter.getBusinessProfile()),
    name: 'SQLite Authoritative Workspace',
  });
  await adapter.saveAppSetting('theme_preference', 'light');
  harness.markerState = 'completed';
  harness.migratedBusinessId = (await harness.getBusinesses())[0].id;
  harness.completedAt = '2026-11-19T13:00:00.000Z';
  harness.eventSequence = [];

  // Put differing LocalStorage data that must NOT overwrite SQLite or trigger migration
  mockStorage.seedRaw(
    'bizora_business_profile_v1',
    JSON.stringify({ ...initialBusinessProfile, name: 'Stale Browser Data' })
  );
  mockStorage.seedRaw(THEME_STORAGE_KEY, 'dark');
  const beforeStorage = mockStorage.snapshotMap();

  let runMigrationCalled = false;
  const { deps } = createStartupDeps(harness, {
    adapter,
    runMigration: async () => {
      runMigrationCalled = true;
      throw new Error('Should never run migration once completed');
    },
  });

  const result = await runDesktopStartupGate(adapter, { deps });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;

  assert.equal(runMigrationCalled, false);
  assert.equal(result.startupMode, 'already_migrated');
  assert.equal(result.hydrated.businessProfile.name, 'SQLite Authoritative Workspace');
  assert.equal(result.hydrated.themePreference, 'light');
  assert.equal(harness.savedBackups.length, 0);
  assert.equal(mockStorage.writeCount(), 0);
  assert.deepEqual(mockStorage.snapshotMap(), beforeStorage);
});

test('Scenario 4: Migration marked not_needed skips migration, initializes clean starter business if needed, and hydrates from SQLite', async () => {
  const harness = new DesktopStartupSqliteHarness();
  harness.markerState = 'not_needed';
  harness.completedAt = '2026-11-19T12:00:00.000Z';

  // Legacy LocalStorage must NOT be imported when marker is not_needed
  mockStorage.seedRaw(
    'bizora_business_profile_v1',
    JSON.stringify({ ...initialBusinessProfile, name: 'Should Not Import' })
  );
  const beforeStorage = mockStorage.snapshotMap();

  let runMigrationCalled = false;
  const { adapter, deps } = createStartupDeps(harness, {
    runMigration: async () => {
      runMigrationCalled = true;
      throw new Error('Should not run migration when not_needed');
    },
  });

  const result = await runDesktopStartupGate(adapter, { deps });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;

  assert.equal(runMigrationCalled, false);
  assert.equal(result.startupMode, 'not_needed');
  assert.equal(result.hydrated.businessProfile.name, 'My Business');
  assert.equal(result.hydrated.clients.length, 0);
  assert.equal(harness.markerState, 'not_needed');
  assert.equal(mockStorage.writeCount(), 0);
  assert.deepEqual(mockStorage.snapshotMap(), beforeStorage);
});

test('Scenario 5: Unmarked existing SQLite data or conflict marker blocks startup cleanly without overwriting SQLite or touching LocalStorage', async () => {
  const harness = new DesktopStartupSqliteHarness();
  const adapter = new SqlitePersistenceAdapter({ bridge: harness });

  // Populate SQLite directly without setting a migration marker -> simulates unmarked existing SQLite data
  await adapter.saveBusinessProfile({
    ...initialBusinessProfile,
    name: 'Existing Unmarked Desktop Business',
  });
  assert.equal(harness.markerState, 'absent');
  harness.eventSequence = [];

  mockStorage.seedRaw(
    'bizora_business_profile_v1',
    JSON.stringify({ ...initialBusinessProfile, name: 'Legacy LocalStorage Biz' })
  );
  const beforeStorage = mockStorage.snapshotMap();

  let runMigrationCalled = false;
  const { deps } = createStartupDeps(harness, {
    adapter,
    runMigration: async () => {
      runMigrationCalled = true;
      throw new Error('Should never run migration during conflict');
    },
  });

  const result = await runDesktopStartupGate(adapter, { deps });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;

  assert.equal(result.reason, 'conflict_existing_data');
  assert.equal(runMigrationCalled, false);
  assert.equal(result.existingCounts?.businesses, '1');
  // Existing SQLite business untouched
  assert.equal((await adapter.getBusinessProfile()).name, 'Existing Unmarked Desktop Business');
  // LocalStorage untouched
  assert.equal(mockStorage.writeCount(), 0);
  assert.deepEqual(mockStorage.snapshotMap(), beforeStorage);
});

test('Scenario 6: Backup, validation, or SQLite rollback failures record sanitized diagnostic, preserve backup & LocalStorage, and never fall back to LocalStorage', async () => {
  // 6A: Corrupted JSON triggers backup_first -> validation_failed -> recorded error
  const harnessA = new DesktopStartupSqliteHarness();
  mockStorage.seedRaw('bizora_business_profile_v1', '{broken json');
  mockStorage.seedRaw('bizora_has_initialized_v1', 'true');
  const snapshotA = mockStorage.snapshotMap();

  const { adapter: adapterA, deps: depsA } = createStartupDeps(harnessA);
  const resA = await runDesktopStartupGate(adapterA, { deps: depsA });
  assert.equal(resA.status, 'failed');
  if (resA.status !== 'failed') return;

  assert.equal(resA.reason, 'migration_failed');
  assert.ok(resA.backup?.verified, 'Raw backup must still be created & verified before validation fails');
  assert.equal(harnessA.recordedErrors.length, 1);
  assert.equal(harnessA.businesses.size, 0);
  assert.equal(mockStorage.writeCount(), 0);
  assert.deepEqual(mockStorage.snapshotMap(), snapshotA);

  // 6B: SQLite rollback failure records sanitized diagnostic cleanly
  const harnessB = new DesktopStartupSqliteHarness();
  harnessB.migrateLegacyWorkspace = async () => {
    throw new Error('SQLite transaction rolled back: simulated I/O error');
  };
  mockStorage.seedRaw('bizora_business_profile_v1', JSON.stringify(initialBusinessProfile));
  mockStorage.seedRaw('bizora_clients_v1', JSON.stringify([initialClients[0]]));
  mockStorage.seedRaw('bizora_has_initialized_v1', 'true');

  const { adapter: adapterB, deps: depsB } = createStartupDeps(harnessB);
  const resB = await runDesktopStartupGate(adapterB, { deps: depsB });
  assert.equal(resB.status, 'failed');
  if (resB.status !== 'failed') return;

  assert.equal(resB.reason, 'migration_failed');
  assert.ok(resB.message.includes('rolled back'));
  assert.equal(harnessB.recordedErrors.length, 1);
  assert.equal(harnessB.markerState, 'absent');
});

test('Demo-seed-only legacy LocalStorage preserves raw backup and LocalStorage, marks not_needed, and avoids polluting fresh desktop SQLite with demo data', async () => {
  const harness = new DesktopStartupSqliteHarness();

  mockStorage.seedRaw('bizora_business_profile_v1', JSON.stringify(initialBusinessProfile));
  mockStorage.seedRaw('bizora_clients_v1', JSON.stringify(initialClients));
  mockStorage.seedRaw('bizora_quotations_v1', JSON.stringify(initialQuotations));
  mockStorage.seedRaw('bizora_invoices_v1', JSON.stringify(initialInvoices));
  mockStorage.seedRaw('bizora_activities_v1', JSON.stringify(initialActivities));
  mockStorage.seedRaw('bizora_has_initialized_v1', 'true');
  mockStorage.seedRaw(THEME_STORAGE_KEY, 'dark');
  const snapshotBefore = mockStorage.snapshotMap();

  const { adapter, deps } = createStartupDeps(harness);
  const result = await runDesktopStartupGate(adapter, { deps });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;

  assert.equal(result.startupMode, 'fresh_install');
  assert.equal(result.migrationStatus.state, 'not_needed');
  assert.equal(harness.markerSource, 'desktop_demo_seed_only');
  assert.equal(harness.savedBackups.length, 1);
  assert.equal(result.hydrated.businessProfile.name, 'My Business');
  assert.equal(result.hydrated.clients.length, 0);
  assert.equal(result.hydrated.themePreference, 'dark');
  assert.equal(mockStorage.writeCount(), 0);
  assert.deepEqual(mockStorage.snapshotMap(), snapshotBefore);
});

test('Unhealthy SQLite database blocks startup cleanly before migration or UI unlock', async () => {
  const harness = new DesktopStartupSqliteHarness();
  const { adapter, deps } = createStartupDeps(harness, {
    initializeDatabase: async () => ({
      ...harness.getHealthyDbStatus(),
      integrityOk: false,
    }),
  });

  const result = await runDesktopStartupGate(adapter, { deps });
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;

  assert.equal(result.reason, 'database_unhealthy');
  assert.equal(mockStorage.writeCount(), 0);
  assert.equal(LEGACY_STORAGE_KEYS.length > 0, true);
});
