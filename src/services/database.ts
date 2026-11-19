import { invoke, isTauri } from '@tauri-apps/api/core';

export interface DatabaseStatus {
  initialized: boolean;
  databasePath: string;
  schemaVersion: number;
  sqliteVersion: string;
  journalMode: string;
  foreignKeysEnabled: boolean;
  busyTimeoutMs: number;
  integrityOk: boolean;
  foreignKeyCheckPassed: boolean;
}

/**
 * Signed 64-bit integer encoded as a canonical base-10 string across Tauri IPC
 * so scaled values exceeding Number.MAX_SAFE_INTEGER never silently lose precision.
 */
export type SafeInt64 = string;

export type DatabaseErrorCode =
  | 'UNSUPPORTED_ENVIRONMENT'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'DUPLICATE_ID'
  | 'DUPLICATE_DOCUMENT_NUMBER'
  | 'UNIQUE_CONSTRAINT'
  | 'FOREIGN_KEY_VIOLATION'
  | 'NOT_INITIALIZED'
  | 'NUMERIC_OVERFLOW'
  | 'TRANSACTION_FAILED'
  | 'QUERY_FAILED'
  | 'DATABASE_UNAVAILABLE'
  | 'DATABASE_CONFIGURATION_ERROR'
  | 'INTERNAL_ERROR';

export interface SerializedCommandError {
  code: DatabaseErrorCode | string;
  message: string;
  field?: string;
}

export class DatabaseCommandError extends Error {
  public readonly code: DatabaseErrorCode | string;
  public readonly field?: string;

  constructor(payload: SerializedCommandError) {
    super(payload.message);
    this.name = 'DatabaseCommandError';
    this.code = payload.code;
    this.field = payload.field;
  }
}

export function isDatabaseCommandError(error: unknown): error is DatabaseCommandError {
  return error instanceof DatabaseCommandError;
}

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

export function toSafeInt64(value: bigint | number | string): SafeInt64 {
  let normalized: bigint;
  if (typeof value === 'bigint') {
    normalized = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new DatabaseCommandError({
        code: 'INVALID_INPUT',
        message: 'Numeric value must be a finite safe integer; pass bigint or decimal string for larger values',
      });
    }
    normalized = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new DatabaseCommandError({
        code: 'INVALID_INPUT',
        message: 'SafeInt64 string must contain only optional leading minus and digits',
      });
    }
    normalized = BigInt(trimmed);
  }

  if (normalized < INT64_MIN || normalized > INT64_MAX) {
    throw new DatabaseCommandError({
      code: 'NUMERIC_OVERFLOW',
      message: 'Integer value exceeds signed 64-bit range',
    });
  }

  return normalized.toString(10);
}

const MAX_DECIMAL_SCALE = 30;

function validateScaleDecimals(decimals: number): void {
  if (
    typeof decimals !== 'number' ||
    !Number.isFinite(decimals) ||
    !Number.isInteger(decimals) ||
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_DECIMAL_SCALE
  ) {
    throw new DatabaseCommandError({
      code: 'INVALID_INPUT',
      field: 'decimals',
      message: `Decimal scale must be an integer between 0 and ${MAX_DECIMAL_SCALE}`,
    });
  }
}

export function parseSafeInt64(value: SafeInt64 | number | bigint): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new DatabaseCommandError({
        code: 'INVALID_INPUT',
        message: 'Cannot safely convert non-safe-integer number to BigInt',
      });
    }
    parsed = BigInt(value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new DatabaseCommandError({
        code: 'INVALID_INPUT',
        message: `Invalid SafeInt64 string '${value}'`,
      });
    }
    parsed = BigInt(trimmed);
  } else {
    throw new DatabaseCommandError({
      code: 'INVALID_INPUT',
      message: 'SafeInt64 value must be a base-10 integer string, bigint, or safe integer',
    });
  }

  if (parsed < INT64_MIN || parsed > INT64_MAX) {
    throw new DatabaseCommandError({
      code: 'NUMERIC_OVERFLOW',
      message: 'Integer value exceeds signed 64-bit range',
    });
  }

  return parsed;
}

