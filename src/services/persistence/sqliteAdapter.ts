import type {
  ActivityLog,
  BusinessProfile,
  Client,
  CurrencyCode,
  Invoice,
  LineItem,
  PaymentRecord,
  Quotation,
} from '../../types';
import { formatDocNumber, generateId } from '../../utils/idGenerator';
import {
  DesktopDatabaseService,
  scaledInt64ToDecimal,
  strictDecimalToScaledInt64,
  toSafeInt64,
  type ActivityLogDto,
  type AppSettingDto,
  type BusinessAssetDto,
  type BusinessDto,
  type ClientDto,
  type CreateActivityLogInput,
  type CreateBusinessAssetInput,
  type CreateBusinessInput,
  type CreateClientInput,
  type CreateInvoiceInput,
  type CreateLocalProfileInput,
  type CreatePaymentInput,
  type CreateQuotationInput,
  type DiscountType,
  type InvoiceDto,
  type InvoiceItemDto,
  type LineItemInput,
  type LocalProfileDto,
  type PaymentDto,
  type QuotationDto,
  type QuotationItemDto,
  type ReplaceDesktopWorkspaceInput,
  type SafeInt64,
  type SaveAppSettingInput,
  type UpdateBusinessInput,
  type UpdateClientInput,
  type UpdateInvoiceInput,
  type UpdateQuotationInput,
  type WorkspaceLifecycleResultDto,
} from '../database';
import { prepareMigrationPayload, sha256Hex } from '../migration';
import {
  initialActivities,
  initialBusinessProfile,
  initialClients,
  initialInvoices,
  initialQuotations,
} from '../seedData';
import { LEGACY_STORAGE_KEYS, type RawLegacyStorageSnapshot } from '../storage';
import {
  PersistenceError,
  type BackupImportResult,
  type NewActivityInput,
  type NewPaymentInput,
  type PersistenceAdapter,
  type PersistenceCapabilities,
  type SaveBusinessAssetInput,
  type SaveClientInput,
} from './types';

const PROTECTED_MIGRATION_SETTING_PREFIX = 'migration.localstorage_v1';

export interface SqlitePersistenceBridge {
  getLocalProfiles(): Promise<LocalProfileDto[]>;
  createLocalProfile(input: CreateLocalProfileInput): Promise<LocalProfileDto>;
  getBusinesses(ownerProfileId?: string | null): Promise<BusinessDto[]>;
  getBusinessById(id: string): Promise<BusinessDto | null>;
  createBusiness(input: CreateBusinessInput): Promise<BusinessDto>;
  updateBusiness(input: UpdateBusinessInput): Promise<BusinessDto>;

  createBusinessAsset(input: CreateBusinessAssetInput): Promise<BusinessAssetDto>;
  getBusinessAssetById(id: string): Promise<BusinessAssetDto | null>;
  getBusinessAssetsByBusiness(businessId: string): Promise<BusinessAssetDto[]>;
  deleteBusinessAsset(id: string): Promise<void>;

  createClient(input: CreateClientInput): Promise<ClientDto>;
  getClientById(id: string): Promise<ClientDto | null>;
  getClientsByBusiness(businessId: string): Promise<ClientDto[]>;
  updateClient(input: UpdateClientInput): Promise<ClientDto>;
  deleteClient(id: string): Promise<void>;

  createQuotation(input: CreateQuotationInput): Promise<QuotationDto>;
  getQuotationById(id: string): Promise<QuotationDto | null>;
  getQuotationsByBusiness(businessId: string): Promise<QuotationDto[]>;
  updateQuotation(input: UpdateQuotationInput): Promise<QuotationDto>;
  deleteQuotation(id: string): Promise<void>;

  createInvoice(input: CreateInvoiceInput): Promise<InvoiceDto>;
  getInvoiceById(id: string): Promise<InvoiceDto | null>;
  getInvoicesByBusiness(businessId: string): Promise<InvoiceDto[]>;
  updateInvoice(input: UpdateInvoiceInput): Promise<InvoiceDto>;
  deleteInvoice(id: string): Promise<void>;

  createPayment(input: CreatePaymentInput): Promise<PaymentDto>;
  getPaymentsByInvoice(invoiceId: string): Promise<PaymentDto[]>;
  getPaymentsByBusiness(businessId: string): Promise<PaymentDto[]>;
  deletePayment(id: string): Promise<void>;

  createActivityLog(input: CreateActivityLogInput): Promise<ActivityLogDto>;
  getActivityLogsByBusiness(
    businessId: string,
    limit?: SafeInt64 | number | null
  ): Promise<ActivityLogDto[]>;

  getAppSetting(key: string): Promise<AppSettingDto | null>;
  saveAppSetting(input: SaveAppSettingInput): Promise<AppSettingDto>;
  deleteAppSetting(key: string): Promise<void>;

  replaceDesktopWorkspace(input: ReplaceDesktopWorkspaceInput): Promise<WorkspaceLifecycleResultDto>;
  clearDesktopWorkspace(source?: string | null): Promise<WorkspaceLifecycleResultDto>;
}

export interface SqlitePersistenceAdapterOptions {
  bridge?: SqlitePersistenceBridge;
  activeBusinessId?: string | null;
  now?: () => string;
}

const DEFAULT_SQLITE_BRIDGE: SqlitePersistenceBridge = {
  getLocalProfiles: () => DesktopDatabaseService.getLocalProfiles(),
  createLocalProfile: (input) => DesktopDatabaseService.createLocalProfile(input),
  getBusinesses: (ownerProfileId) => DesktopDatabaseService.getBusinesses(ownerProfileId),
  getBusinessById: (id) => DesktopDatabaseService.getBusinessById(id),
  createBusiness: (input) => DesktopDatabaseService.createBusiness(input),
  updateBusiness: (input) => DesktopDatabaseService.updateBusiness(input),
  createBusinessAsset: (input) => DesktopDatabaseService.createBusinessAsset(input),
  getBusinessAssetById: (id) => DesktopDatabaseService.getBusinessAssetById(id),
  getBusinessAssetsByBusiness: (businessId) =>
    DesktopDatabaseService.getBusinessAssetsByBusiness(businessId),
  deleteBusinessAsset: (id) => DesktopDatabaseService.deleteBusinessAsset(id),
  createClient: (input) => DesktopDatabaseService.createClient(input),
  getClientById: (id) => DesktopDatabaseService.getClientById(id),
  getClientsByBusiness: (businessId) => DesktopDatabaseService.getClientsByBusiness(businessId),
  updateClient: (input) => DesktopDatabaseService.updateClient(input),
  deleteClient: (id) => DesktopDatabaseService.deleteClient(id),
  createQuotation: (input) => DesktopDatabaseService.createQuotation(input),
  getQuotationById: (id) => DesktopDatabaseService.getQuotationById(id),
  getQuotationsByBusiness: (businessId) =>
    DesktopDatabaseService.getQuotationsByBusiness(businessId),
  updateQuotation: (input) => DesktopDatabaseService.updateQuotation(input),
  deleteQuotation: (id) => DesktopDatabaseService.deleteQuotation(id),
  createInvoice: (input) => DesktopDatabaseService.createInvoice(input),
  getInvoiceById: (id) => DesktopDatabaseService.getInvoiceById(id),
  getInvoicesByBusiness: (businessId) => DesktopDatabaseService.getInvoicesByBusiness(businessId),
  updateInvoice: (input) => DesktopDatabaseService.updateInvoice(input),
  deleteInvoice: (id) => DesktopDatabaseService.deleteInvoice(id),
  createPayment: (input) => DesktopDatabaseService.createPayment(input),
  getPaymentsByInvoice: (invoiceId) => DesktopDatabaseService.getPaymentsByInvoice(invoiceId),
  getPaymentsByBusiness: (businessId) => DesktopDatabaseService.getPaymentsByBusiness(businessId),
  deletePayment: (id) => DesktopDatabaseService.deletePayment(id),
  createActivityLog: (input) => DesktopDatabaseService.createActivityLog(input),
  getActivityLogsByBusiness: (businessId, limit) =>
    DesktopDatabaseService.getActivityLogsByBusiness(businessId, limit),
  getAppSetting: (key) => DesktopDatabaseService.getAppSetting(key),
  saveAppSetting: (input) => DesktopDatabaseService.saveAppSetting(input),
  deleteAppSetting: (key) => DesktopDatabaseService.deleteAppSetting(key),
  replaceDesktopWorkspace: (input) => DesktopDatabaseService.replaceDesktopWorkspace(input),
  clearDesktopWorkspace: (source) => DesktopDatabaseService.clearDesktopWorkspace(source),
};