export function decimalToScaledInt64(decimalStr: string, decimals: number): SafeInt64 {
  validateScaleDecimals(decimals);
  if (typeof decimalStr !== 'string') {
    throw new DatabaseCommandError({
      code: 'INVALID_INPUT',
      message: 'Decimal value must be provided as a string',
    });
  }
  const trimmed = decimalStr.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new DatabaseCommandError({
      code: 'INVALID_INPUT',
      message: `Invalid decimal value '${decimalStr}'`,
    });
  }
  const negative = Boolean(match[1]);
  const whole = match[2];
  const fracRaw = match[3] ?? '';
  const scaleFactor = 10n ** BigInt(decimals);
  const padded = fracRaw.slice(0, decimals).padEnd(decimals, '0');
  const nextDigit = fracRaw.length > decimals ? Number(fracRaw[decimals]) : 0;

  let scaled = BigInt(whole) * scaleFactor + (padded ? BigInt(padded) : 0n);
  if (nextDigit >= 5) {
    scaled += 1n;
  }
  if (negative && scaled !== 0n) {
    scaled = -scaled;
  }
  return toSafeInt64(scaled);
}

export function scaledInt64ToDecimal(value: SafeInt64, decimals: number): string {
  validateScaleDecimals(decimals);
  const raw = parseSafeInt64(value);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole.toString()}${decimals > 0 ? `.${frac}` : ''}`;
}

function expandFiniteNumberToPlainDecimal(num: number): string {
  const str = String(num);
  if (!/[eE]/.test(str)) {
    return str;
  }
  const match = /^(-)?(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(str);
  if (!match) {
    throw new DatabaseCommandError({
      code: 'INVALID_INPUT',
      message: `Invalid numeric representation '${str}'`,
    });
  }
  const sign = match[1] ? '-' : '';
  const intPart = match[2];
  const fracPart = match[3] ?? '';
  const exp = Number.parseInt(match[4], 10);
  const digits = intPart + fracPart;
  const decimalPos = intPart.length + exp;

  if (decimalPos <= 0) {
    return `${sign}0.${'0'.repeat(-decimalPos)}${digits}`;
  }
  if (decimalPos >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalPos - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPos)}.${digits.slice(decimalPos)}`;
}

/**
 * Lossless decimal-to-SafeInt64 conversion for historical migration.
 * Never rounds, clamps, or truncates non-zero fractional digits past `decimals`.
 */
export function strictDecimalToScaledInt64(
  rawValue: unknown,
  decimals: number,
  fieldName?: string
): SafeInt64 {
  validateScaleDecimals(decimals);

  let normalizedDecimal: string;
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue)) {
      throw new DatabaseCommandError({
        code: 'INVALID_INPUT',
        field: fieldName,
        message: 'Numeric value must be finite (NaN and Infinity are not allowed)',
      });
    }
    normalizedDecimal = Object.is(rawValue, -0) ? '0' : expandFiniteNumberToPlainDecimal(rawValue);
  } else if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      throw new DatabaseCommandError({
        code: 'INVALID_INPUT',
        field: fieldName,
        message: 'Numeric string cannot be empty',
      });
    }
    if (/[eE]/.test(trimmed)) {
      const sciMatch = /^(-)?(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(trimmed);
      if (!sciMatch) {
        throw new DatabaseCommandError({
          code: 'INVALID_INPUT',
          field: fieldName,
          message: `Invalid numeric value '${trimmed}'`,
        });
      }
      const sign = sciMatch[1] ? '-' : '';
      const intPart = sciMatch[2];
      const fracPart = sciMatch[3] ?? '';
      const exp = Number.parseInt(sciMatch[4], 10);
      const digits = intPart + fracPart;
      const decimalPos = intPart.length + exp;
      if (decimalPos <= 0) {
        normalizedDecimal = `${sign}0.${'0'.repeat(-decimalPos)}${digits}`;
      } else if (decimalPos >= digits.length) {
        normalizedDecimal = `${sign}${digits}${'0'.repeat(decimalPos - digits.length)}`;
      } else {
        normalizedDecimal = `${sign}${digits.slice(0, decimalPos)}.${digits.slice(decimalPos)}`;
      }
    } else {
      normalizedDecimal = trimmed;
    }
  } else {
    throw new DatabaseCommandError({
      code: 'INVALID_INPUT',
      field: fieldName,
      message: 'Required numeric value is missing or has an invalid type',
    });
  }

  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(normalizedDecimal);
  if (!match) {
    throw new DatabaseCommandError({
      code: 'INVALID_INPUT',
      field: fieldName,
      message: `Invalid decimal value '${normalizedDecimal}'`,
    });
  }

  const negative = Boolean(match[1]);
  const whole = match[2];
  const fracRaw = match[3] ?? '';

  if (fracRaw.length > decimals) {
    const extraDigits = fracRaw.slice(decimals);
    if (!/^0+$/.test(extraDigits)) {
      throw new DatabaseCommandError({
        code: 'UNREPRESENTABLE_FINANCIAL_PRECISION',
        field: fieldName,
        message: `Value '${normalizedDecimal}' exceeds ${decimals} decimal places and cannot be represented without rounding loss`,
      });
    }
  }

  const scaleFactor = 10n ** BigInt(decimals);
  const padded = fracRaw.slice(0, decimals).padEnd(decimals, '0');
  let scaled = BigInt(whole) * scaleFactor + (padded ? BigInt(padded) : 0n);
  if (negative && scaled !== 0n) {
    scaled = -scaled;
  }

  try {
    return toSafeInt64(scaled);
  } catch (err) {
    if (err instanceof DatabaseCommandError && fieldName && !err.field) {
      throw new DatabaseCommandError({
        code: err.code,
        message: err.message,
        field: fieldName,
      });
    }
    throw err;
  }
}