function isProtectedSettingKey(key: string): boolean {
  const trimmed = key.trim();
  return (
    trimmed === PROTECTED_MIGRATION_SETTING_PREFIX ||
    trimmed.startsWith(`${PROTECTED_MIGRATION_SETTING_PREFIX}_`) ||
    trimmed.startsWith(`${PROTECTED_MIGRATION_SETTING_PREFIX}.`)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scaledToNumber(value: SafeInt64, decimals: number): number {
  return Number(scaledInt64ToDecimal(value, decimals));
}

function parseJsonObject<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed)) {
      return parsed as unknown as T;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function resolveAssetUrl(asset: BusinessAssetDto | null, fallbackUrl: string): string {
  if (!asset) return fallbackUrl || '';
  return asset.inlineData || asset.externalUrl || asset.filePath || fallbackUrl || '';
}

function extractDataUrlMeta(dataUrl: string): { mimeType: string; byteSize: SafeInt64 } {
  const headerMatch = /^data:([^;,\s]+)?([^,]*),(.*)$/s.exec(dataUrl);
  const mimeType = headerMatch?.[1] || 'application/octet-stream';
  const meta = headerMatch?.[2] || '';
  const body = headerMatch?.[3] || '';

  let bytes = new TextEncoder().encode(dataUrl).length;
  if (/;base64/i.test(meta)) {
    const clean = body.replace(/\s+/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    const decoded = Math.floor((clean.length * 3) / 4) - padding;
    if (decoded >= 0) {
      bytes = decoded;
    }
  }

  return {
    mimeType,
    byteSize: toSafeInt64(bytes),
  };
}

function normalizeDocNumber(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function parseSequentialDocNumber(docNumber: string, prefix: string): number | null {
  const trimmed = docNumber.trim();
  const normalizedPrefix = prefix.trim();
  if (normalizedPrefix) {
    if (!trimmed.toLowerCase().startsWith(normalizedPrefix.toLowerCase())) {
      return null;
    }
  }
  const suffix = normalizedPrefix ? trimmed.slice(normalizedPrefix.length) : trimmed;
  if (!/^\d+$/.test(suffix)) return null;
  const num = Number.parseInt(suffix, 10);
  return Number.isFinite(num) && num >= 1 ? num : null;
}

const VALID_CURRENCY_CODES: ReadonlySet<CurrencyCode> = new Set([
  'NAD',
  'ZAR',
  'USD',
  'EUR',
  'GBP',
]);

function normalizeCurrencyCode(raw: string): CurrencyCode {
  const upper = raw.trim().toUpperCase() as CurrencyCode;
  return VALID_CURRENCY_CODES.has(upper) ? upper : 'NAD';
}

function mapBusinessDtoToDomain(dto: BusinessDto, resolvedLogoUrl: string): BusinessProfile {
  return {
    id: dto.id,
    name: dto.name,
    tagline: dto.tagline,
    logoUrl: resolvedLogoUrl,
    email: dto.email,
    phone: dto.phone,
    address: dto.address,
    city: dto.city,
    country: dto.country,
    postalCode: dto.postalCode ?? undefined,
    website: dto.website ?? undefined,
    taxNumber: dto.taxNumber ?? undefined,
    registrationNumber: dto.registrationNumber ?? undefined,
    defaultCurrency: normalizeCurrencyCode(dto.defaultCurrency),
    currencySymbol: dto.currencySymbol,
    defaultTaxName: dto.defaultTaxName,
    defaultTaxRate: scaledToNumber(dto.defaultTaxRatePpm, 4),
    isTaxEnabled: dto.isTaxEnabled,
    quotePrefix: dto.quotePrefix,
    invoicePrefix: dto.invoicePrefix,
    nextQuoteNumber: Number(dto.nextQuoteNumber),
    nextInvoiceNumber: Number(dto.nextInvoiceNumber),
    defaultTermsQuotation: dto.defaultTermsQuotation,
    defaultTermsInvoice: dto.defaultTermsInvoice,
    defaultNotes: dto.defaultNotes,
    bankDetails: {
      bankName: dto.bankName,
      accountName: dto.accountName,
      accountNumber: dto.accountNumber,
      branchCode: dto.branchCode,
      accountType: dto.accountType ?? undefined,
      swiftCode: dto.swiftCode ?? undefined,
    },
    updatedAt: dto.updatedAt,
  };
}

function mapClientDtoToDomain(dto: ClientDto): Client {
  return {
    id: dto.id,
    name: dto.name,
    companyName: dto.companyName ?? undefined,
    email: dto.email,
    phone: dto.phone,
    address: dto.address,
    city: dto.city ?? undefined,
    country: dto.country ?? undefined,
    vatNumber: dto.vatNumber ?? undefined,
    notes: dto.notes ?? undefined,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function mapLineItemDtoToDomain(dto: QuotationItemDto | InvoiceItemDto): LineItem {
  return {
    id: dto.id,
    description: dto.description,
    quantity: scaledToNumber(dto.quantityScaled, 6),
    unitPrice: scaledToNumber(dto.unitPriceScaled, 6),
    total: scaledToNumber(dto.totalMinor, 2),
  };
}

function mapLineItemsToInput(items: LineItem[]): LineItemInput[] {
  return (items ?? []).map((item, idx) => ({
    id: item.id || generateId('item'),
    sortOrder: toSafeInt64(idx),
    description: item.description,
    quantityScaled: strictDecimalToScaledInt64(item.quantity, 6, `items[${idx}].quantity`),
    unitPriceScaled: strictDecimalToScaledInt64(item.unitPrice, 6, `items[${idx}].unitPrice`),
    totalMinor: strictDecimalToScaledInt64(item.total, 2, `items[${idx}].total`),
  }));
}

function mapPaymentDtoToDomain(dto: PaymentDto): PaymentRecord {
  return {
    id: dto.id,
    invoiceId: dto.invoiceId,
    amount: scaledToNumber(dto.amountMinor, 2),
    paymentDate: dto.paymentDate,
    paymentMethod: dto.paymentMethod,
    reference: dto.reference ?? undefined,
    notes: dto.notes ?? undefined,
    recordedAt: dto.recordedAt,
  };
}

function mapActivityDtoToDomain(dto: ActivityLogDto): ActivityLog {
  return {
    id: dto.id,
    type: dto.type,
    title: dto.title,
    description: dto.description,
    timestamp: dto.timestamp,
    referenceId: dto.referenceId ?? undefined,
  };
}

function hydrateSnapshotBusinessProfile(
  rawJson: string,
  fallbackProfile: BusinessProfile
): BusinessProfile {
  const parsed = parseJsonObject<Partial<BusinessProfile>>(rawJson, {});
  const hydrated: BusinessProfile = {
    ...fallbackProfile,
    ...parsed,
    bankDetails: {
      ...fallbackProfile.bankDetails,
      ...(isPlainObject(parsed.bankDetails) ? parsed.bankDetails : {}),
    },
  };
  if (!hydrated.logoUrl && hydrated.id === fallbackProfile.id && fallbackProfile.logoUrl) {
    hydrated.logoUrl = fallbackProfile.logoUrl;
  }
  return hydrated;
}

function hydrateSnapshotClient(rawJson: string): Client {
  const parsed = parseJsonObject<Partial<Client>>(rawJson, {});
  return {
    id: typeof parsed.id === 'string' ? parsed.id : '',
    name: typeof parsed.name === 'string' ? parsed.name : '',
    companyName: typeof parsed.companyName === 'string' ? parsed.companyName : undefined,
    email: typeof parsed.email === 'string' ? parsed.email : '',
    phone: typeof parsed.phone === 'string' ? parsed.phone : '',
    address: typeof parsed.address === 'string' ? parsed.address : '',
    city: typeof parsed.city === 'string' ? parsed.city : undefined,
    country: typeof parsed.country === 'string' ? parsed.country : undefined,
    vatNumber: typeof parsed.vatNumber === 'string' ? parsed.vatNumber : undefined,
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  };
}

function mapQuotationDtoToDomain(dto: QuotationDto, activeProfile: BusinessProfile): Quotation {
  const discountType: DiscountType = dto.discountType;
  const discountValue =
    discountType === 'percentage'
      ? scaledToNumber(dto.discountPercentagePpm, 4)
      : scaledToNumber(dto.discountFixedMinor, 2);

  return {
    id: dto.id,
    quotationNumber: dto.quotationNumber,
    clientId: dto.clientId ?? '',
    clientSnapshot: hydrateSnapshotClient(dto.clientSnapshotJson),
    businessSnapshot: hydrateSnapshotBusinessProfile(dto.businessSnapshotJson, activeProfile),
    issueDate: dto.issueDate,
    expiryDate: dto.expiryDate ?? '',
    items: (dto.items ?? []).map(mapLineItemDtoToDomain),
    subtotal: scaledToNumber(dto.subtotalMinor, 2),
    discountType,
    discountValue,
    discountAmount: scaledToNumber(dto.discountAmountMinor, 2),
    taxName: dto.taxName,
    taxRate: scaledToNumber(dto.taxRatePpm, 4),
    taxAmount: scaledToNumber(dto.taxAmountMinor, 2),
    grandTotal: scaledToNumber(dto.grandTotalMinor, 2),
    currency: dto.currency,
    currencySymbol: dto.currencySymbol,
    status: dto.status,
    preConversionStatus: dto.preConversionStatus ?? undefined,
    notes: dto.notes ?? '',
    terms: dto.terms ?? '',
    convertedInvoiceId: dto.convertedInvoiceId ?? undefined,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function mapInvoiceDtoToDomain(dto: InvoiceDto, activeProfile: BusinessProfile): Invoice {
  const discountType: DiscountType = dto.discountType;
  const discountValue =
    discountType === 'percentage'
      ? scaledToNumber(dto.discountPercentagePpm, 4)
      : scaledToNumber(dto.discountFixedMinor, 2);

  return {
    id: dto.id,
    invoiceNumber: dto.invoiceNumber,
    quotationId: dto.quotationId ?? undefined,
    clientId: dto.clientId ?? '',
    clientSnapshot: hydrateSnapshotClient(dto.clientSnapshotJson),
    businessSnapshot: hydrateSnapshotBusinessProfile(dto.businessSnapshotJson, activeProfile),
    issueDate: dto.issueDate,
    dueDate: dto.dueDate ?? '',
    items: (dto.items ?? []).map(mapLineItemDtoToDomain),
    subtotal: scaledToNumber(dto.subtotalMinor, 2),
    discountType,
    discountValue,
    discountAmount: scaledToNumber(dto.discountAmountMinor, 2),
    taxName: dto.taxName,
    taxRate: scaledToNumber(dto.taxRatePpm, 4),
    taxAmount: scaledToNumber(dto.taxAmountMinor, 2),
    grandTotal: scaledToNumber(dto.grandTotalMinor, 2),
    amountPaid: scaledToNumber(dto.amountPaidMinor, 2),
    outstandingBalance: scaledToNumber(dto.outstandingBalanceMinor, 2),
    currency: dto.currency,
    currencySymbol: dto.currencySymbol,
    status: dto.status,
    notes: dto.notes ?? '',
    terms: dto.terms ?? '',
    paymentInstructions: dto.paymentInstructions ?? '',
    payments: (dto.payments ?? []).map(mapPaymentDtoToDomain),
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function inferActivityReferenceType(type: NewActivityInput['type']): string | null {
  switch (type) {
    case 'quote_created':
    case 'quote_converted':
    case 'quote_status':
      return 'quotation';
    case 'invoice_created':
    case 'payment_recorded':
    case 'invoice_status':
      return 'invoice';
    case 'client_created':
      return 'client';
    case 'settings_updated':
      return 'business';
    default:
      return null;
  }
}

function buildSnapshotForWorkspaceInput(
  rawData: {
    profile: unknown;
    clients: unknown;
    quotations?: unknown;
    invoices?: unknown;
    activities?: unknown;
  },
  nowIso: string
): RawLegacyStorageSnapshot {
  const serializedByKey: Record<string, string> = {
    bizora_business_profile_v1: JSON.stringify(rawData.profile),
    bizora_clients_v1: JSON.stringify(rawData.clients ?? []),
    bizora_quotations_v1: JSON.stringify(rawData.quotations ?? []),
    bizora_invoices_v1: JSON.stringify(rawData.invoices ?? []),
    bizora_activities_v1: JSON.stringify(rawData.activities ?? []),
    bizora_has_initialized_v1: 'true',
  };

  return {
    capturedAt: nowIso,
    source: 'backupJson',
    entries: LEGACY_STORAGE_KEYS.map((key) => {
      const rawValue = Object.prototype.hasOwnProperty.call(serializedByKey, key)
        ? serializedByKey[key]
        : null;
      return {
        key,
        present: rawValue !== null,
        presentInLocalStorage: false,
        presentInMemoryFallback: rawValue !== null,
        rawValue,
      };
    }),
  };
}

/**
 * Desktop SQLite persistence adapter.
 *
 * Delegates all operations exclusively through Tauri's typed SQLite IPC bridge
 * (`DesktopDatabaseService`). Never touches LocalStorage, never executes SQL in TypeScript,
 * and performs zero side effects on construction.
 */
export class SqlitePersistenceAdapter implements PersistenceAdapter {
  public readonly backend = 'sqlite' as const;
  public readonly capabilities: PersistenceCapabilities = {
    backend: 'sqlite',
    isAsync: true,
    supportsStandaloneAssets: true,
    supportsArbitrarySettings: true,
    supportsAtomicWorkspaceReplace: true,
  };

  private readonly bridge: SqlitePersistenceBridge;
  private activeBusinessId: string | null;
  private readonly now: () => string;

  constructor(options?: SqlitePersistenceAdapterOptions) {
    this.bridge = options?.bridge ?? DEFAULT_SQLITE_BRIDGE;
    this.activeBusinessId = options?.activeBusinessId ?? null;
    this.now = options?.now ?? (() => new Date().toISOString());
  }

  private async findActiveBusiness(): Promise<BusinessDto | null> {
    if (this.activeBusinessId) {
      const byId = await this.bridge.getBusinessById(this.activeBusinessId);
      if (byId) return byId;
      this.activeBusinessId = null;
    }

    const businesses = await this.bridge.getBusinesses(null);
    if (businesses.length === 0) {
      return null;
    }
    this.activeBusinessId = businesses[0].id;
    return businesses[0];
  }

  private async requireActiveBusiness(): Promise<BusinessDto> {
    const business = await this.findActiveBusiness();
    if (!business) {
      throw new PersistenceError(
        'WORKSPACE_NOT_INITIALIZED',
        'No SQLite business workspace exists yet. Initialize or restore a workspace before accessing records.'
      );
    }
    return business;
  }

  private async hydrateBusinessProfile(dto: BusinessDto): Promise<BusinessProfile> {
    let resolvedLogoUrl = dto.logoUrlFallback || '';
    if (dto.logoAssetId) {
      const asset = await this.bridge.getBusinessAssetById(dto.logoAssetId);
      resolvedLogoUrl = resolveAssetUrl(asset, dto.logoUrlFallback);
    }
    return mapBusinessDtoToDomain(dto, resolvedLogoUrl);
  }

  private async ensureLogoAssetForUrl(
    businessId: string,
    rawLogoUrl: string | undefined
  ): Promise<{ assetId: string | null; fallbackUrl: string }> {
    const trimmed = (rawLogoUrl ?? '').trim();
    if (!trimmed) {
      return { assetId: null, fallbackUrl: '' };
    }

    const isDataUrl = /^data:/i.test(trimmed);
    const isExternalUrl = /^https?:\/\//i.test(trimmed);
    if (!isDataUrl && !isExternalUrl) {
      return { assetId: null, fallbackUrl: trimmed };
    }

    const contentHash = sha256Hex(trimmed);
    const existingAssets = await this.bridge.getBusinessAssetsByBusiness(businessId);
    const existing = existingAssets.find((asset) => asset.contentHash === contentHash);
    if (existing) {
      return { assetId: existing.id, fallbackUrl: '' };
    }

    if (isDataUrl) {
      const meta = extractDataUrlMeta(trimmed);
      const created = await this.bridge.createBusinessAsset({
        id: generateId('ast'),
        businessId,
        contentHash,
        sourceType: 'data_url',
        mimeType: meta.mimeType,
        inlineData: trimmed,
        filePath: null,
        externalUrl: null,
        originalFilename: null,
        byteSize: meta.byteSize,
        createdAt: this.now(),
      });
      return { assetId: created.id, fallbackUrl: '' };
    }

    const created = await this.bridge.createBusinessAsset({
      id: generateId('ast'),
      businessId,
      contentHash,
      sourceType: 'external_url',
      mimeType: null,
      inlineData: null,
      filePath: null,
      externalUrl: trimmed,
      originalFilename: null,
      byteSize: null,
      createdAt: this.now(),
    });
    return { assetId: created.id, fallbackUrl: '' };
  }

  // Business Profile
  async getBusinessProfile(): Promise<BusinessProfile> {
    const business = await this.requireActiveBusiness();
    return this.hydrateBusinessProfile(business);
  }

  async saveBusinessProfile(profile: BusinessProfile): Promise<BusinessProfile> {
    const existing = await this.findActiveBusiness();
    const defaultTaxRatePpm = strictDecimalToScaledInt64(
      profile.defaultTaxRate,
      4,
      'defaultTaxRate'
    );
    const nextQuoteNumber = toSafeInt64(Math.max(1, Math.trunc(profile.nextQuoteNumber || 1)));
    const nextInvoiceNumber = toSafeInt64(Math.max(1, Math.trunc(profile.nextInvoiceNumber || 1)));

    if (!existing) {
      const profiles = await this.bridge.getLocalProfiles();
      let ownerProfileId = profiles[0]?.id ?? null;
      if (!ownerProfileId) {
        const createdProfile = await this.bridge.createLocalProfile({
          id: generateId('prof'),
          displayName: profile.name.trim() || 'Local User',
          email: profile.email.trim(),
          supabaseUserId: null,
          createdAt: this.now(),
          updatedAt: this.now(),
        });
        ownerProfileId = createdProfile.id;
      }

      const businessId = profile.id?.trim() || generateId('biz');
      const createdBusiness = await this.bridge.createBusiness({
        id: businessId,
        ownerProfileId,
        name: profile.name,
        tagline: profile.tagline,
        logoAssetId: null,
        logoUrlFallback: /^data:|^https?:\/\//i.test((profile.logoUrl ?? '').trim())
          ? ''
          : (profile.logoUrl ?? '').trim(),
        email: profile.email,
        phone: profile.phone,
        address: profile.address,
        city: profile.city,
        country: profile.country,
        postalCode: profile.postalCode ?? null,
        website: profile.website ?? null,
        taxNumber: profile.taxNumber ?? null,
        registrationNumber: profile.registrationNumber ?? null,
        defaultCurrency: profile.defaultCurrency,
        currencySymbol: profile.currencySymbol,
        defaultTaxName: profile.defaultTaxName,
        defaultTaxRatePpm,
        isTaxEnabled: profile.isTaxEnabled,
        quotePrefix: profile.quotePrefix,
        invoicePrefix: profile.invoicePrefix,
        nextQuoteNumber,
        nextInvoiceNumber,
        defaultTermsQuotation: profile.defaultTermsQuotation,
        defaultTermsInvoice: profile.defaultTermsInvoice,
        defaultNotes: profile.defaultNotes,
        bankName: profile.bankDetails.bankName,
        accountName: profile.bankDetails.accountName,
        accountNumber: profile.bankDetails.accountNumber,
        branchCode: profile.bankDetails.branchCode,
        accountType: profile.bankDetails.accountType ?? null,
        swiftCode: profile.bankDetails.swiftCode ?? null,
        createdAt: this.now(),
        updatedAt: this.now(),
      });

      this.activeBusinessId = createdBusiness.id;

      let finalBusiness = createdBusiness;
      const logoAsset = await this.ensureLogoAssetForUrl(createdBusiness.id, profile.logoUrl);
      if (logoAsset.assetId) {
        finalBusiness = await this.bridge.updateBusiness({
          id: createdBusiness.id,
          ownerProfileId: createdBusiness.ownerProfileId,
          name: createdBusiness.name,
          tagline: createdBusiness.tagline,
          logoAssetId: logoAsset.assetId,
          logoUrlFallback: logoAsset.fallbackUrl,
          email: createdBusiness.email,
          phone: createdBusiness.phone,
          address: createdBusiness.address,
          city: createdBusiness.city,
          country: createdBusiness.country,
          postalCode: createdBusiness.postalCode,
          website: createdBusiness.website,
          taxNumber: createdBusiness.taxNumber,
          registrationNumber: createdBusiness.registrationNumber,
          defaultCurrency: createdBusiness.defaultCurrency,
          currencySymbol: createdBusiness.currencySymbol,
          defaultTaxName: createdBusiness.defaultTaxName,
          defaultTaxRatePpm: createdBusiness.defaultTaxRatePpm,
          isTaxEnabled: createdBusiness.isTaxEnabled,
          quotePrefix: createdBusiness.quotePrefix,
          invoicePrefix: createdBusiness.invoicePrefix,
          nextQuoteNumber: createdBusiness.nextQuoteNumber,
          nextInvoiceNumber: createdBusiness.nextInvoiceNumber,
          defaultTermsQuotation: createdBusiness.defaultTermsQuotation,
          defaultTermsInvoice: createdBusiness.defaultTermsInvoice,
          defaultNotes: createdBusiness.defaultNotes,
          bankName: createdBusiness.bankName,
          accountName: createdBusiness.accountName,
          accountNumber: createdBusiness.accountNumber,
          branchCode: createdBusiness.branchCode,
          accountType: createdBusiness.accountType,
          swiftCode: createdBusiness.swiftCode,
        });
      }

      await this.addActivity({
        type: 'settings_updated',
        title: 'Business Profile Updated',
        description: `Settings updated for ${profile.name}`,
        referenceId: finalBusiness.id,
      });

      return this.hydrateBusinessProfile(finalBusiness);
    }

    const logoAsset = await this.ensureLogoAssetForUrl(existing.id, profile.logoUrl);
    const updated = await this.bridge.updateBusiness({
      id: existing.id,
      ownerProfileId: existing.ownerProfileId,
      name: profile.name,
      tagline: profile.tagline,
      logoAssetId: logoAsset.assetId,
      logoUrlFallback: logoAsset.fallbackUrl,
      email: profile.email,
      phone: profile.phone,
      address: profile.address,
      city: profile.city,
      country: profile.country,
      postalCode: profile.postalCode ?? null,
      website: profile.website ?? null,
      taxNumber: profile.taxNumber ?? null,
      registrationNumber: profile.registrationNumber ?? null,
      defaultCurrency: profile.defaultCurrency,
      currencySymbol: profile.currencySymbol,
      defaultTaxName: profile.defaultTaxName,
      defaultTaxRatePpm,
      isTaxEnabled: profile.isTaxEnabled,
      quotePrefix: profile.quotePrefix,
      invoicePrefix: profile.invoicePrefix,
      nextQuoteNumber,
      nextInvoiceNumber,
      defaultTermsQuotation: profile.defaultTermsQuotation,
      defaultTermsInvoice: profile.defaultTermsInvoice,
      defaultNotes: profile.defaultNotes,
      bankName: profile.bankDetails.bankName,
      accountName: profile.bankDetails.accountName,
      accountNumber: profile.bankDetails.accountNumber,
      branchCode: profile.bankDetails.branchCode,
      accountType: profile.bankDetails.accountType ?? null,
      swiftCode: profile.bankDetails.swiftCode ?? null,
    });

    await this.addActivity({
      type: 'settings_updated',
      title: 'Business Profile Updated',
      description: `Settings updated for ${profile.name}`,
      referenceId: updated.id,
    });

    return this.hydrateBusinessProfile(updated);
  }

  // Business Assets
  async getBusinessAssets(): Promise<BusinessAssetDto[]> {
    const business = await this.findActiveBusiness();
    if (!business) return [];
    return this.bridge.getBusinessAssetsByBusiness(business.id);
  }

  async getBusinessAssetById(id: string): Promise<BusinessAssetDto | null> {
    return this.bridge.getBusinessAssetById(id);
  }

  async saveBusinessAsset(input: SaveBusinessAssetInput): Promise<BusinessAssetDto> {
    const businessId = input.businessId ?? (await this.requireActiveBusiness()).id;
    return this.bridge.createBusinessAsset({
      ...input,
      businessId,
    });
  }

  async deleteBusinessAsset(id: string): Promise<void> {
    await this.bridge.deleteBusinessAsset(id);
  }

  // Clients
  async getClients(): Promise<Client[]> {
    const business = await this.findActiveBusiness();
    if (!business) return [];
    const dtos = await this.bridge.getClientsByBusiness(business.id);
    return dtos.map(mapClientDtoToDomain);
  }

  async getClientById(id: string): Promise<Client | null> {
    const dto = await this.bridge.getClientById(id);
    return dto ? mapClientDtoToDomain(dto) : null;
  }

  async saveClient(client: SaveClientInput): Promise<Client> {
    const business = await this.requireActiveBusiness();
    const callerSuppliedId = Boolean(client.id && client.id.trim());

    if (callerSuppliedId && client.id) {
      const existing = await this.bridge.getClientById(client.id);
      if (existing) {
        const updated = await this.bridge.updateClient({
          id: existing.id,
          businessId: business.id,
          name: client.name,
          companyName: client.companyName ?? null,
          email: client.email,
          phone: client.phone ?? '',
          address: client.address ?? '',
          city: client.city ?? null,
          country: client.country ?? null,
          vatNumber: client.vatNumber ?? null,
          notes: client.notes ?? null,
        });
        return mapClientDtoToDomain(updated);
      }
    }

    const newId = callerSuppliedId && client.id ? client.id : generateId('cli');
    const created = await this.bridge.createClient({
      id: newId,
      businessId: business.id,
      name: client.name,
      companyName: client.companyName ?? null,
      email: client.email,
      phone: client.phone ?? '',
      address: client.address ?? '',
      city: client.city ?? null,
      country: client.country ?? null,
      vatNumber: client.vatNumber ?? null,
      notes: client.notes ?? null,
      createdAt: client.createdAt ?? this.now(),
      updatedAt: client.updatedAt ?? this.now(),
    });

    if (!callerSuppliedId) {
      await this.addActivity({
        type: 'client_created',
        title: `Client Added: ${created.name}`,
        description: created.companyName ? `Company: ${created.companyName}` : `Email: ${created.email}`,
        referenceId: created.id,
      });
    }

    return mapClientDtoToDomain(created);
  }

  async deleteClient(id: string): Promise<boolean> {
    const existing = await this.bridge.getClientById(id);
    if (!existing) return false;
    await this.bridge.deleteClient(id);
    return true;
  }

  // Quotations
  async getQuotations(): Promise<Quotation[]> {
    const business = await this.findActiveBusiness();
    if (!business) return [];
    const activeProfile = await this.hydrateBusinessProfile(business);
    const dtos = await this.bridge.getQuotationsByBusiness(business.id);
    return dtos.map((dto) => mapQuotationDtoToDomain(dto, activeProfile));
  }

  async getQuotationById(id: string): Promise<Quotation | null> {
    const dto = await this.bridge.getQuotationById(id);
    if (!dto) return null;
    const business = await this.bridge.getBusinessById(dto.businessId);
    const activeProfile = business
      ? await this.hydrateBusinessProfile(business)
      : dto.businessSnapshotJson
        ? hydrateSnapshotBusinessProfile(dto.businessSnapshotJson, initialBusinessProfile)
        : initialBusinessProfile;
    return mapQuotationDtoToDomain(dto, activeProfile);
  }

  async saveQuotation(quotation: Quotation): Promise<Quotation> {
    const business = await this.requireActiveBusiness();
    const activeProfile = await this.hydrateBusinessProfile(business);
    const trimmedNumber = (quotation.quotationNumber || '').trim();
    if (!trimmedNumber) {
      throw new PersistenceError('VALIDATION_ERROR', 'Quotation number is required.');
    }

    if (quotation.businessSnapshot?.logoUrl) {
      await this.ensureLogoAssetForUrl(business.id, quotation.businessSnapshot.logoUrl);
    }

    const existing = await this.bridge.getQuotationById(quotation.id);
    const discountPercentagePpm =
      quotation.discountType === 'percentage'
        ? strictDecimalToScaledInt64(quotation.discountValue, 4, 'discountValue')
        : '0';
    const discountFixedMinor =
      quotation.discountType === 'fixed'
        ? strictDecimalToScaledInt64(quotation.discountValue, 2, 'discountValue')
        : '0';

    const commonFields = {
      businessId: business.id,
      clientId: quotation.clientId ? quotation.clientId : null,
      quotationNumber: trimmedNumber,
      clientSnapshotJson: JSON.stringify(quotation.clientSnapshot ?? {}),
      businessSnapshotJson: JSON.stringify(quotation.businessSnapshot ?? {}),
      issueDate: quotation.issueDate,
      expiryDate: quotation.expiryDate ? quotation.expiryDate : null,
      currency: quotation.currency,
      currencySymbol: quotation.currencySymbol,
      subtotalMinor: strictDecimalToScaledInt64(quotation.subtotal, 2, 'subtotal'),
      discountType: quotation.discountType,
      discountPercentagePpm,
      discountFixedMinor,
      discountAmountMinor: strictDecimalToScaledInt64(quotation.discountAmount, 2, 'discountAmount'),
      taxName: quotation.taxName,
      taxRatePpm: strictDecimalToScaledInt64(quotation.taxRate, 4, 'taxRate'),
      taxAmountMinor: strictDecimalToScaledInt64(quotation.taxAmount, 2, 'taxAmount'),
      grandTotalMinor: strictDecimalToScaledInt64(quotation.grandTotal, 2, 'grandTotal'),
      status: quotation.status,
      preConversionStatus: quotation.preConversionStatus ?? null,
      notes: quotation.notes ?? null,
      terms: quotation.terms ?? null,
      convertedInvoiceId: quotation.convertedInvoiceId ?? null,
      items: mapLineItemsToInput(quotation.items),
    };

    if (existing) {
      const updated = await this.bridge.updateQuotation({
        id: quotation.id,
        ...commonFields,
      });
      return mapQuotationDtoToDomain(updated, activeProfile);
    }

    const created = await this.bridge.createQuotation({
      id: quotation.id || generateId('quo'),
      ...commonFields,
      createdAt: quotation.createdAt || this.now(),
      updatedAt: quotation.updatedAt || this.now(),
    });

    await this.addActivity({
      type: 'quote_created',
      title: `Quotation ${trimmedNumber} Created`,
      description: `For ${quotation.clientSnapshot?.name || 'Client'} (${quotation.currencySymbol} ${quotation.grandTotal.toLocaleString()})`,
      referenceId: created.id,
    });

    return mapQuotationDtoToDomain(created, activeProfile);
  }

  async deleteQuotation(id: string): Promise<boolean> {
    const existing = await this.bridge.getQuotationById(id);
    if (!existing) return false;
    await this.bridge.deleteQuotation(id);
    return true;
  }

  async isQuotationNumberTaken(quotationNumber: string, excludeId?: string): Promise<boolean> {
    const target = normalizeDocNumber(quotationNumber);
    if (!target) return false;
    const business = await this.findActiveBusiness();
    if (!business) return false;
    const quotes = await this.bridge.getQuotationsByBusiness(business.id);
    return quotes.some((q) => q.id !== excludeId && normalizeDocNumber(q.quotationNumber) === target);
  }

  async getNextAvailableQuoteNumber(): Promise<number> {
    const business = await this.requireActiveBusiness();
    const quotes = await this.bridge.getQuotationsByBusiness(business.id);
    const prefix = business.quotePrefix || 'QUO-';
    let candidate = Math.max(1, Number(business.nextQuoteNumber) || 1);

    const taken = new Set(quotes.map((q) => normalizeDocNumber(q.quotationNumber)));
    while (taken.has(normalizeDocNumber(formatDocNumber(prefix, candidate)))) {
      candidate += 1;
    }
    return candidate;
  }

  async commitUsedQuoteNumber(savedQuoteNumber: string): Promise<boolean> {
    const business = await this.requireActiveBusiness();
    const prefix = business.quotePrefix || 'QUO-';
    const currentNext = Math.max(1, Number(business.nextQuoteNumber) || 1);
    const parsed = parseSequentialDocNumber(savedQuoteNumber, prefix);

    if (parsed !== null && parsed >= currentNext) {
      await this.bridge.updateBusiness({
        id: business.id,
        ownerProfileId: business.ownerProfileId,
        name: business.name,
        tagline: business.tagline,
        logoAssetId: business.logoAssetId,
        logoUrlFallback: business.logoUrlFallback,
        email: business.email,
        phone: business.phone,
        address: business.address,
        city: business.city,
        country: business.country,
        postalCode: business.postalCode,
        website: business.website,
        taxNumber: business.taxNumber,
        registrationNumber: business.registrationNumber,
        defaultCurrency: business.defaultCurrency,
        currencySymbol: business.currencySymbol,
        defaultTaxName: business.defaultTaxName,
        defaultTaxRatePpm: business.defaultTaxRatePpm,
        isTaxEnabled: business.isTaxEnabled,
        quotePrefix: business.quotePrefix,
        invoicePrefix: business.invoicePrefix,
        nextQuoteNumber: toSafeInt64(parsed + 1),
        nextInvoiceNumber: business.nextInvoiceNumber,
        defaultTermsQuotation: business.defaultTermsQuotation,
        defaultTermsInvoice: business.defaultTermsInvoice,
        defaultNotes: business.defaultNotes,
        bankName: business.bankName,
        accountName: business.accountName,
        accountNumber: business.accountNumber,
        branchCode: business.branchCode,
        accountType: business.accountType,
        swiftCode: business.swiftCode,
      });
    }
    return true;
  }

  // Invoices
  async getInvoices(): Promise<Invoice[]> {
    const business = await this.findActiveBusiness();
    if (!business) return [];
    const activeProfile = await this.hydrateBusinessProfile(business);
    const dtos = await this.bridge.getInvoicesByBusiness(business.id);
    return dtos.map((dto) => mapInvoiceDtoToDomain(dto, activeProfile));
  }

  async getInvoiceById(id: string): Promise<Invoice | null> {
    const dto = await this.bridge.getInvoiceById(id);
    if (!dto) return null;
    const business = await this.bridge.getBusinessById(dto.businessId);
    const activeProfile = business
      ? await this.hydrateBusinessProfile(business)
      : hydrateSnapshotBusinessProfile(dto.businessSnapshotJson, initialBusinessProfile);
    return mapInvoiceDtoToDomain(dto, activeProfile);
  }

  async saveInvoice(invoice: Invoice): Promise<Invoice> {
    const business = await this.requireActiveBusiness();
    const activeProfile = await this.hydrateBusinessProfile(business);
    const trimmedNumber = (invoice.invoiceNumber || '').trim();
    if (!trimmedNumber) {
      throw new PersistenceError('VALIDATION_ERROR', 'Invoice number is required.');
    }

    if (invoice.businessSnapshot?.logoUrl) {
      await this.ensureLogoAssetForUrl(business.id, invoice.businessSnapshot.logoUrl);
    }

    const existing = await this.bridge.getInvoiceById(invoice.id);
    const discountPercentagePpm =
      invoice.discountType === 'percentage'
        ? strictDecimalToScaledInt64(invoice.discountValue, 4, 'discountValue')
        : '0';
    const discountFixedMinor =
      invoice.discountType === 'fixed'
        ? strictDecimalToScaledInt64(invoice.discountValue, 2, 'discountValue')
        : '0';

    const grandTotalMinor = strictDecimalToScaledInt64(invoice.grandTotal, 2, 'grandTotal');
    const commonFields = {
      businessId: business.id,
      clientId: invoice.clientId ? invoice.clientId : null,
      quotationId: invoice.quotationId ? invoice.quotationId : null,
      invoiceNumber: trimmedNumber,
      clientSnapshotJson: JSON.stringify(invoice.clientSnapshot ?? {}),
      businessSnapshotJson: JSON.stringify(invoice.businessSnapshot ?? {}),
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate ? invoice.dueDate : null,
      currency: invoice.currency,
      currencySymbol: invoice.currencySymbol,
      subtotalMinor: strictDecimalToScaledInt64(invoice.subtotal, 2, 'subtotal'),
      discountType: invoice.discountType,
      discountPercentagePpm,
      discountFixedMinor,
      discountAmountMinor: strictDecimalToScaledInt64(invoice.discountAmount, 2, 'discountAmount'),
      taxName: invoice.taxName,
      taxRatePpm: strictDecimalToScaledInt64(invoice.taxRate, 4, 'taxRate'),
      taxAmountMinor: strictDecimalToScaledInt64(invoice.taxAmount, 2, 'taxAmount'),
      grandTotalMinor,
      notes: invoice.notes ?? null,
      terms: invoice.terms ?? null,
      paymentInstructions: invoice.paymentInstructions ?? null,
      items: mapLineItemsToInput(invoice.items),
    };

    if (existing) {
      const updated = await this.bridge.updateInvoice({
        id: invoice.id,
        ...commonFields,
        amountPaidMinor: strictDecimalToScaledInt64(invoice.amountPaid ?? 0, 2, 'amountPaid'),
        outstandingBalanceMinor: strictDecimalToScaledInt64(
          invoice.outstandingBalance ?? invoice.grandTotal,
          2,
          'outstandingBalance'
        ),
        status: invoice.status,
      });
      return mapInvoiceDtoToDomain(updated, activeProfile);
    }

    const initialPayments = invoice.payments ?? [];
    const initialStatus =
      invoice.status === 'paid' || invoice.status === 'partially_paid'
        ? 'sent'
        : invoice.status;

    const created = await this.bridge.createInvoice({
      id: invoice.id || generateId('inv'),
      ...commonFields,
      amountPaidMinor: '0',
      outstandingBalanceMinor: grandTotalMinor,
      status: initialStatus,
      createdAt: invoice.createdAt || this.now(),
      updatedAt: invoice.updatedAt || this.now(),
    });

    for (const payment of initialPayments) {
      await this.bridge.createPayment({
        id: payment.id || generateId('pay'),
        businessId: business.id,
        invoiceId: created.id,
        amountMinor: strictDecimalToScaledInt64(payment.amount, 2, 'payment.amount'),
        paymentDate: payment.paymentDate,
        paymentMethod: payment.paymentMethod,
        reference: payment.reference ?? null,
        notes: payment.notes ?? null,
        recordedAt: payment.recordedAt || this.now(),
      });
    }

    const finalInvoice =
      initialPayments.length > 0
        ? (await this.bridge.getInvoiceById(created.id)) ?? created
        : created;

    await this.addActivity({
      type: 'invoice_created',
      title: `Invoice ${trimmedNumber} Created`,
      description: `For ${invoice.clientSnapshot?.name || 'Client'} (${invoice.currencySymbol} ${invoice.grandTotal.toLocaleString()})`,
      referenceId: finalInvoice.id,
    });

    return mapInvoiceDtoToDomain(finalInvoice, activeProfile);
  }

  async deleteInvoice(id: string): Promise<boolean> {
    const existing = await this.bridge.getInvoiceById(id);
    if (!existing) return false;
    await this.bridge.deleteInvoice(id);
    return true;
  }

  async isInvoiceNumberTaken(invoiceNumber: string, excludeId?: string): Promise<boolean> {
    const target = normalizeDocNumber(invoiceNumber);
    if (!target) return false;
    const business = await this.findActiveBusiness();
    if (!business) return false;
    const invoices = await this.bridge.getInvoicesByBusiness(business.id);
    return invoices.some((inv) => inv.id !== excludeId && normalizeDocNumber(inv.invoiceNumber) === target);
  }

  async getNextAvailableInvoiceNumber(): Promise<number> {
    const business = await this.requireActiveBusiness();
    const invoices = await this.bridge.getInvoicesByBusiness(business.id);
    const prefix = business.invoicePrefix || 'INV-';
    let candidate = Math.max(1, Number(business.nextInvoiceNumber) || 1);

    const taken = new Set(invoices.map((inv) => normalizeDocNumber(inv.invoiceNumber)));
    while (taken.has(normalizeDocNumber(formatDocNumber(prefix, candidate)))) {
      candidate += 1;
    }
    return candidate;
  }

  async commitUsedInvoiceNumber(savedInvoiceNumber: string): Promise<boolean> {
    const business = await this.requireActiveBusiness();
    const prefix = business.invoicePrefix || 'INV-';
    const currentNext = Math.max(1, Number(business.nextInvoiceNumber) || 1);
    const parsed = parseSequentialDocNumber(savedInvoiceNumber, prefix);

    if (parsed !== null && parsed >= currentNext) {
      await this.bridge.updateBusiness({
        id: business.id,
        ownerProfileId: business.ownerProfileId,
        name: business.name,
        tagline: business.tagline,
        logoAssetId: business.logoAssetId,
        logoUrlFallback: business.logoUrlFallback,
        email: business.email,
        phone: business.phone,
        address: business.address,
        city: business.city,
        country: business.country,
        postalCode: business.postalCode,
        website: business.website,
        taxNumber: business.taxNumber,
        registrationNumber: business.registrationNumber,
        defaultCurrency: business.defaultCurrency,
        currencySymbol: business.currencySymbol,
        defaultTaxName: business.defaultTaxName,
        defaultTaxRatePpm: business.defaultTaxRatePpm,
        isTaxEnabled: business.isTaxEnabled,
        quotePrefix: business.quotePrefix,
        invoicePrefix: business.invoicePrefix,
        nextQuoteNumber: business.nextQuoteNumber,
        nextInvoiceNumber: toSafeInt64(parsed + 1),
        defaultTermsQuotation: business.defaultTermsQuotation,
        defaultTermsInvoice: business.defaultTermsInvoice,
        defaultNotes: business.defaultNotes,
        bankName: business.bankName,
        accountName: business.accountName,
        accountNumber: business.accountNumber,
        branchCode: business.branchCode,
        accountType: business.accountType,
        swiftCode: business.swiftCode,
      });
    }
    return true;
  }

  // Payments
  async getPaymentsByInvoice(invoiceId: string): Promise<PaymentRecord[]> {
    const dtos = await this.bridge.getPaymentsByInvoice(invoiceId);
    return dtos.map(mapPaymentDtoToDomain);
  }

  async getPaymentsByBusiness(): Promise<PaymentRecord[]> {
    const business = await this.findActiveBusiness();
    if (!business) return [];
    const dtos = await this.bridge.getPaymentsByBusiness(business.id);
    return dtos.map(mapPaymentDtoToDomain);
  }

  async recordPayment(invoiceId: string, paymentData: NewPaymentInput): Promise<Invoice | undefined> {
    const existingDto = await this.bridge.getInvoiceById(invoiceId);
    if (!existingDto) return undefined;

    const amountMinor = strictDecimalToScaledInt64(paymentData.amount, 2, 'amount');
    const createdPayment = await this.bridge.createPayment({
      id: generateId('pay'),
      businessId: existingDto.businessId,
      invoiceId: existingDto.id,
      amountMinor,
      paymentDate: paymentData.paymentDate || this.now().split('T')[0],
      paymentMethod: paymentData.paymentMethod,
      reference: paymentData.reference ?? null,
      notes: paymentData.notes ?? null,
      recordedAt: this.now(),
    });

    const refreshedDto = await this.bridge.getInvoiceById(invoiceId);
    if (!refreshedDto) return undefined;

    const business = await this.bridge.getBusinessById(refreshedDto.businessId);
    const activeProfile = business
      ? await this.hydrateBusinessProfile(business)
      : hydrateSnapshotBusinessProfile(refreshedDto.businessSnapshotJson, initialBusinessProfile);
    const refreshed = mapInvoiceDtoToDomain(refreshedDto, activeProfile);

    const paymentAmount = scaledToNumber(createdPayment.amountMinor, 2);
    await this.addActivity({
      type: 'payment_recorded',
      title: `Payment of ${refreshed.currencySymbol} ${paymentAmount.toLocaleString()} Recorded`,
      description: `Applied to ${refreshed.invoiceNumber}. Remaining balance: ${refreshed.currencySymbol} ${refreshed.outstandingBalance.toLocaleString()}`,
      referenceId: refreshed.id,
    });

    return refreshed;
  }

  async deletePayment(paymentId: string): Promise<void> {
    await this.bridge.deletePayment(paymentId);
  }

  // Activity Logs
  async getActivities(limit?: number): Promise<ActivityLog[]> {
    const business = await this.findActiveBusiness();
    if (!business) return [];
    const normalizedLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : null;
    const dtos = await this.bridge.getActivityLogsByBusiness(business.id, normalizedLimit);
    return dtos.map(mapActivityDtoToDomain);
  }

  async addActivity(activity: NewActivityInput): Promise<ActivityLog> {
    const business = await this.requireActiveBusiness();
    const dto = await this.bridge.createActivityLog({
      id: generateId('act'),
      businessId: business.id,
      type: activity.type,
      title: activity.title,
      description: activity.description,
      timestamp: this.now(),
      referenceId: activity.referenceId ?? null,
      referenceType: inferActivityReferenceType(activity.type),
      actorLocalProfileId: business.ownerProfileId,
    });
    return mapActivityDtoToDomain(dto);
  }

  // Application Settings
  async getAppSetting<T = unknown>(key: string): Promise<T | null> {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new PersistenceError('VALIDATION_ERROR', 'Setting key cannot be empty.');
    }
    const dto = await this.bridge.getAppSetting(trimmed);
    if (!dto) return null;
    try {
      return JSON.parse(dto.valueJson) as T;
    } catch {
      return dto.valueJson as unknown as T;
    }
  }

  async saveAppSetting(key: string, value: unknown): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new PersistenceError('VALIDATION_ERROR', 'Setting key cannot be empty.');
    }
    if (isProtectedSettingKey(trimmed)) {
      throw new PersistenceError(
        'PROTECTED_SETTING',
        `Setting key '${trimmed}' is managed by migration safeguards and cannot be overwritten directly.`
      );
    }
    if (value === undefined) {
      throw new PersistenceError(
        'VALIDATION_ERROR',
        'Setting value cannot be undefined; use deleteAppSetting instead.'
      );
    }
    await this.bridge.saveAppSetting({
      key: trimmed,
      valueJson: JSON.stringify(value),
      updatedAt: this.now(),
    });
  }

  async deleteAppSetting(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new PersistenceError('VALIDATION_ERROR', 'Setting key cannot be empty.');
    }
    if (isProtectedSettingKey(trimmed)) {
      throw new PersistenceError(
        'PROTECTED_SETTING',
        `Setting key '${trimmed}' is managed by migration safeguards and cannot be deleted directly.`
      );
    }
    await this.bridge.deleteAppSetting(trimmed);
  }

  // Workspace Backup & Lifecycle
  async exportBackupJson(): Promise<string> {
    const [profile, clients, quotations, invoices, activities] = await Promise.all([
      this.getBusinessProfile(),
      this.getClients(),
      this.getQuotations(),
      this.getInvoices(),
      this.getActivities(),
    ]);

    return JSON.stringify(
      {
        profile,
        clients,
        quotations,
        invoices,
        activities,
        exportedAt: this.now(),
        version: '1.0',
      },
      null,
      2
    );
  }

  async importBackupJson(jsonString: string): Promise<BackupImportResult> {
    let data: unknown;
    try {
      data = JSON.parse(jsonString);
    } catch {
      return {
        ok: false,
        error: 'The selected file is not valid JSON.',
        persisted: false,
      };
    }

    if (!isPlainObject(data)) {
      return {
        ok: false,
        error: 'The selected file does not contain a valid Bizora backup object.',
        persisted: false,
      };
    }
    if (!isPlainObject(data.profile) || typeof data.profile.name !== 'string') {
      return {
        ok: false,
        error: 'Backup is missing a valid business profile.',
        persisted: false,
      };
    }
    if (
      !Array.isArray(data.clients) ||
      !data.clients.every(
        (c) => isPlainObject(c) && typeof c.id === 'string' && typeof c.name === 'string'
      )
    ) {
      return {
        ok: false,
        error: 'Backup contains missing or malformed client records.',
        persisted: false,
      };
    }
    if (
      data.quotations !== undefined &&
      (!Array.isArray(data.quotations) ||
        !data.quotations.every(
          (q) =>
            isPlainObject(q) &&
            typeof q.id === 'string' &&
            typeof q.quotationNumber === 'string'
        ))
    ) {
      return {
        ok: false,
        error: 'Backup contains malformed quotation records.',
        persisted: false,
      };
    }
    if (
      data.invoices !== undefined &&
      (!Array.isArray(data.invoices) ||
        !data.invoices.every(
          (inv) =>
            isPlainObject(inv) &&
            typeof inv.id === 'string' &&
            typeof inv.invoiceNumber === 'string'
        ))
    ) {
      return {
        ok: false,
        error: 'Backup contains malformed invoice records.',
        persisted: false,
      };
    }
    if (
      data.activities !== undefined &&
      (!Array.isArray(data.activities) ||
        !data.activities.every(
          (act) => isPlainObject(act) && typeof act.id === 'string' && typeof act.title === 'string'
        ))
    ) {
      return {
        ok: false,
        error: 'Backup contains malformed activity log records.',
        persisted: false,
      };
    }

    const nowIso = this.now();
    const snapshot = buildSnapshotForWorkspaceInput(
      {
        profile: data.profile,
        clients: data.clients,
        quotations: data.quotations ?? [],
        invoices: data.invoices ?? [],
        activities: data.activities ?? [],
      },
      nowIso
    );
    const prepared = prepareMigrationPayload(snapshot, { nowIso });

    if (prepared.hasErrors || !prepared.payload) {
      const firstError = prepared.diagnostics.find((d) => d.severity === 'error');
      return {
        ok: false,
        error: firstError?.message ?? 'Could not validate the selected backup file.',
        persisted: false,
      };
    }

    const result = await this.bridge.replaceDesktopWorkspace({
      source: 'backup_import',
      localProfile: prepared.payload.localProfile,
      business: prepared.payload.business,
      assets: prepared.payload.assets,
      clients: prepared.payload.clients,
      quotations: prepared.payload.quotations,
      invoices: prepared.payload.invoices,
      payments: prepared.payload.payments,
      activityLogs: prepared.payload.activityLogs,
      settings: prepared.payload.settings,
    });
    this.activeBusinessId = result.businessId;

    return {
      ok: true,
      persisted: true,
    };
  }

  async resetToDemoData(): Promise<void> {
    const nowIso = this.now();
    const snapshot = buildSnapshotForWorkspaceInput(
      {
        profile: initialBusinessProfile,
        clients: initialClients,
        quotations: initialQuotations,
        invoices: initialInvoices,
        activities: initialActivities,
      },
      nowIso
    );
    const prepared = prepareMigrationPayload(snapshot, { nowIso });
    if (prepared.hasErrors || !prepared.payload) {
      const firstError = prepared.diagnostics.find((d) => d.severity === 'error');
      throw new PersistenceError(
        'VALIDATION_ERROR',
        firstError?.message ?? 'Failed to prepare demo workspace payload.'
      );
    }

    const result = await this.bridge.replaceDesktopWorkspace({
      source: 'reset_to_demo',
      localProfile: prepared.payload.localProfile,
      business: prepared.payload.business,
      assets: prepared.payload.assets,
      clients: prepared.payload.clients,
      quotations: prepared.payload.quotations,
      invoices: prepared.payload.invoices,
      payments: prepared.payload.payments,
      activityLogs: prepared.payload.activityLogs,
      settings: prepared.payload.settings,
    });
    this.activeBusinessId = result.businessId;
  }

  async clearAllData(): Promise<void> {
    const nowIso = this.now();
    const starterProfile: BusinessProfile = {
      ...initialBusinessProfile,
      name: 'My Business',
      tagline: '',
      logoUrl: '',
      email: '',
      phone: '',
      address: '',
      city: '',
      country: '',
      postalCode: '',
      website: '',
      taxNumber: '',
      registrationNumber: '',
      nextQuoteNumber: 1,
      nextInvoiceNumber: 1,
      defaultNotes: '',
      bankDetails: {
        bankName: '',
        accountName: '',
        accountNumber: '',
        branchCode: '',
        accountType: '',
        swiftCode: '',
      },
      updatedAt: nowIso,
    };
    const starterActivity: ActivityLog = {
      id: generateId('act'),
      type: 'settings_updated',
      title: 'Workspace Initialized',
      description: 'Clean slate started.',
      timestamp: nowIso,
    };

    const snapshot = buildSnapshotForWorkspaceInput(
      {
        profile: starterProfile,
        clients: [],
        quotations: [],
        invoices: [],
        activities: [starterActivity],
      },
      nowIso
    );
    const prepared = prepareMigrationPayload(snapshot, { nowIso });
    if (prepared.hasErrors || !prepared.payload) {
      const firstError = prepared.diagnostics.find((d) => d.severity === 'error');
      throw new PersistenceError(
        'VALIDATION_ERROR',
        firstError?.message ?? 'Failed to prepare clean workspace payload.'
      );
    }

    const result = await this.bridge.replaceDesktopWorkspace({
      source: 'clear_all_data',
      localProfile: prepared.payload.localProfile,
      business: prepared.payload.business,
      assets: prepared.payload.assets,
      clients: prepared.payload.clients,
      quotations: prepared.payload.quotations,
      invoices: prepared.payload.invoices,
      payments: prepared.payload.payments,
      activityLogs: prepared.payload.activityLogs,
      settings: prepared.payload.settings,
    });
    this.activeBusinessId = result.businessId;
  }

  /**
   * Explicitly wipes all business-scoped tables on desktop SQLite (without creating
   * a starter business row) via the Step 1 `clear_desktop_workspace` command.
   */
  async wipeWorkspaceTables(source?: string | null): Promise<WorkspaceLifecycleResultDto> {
    const result = await this.bridge.clearDesktopWorkspace(source ?? 'wipe_workspace');
    this.activeBusinessId = result.businessId;
    return result;
  }
}