export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
export type InvoiceStatus = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue';
export type DiscountType = 'percentage' | 'fixed';
export type PaymentMethod =
  | 'bank_transfer'
  | 'cash'
  | 'credit_card'
  | 'eft'
  | 'mobile_money'
  | 'cheque'
  | 'other';
export type ActivityLogType =
  | 'quote_created'
  | 'quote_converted'
  | 'quote_status'
  | 'invoice_created'
  | 'payment_recorded'
  | 'invoice_status'
  | 'client_created'
  | 'settings_updated';
export type AssetSourceType = 'data_url' | 'file' | 'external_url';

export interface LocalProfileDto {
  id: string;
  displayName: string;
  email: string;
  supabaseUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalProfileInput {
  id: string;
  displayName?: string;
  email?: string;
  supabaseUserId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UpdateLocalProfileInput {
  id: string;
  displayName: string;
  email: string;
  supabaseUserId?: string | null;
}

export interface BusinessDto {
  id: string;
  legacyId: string | null;
  ownerProfileId: string | null;
  name: string;
  tagline: string;
  logoAssetId: string | null;
  logoUrlFallback: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  postalCode: string | null;
  website: string | null;
  taxNumber: string | null;
  registrationNumber: string | null;
  defaultCurrency: string;
  currencySymbol: string;
  defaultTaxName: string;
  defaultTaxRatePpm: SafeInt64;
  isTaxEnabled: boolean;
  quotePrefix: string;
  invoicePrefix: string;
  nextQuoteNumber: SafeInt64;
  nextInvoiceNumber: SafeInt64;
  defaultTermsQuotation: string;
  defaultTermsInvoice: string;
  defaultNotes: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  branchCode: string;
  accountType: string | null;
  swiftCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBusinessInput {
  id: string;
  legacyId?: string | null;
  ownerProfileId?: string | null;
  name: string;
  tagline?: string;
  logoAssetId?: string | null;
  logoUrlFallback?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  postalCode?: string | null;
  website?: string | null;
  taxNumber?: string | null;
  registrationNumber?: string | null;
  defaultCurrency: string;
  currencySymbol: string;
  defaultTaxName: string;
  defaultTaxRatePpm: SafeInt64;
  isTaxEnabled: boolean;
  quotePrefix: string;
  invoicePrefix: string;
  nextQuoteNumber: SafeInt64;
  nextInvoiceNumber: SafeInt64;
  defaultTermsQuotation?: string;
  defaultTermsInvoice?: string;
  defaultNotes?: string;
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  branchCode?: string;
  accountType?: string | null;
  swiftCode?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UpdateBusinessInput {
  id: string;
  ownerProfileId?: string | null;
  name: string;
  tagline?: string;
  logoAssetId?: string | null;
  logoUrlFallback?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  postalCode?: string | null;
  website?: string | null;
  taxNumber?: string | null;
  registrationNumber?: string | null;
  defaultCurrency: string;
  currencySymbol: string;
  defaultTaxName: string;
  defaultTaxRatePpm: SafeInt64;
  isTaxEnabled: boolean;
  quotePrefix: string;
  invoicePrefix: string;
  nextQuoteNumber: SafeInt64;
  nextInvoiceNumber: SafeInt64;
  defaultTermsQuotation?: string;
  defaultTermsInvoice?: string;
  defaultNotes?: string;
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  branchCode?: string;
  accountType?: string | null;
  swiftCode?: string | null;
}

export interface ClientDto {
  id: string;
  businessId: string;
  legacyId: string | null;
  name: string;
  companyName: string | null;
  email: string;
  phone: string;
  address: string;
  city: string | null;
  country: string | null;
  vatNumber: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateClientInput {
  id: string;
  businessId: string;
  legacyId?: string | null;
  name: string;
  companyName?: string | null;
  email?: string;
  phone?: string;
  address?: string;
  city?: string | null;
  country?: string | null;
  vatNumber?: string | null;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UpdateClientInput {
  id: string;
  businessId: string;
  name: string;
  companyName?: string | null;
  email?: string;
  phone?: string;
  address?: string;
  city?: string | null;
  country?: string | null;
  vatNumber?: string | null;
  notes?: string | null;
}

export interface LineItemInput {
  id: string;
  legacyId?: string | null;
  sortOrder?: SafeInt64 | number | null;
  description: string;
  quantityScaled: SafeInt64;
  unitPriceScaled: SafeInt64;
  totalMinor: SafeInt64;
  createdAt?: string | null;
}

export interface QuotationItemDto {
  id: string;
  businessId: string;
  quotationId: string;
  legacyId: string | null;
  sortOrder: SafeInt64;
  description: string;
  quantityScaled: SafeInt64;
  unitPriceScaled: SafeInt64;
  totalMinor: SafeInt64;
  createdAt: string;
}

export interface InvoiceItemDto {
  id: string;
  businessId: string;
  invoiceId: string;
  legacyId: string | null;
  sortOrder: SafeInt64;
  description: string;
  quantityScaled: SafeInt64;
  unitPriceScaled: SafeInt64;
  totalMinor: SafeInt64;
  createdAt: string;
}

export interface QuotationDto {
  id: string;
  businessId: string;
  legacyId: string | null;
  clientId: string | null;
  quotationNumber: string;
  clientSnapshotJson: string;
  businessSnapshotJson: string;
  issueDate: string;
  expiryDate: string | null;
  currency: string;
  currencySymbol: string;
  subtotalMinor: SafeInt64;
  discountType: DiscountType;
  discountPercentagePpm: SafeInt64;
  discountFixedMinor: SafeInt64;
  discountAmountMinor: SafeInt64;
  taxName: string;
  taxRatePpm: SafeInt64;
  taxAmountMinor: SafeInt64;
  grandTotalMinor: SafeInt64;
  status: QuotationStatus;
  preConversionStatus: QuotationStatus | null;
  notes: string | null;
  terms: string | null;
  convertedInvoiceId: string | null;
  items: QuotationItemDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateQuotationInput {
  id: string;
  businessId: string;
  legacyId?: string | null;
  clientId?: string | null;
  quotationNumber: string;
  clientSnapshotJson: string;
  businessSnapshotJson: string;
  issueDate: string;
  expiryDate?: string | null;
  currency: string;
  currencySymbol: string;
  subtotalMinor: SafeInt64;
  discountType: DiscountType;
  discountPercentagePpm: SafeInt64;
  discountFixedMinor: SafeInt64;
  discountAmountMinor: SafeInt64;
  taxName?: string;
  taxRatePpm: SafeInt64;
  taxAmountMinor: SafeInt64;
  grandTotalMinor: SafeInt64;
  status: QuotationStatus;
  preConversionStatus?: QuotationStatus | null;
  notes?: string | null;
  terms?: string | null;
  convertedInvoiceId?: string | null;
  items: LineItemInput[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UpdateQuotationInput {
  id: string;
  businessId: string;
  clientId?: string | null;
  quotationNumber: string;
  clientSnapshotJson: string;
  businessSnapshotJson: string;
  issueDate: string;
  expiryDate?: string | null;
  currency: string;
  currencySymbol: string;
  subtotalMinor: SafeInt64;
  discountType: DiscountType;
  discountPercentagePpm: SafeInt64;
  discountFixedMinor: SafeInt64;
  discountAmountMinor: SafeInt64;
  taxName?: string;
  taxRatePpm: SafeInt64;
  taxAmountMinor: SafeInt64;
  grandTotalMinor: SafeInt64;
  status: QuotationStatus;
  preConversionStatus?: QuotationStatus | null;
  notes?: string | null;
  terms?: string | null;
  convertedInvoiceId?: string | null;
  items: LineItemInput[];
}

export interface PaymentDto {
  id: string;
  businessId: string;
  invoiceId: string;
  legacyId: string | null;
  amountMinor: SafeInt64;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  reference: string | null;
  notes: string | null;
  recordedAt: string;
}

export interface CreatePaymentInput {
  id: string;
  businessId: string;
  invoiceId: string;
  legacyId?: string | null;
  amountMinor: SafeInt64;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  recordedAt?: string | null;
}

export interface InvoiceDto {
  id: string;
  businessId: string;
  legacyId: string | null;
  clientId: string | null;
  quotationId: string | null;
  invoiceNumber: string;
  clientSnapshotJson: string;
  businessSnapshotJson: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  currencySymbol: string;
  subtotalMinor: SafeInt64;
  discountType: DiscountType;
  discountPercentagePpm: SafeInt64;
  discountFixedMinor: SafeInt64;
  discountAmountMinor: SafeInt64;
  taxName: string;
  taxRatePpm: SafeInt64;
  taxAmountMinor: SafeInt64;
  grandTotalMinor: SafeInt64;
  amountPaidMinor: SafeInt64;
  outstandingBalanceMinor: SafeInt64;
  status: InvoiceStatus;
  notes: string | null;
  terms: string | null;
  paymentInstructions: string | null;
  items: InvoiceItemDto[];
  payments: PaymentDto[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateInvoiceInput {
  id: string;
  businessId: string;
  legacyId?: string | null;
  clientId?: string | null;
  quotationId?: string | null;
  invoiceNumber: string;
  clientSnapshotJson: string;
  businessSnapshotJson: string;
  issueDate: string;
  dueDate?: string | null;
  currency: string;
  currencySymbol: string;
  subtotalMinor: SafeInt64;
  discountType: DiscountType;
  discountPercentagePpm: SafeInt64;
  discountFixedMinor: SafeInt64;
  discountAmountMinor: SafeInt64;
  taxName?: string;
  taxRatePpm: SafeInt64;
  taxAmountMinor: SafeInt64;
  grandTotalMinor: SafeInt64;
  amountPaidMinor: SafeInt64;
  outstandingBalanceMinor: SafeInt64;
  status: InvoiceStatus;
  notes?: string | null;
  terms?: string | null;
  paymentInstructions?: string | null;
  items: LineItemInput[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UpdateInvoiceInput {
  id: string;
  businessId: string;
  clientId?: string | null;
  quotationId?: string | null;
  invoiceNumber: string;
  clientSnapshotJson: string;
  businessSnapshotJson: string;
  issueDate: string;
  dueDate?: string | null;
  currency: string;
  currencySymbol: string;
  subtotalMinor: SafeInt64;
  discountType: DiscountType;
  discountPercentagePpm: SafeInt64;
  discountFixedMinor: SafeInt64;
  discountAmountMinor: SafeInt64;
  taxName?: string;
  taxRatePpm: SafeInt64;
  taxAmountMinor: SafeInt64;
  grandTotalMinor: SafeInt64;
  amountPaidMinor: SafeInt64;
  outstandingBalanceMinor: SafeInt64;
  status: InvoiceStatus;
  notes?: string | null;
  terms?: string | null;
  paymentInstructions?: string | null;
  items: LineItemInput[];
}

export interface ActivityLogDto {
  id: string;
  businessId: string;
  legacyId: string | null;
  type: ActivityLogType;
  title: string;
  description: string;
  timestamp: string;
  referenceId: string | null;
  referenceType: string | null;
  actorLocalProfileId: string | null;
}

export interface CreateActivityLogInput {
  id: string;
  businessId: string;
  legacyId?: string | null;
  type: ActivityLogType;
  title: string;
  description: string;
  timestamp?: string | null;
  referenceId?: string | null;
  referenceType?: string | null;
  actorLocalProfileId?: string | null;
}

export interface BusinessAssetDto {
  id: string;
  businessId: string;
  contentHash: string;
  sourceType: AssetSourceType;
  mimeType: string | null;
  inlineData: string | null;
  filePath: string | null;
  externalUrl: string | null;
  originalFilename: string | null;
  byteSize: SafeInt64 | null;
  createdAt: string;
}

export interface CreateBusinessAssetInput {
  id: string;
  businessId: string;
  contentHash: string;
  sourceType: AssetSourceType;
  mimeType?: string | null;
  inlineData?: string | null;
  filePath?: string | null;
  externalUrl?: string | null;
  originalFilename?: string | null;
  byteSize?: SafeInt64 | null;
  createdAt?: string | null;
}

export interface AppSettingDto {
  key: string;
  valueJson: string;
  updatedAt: string;
}

export interface SaveAppSettingInput {
  key: string;
  valueJson: string;
  updatedAt?: string | null;
}

export type MigrationState =
  | 'absent'
  | 'not_needed'
  | 'completed'
  | 'conflict_existing_data';

export type MigrationDiagnosticSeverity = 'error' | 'warning' | 'info';

export type MigrationDiagnosticStage =
  | 'backup'
  | 'extract'
  | 'normalize'
  | 'relationship'
  | 'validate'
  | 'sqlite_import'
  | 'verify';

export interface MigrationCountsDto {
  localProfiles: SafeInt64;
  businesses: SafeInt64;
  businessAssets: SafeInt64;
  clients: SafeInt64;
  quotations: SafeInt64;
  quotationItems: SafeInt64;
  invoices: SafeInt64;
  invoiceItems: SafeInt64;
  payments: SafeInt64;
  activityLogs: SafeInt64;
  appSettings: SafeInt64;
}

export interface MigrationDiagnosticDto {
  code: string;
  severity: MigrationDiagnosticSeverity;
  stage: MigrationDiagnosticStage;
  entityType: string;
  recordId: string | null;
  field: string | null;
  originalValue: string | null;
  message: string;
  suggestedAction: string;
}

export interface MigrationStatusDto {
  state: MigrationState;
  markerVersion: number | null;
  completedAt: string | null;
  migratedBusinessId: string | null;
  backupFilename: string | null;
  lastError: MigrationDiagnosticDto | null;
  existingCounts: MigrationCountsDto;
}

export interface RawLegacyKeyEntry {
  key: string;
  present: boolean;
  presentInLocalStorage: boolean;
  presentInMemoryFallback: boolean;
  rawValue: string | null;
}

export interface BackupLegacyStorageInput {
  capturedAt: string;
  source: string;
  keys: RawLegacyKeyEntry[];
}

export interface BackupLegacyStorageResult {
  backupFilename: string;
  byteSize: SafeInt64;
  sha256: string;
  verified: boolean;
  capturedKeyCount: SafeInt64;
}

export interface ExpectedFinancialSumsInput {
  quotationGrandTotalSumMinor: SafeInt64;
  invoiceGrandTotalSumMinor: SafeInt64;
  invoiceAmountPaidSumMinor: SafeInt64;
  paymentAmountSumMinor: SafeInt64;
}

export interface LegacyWorkspaceMigrationInput {
  backupVerification: BackupLegacyStorageResult;
  localProfile: CreateLocalProfileInput;
  business: CreateBusinessInput;
  assets: CreateBusinessAssetInput[];
  clients: CreateClientInput[];
  quotations: CreateQuotationInput[];
  invoices: CreateInvoiceInput[];
  payments: CreatePaymentInput[];
  activityLogs: CreateActivityLogInput[];
  settings: SaveAppSettingInput[];
  diagnostics: MigrationDiagnosticDto[];
  expectedFinancialSums?: ExpectedFinancialSumsInput | null;
}

export interface MigrationResultDto {
  state: MigrationState;
  migratedBusinessId: string;
  localProfileId: string;
  backupFilename: string;
  counts: MigrationCountsDto;
  diagnostics: MigrationDiagnosticDto[];
  completedAt: string;
}

function normalizeCommandError(err: unknown): DatabaseCommandError {
  if (err instanceof DatabaseCommandError) {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const candidate = err as Partial<SerializedCommandError>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return new DatabaseCommandError({
        code: candidate.code,
        message: candidate.message,
        field: typeof candidate.field === 'string' ? candidate.field : undefined,
      });
    }
  }
  if (typeof err === 'string') {
    return new DatabaseCommandError({
      code: 'INTERNAL_ERROR',
      message: err,
    });
  }
  return new DatabaseCommandError({
    code: 'INTERNAL_ERROR',
    message: err instanceof Error ? err.message : 'Unexpected database command error',
  });
}

async function invokeDbCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new DatabaseCommandError({
      code: 'UNSUPPORTED_ENVIRONMENT',
      message: 'Desktop SQLite commands are only available inside the Tauri desktop runtime.',
    });
  }

  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeCommandError(error);
  }
}

/**
 * Ensures the desktop SQLite database (`bizora.db`) is initialized in the Tauri
 * application data directory and returns structured status/configuration info.
 */
export async function initializeDesktopDatabase(): Promise<DatabaseStatus | null> {
  if (!isTauri()) {
    return null;
  }
  try {
    return await invoke<DatabaseStatus>('initialize_database');
  } catch (error) {
    throw normalizeCommandError(error);
  }
}

/**
 * Requests a read/verify health check of the desktop SQLite database without
 * replacing existing LocalStorage persistence.
 */
export async function getDesktopDatabaseStatus(): Promise<DatabaseStatus | null> {
  if (!isTauri()) {
    return null;
  }
  try {
    return await invoke<DatabaseStatus>('get_database_status');
  } catch (error) {
    throw normalizeCommandError(error);
  }
}

// Local Profiles
export function createLocalProfile(input: CreateLocalProfileInput): Promise<LocalProfileDto> {
  return invokeDbCommand('create_local_profile', { input });
}

export function getLocalProfileById(id: string): Promise<LocalProfileDto | null> {
  return invokeDbCommand('get_local_profile_by_id', { id });
}

export function getLocalProfiles(): Promise<LocalProfileDto[]> {
  return invokeDbCommand('get_local_profiles');
}

export function updateLocalProfile(input: UpdateLocalProfileInput): Promise<LocalProfileDto> {
  return invokeDbCommand('update_local_profile', { input });
}

// Businesses
export function createBusiness(input: CreateBusinessInput): Promise<BusinessDto> {
  return invokeDbCommand('create_business', { input });
}

export function getBusinessById(id: string): Promise<BusinessDto | null> {
  return invokeDbCommand('get_business_by_id', { id });
}

export function getBusinesses(ownerProfileId?: string | null): Promise<BusinessDto[]> {
  return invokeDbCommand('get_businesses', { ownerProfileId: ownerProfileId ?? null });
}

export function updateBusiness(input: UpdateBusinessInput): Promise<BusinessDto> {
  return invokeDbCommand('update_business', { input });
}

export function deleteBusiness(id: string): Promise<void> {
  return invokeDbCommand('delete_business', { id });
}

// Clients
export function createClient(input: CreateClientInput): Promise<ClientDto> {
  return invokeDbCommand('create_client', { input });
}

export function getClientById(id: string): Promise<ClientDto | null> {
  return invokeDbCommand('get_client_by_id', { id });
}

export function getClientsByBusiness(businessId: string): Promise<ClientDto[]> {
  return invokeDbCommand('get_clients_by_business', { businessId });
}

export function updateClient(input: UpdateClientInput): Promise<ClientDto> {
  return invokeDbCommand('update_client', { input });
}

export function deleteClient(id: string): Promise<void> {
  return invokeDbCommand('delete_client', { id });
}

// Quotations
export function createQuotation(input: CreateQuotationInput): Promise<QuotationDto> {
  return invokeDbCommand('create_quotation', { input });
}

export function getQuotationById(id: string): Promise<QuotationDto | null> {
  return invokeDbCommand('get_quotation_by_id', { id });
}

export function getQuotationsByBusiness(businessId: string): Promise<QuotationDto[]> {
  return invokeDbCommand('get_quotations_by_business', { businessId });
}

export function getQuotationItems(quotationId: string): Promise<QuotationItemDto[]> {
  return invokeDbCommand('get_quotation_items', { quotationId });
}

export function updateQuotation(input: UpdateQuotationInput): Promise<QuotationDto> {
  return invokeDbCommand('update_quotation', { input });
}

export function deleteQuotation(id: string): Promise<void> {
  return invokeDbCommand('delete_quotation', { id });
}

// Invoices
export function createInvoice(input: CreateInvoiceInput): Promise<InvoiceDto> {
  return invokeDbCommand('create_invoice', { input });
}

export function getInvoiceById(id: string): Promise<InvoiceDto | null> {
  return invokeDbCommand('get_invoice_by_id', { id });
}

export function getInvoicesByBusiness(businessId: string): Promise<InvoiceDto[]> {
  return invokeDbCommand('get_invoices_by_business', { businessId });
}

export function getInvoiceItems(invoiceId: string): Promise<InvoiceItemDto[]> {
  return invokeDbCommand('get_invoice_items', { invoiceId });
}

export function updateInvoice(input: UpdateInvoiceInput): Promise<InvoiceDto> {
  return invokeDbCommand('update_invoice', { input });
}

export function deleteInvoice(id: string): Promise<void> {
  return invokeDbCommand('delete_invoice', { id });
}

// Payments
export function createPayment(input: CreatePaymentInput): Promise<PaymentDto> {
  return invokeDbCommand('create_payment', { input });
}

export function getPaymentsByInvoice(invoiceId: string): Promise<PaymentDto[]> {
  return invokeDbCommand('get_payments_by_invoice', { invoiceId });
}

export function getPaymentsByBusiness(businessId: string): Promise<PaymentDto[]> {
  return invokeDbCommand('get_payments_by_business', { businessId });
}

export function deletePayment(id: string): Promise<void> {
  return invokeDbCommand('delete_payment', { id });
}

// Activity Logs
export function createActivityLog(input: CreateActivityLogInput): Promise<ActivityLogDto> {
  return invokeDbCommand('create_activity_log', { input });
}

export function getActivityLogById(id: string): Promise<ActivityLogDto | null> {
  return invokeDbCommand('get_activity_log_by_id', { id });
}

export function getActivityLogsByBusiness(
  businessId: string,
  limit?: SafeInt64 | number | null
): Promise<ActivityLogDto[]> {
  const normalizedLimit =
    limit === undefined || limit === null ? null : toSafeInt64(limit);
  return invokeDbCommand('get_activity_logs_by_business', {
    businessId,
    limit: normalizedLimit,
  });
}

// Business Assets
export function createBusinessAsset(input: CreateBusinessAssetInput): Promise<BusinessAssetDto> {
  return invokeDbCommand('create_business_asset', { input });
}

export function getBusinessAssetById(id: string): Promise<BusinessAssetDto | null> {
  return invokeDbCommand('get_business_asset_by_id', { id });
}

export function getBusinessAssetsByBusiness(businessId: string): Promise<BusinessAssetDto[]> {
  return invokeDbCommand('get_business_assets_by_business', { businessId });
}

export function deleteBusinessAsset(id: string): Promise<void> {
  return invokeDbCommand('delete_business_asset', { id });
}

// App Settings
export function getAppSetting(key: string): Promise<AppSettingDto | null> {
  return invokeDbCommand('get_app_setting', { key });
}

export function saveAppSetting(input: SaveAppSettingInput): Promise<AppSettingDto> {
  return invokeDbCommand('save_app_setting', { input });
}

export function deleteAppSetting(key: string): Promise<void> {
  return invokeDbCommand('delete_app_setting', { key });
}

// Legacy LocalStorage Migration (Stage 2.2.3)
export function getMigrationStatus(): Promise<MigrationStatusDto> {
  return invokeDbCommand('get_migration_status');
}

export function backupLegacyLocalstorage(
  input: BackupLegacyStorageInput
): Promise<BackupLegacyStorageResult> {
  return invokeDbCommand('backup_legacy_localstorage', { input });
}

export function migrateLegacyWorkspace(
  input: LegacyWorkspaceMigrationInput
): Promise<MigrationResultDto> {
  return invokeDbCommand('migrate_legacy_workspace', { input });
}

export const DesktopDatabaseService = {
  isSupported: isTauri,
  initializeDesktopDatabase,
  getDesktopDatabaseStatus,
  toSafeInt64,
  parseSafeInt64,
  decimalToScaledInt64,
  strictDecimalToScaledInt64,
  scaledInt64ToDecimal,
  createLocalProfile,
  getLocalProfileById,
  getLocalProfiles,
  updateLocalProfile,
  createBusiness,
  getBusinessById,
  getBusinesses,
  updateBusiness,
  deleteBusiness,
  createClient,
  getClientById,
  getClientsByBusiness,
  updateClient,
  deleteClient,
  createQuotation,
  getQuotationById,
  getQuotationsByBusiness,
  getQuotationItems,
  updateQuotation,
  deleteQuotation,
  createInvoice,
  getInvoiceById,
  getInvoicesByBusiness,
  getInvoiceItems,
  updateInvoice,
  deleteInvoice,
  createPayment,
  getPaymentsByInvoice,
  getPaymentsByBusiness,
  deletePayment,
  createActivityLog,
  getActivityLogById,
  getActivityLogsByBusiness,
  createBusinessAsset,
  getBusinessAssetById,
  getBusinessAssetsByBusiness,
  deleteBusinessAsset,
  getAppSetting,
  saveAppSetting,
  deleteAppSetting,
  getMigrationStatus,
  backupLegacyLocalstorage,
  migrateLegacyWorkspace,
};

