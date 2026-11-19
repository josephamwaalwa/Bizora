import {
  DesktopDatabaseService,
  parseSafeInt64,
  strictDecimalToScaledInt64,
  toSafeInt64,
  type BackupLegacyStorageInput,
  type BackupLegacyStorageResult,
  type CreateActivityLogInput,
  type CreateBusinessAssetInput,
  type CreateBusinessInput,
  type CreateClientInput,
  type CreateInvoiceInput,
  type CreateLocalProfileInput,
  type CreatePaymentInput,
  type CreateQuotationInput,
  type DiscountType,
  type ExpectedFinancialSumsInput,
  type InvoiceStatus,
  type LegacyWorkspaceMigrationInput,
  type LineItemInput,
  type MigrationDiagnosticDto,
  type MigrationDiagnosticSeverity,
  type MigrationDiagnosticStage,
  type MigrationResultDto,
  type MigrationStatusDto,
  type PaymentMethod,
  type QuotationStatus,
  type SafeInt64,
  type SaveAppSettingInput,
} from './database';
import {
  initialActivities,
  initialBusinessProfile,
  initialClients,
  initialInvoices,
  initialQuotations,
} from './seedData';
import {
  restoreUnlinkedQuotationStatus,
  StorageService,
  type LegacyStorageKey,
  type RawLegacyStorageSnapshot,
} from './storage';
import { generateId, isUuid } from '../utils/idGenerator';
import { isValidThemeMode, THEME_STORAGE_KEY } from '../utils/theme';

const PROFILE_KEY: LegacyStorageKey = 'bizora_business_profile_v1';
const CLIENTS_KEY: LegacyStorageKey = 'bizora_clients_v1';
const QUOTATIONS_KEY: LegacyStorageKey = 'bizora_quotations_v1';
const INVOICES_KEY: LegacyStorageKey = 'bizora_invoices_v1';
const ACTIVITIES_KEY: LegacyStorageKey = 'bizora_activities_v1';
const INITIALIZED_KEY: LegacyStorageKey = 'bizora_has_initialized_v1';
const LOGO_CACHE_KEY: LegacyStorageKey = 'bizora_logo_cache_v1';

const PROFILE_LOGO_MARKER = '__BIZORA_PROFILE_LOGO__';
const LOGO_REF_PREFIX = '__BIZORA_LOGO__:';

const VALID_QUOTATION_STATUSES: ReadonlySet<QuotationStatus> = new Set([
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
]);

const VALID_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'overdue',
]);

const VALID_DISCOUNT_TYPES: ReadonlySet<DiscountType> = new Set(['percentage', 'fixed']);

const VALID_PAYMENT_METHODS: ReadonlySet<PaymentMethod> = new Set([
  'bank_transfer',
  'cash',
  'credit_card',
  'eft',
  'mobile_money',
  'cheque',
  'other',
]);

const VALID_ACTIVITY_TYPES: ReadonlySet<CreateActivityLogInput['type']> = new Set([
  'quote_created',
  'quote_converted',
  'quote_status',
  'invoice_created',
  'payment_recorded',
  'invoice_status',
  'client_created',
  'settings_updated',
]);

export type WorkspaceClassification =
  | 'empty_fresh_install'
  | 'demo_seed_only'
  | 'existing_initialized'
  | 'existing_missing_init_marker'
  | 'partial_or_corrupted';

export interface PreparedMigrationResult {
  classification: WorkspaceClassification;
  payload: Omit<LegacyWorkspaceMigrationInput, 'backupVerification'> | null;
  diagnostics: MigrationDiagnosticDto[];
  hasErrors: boolean;
}

export interface MigrationRunnerDeps {
  getRawSnapshot?: () => RawLegacyStorageSnapshot;
  getMigrationStatus?: () => Promise<MigrationStatusDto>;
  backupLegacyLocalstorage?: (input: BackupLegacyStorageInput) => Promise<BackupLegacyStorageResult>;
  migrateLegacyWorkspace?: (input: LegacyWorkspaceMigrationInput) => Promise<MigrationResultDto>;
}

export interface RunMigrationOptions {
  nowIso?: string;
  migrateDemoSeed?: boolean;
  deps?: MigrationRunnerDeps;
}

export type ExplicitMigrationOutcome =
  | {
      outcome: 'completed';
      classification: WorkspaceClassification;
      backup: BackupLegacyStorageResult;
      result: MigrationResultDto;
      diagnostics: MigrationDiagnosticDto[];
    }
  | {
      outcome: 'already_completed';
      status: MigrationStatusDto;
      diagnostics: MigrationDiagnosticDto[];
    }
  | {
      outcome: 'conflict_existing_data';
      status: MigrationStatusDto;
      diagnostics: MigrationDiagnosticDto[];
    }
  | {
      outcome: 'empty_fresh_install';
      classification: WorkspaceClassification;
      diagnostics: MigrationDiagnosticDto[];
    }
  | {
      outcome: 'demo_seed_only';
      classification: WorkspaceClassification;
      backup: BackupLegacyStorageResult;
      diagnostics: MigrationDiagnosticDto[];
    }
  | {
      outcome: 'backup_failed';
      classification?: WorkspaceClassification;
      diagnostics: MigrationDiagnosticDto[];
    }
  | {
      outcome: 'validation_failed';
      classification: WorkspaceClassification;
      backup: BackupLegacyStorageResult;
      diagnostics: MigrationDiagnosticDto[];
    };

// ============================================================
// Pure-TS Synchronous FIPS 180-4 SHA-256 (UTF-8)
// ============================================================

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = BigInt(bytes.length) * 8n;

  const rem = (bytes.length + 9) % 64;
  const padZeroBytes = rem === 0 ? 0 : 64 - rem;
  const totalLen = bytes.length + 1 + padZeroBytes + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, Number((bitLen >> 32n) & 0xffffffffn), false);
  view.setUint32(totalLen - 4, Number(bitLen & 0xffffffffn), false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i++) {
    out += h[i].toString(16).padStart(8, '0');
  }
  return out;
}

// ============================================================
// Diagnostics & Redaction
// ============================================================

export function redactDiagnosticValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    text = String(raw);
  } else {
    try {
      text = JSON.stringify(raw) ?? String(raw);
    } catch {
      text = '[unserializable value]';
    }
  }

  const trimmed = text.trim();
  if (/^data:/i.test(trimmed)) {
    const mimeMatch = /^data:([^;,\s]+)/i.exec(trimmed);
    const mime = mimeMatch?.[1] || 'application/octet-stream';
    const summary = `[data:${mime}; ${trimmed.length} chars]`;
    return summary.length <= 120 ? summary : summary.slice(0, 120);
  }

  let sanitized = text
    .replace(/data:([^;,\s]+)?(?:;[^,\s]*)?,[^\s"'`]+/gi, (match, mime) => {
      const m = mime || 'application/octet-stream';
      return `[data:${m}; ${match.length} chars]`;
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]');

  let cleanChars = '';
  for (let i = 0; i < sanitized.length; i++) {
    const code = sanitized.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      cleanChars += sanitized[i];
    } else if (code === 0x09 || code === 0x0a || code === 0x0d) {
      cleanChars += ' ';
    }
  }

  const collapsed = cleanChars.trim();
  if (collapsed.length <= 120) {
    return collapsed;
  }
  return `${collapsed.slice(0, 117)}...`;
}

function makeDiagnostic(params: {
  code: string;
  severity: MigrationDiagnosticSeverity;
  stage: MigrationDiagnosticStage;
  entityType: string;
  recordId?: string | null;
  field?: string | null;
  originalValue?: unknown;
  message: string;
  suggestedAction: string;
}): MigrationDiagnosticDto {
  return {
    code: params.code,
    severity: params.severity,
    stage: params.stage,
    entityType: params.entityType,
    recordId: params.recordId ?? null,
    field: params.field ?? null,
    originalValue: redactDiagnosticValue(params.originalValue),
    message: params.message,
    suggestedAction: params.suggestedAction,
  };
}

// ============================================================
// Raw Backup Payload & Key Lookup Helpers
// ============================================================

export function buildRawBackupPayload(snapshot: RawLegacyStorageSnapshot): BackupLegacyStorageInput {
  return {
    capturedAt: snapshot.capturedAt,
    source: snapshot.source,
    keys: snapshot.entries.map((entry) => ({
      key: entry.key,
      present: entry.present,
      presentInLocalStorage: entry.presentInLocalStorage,
      presentInMemoryFallback: entry.presentInMemoryFallback,
      rawValue: entry.rawValue,
    })),
  };
}

function getEntry(snapshot: RawLegacyStorageSnapshot, key: LegacyStorageKey) {
  return snapshot.entries.find((e) => e.key === key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

function asOptionalTrimmedNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ============================================================
// Calendar Date & Timestamp Helpers (matching Rust validation)
// ============================================================

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number | null {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return null;
  }
}

export function isValidIsoCalendarDate(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return false;
  }
  const year = Number.parseInt(trimmed.slice(0, 4), 10);
  const month = Number.parseInt(trimmed.slice(5, 7), 10);
  const day = Number.parseInt(trimmed.slice(8, 10), 10);
  if (year < 1 || year > 9999) return false;
  const maxDay = daysInMonth(year, month);
  if (maxDay === null) return false;
  return day >= 1 && day <= maxDay;
}

function isValidTimestampString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return Number.isFinite(Date.parse(trimmed));
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function compareAscNullableStr(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeRequiredIsoDate(params: {
  rawValue: unknown;
  entityType: string;
  recordId: string;
  field: string;
  diagnostics: MigrationDiagnosticDto[];
}): string | null {
  if (typeof params.rawValue !== 'string' || !params.rawValue.trim()) {
    params.diagnostics.push(
      makeDiagnostic({
        code: 'INVALID_DATE',
        severity: 'error',
        stage: 'validate',
        entityType: params.entityType,
        recordId: params.recordId,
        field: params.field,
        originalValue: params.rawValue,
        message: `${params.entityType}.${params.field} is missing or not a valid YYYY-MM-DD calendar date.`,
        suggestedAction: 'Fix the date in the legacy record to a valid YYYY-MM-DD calendar date and retry.',
      })
    );
    return null;
  }

  const trimmed = params.rawValue.trim();
  if (isValidIsoCalendarDate(trimmed)) {
    return trimmed;
  }

  // Handle full ISO datetime strings such as 2026-10-05T09:00:00.000Z when the leading date is valid
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && Number.isFinite(Date.parse(trimmed))) {
    const datePart = trimmed.slice(0, 10);
    if (isValidIsoCalendarDate(datePart)) {
      params.diagnostics.push(
        makeDiagnostic({
          code: 'INVALID_DATE',
          severity: 'warning',
          stage: 'normalize',
          entityType: params.entityType,
          recordId: params.recordId,
          field: params.field,
          originalValue: trimmed,
          message: `Normalized ISO timestamp in ${params.entityType}.${params.field} to calendar date ${datePart}.`,
          suggestedAction: 'Verify the normalized date matches the intended document date.',
        })
      );
      return datePart;
    }
  }

  params.diagnostics.push(
    makeDiagnostic({
      code: 'INVALID_DATE',
      severity: 'error',
      stage: 'validate',
      entityType: params.entityType,
      recordId: params.recordId,
      field: params.field,
      originalValue: trimmed,
      message: `${params.entityType}.${params.field} ('${trimmed}') is not a valid YYYY-MM-DD calendar date.`,
      suggestedAction: 'Correct the invalid calendar date before migrating to SQLite.',
    })
  );
  return null;
}

function normalizeOptionalIsoDate(params: {
  rawValue: unknown;
  entityType: string;
  recordId: string;
  field: string;
  diagnostics: MigrationDiagnosticDto[];
}): string | null {
  if (params.rawValue === undefined || params.rawValue === null) {
    return null;
  }
  if (typeof params.rawValue === 'string' && !params.rawValue.trim()) {
    return null;
  }
  return normalizeRequiredIsoDate(params);
}

// ============================================================
// Workspace Classification
// ============================================================

function stripBusinessUpdatedAt(profile: unknown): unknown {
  if (!isPlainObject(profile)) return profile;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(profile)) {
    if (key !== 'updatedAt') {
      copy[key] = profile[key];
    }
  }
  return copy;
}

function stripDocBusinessUpdatedAt(doc: unknown): unknown {
  if (!isPlainObject(doc)) return doc;
  if ('businessSnapshot' in doc && isPlainObject(doc.businessSnapshot)) {
    return {
      ...doc,
      businessSnapshot: stripBusinessUpdatedAt(doc.businessSnapshot),
    };
  }
  return doc;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJson(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqualJson(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

interface ParsedLegacyKeys {
  profile: Record<string, unknown> | null;
  clients: unknown[] | null;
  quotations: unknown[] | null;
  invoices: unknown[] | null;
  activities: unknown[] | null;
  logoCache: Record<string, unknown> | null;
  initRaw: string | null;
  themeRaw: string | null;
  parseErrors: Array<{ key: LegacyStorageKey; message: string; rawPreview: string }>;
}

function parseSnapshotKeys(snapshot: RawLegacyStorageSnapshot): ParsedLegacyKeys {
  const result: ParsedLegacyKeys = {
    profile: null,
    clients: null,
    quotations: null,
    invoices: null,
    activities: null,
    logoCache: null,
    initRaw: getEntry(snapshot, INITIALIZED_KEY)?.rawValue ?? null,
    themeRaw: getEntry(snapshot, THEME_STORAGE_KEY)?.rawValue ?? null,
    parseErrors: [],
  };

  const parseObjectKey = (key: LegacyStorageKey): Record<string, unknown> | null => {
    const entry = getEntry(snapshot, key);
    if (!entry?.present || entry.rawValue === null) return null;
    try {
      const parsed: unknown = JSON.parse(entry.rawValue);
      if (!isPlainObject(parsed)) {
        result.parseErrors.push({
          key,
          message: `Legacy key '${key}' must contain a JSON object.`,
          rawPreview: entry.rawValue,
        });
        return null;
      }
      return parsed;
    } catch (err) {
      result.parseErrors.push({
        key,
        message: `Corrupted JSON in legacy key '${key}': ${err instanceof Error ? err.message : 'parse failure'}`,
        rawPreview: entry.rawValue,
      });
      return null;
    }
  };

  const parseArrayKey = (key: LegacyStorageKey): unknown[] | null => {
    const entry = getEntry(snapshot, key);
    if (!entry?.present || entry.rawValue === null) return null;
    try {
      const parsed: unknown = JSON.parse(entry.rawValue);
      if (!Array.isArray(parsed)) {
        result.parseErrors.push({
          key,
          message: `Legacy key '${key}' must contain a JSON array.`,
          rawPreview: entry.rawValue,
        });
        return null;
      }
      return parsed;
    } catch (err) {
      result.parseErrors.push({
        key,
        message: `Corrupted JSON in legacy key '${key}': ${err instanceof Error ? err.message : 'parse failure'}`,
        rawPreview: entry.rawValue,
      });
      return null;
    }
  };

  result.profile = parseObjectKey(PROFILE_KEY);
  result.clients = parseArrayKey(CLIENTS_KEY);
  result.quotations = parseArrayKey(QUOTATIONS_KEY);
  result.invoices = parseArrayKey(INVOICES_KEY);
  result.activities = parseArrayKey(ACTIVITIES_KEY);
  result.logoCache = parseObjectKey(LOGO_CACHE_KEY);

  return result;
}

function classifyParsedWorkspace(
  snapshot: RawLegacyStorageSnapshot,
  parsed: ParsedLegacyKeys
): WorkspaceClassification {
  const coreKeys: LegacyStorageKey[] = [
    PROFILE_KEY,
    CLIENTS_KEY,
    QUOTATIONS_KEY,
    INVOICES_KEY,
    ACTIVITIES_KEY,
  ];
  const anyCorePresent = coreKeys.some((k) => Boolean(getEntry(snapshot, k)?.present));
  const initPresent = Boolean(getEntry(snapshot, INITIALIZED_KEY)?.present);
  const logoCachePresent = Boolean(getEntry(snapshot, LOGO_CACHE_KEY)?.present);

  if (!anyCorePresent && !initPresent && !logoCachePresent) {
    return 'empty_fresh_install';
  }

  if (parsed.parseErrors.length > 0) {
    return 'partial_or_corrupted';
  }

  if (!parsed.profile) {
    return 'partial_or_corrupted';
  }

  const isInitTrue = parsed.initRaw === 'true';
  if (!isInitTrue) {
    return 'existing_missing_init_marker';
  }

  const logoCacheEmpty = !parsed.logoCache || Object.keys(parsed.logoCache).length === 0;
  const matchesDemo =
    logoCacheEmpty &&
    deepEqualJson(stripBusinessUpdatedAt(parsed.profile), stripBusinessUpdatedAt(initialBusinessProfile)) &&
    deepEqualJson(parsed.clients ?? [], initialClients) &&
    deepEqualJson((parsed.quotations ?? []).map(stripDocBusinessUpdatedAt), initialQuotations.map(stripDocBusinessUpdatedAt)) &&
    deepEqualJson((parsed.invoices ?? []).map(stripDocBusinessUpdatedAt), initialInvoices.map(stripDocBusinessUpdatedAt)) &&
    deepEqualJson(parsed.activities ?? [], initialActivities);

  if (matchesDemo) {
    return 'demo_seed_only';
  }

  return 'existing_initialized';
}

export function classifyWorkspace(snapshot: RawLegacyStorageSnapshot): WorkspaceClassification {
  const parsed = parseSnapshotKeys(snapshot);
  return classifyParsedWorkspace(snapshot, parsed);
}

// ============================================================
// Strict Financial Helpers
// ============================================================

function convertFinancialStrict(params: {
  rawValue: unknown;
  decimals: number;
  entityType: string;
  recordId: string;
  field: string;
  diagnostics: MigrationDiagnosticDto[];
  allowNegativeWarning?: boolean;
}): SafeInt64 | null {
  try {
    const scaled = strictDecimalToScaledInt64(params.rawValue, params.decimals, params.field);
    if (params.allowNegativeWarning !== false && BigInt(scaled) < 0n) {
      params.diagnostics.push(
        makeDiagnostic({
          code: 'NEGATIVE_FINANCIAL_VALUE_PRESERVED',
          severity: 'warning',
          stage: 'normalize',
          entityType: params.entityType,
          recordId: params.recordId,
          field: params.field,
          originalValue: params.rawValue,
          message: `Preserved historical negative value in ${params.entityType}.${params.field} without clamping.`,
          suggestedAction: 'Review historical adjustment/credit note value after migration.',
        })
      );
    }
    return scaled;
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? ((err as { code: string }).code === 'NUMERIC_OVERFLOW'
            ? 'NUMERIC_OVERFLOW'
            : 'UNREPRESENTABLE_FINANCIAL_PRECISION')
        : 'UNREPRESENTABLE_FINANCIAL_PRECISION';
    params.diagnostics.push(
      makeDiagnostic({
        code,
        severity: 'error',
        stage: 'validate',
        entityType: params.entityType,
        recordId: params.recordId,
        field: params.field,
        originalValue: params.rawValue,
        message:
          err instanceof Error
            ? err.message
            : `Unable to represent ${params.entityType}.${params.field} at scale ${params.decimals}.`,
        suggestedAction: 'Inspect the legacy numeric value and resolve precision/overflow before retrying.',
      })
    );
    return null;
  }
}

// ============================================================
// Logo Hydration & Asset Deduplication (Payload-Only)
// ============================================================

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

// ============================================================
// Primary Workspace Normalization & Relationship Resolution
// ============================================================

interface NormalizedQuoteMeta {
  input: CreateQuotationInput;
  rawId: string;
  rawConvertedInvoiceId: string | null;
}

interface NormalizedInvoiceMeta {
  input: CreateInvoiceInput;
  rawId: string;
  rawQuotationId: string | null;
  payments: CreatePaymentInput[];
}

export function prepareMigrationPayload(
  snapshot: RawLegacyStorageSnapshot,
  options?: { nowIso?: string }
): PreparedMigrationResult {
  const nowIso = options?.nowIso ?? new Date().toISOString();
  const parsed = parseSnapshotKeys(snapshot);
  const classification = classifyParsedWorkspace(snapshot, parsed);
  const diagnostics: MigrationDiagnosticDto[] = [];

  for (const err of parsed.parseErrors) {
    diagnostics.push(
      makeDiagnostic({
        code: 'CORRUPTED_JSON',
        severity: 'error',
        stage: 'extract',
        entityType: 'storage_key',
        recordId: err.key,
        field: err.key,
        originalValue: err.rawPreview,
        message: err.message,
        suggestedAction: 'Repair or restore the corrupted LocalStorage key from a verified JSON backup.',
      })
    );
  }

  if (classification === 'empty_fresh_install') {
    return {
      classification,
      payload: null,
      diagnostics,
      hasErrors: diagnostics.some((d) => d.severity === 'error'),
    };
  }

  if (classification === 'existing_missing_init_marker') {
    diagnostics.push(
      makeDiagnostic({
        code: 'MISSING_INIT_MARKER',
        severity: 'warning',
        stage: 'extract',
        entityType: 'storage_key',
        recordId: INITIALIZED_KEY,
        field: INITIALIZED_KEY,
        originalValue: parsed.initRaw,
        message: 'Legacy business data found without the bizora_has_initialized_v1 marker.',
        suggestedAction: 'Review migrated records after import to verify completeness.',
      })
    );
  }

  if (!parsed.profile) {
    if (parsed.parseErrors.every((e) => e.key !== PROFILE_KEY)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'extract',
          entityType: 'business',
          recordId: PROFILE_KEY,
          field: PROFILE_KEY,
          originalValue: null,
          message: 'Legacy business profile is missing while workspace keys exist.',
          suggestedAction: 'Restore bizora_business_profile_v1 before running migration.',
        })
      );
    }
    return {
      classification,
      payload: null,
      diagnostics,
      hasErrors: true,
    };
  }

  // Validate logo cache entries if present
  const logoCache: Record<string, string> = {};
  if (parsed.logoCache) {
    for (const [k, v] of Object.entries(parsed.logoCache)) {
      if (typeof v === 'string') {
        logoCache[k] = v;
      } else {
        diagnostics.push(
          makeDiagnostic({
            code: 'CORRUPTED_JSON',
            severity: 'warning',
            stage: 'extract',
            entityType: 'logo_cache',
            recordId: k,
            field: k,
            originalValue: typeof v,
            message: `Ignored non-string logo cache entry '${k}'.`,
            suggestedAction: 'Verify document logos after migration.',
          })
        );
      }
    }
  }

  // Gather candidate timestamps for Business.created_at fallback
  const candidateTimestamps: string[] = [];
  const collectTs = (val: unknown) => {
    if (isValidTimestampString(val)) {
      candidateTimestamps.push(val.trim());
    }
  };
  for (const rawList of [parsed.clients, parsed.quotations, parsed.invoices, parsed.activities]) {
    if (!rawList) continue;
    for (const rec of rawList) {
      if (!isPlainObject(rec)) continue;
      collectTs(rec.createdAt);
      collectTs(rec.updatedAt);
      collectTs(rec.timestamp);
      if (Array.isArray(rec.payments)) {
        for (const p of rec.payments) {
          if (isPlainObject(p)) {
            collectTs(p.recordedAt);
          }
        }
      }
    }
  }
  candidateTimestamps.sort((a, b) => Date.parse(a) - Date.parse(b));

  // Business ID & timestamps
  const rawProfile = parsed.profile;
  const rawBizId = typeof rawProfile.id === 'string' ? rawProfile.id.trim() : '';
  const bizUuid = rawBizId && isUuid(rawBizId) ? rawBizId : generateId('biz');
  const bizLegacyId = rawBizId && rawBizId !== bizUuid ? rawBizId : null;

  let businessCreatedAt: string;
  if (isValidTimestampString(rawProfile.createdAt)) {
    businessCreatedAt = rawProfile.createdAt.trim();
  } else if (isValidTimestampString(rawProfile.updatedAt)) {
    businessCreatedAt = rawProfile.updatedAt.trim();
    diagnostics.push(
      makeDiagnostic({
        code: 'BUSINESS_CREATED_AT_FALLBACK',
        severity: 'warning',
        stage: 'normalize',
        entityType: 'business',
        recordId: bizUuid,
        field: 'createdAt',
        originalValue: null,
        message: 'Legacy business profile had no createdAt; fell back to business updatedAt.',
        suggestedAction: 'No action required unless an exact historical incorporation timestamp is needed.',
      })
    );
  } else if (candidateTimestamps.length > 0) {
    businessCreatedAt = candidateTimestamps[0];
    diagnostics.push(
      makeDiagnostic({
        code: 'BUSINESS_CREATED_AT_FALLBACK',
        severity: 'warning',
        stage: 'normalize',
        entityType: 'business',
        recordId: bizUuid,
        field: 'createdAt',
        originalValue: null,
        message: 'Legacy business profile had no createdAt/updatedAt; fell back to earliest valid record timestamp.',
        suggestedAction: 'Verify business creation timestamp if required.',
      })
    );
  } else {
    businessCreatedAt = nowIso;
    diagnostics.push(
      makeDiagnostic({
        code: 'BUSINESS_CREATED_AT_FALLBACK',
        severity: 'warning',
        stage: 'normalize',
        entityType: 'business',
        recordId: bizUuid,
        field: 'createdAt',
        originalValue: null,
        message: 'Legacy business profile had no valid timestamps; fell back to migration timestamp.',
        suggestedAction: 'Verify business creation timestamp if required.',
      })
    );
  }

  const businessUpdatedAt = isValidTimestampString(rawProfile.updatedAt)
    ? rawProfile.updatedAt.trim()
    : businessCreatedAt;

  const businessName = asString(rawProfile.name).trim();
  if (!businessName) {
    diagnostics.push(
      makeDiagnostic({
        code: 'CORRUPTED_JSON',
        severity: 'error',
        stage: 'validate',
        entityType: 'business',
        recordId: bizUuid,
        field: 'name',
        originalValue: rawProfile.name,
        message: 'Business profile name is required and cannot be blank.',
        suggestedAction: 'Set a valid business name in Business Settings before migrating.',
      })
    );
  }

  const defaultCurrency = asString(rawProfile.defaultCurrency, 'NAD').trim() || 'NAD';
  const currencySymbol = asString(rawProfile.currencySymbol, 'N$').trim() || 'N$';
  const defaultTaxName = asString(rawProfile.defaultTaxName, 'VAT').trim() || 'VAT';
  const quotePrefix = asString(rawProfile.quotePrefix, 'QUO-').trim() || 'QUO-';
  const invoicePrefix = asString(rawProfile.invoicePrefix, 'INV-').trim() || 'INV-';

  const defaultTaxRatePpm = convertFinancialStrict({
    rawValue: rawProfile.defaultTaxRate ?? 0,
    decimals: 4,
    entityType: 'business',
    recordId: bizUuid,
    field: 'defaultTaxRate',
    diagnostics,
  });

  const nextQuoteNumber = convertFinancialStrict({
    rawValue: rawProfile.nextQuoteNumber ?? 1,
    decimals: 0,
    entityType: 'business',
    recordId: bizUuid,
    field: 'nextQuoteNumber',
    diagnostics,
    allowNegativeWarning: false,
  });
  if (nextQuoteNumber !== null && BigInt(nextQuoteNumber) < 1n) {
    diagnostics.push(
      makeDiagnostic({
        code: 'INVALID_SEQUENCE_NUMBER',
        severity: 'error',
        stage: 'validate',
        entityType: 'business',
        recordId: bizUuid,
        field: 'nextQuoteNumber',
        originalValue: rawProfile.nextQuoteNumber,
        message: 'Business nextQuoteNumber must be >= 1.',
        suggestedAction: 'Set nextQuoteNumber to a positive integer >= 1 before migrating.',
      })
    );
  }

  const nextInvoiceNumber = convertFinancialStrict({
    rawValue: rawProfile.nextInvoiceNumber ?? 1,
    decimals: 0,
    entityType: 'business',
    recordId: bizUuid,
    field: 'nextInvoiceNumber',
    diagnostics,
    allowNegativeWarning: false,
  });
  if (nextInvoiceNumber !== null && BigInt(nextInvoiceNumber) < 1n) {
    diagnostics.push(
      makeDiagnostic({
        code: 'INVALID_SEQUENCE_NUMBER',
        severity: 'error',
        stage: 'validate',
        entityType: 'business',
        recordId: bizUuid,
        field: 'nextInvoiceNumber',
        originalValue: rawProfile.nextInvoiceNumber,
        message: 'Business nextInvoiceNumber must be >= 1.',
        suggestedAction: 'Set nextInvoiceNumber to a positive integer >= 1 before migrating.',
      })
    );
  }

  // Asset deduplication helper
  const assetByHash = new Map<string, CreateBusinessAssetInput>();
  const registerLogoAsset = (
    rawLogoUrl: string,
    createdAt: string
  ): { assetId: string | null; fallbackUrl: string } => {
    const trimmed = rawLogoUrl.trim();
    if (!trimmed) {
      return { assetId: null, fallbackUrl: '' };
    }

    if (/^data:/i.test(trimmed)) {
      const contentHash = sha256Hex(trimmed);
      const existing = assetByHash.get(contentHash);
      if (existing) {
        return { assetId: existing.id, fallbackUrl: '' };
      }
      const meta = extractDataUrlMeta(trimmed);
      const asset: CreateBusinessAssetInput = {
        id: generateId('ast'),
        businessId: bizUuid,
        contentHash,
        sourceType: 'data_url',
        mimeType: meta.mimeType,
        inlineData: trimmed,
        filePath: null,
        externalUrl: null,
        originalFilename: null,
        byteSize: meta.byteSize,
        createdAt,
      };
      assetByHash.set(contentHash, asset);
      return { assetId: asset.id, fallbackUrl: '' };
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const contentHash = sha256Hex(trimmed);
      const existing = assetByHash.get(contentHash);
      if (existing) {
        return { assetId: existing.id, fallbackUrl: '' };
      }
      const asset: CreateBusinessAssetInput = {
        id: generateId('ast'),
        businessId: bizUuid,
        contentHash,
        sourceType: 'external_url',
        mimeType: null,
        inlineData: null,
        filePath: null,
        externalUrl: trimmed,
        originalFilename: null,
        byteSize: null,
        createdAt,
      };
      assetByHash.set(contentHash, asset);
      return { assetId: asset.id, fallbackUrl: '' };
    }

    // Relative paths or non-data/non-http paths stay in logoUrlFallback
    return { assetId: null, fallbackUrl: trimmed };
  };

  const profileLogoRaw = asString(rawProfile.logoUrl).trim();
  const profileLogoAsset = registerLogoAsset(profileLogoRaw, businessCreatedAt);

  const hydrateSnapshotLogoInPayload = (
    rawSnapshotObj: unknown,
    entityType: 'quotation' | 'invoice',
    recordId: string,
    createdAt: string
  ): Record<string, unknown> => {
    if (!isPlainObject(rawSnapshotObj)) {
      return {};
    }
    const copy: Record<string, unknown> = { ...rawSnapshotObj };
    const rawSnapLogo = asString(copy.logoUrl).trim();

    let hydratedLogo = rawSnapLogo;
    if (!rawSnapLogo) {
      if (profileLogoRaw && asString(copy.id).trim() === rawBizId) {
        hydratedLogo = profileLogoRaw;
      }
    } else if (rawSnapLogo === PROFILE_LOGO_MARKER) {
      hydratedLogo = profileLogoRaw;
    } else if (rawSnapLogo.startsWith(LOGO_REF_PREFIX)) {
      const refKey = rawSnapLogo.slice(LOGO_REF_PREFIX.length);
      const cached = logoCache[refKey];
      if (cached) {
        hydratedLogo = cached;
      } else {
        hydratedLogo = profileLogoRaw;
        diagnostics.push(
          makeDiagnostic({
            code: 'MISSING_LOGO_CACHE_REF',
            severity: 'warning',
            stage: 'normalize',
            entityType,
            recordId,
            field: 'businessSnapshot.logoUrl',
            originalValue: rawSnapLogo,
            message: `Logo cache entry '${refKey}' was missing; fell back to profile logo.`,
            suggestedAction: 'Re-upload or inspect the document logo if a historical logo was replaced.',
          })
        );
      }
    }

    copy.logoUrl = hydratedLogo;
    if (hydratedLogo) {
      registerLogoAsset(hydratedLogo, createdAt);
    }
    return copy;
  };

  const bankDetails = isPlainObject(rawProfile.bankDetails) ? rawProfile.bankDetails : {};

  const localProfileId = generateId('prof');
  const localProfile: CreateLocalProfileInput = {
    id: localProfileId,
    displayName: businessName || 'Local User',
    email: asString(rawProfile.email).trim(),
    supabaseUserId: null,
    createdAt: businessCreatedAt,
    updatedAt: businessUpdatedAt,
  };

  const business: CreateBusinessInput = {
    id: bizUuid,
    legacyId: bizLegacyId,
    ownerProfileId: localProfileId,
    name: businessName || 'Unnamed Business',
    tagline: asString(rawProfile.tagline),
    logoAssetId: profileLogoAsset.assetId,
    logoUrlFallback: profileLogoAsset.fallbackUrl,
    email: asString(rawProfile.email),
    phone: asString(rawProfile.phone),
    address: asString(rawProfile.address),
    city: asString(rawProfile.city),
    country: asString(rawProfile.country),
    postalCode: asOptionalNullableString(rawProfile.postalCode),
    website: asOptionalNullableString(rawProfile.website),
    taxNumber: asOptionalNullableString(rawProfile.taxNumber),
    registrationNumber: asOptionalNullableString(rawProfile.registrationNumber),
    defaultCurrency,
    currencySymbol,
    defaultTaxName,
    defaultTaxRatePpm: defaultTaxRatePpm ?? '0',
    isTaxEnabled: typeof rawProfile.isTaxEnabled === 'boolean' ? rawProfile.isTaxEnabled : true,
    quotePrefix,
    invoicePrefix,
    nextQuoteNumber: nextQuoteNumber ?? '1',
    nextInvoiceNumber: nextInvoiceNumber ?? '1',
    defaultTermsQuotation: asString(rawProfile.defaultTermsQuotation),
    defaultTermsInvoice: asString(rawProfile.defaultTermsInvoice),
    defaultNotes: asString(rawProfile.defaultNotes),
    bankName: asString(bankDetails.bankName),
    accountName: asString(bankDetails.accountName),
    accountNumber: asString(bankDetails.accountNumber),
    branchCode: asString(bankDetails.branchCode),
    accountType: asOptionalNullableString(bankDetails.accountType),
    swiftCode: asOptionalNullableString(bankDetails.swiftCode),
    createdAt: businessCreatedAt,
    updatedAt: businessUpdatedAt,
  };

  // ============================================================
  // Clients Normalization
  // ============================================================
  const clients: CreateClientInput[] = [];
  const seenRawClientIds = new Set<string>();
  const clientIdByRawId = new Map<string, string>();

  for (let idx = 0; idx < (parsed.clients ?? []).length; idx++) {
    const raw = (parsed.clients ?? [])[idx];
    if (!isPlainObject(raw)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'extract',
          entityType: 'client',
          recordId: `index:${idx}`,
          field: 'clients',
          originalValue: raw,
          message: `Client entry at index ${idx} is not a valid object.`,
          suggestedAction: 'Repair malformed client entries before migrating.',
        })
      );
      continue;
    }

    const rawId = asString(raw.id).trim();
    if (!rawId) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_ID',
          severity: 'error',
          stage: 'validate',
          entityType: 'client',
          recordId: `index:${idx}`,
          field: 'id',
          originalValue: raw.id,
          message: `Client entry at index ${idx} is missing a valid id.`,
          suggestedAction: 'Assign a unique id to the client record before migrating.',
        })
      );
      continue;
    }
    if (seenRawClientIds.has(rawId)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_ID',
          severity: 'error',
          stage: 'validate',
          entityType: 'client',
          recordId: rawId,
          field: 'id',
          originalValue: rawId,
          message: `Duplicate client id '${rawId}' found in legacy storage.`,
          suggestedAction: 'Deduplicate or assign distinct client IDs before migrating.',
        })
      );
      continue;
    }
    seenRawClientIds.add(rawId);

    const uuid = isUuid(rawId) ? rawId : generateId('cli');
    clientIdByRawId.set(rawId, uuid);

    const clientName = asString(raw.name).trim();
    if (!clientName) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'validate',
          entityType: 'client',
          recordId: uuid,
          field: 'name',
          originalValue: raw.name,
          message: `Client '${rawId}' has an empty name.`,
          suggestedAction: 'Provide a non-empty client name before migrating.',
        })
      );
    }

    const createdAt = isValidTimestampString(raw.createdAt)
      ? raw.createdAt.trim()
      : isValidTimestampString(raw.updatedAt)
        ? raw.updatedAt.trim()
        : businessCreatedAt;
    const updatedAt = isValidTimestampString(raw.updatedAt) ? raw.updatedAt.trim() : createdAt;

    clients.push({
      id: uuid,
      businessId: bizUuid,
      legacyId: rawId !== uuid ? rawId : null,
      name: clientName || 'Unnamed Client',
      companyName: asOptionalNullableString(raw.companyName),
      email: asString(raw.email),
      phone: asString(raw.phone),
      address: asString(raw.address),
      city: asOptionalNullableString(raw.city),
      country: asOptionalNullableString(raw.country),
      vatNumber: asOptionalNullableString(raw.vatNumber),
      notes: asOptionalNullableString(raw.notes),
      createdAt,
      updatedAt,
    });
  }

  // Helper to normalize line items cleanly
  const normalizeLineItems = (
    rawItems: unknown,
    entityType: 'quotation' | 'invoice',
    docUuid: string,
    docCreatedAt: string,
    seenItemIds: Set<string>
  ): LineItemInput[] => {
    if (!Array.isArray(rawItems)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'extract',
          entityType,
          recordId: docUuid,
          field: 'items',
          originalValue: rawItems,
          message: `${entityType} '${docUuid}' items must be an array.`,
          suggestedAction: 'Repair malformed line items array before migrating.',
        })
      );
      return [];
    }

    const out: LineItemInput[] = [];
    for (let idx = 0; idx < rawItems.length; idx++) {
      const rawItem = rawItems[idx];
      if (!isPlainObject(rawItem)) {
        diagnostics.push(
          makeDiagnostic({
            code: 'CORRUPTED_JSON',
            severity: 'error',
            stage: 'extract',
            entityType: `${entityType}_item`,
            recordId: `${docUuid}:${idx}`,
            field: 'items',
            originalValue: rawItem,
            message: `Line item ${idx} on ${entityType} '${docUuid}' is malformed.`,
            suggestedAction: 'Repair malformed line item entry before migrating.',
          })
        );
        continue;
      }

      const rawItemId = asString(rawItem.id).trim();
      if (rawItemId && seenItemIds.has(rawItemId)) {
        diagnostics.push(
          makeDiagnostic({
            code: 'DUPLICATE_ID',
            severity: 'error',
            stage: 'validate',
            entityType: `${entityType}_item`,
            recordId: rawItemId,
            field: 'items.id',
            originalValue: rawItemId,
            message: `Duplicate line item id '${rawItemId}' detected.`,
            suggestedAction: 'Ensure every line item has a unique identifier before migrating.',
          })
        );
        continue;
      }
      if (rawItemId) {
        seenItemIds.add(rawItemId);
      }

      const itemUuid = rawItemId && isUuid(rawItemId) ? rawItemId : generateId('item');
      const quantityScaled = convertFinancialStrict({
        rawValue: rawItem.quantity,
        decimals: 6,
        entityType: `${entityType}_item`,
        recordId: itemUuid,
        field: 'quantity',
        diagnostics,
      });
      const unitPriceScaled = convertFinancialStrict({
        rawValue: rawItem.unitPrice,
        decimals: 6,
        entityType: `${entityType}_item`,
        recordId: itemUuid,
        field: 'unitPrice',
        diagnostics,
      });
      const totalMinor = convertFinancialStrict({
        rawValue: rawItem.total,
        decimals: 2,
        entityType: `${entityType}_item`,
        recordId: itemUuid,
        field: 'total',
        diagnostics,
      });

      out.push({
        id: itemUuid,
        legacyId: rawItemId && rawItemId !== itemUuid ? rawItemId : null,
        sortOrder: toSafeInt64(idx),
        description: asString(rawItem.description),
        quantityScaled: quantityScaled ?? '0',
        unitPriceScaled: unitPriceScaled ?? '0',
        totalMinor: totalMinor ?? '0',
        createdAt: docCreatedAt,
      });
    }
    return out;
  };

  // ============================================================
  // Quotations Normalization
  // ============================================================
  const quoteMetas: NormalizedQuoteMeta[] = [];
  const seenRawQuoteIds = new Set<string>();
  const seenQuoteNumbers = new Set<string>();
  const seenQuoteItemIds = new Set<string>();
  const quoteMetaByRawId = new Map<string, NormalizedQuoteMeta>();
  const quoteMetaByNumberLower = new Map<string, NormalizedQuoteMeta>();

  for (let idx = 0; idx < (parsed.quotations ?? []).length; idx++) {
    const raw = (parsed.quotations ?? [])[idx];
    if (!isPlainObject(raw)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'extract',
          entityType: 'quotation',
          recordId: `index:${idx}`,
          field: 'quotations',
          originalValue: raw,
          message: `Quotation entry at index ${idx} is not an object.`,
          suggestedAction: 'Repair malformed quotation entry before migrating.',
        })
      );
      continue;
    }

    const rawId = asString(raw.id).trim();
    if (!rawId) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_ID',
          severity: 'error',
          stage: 'validate',
          entityType: 'quotation',
          recordId: `index:${idx}`,
          field: 'id',
          originalValue: raw.id,
          message: `Quotation at index ${idx} is missing a valid id.`,
          suggestedAction: 'Assign a unique id to the quotation before migrating.',
        })
      );
      continue;
    }
    if (seenRawQuoteIds.has(rawId)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_ID',
          severity: 'error',
          stage: 'validate',
          entityType: 'quotation',
          recordId: rawId,
          field: 'id',
          originalValue: rawId,
          message: `Duplicate quotation id '${rawId}' found in legacy storage.`,
          suggestedAction: 'Deduplicate or assign distinct quotation IDs before migrating.',
        })
      );
      continue;
    }
    seenRawQuoteIds.add(rawId);

    const uuid = isUuid(rawId) ? rawId : generateId('quo');
    const quotationNumber = asString(raw.quotationNumber).trim();
    if (!quotationNumber) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_DOCUMENT_NUMBER',
          severity: 'error',
          stage: 'validate',
          entityType: 'quotation',
          recordId: uuid,
          field: 'quotationNumber',
          originalValue: raw.quotationNumber,
          message: `Quotation '${rawId}' has an empty quotationNumber.`,
          suggestedAction: 'Provide a unique quotation number before migrating.',
        })
      );
    } else {
      const lowerNum = quotationNumber.toLowerCase();
      if (seenQuoteNumbers.has(lowerNum)) {
        diagnostics.push(
          makeDiagnostic({
            code: 'DUPLICATE_DOCUMENT_NUMBER',
            severity: 'error',
            stage: 'validate',
            entityType: 'quotation',
            recordId: uuid,
            field: 'quotationNumber',
            originalValue: quotationNumber,
            message: `Duplicate quotationNumber '${quotationNumber}' (case-insensitive) detected.`,
            suggestedAction: 'Resolve the duplicate quotation number explicitly; migration never auto-renames documents.',
          })
        );
      } else {
        seenQuoteNumbers.add(lowerNum);
      }
    }

    const createdAt = isValidTimestampString(raw.createdAt)
      ? raw.createdAt.trim()
      : isValidTimestampString(raw.updatedAt)
        ? raw.updatedAt.trim()
        : businessCreatedAt;
    const updatedAt = isValidTimestampString(raw.updatedAt) ? raw.updatedAt.trim() : createdAt;

    const issueDate =
      normalizeRequiredIsoDate({
        rawValue: raw.issueDate,
        entityType: 'quotation',
        recordId: uuid,
        field: 'issueDate',
        diagnostics,
      }) ?? '1970-01-01';

    const expiryDate = normalizeOptionalIsoDate({
      rawValue: raw.expiryDate,
      entityType: 'quotation',
      recordId: uuid,
      field: 'expiryDate',
      diagnostics,
    });

    const rawClientId = asOptionalTrimmedNull(raw.clientId);
    let resolvedClientId: string | null = null;
    if (rawClientId) {
      const mappedClient = clientIdByRawId.get(rawClientId);
      if (mappedClient) {
        resolvedClientId = mappedClient;
      } else {
        diagnostics.push(
          makeDiagnostic({
            code: 'DELETED_CLIENT_PRESERVED',
            severity: 'warning',
            stage: 'relationship',
            entityType: 'quotation',
            recordId: uuid,
            field: 'clientId',
            originalValue: rawClientId,
            message: `Quotation ${quotationNumber || rawId} references deleted client '${rawClientId}'; preserved clientSnapshot with clientId = null.`,
            suggestedAction: 'No action required; snapshot billing details remain intact.',
          })
        );
      }
    }

    const discountTypeRaw = asString(raw.discountType, 'percentage').trim();
    const discountType: DiscountType = VALID_DISCOUNT_TYPES.has(discountTypeRaw as DiscountType)
      ? (discountTypeRaw as DiscountType)
      : 'percentage';
    if (!VALID_DISCOUNT_TYPES.has(discountTypeRaw as DiscountType)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'validate',
          entityType: 'quotation',
          recordId: uuid,
          field: 'discountType',
          originalValue: raw.discountType,
          message: `Invalid quotation discountType '${discountTypeRaw}'.`,
          suggestedAction: 'Fix discountType to percentage or fixed before migrating.',
        })
      );
    }

    const rawStatus = asString(raw.status, 'draft').trim();
    const status: QuotationStatus = VALID_QUOTATION_STATUSES.has(rawStatus as QuotationStatus)
      ? (rawStatus as QuotationStatus)
      : 'draft';
    if (!VALID_QUOTATION_STATUSES.has(rawStatus as QuotationStatus)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'validate',
          entityType: 'quotation',
          recordId: uuid,
          field: 'status',
          originalValue: raw.status,
          message: `Invalid quotation status '${rawStatus}'.`,
          suggestedAction: 'Correct the quotation status value before migrating.',
        })
      );
    }

    const rawPreStatus = asOptionalTrimmedNull(raw.preConversionStatus);
    let preConversionStatus: QuotationStatus | null = null;
    if (rawPreStatus) {
      if (VALID_QUOTATION_STATUSES.has(rawPreStatus as QuotationStatus)) {
        preConversionStatus = rawPreStatus as QuotationStatus;
      } else {
        diagnostics.push(
          makeDiagnostic({
            code: 'CORRUPTED_JSON',
            severity: 'error',
            stage: 'validate',
            entityType: 'quotation',
            recordId: uuid,
            field: 'preConversionStatus',
            originalValue: rawPreStatus,
            message: `Invalid quotation preConversionStatus '${rawPreStatus}'.`,
            suggestedAction: 'Correct or clear invalid preConversionStatus before migrating.',
          })
        );
      }
    }

    const items = normalizeLineItems(raw.items, 'quotation', uuid, createdAt, seenQuoteItemIds);
    const subtotalMinor =
      convertFinancialStrict({
        rawValue: raw.subtotal,
        decimals: 2,
        entityType: 'quotation',
        recordId: uuid,
        field: 'subtotal',
        diagnostics,
      }) ?? '0';

    const discountPercentagePpm =
      discountType === 'percentage'
        ? (convertFinancialStrict({
            rawValue: raw.discountValue ?? 0,
            decimals: 4,
            entityType: 'quotation',
            recordId: uuid,
            field: 'discountValue',
            diagnostics,
          }) ?? '0')
        : '0';

    const discountFixedMinor =
      discountType === 'fixed'
        ? (convertFinancialStrict({
            rawValue: raw.discountValue ?? 0,
            decimals: 2,
            entityType: 'quotation',
            recordId: uuid,
            field: 'discountValue',
            diagnostics,
          }) ?? '0')
        : '0';

    const discountAmountMinor =
      convertFinancialStrict({
        rawValue: raw.discountAmount ?? 0,
        decimals: 2,
        entityType: 'quotation',
        recordId: uuid,
        field: 'discountAmount',
        diagnostics,
      }) ?? '0';

    const taxRatePpm =
      convertFinancialStrict({
        rawValue: raw.taxRate ?? 0,
        decimals: 4,
        entityType: 'quotation',
        recordId: uuid,
        field: 'taxRate',
        diagnostics,
      }) ?? '0';

    const taxAmountMinor =
      convertFinancialStrict({
        rawValue: raw.taxAmount ?? 0,
        decimals: 2,
        entityType: 'quotation',
        recordId: uuid,
        field: 'taxAmount',
        diagnostics,
      }) ?? '0';

    const grandTotalMinor =
      convertFinancialStrict({
        rawValue: raw.grandTotal,
        decimals: 2,
        entityType: 'quotation',
        recordId: uuid,
        field: 'grandTotal',
        diagnostics,
      }) ?? '0';

    const hydratedBusinessSnap = hydrateSnapshotLogoInPayload(
      raw.businessSnapshot,
      'quotation',
      uuid,
      createdAt
    );
    const clientSnapObj = isPlainObject(raw.clientSnapshot) ? raw.clientSnapshot : {};

    const quoteInput: CreateQuotationInput = {
      id: uuid,
      businessId: bizUuid,
      legacyId: rawId !== uuid ? rawId : null,
      clientId: resolvedClientId,
      quotationNumber: quotationNumber || rawId,
      clientSnapshotJson: JSON.stringify(clientSnapObj),
      businessSnapshotJson: JSON.stringify(hydratedBusinessSnap),
      issueDate,
      expiryDate,
      currency: asString(raw.currency, defaultCurrency).trim() || defaultCurrency,
      currencySymbol: asString(raw.currencySymbol, currencySymbol).trim() || currencySymbol,
      subtotalMinor,
      discountType,
      discountPercentagePpm,
      discountFixedMinor,
      discountAmountMinor,
      taxName: asString(raw.taxName, defaultTaxName).trim() || defaultTaxName,
      taxRatePpm,
      taxAmountMinor,
      grandTotalMinor,
      status,
      preConversionStatus,
      notes: asOptionalNullableString(raw.notes),
      terms: asOptionalNullableString(raw.terms),
      convertedInvoiceId: null,
      items,
      createdAt,
      updatedAt,
    };

    const meta: NormalizedQuoteMeta = {
      input: quoteInput,
      rawId,
      rawConvertedInvoiceId: asOptionalTrimmedNull(raw.convertedInvoiceId),
    };
    quoteMetas.push(meta);
    quoteMetaByRawId.set(rawId, meta);
    if (quotationNumber) {
      quoteMetaByNumberLower.set(quotationNumber.toLowerCase(), meta);
    }
  }

  // ============================================================
  // Invoices & Payments Normalization
  // ============================================================
  const invoiceMetas: NormalizedInvoiceMeta[] = [];
  const allPayments: CreatePaymentInput[] = [];
  const seenRawInvoiceIds = new Set<string>();
  const seenInvoiceNumbers = new Set<string>();
  const seenInvoiceItemIds = new Set<string>();
  const seenRawPaymentIds = new Set<string>();
  const paymentUuidByRawId = new Map<string, string>();
  const invoiceMetaByRawId = new Map<string, NormalizedInvoiceMeta>();
  const invoiceMetaByNumberLower = new Map<string, NormalizedInvoiceMeta>();

  for (let idx = 0; idx < (parsed.invoices ?? []).length; idx++) {
    const raw = (parsed.invoices ?? [])[idx];
    if (!isPlainObject(raw)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'extract',
          entityType: 'invoice',
          recordId: `index:${idx}`,
          field: 'invoices',
          originalValue: raw,
          message: `Invoice entry at index ${idx} is not an object.`,
          suggestedAction: 'Repair malformed invoice entry before migrating.',
        })
      );
      continue;
    }

    const rawId = asString(raw.id).trim();
    if (!rawId) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_ID',
          severity: 'error',
          stage: 'validate',
          entityType: 'invoice',
          recordId: `index:${idx}`,
          field: 'id',
          originalValue: raw.id,
          message: `Invoice at index ${idx} is missing a valid id.`,
          suggestedAction: 'Assign a unique id to the invoice before migrating.',
        })
      );
      continue;
    }
    if (seenRawInvoiceIds.has(rawId)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_ID',
          severity: 'error',
          stage: 'validate',
          entityType: 'invoice',
          recordId: rawId,
          field: 'id',
          originalValue: rawId,
          message: `Duplicate invoice id '${rawId}' found in legacy storage.`,
          suggestedAction: 'Deduplicate or assign distinct invoice IDs before migrating.',
        })
      );
      continue;
    }
    seenRawInvoiceIds.add(rawId);

    const uuid = isUuid(rawId) ? rawId : generateId('inv');
    const invoiceNumber = asString(raw.invoiceNumber).trim();
    if (!invoiceNumber) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_DOCUMENT_NUMBER',
          severity: 'error',
          stage: 'validate',
          entityType: 'invoice',
          recordId: uuid,
          field: 'invoiceNumber',
          originalValue: raw.invoiceNumber,
          message: `Invoice '${rawId}' has an empty invoiceNumber.`,
          suggestedAction: 'Provide a unique invoice number before migrating.',
        })
      );
    } else {
      const lowerNum = invoiceNumber.toLowerCase();
      if (seenInvoiceNumbers.has(lowerNum)) {
        diagnostics.push(
          makeDiagnostic({
            code: 'DUPLICATE_DOCUMENT_NUMBER',
            severity: 'error',
            stage: 'validate',
            entityType: 'invoice',
            recordId: uuid,
            field: 'invoiceNumber',
            originalValue: invoiceNumber,
            message: `Duplicate invoiceNumber '${invoiceNumber}' (case-insensitive) detected.`,
            suggestedAction: 'Resolve the duplicate invoice number explicitly; migration never auto-renames documents.',
          })
        );
      } else {
        seenInvoiceNumbers.add(lowerNum);
      }
    }

    const createdAt = isValidTimestampString(raw.createdAt)
      ? raw.createdAt.trim()
      : isValidTimestampString(raw.updatedAt)
        ? raw.updatedAt.trim()
        : businessCreatedAt;
    const updatedAt = isValidTimestampString(raw.updatedAt) ? raw.updatedAt.trim() : createdAt;

    const issueDate =
      normalizeRequiredIsoDate({
        rawValue: raw.issueDate,
        entityType: 'invoice',
        recordId: uuid,
        field: 'issueDate',
        diagnostics,
      }) ?? '1970-01-01';

    const dueDate = normalizeOptionalIsoDate({
      rawValue: raw.dueDate,
      entityType: 'invoice',
      recordId: uuid,
      field: 'dueDate',
      diagnostics,
    });

    const rawClientId = asOptionalTrimmedNull(raw.clientId);
    let resolvedClientId: string | null = null;
    if (rawClientId) {
      const mappedClient = clientIdByRawId.get(rawClientId);
      if (mappedClient) {
        resolvedClientId = mappedClient;
      } else {
        diagnostics.push(
          makeDiagnostic({
            code: 'DELETED_CLIENT_PRESERVED',
            severity: 'warning',
            stage: 'relationship',
            entityType: 'invoice',
            recordId: uuid,
            field: 'clientId',
            originalValue: rawClientId,
            message: `Invoice ${invoiceNumber || rawId} references deleted client '${rawClientId}'; preserved clientSnapshot with clientId = null.`,
            suggestedAction: 'No action required; snapshot billing details remain intact.',
          })
        );
      }
    }

    const discountTypeRaw = asString(raw.discountType, 'percentage').trim();
    const discountType: DiscountType = VALID_DISCOUNT_TYPES.has(discountTypeRaw as DiscountType)
      ? (discountTypeRaw as DiscountType)
      : 'percentage';
    if (!VALID_DISCOUNT_TYPES.has(discountTypeRaw as DiscountType)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'validate',
          entityType: 'invoice',
          recordId: uuid,
          field: 'discountType',
          originalValue: raw.discountType,
          message: `Invalid invoice discountType '${discountTypeRaw}'.`,
          suggestedAction: 'Fix discountType to percentage or fixed before migrating.',
        })
      );
    }

    const rawStatus = asString(raw.status, 'draft').trim();
    const status: InvoiceStatus = VALID_INVOICE_STATUSES.has(rawStatus as InvoiceStatus)
      ? (rawStatus as InvoiceStatus)
      : 'draft';
    if (!VALID_INVOICE_STATUSES.has(rawStatus as InvoiceStatus)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'validate',
          entityType: 'invoice',
          recordId: uuid,
          field: 'status',
          originalValue: raw.status,
          message: `Invalid invoice status '${rawStatus}'.`,
          suggestedAction: 'Correct the invoice status value before migrating.',
        })
      );
    }

    const items = normalizeLineItems(raw.items, 'invoice', uuid, createdAt, seenInvoiceItemIds);
    const subtotalMinor =
      convertFinancialStrict({
        rawValue: raw.subtotal,
        decimals: 2,
        entityType: 'invoice',
        recordId: uuid,
        field: 'subtotal',
        diagnostics,
      }) ?? '0';

    const discountPercentagePpm =
      discountType === 'percentage'
        ? (convertFinancialStrict({
            rawValue: raw.discountValue ?? 0,
            decimals: 4,
            entityType: 'invoice',
            recordId: uuid,
            field: 'discountValue',
            diagnostics,
          }) ?? '0')
        : '0';

    const discountFixedMinor =
      discountType === 'fixed'
        ? (convertFinancialStrict({
            rawValue: raw.discountValue ?? 0,
            decimals: 2,
            entityType: 'invoice',
            recordId: uuid,
            field: 'discountValue',
            diagnostics,
          }) ?? '0')
        : '0';

    const discountAmountMinor =
      convertFinancialStrict({
        rawValue: raw.discountAmount ?? 0,
        decimals: 2,
        entityType: 'invoice',
        recordId: uuid,
        field: 'discountAmount',
        diagnostics,
      }) ?? '0';

    const taxRatePpm =
      convertFinancialStrict({
        rawValue: raw.taxRate ?? 0,
        decimals: 4,
        entityType: 'invoice',
        recordId: uuid,
        field: 'taxRate',
        diagnostics,
      }) ?? '0';

    const taxAmountMinor =
      convertFinancialStrict({
        rawValue: raw.taxAmount ?? 0,
        decimals: 2,
        entityType: 'invoice',
        recordId: uuid,
        field: 'taxAmount',
        diagnostics,
      }) ?? '0';

    const grandTotalMinor =
      convertFinancialStrict({
        rawValue: raw.grandTotal,
        decimals: 2,
        entityType: 'invoice',
        recordId: uuid,
        field: 'grandTotal',
        diagnostics,
      }) ?? '0';

    const amountPaidMinor =
      convertFinancialStrict({
        rawValue: raw.amountPaid ?? 0,
        decimals: 2,
        entityType: 'invoice',
        recordId: uuid,
        field: 'amountPaid',
        diagnostics,
      }) ?? '0';

    const outstandingBalanceMinor =
      convertFinancialStrict({
        rawValue: raw.outstandingBalance ?? 0,
        decimals: 2,
        entityType: 'invoice',
        recordId: uuid,
        field: 'outstandingBalance',
        diagnostics,
      }) ?? '0';

    // Payments preserved independently without recalculating invoice balances
    const rawPayments = Array.isArray(raw.payments) ? raw.payments : raw.payments === undefined ? [] : null;
    const invoicePayments: CreatePaymentInput[] = [];
    if (rawPayments === null) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'extract',
          entityType: 'invoice',
          recordId: uuid,
          field: 'payments',
          originalValue: raw.payments,
          message: `Invoice '${uuid}' payments must be an array.`,
          suggestedAction: 'Repair malformed payments array before migrating.',
        })
      );
    } else {
      let paymentSumMinor = 0n;
      for (let pIdx = 0; pIdx < rawPayments.length; pIdx++) {
        const rawPay = rawPayments[pIdx];
        if (!isPlainObject(rawPay)) {
          diagnostics.push(
            makeDiagnostic({
              code: 'CORRUPTED_JSON',
              severity: 'error',
              stage: 'extract',
              entityType: 'payment',
              recordId: `${uuid}:${pIdx}`,
              field: 'payments',
              originalValue: rawPay,
              message: `Payment entry ${pIdx} on invoice '${uuid}' is malformed.`,
              suggestedAction: 'Repair malformed payment object before migrating.',
            })
          );
          continue;
        }

        const rawPayId = asString(rawPay.id).trim();
        if (rawPayId && seenRawPaymentIds.has(rawPayId)) {
          diagnostics.push(
            makeDiagnostic({
              code: 'DUPLICATE_ID',
              severity: 'error',
              stage: 'validate',
              entityType: 'payment',
              recordId: rawPayId,
              field: 'payments.id',
              originalValue: rawPayId,
              message: `Duplicate payment id '${rawPayId}' detected.`,
              suggestedAction: 'Ensure all payment IDs are unique before migrating.',
            })
          );
          continue;
        }
        if (rawPayId) {
          seenRawPaymentIds.add(rawPayId);
        }

        const payUuid = rawPayId && isUuid(rawPayId) ? rawPayId : generateId('pay');
        if (rawPayId) {
          paymentUuidByRawId.set(rawPayId, payUuid);
        }

        const amountMinor =
          convertFinancialStrict({
            rawValue: rawPay.amount,
            decimals: 2,
            entityType: 'payment',
            recordId: payUuid,
            field: 'amount',
            diagnostics,
          }) ?? '0';

        paymentSumMinor += parseSafeInt64(amountMinor);

        const paymentDate =
          normalizeRequiredIsoDate({
            rawValue: rawPay.paymentDate,
            entityType: 'payment',
            recordId: payUuid,
            field: 'paymentDate',
            diagnostics,
          }) ?? '1970-01-01';

        const rawMethod = asString(rawPay.paymentMethod, 'other').trim();
        const paymentMethod: PaymentMethod = VALID_PAYMENT_METHODS.has(rawMethod as PaymentMethod)
          ? (rawMethod as PaymentMethod)
          : 'other';
        if (!VALID_PAYMENT_METHODS.has(rawMethod as PaymentMethod)) {
          diagnostics.push(
            makeDiagnostic({
              code: 'CORRUPTED_JSON',
              severity: 'error',
              stage: 'validate',
              entityType: 'payment',
              recordId: payUuid,
              field: 'paymentMethod',
              originalValue: rawPay.paymentMethod,
              message: `Invalid paymentMethod '${rawMethod}'.`,
              suggestedAction: 'Use a supported payment method before migrating.',
            })
          );
        }

        const recordedAt = isValidTimestampString(rawPay.recordedAt)
          ? rawPay.recordedAt.trim()
          : `${paymentDate}T00:00:00.000Z`;

        const paymentInput: CreatePaymentInput = {
          id: payUuid,
          businessId: bizUuid,
          invoiceId: uuid,
          legacyId: rawPayId && rawPayId !== payUuid ? rawPayId : null,
          amountMinor,
          paymentDate,
          paymentMethod,
          reference: asOptionalNullableString(rawPay.reference),
          notes: asOptionalNullableString(rawPay.notes),
          recordedAt,
        };
        invoicePayments.push(paymentInput);
        allPayments.push(paymentInput);
      }

      if (paymentSumMinor !== parseSafeInt64(amountPaidMinor)) {
        diagnostics.push(
          makeDiagnostic({
            code: 'INVOICE_PAYMENT_SUM_MISMATCH',
            severity: 'warning',
            stage: 'normalize',
            entityType: 'invoice',
            recordId: uuid,
            field: 'amountPaid',
            originalValue: `amountPaidMinor=${amountPaidMinor}, paymentSumMinor=${paymentSumMinor.toString()}`,
            message: `Invoice ${invoiceNumber || rawId} amountPaid differs from the sum of its payment records; both values were preserved verbatim.`,
            suggestedAction: 'Review historical invoice payment ledger after migration.',
          })
        );
      }
    }

    const hydratedBusinessSnap = hydrateSnapshotLogoInPayload(
      raw.businessSnapshot,
      'invoice',
      uuid,
      createdAt
    );
    const clientSnapObj = isPlainObject(raw.clientSnapshot) ? raw.clientSnapshot : {};

    const invoiceInput: CreateInvoiceInput = {
      id: uuid,
      businessId: bizUuid,
      legacyId: rawId !== uuid ? rawId : null,
      clientId: resolvedClientId,
      quotationId: null,
      invoiceNumber: invoiceNumber || rawId,
      clientSnapshotJson: JSON.stringify(clientSnapObj),
      businessSnapshotJson: JSON.stringify(hydratedBusinessSnap),
      issueDate,
      dueDate,
      currency: asString(raw.currency, defaultCurrency).trim() || defaultCurrency,
      currencySymbol: asString(raw.currencySymbol, currencySymbol).trim() || currencySymbol,
      subtotalMinor,
      discountType,
      discountPercentagePpm,
      discountFixedMinor,
      discountAmountMinor,
      taxName: asString(raw.taxName, defaultTaxName).trim() || defaultTaxName,
      taxRatePpm,
      taxAmountMinor,
      grandTotalMinor,
      amountPaidMinor,
      outstandingBalanceMinor,
      status,
      notes: asOptionalNullableString(raw.notes),
      terms: asOptionalNullableString(raw.terms),
      paymentInstructions: asOptionalNullableString(raw.paymentInstructions),
      items,
      createdAt,
      updatedAt,
    };

    const meta: NormalizedInvoiceMeta = {
      input: invoiceInput,
      rawId,
      rawQuotationId: asOptionalTrimmedNull(raw.quotationId),
      payments: invoicePayments,
    };
    invoiceMetas.push(meta);
    invoiceMetaByRawId.set(rawId, meta);
    if (invoiceNumber) {
      invoiceMetaByNumberLower.set(invoiceNumber.toLowerCase(), meta);
    }
  }

  // ============================================================
  // Revision 3 Order-Independent Relationship Resolution (Passes 1-5)
  // ============================================================
  const resolveQuoteByRef = (ref: string | null): NormalizedQuoteMeta | undefined => {
    if (!ref) return undefined;
    const trimmed = ref.trim();
    if (!trimmed) return undefined;
    return quoteMetaByRawId.get(trimmed) ?? quoteMetaByNumberLower.get(trimmed.toLowerCase());
  };

  const resolveInvoiceByRef = (ref: string | null): NormalizedInvoiceMeta | undefined => {
    if (!ref) return undefined;
    const trimmed = ref.trim();
    if (!trimmed) return undefined;
    return invoiceMetaByRawId.get(trimmed) ?? invoiceMetaByNumberLower.get(trimmed.toLowerCase());
  };

  // Pass 1: Resolve invoices.quotationId first (preserving all historical invoices per quotation)
  const invoicesByQuoteUuid = new Map<string, NormalizedInvoiceMeta[]>();
  for (const invMeta of invoiceMetas) {
    if (!invMeta.rawQuotationId) {
      invMeta.input.quotationId = null;
      continue;
    }
    const matchedQuote = resolveQuoteByRef(invMeta.rawQuotationId);
    if (matchedQuote) {
      invMeta.input.quotationId = matchedQuote.input.id;
      const list = invoicesByQuoteUuid.get(matchedQuote.input.id) ?? [];
      list.push(invMeta);
      invoicesByQuoteUuid.set(matchedQuote.input.id, list);
    } else {
      invMeta.input.quotationId = null;
      diagnostics.push(
        makeDiagnostic({
          code: 'DANGLING_INVOICE_QUOTATION_REF',
          severity: 'warning',
          stage: 'relationship',
          entityType: 'invoice',
          recordId: invMeta.input.id,
          field: 'quotationId',
          originalValue: invMeta.rawQuotationId,
          message: `Invoice ${invMeta.input.invoiceNumber} referenced non-existent quotation '${invMeta.rawQuotationId}'; cleared quotationId.`,
          suggestedAction: 'Verify the invoice quotation link if the source quotation was previously deleted.',
        })
      );
    }
  }

  // Pass 2: Reserve canonical convertedInvoiceId for quotations with explicit invoice back-links
  const reservedInvoiceUuids = new Set<string>();
  const quotesHandledInPass2 = new Set<string>();

  for (const qMeta of quoteMetas) {
    const linkedInvoices = invoicesByQuoteUuid.get(qMeta.input.id);
    if (!linkedInvoices || linkedInvoices.length === 0) {
      continue;
    }

    quotesHandledInPass2.add(qMeta.input.id);
    const preferredFromRaw = resolveInvoiceByRef(qMeta.rawConvertedInvoiceId);
    let chosenInvoice: NormalizedInvoiceMeta | undefined =
      preferredFromRaw && linkedInvoices.some((inv) => inv.input.id === preferredFromRaw.input.id)
        ? preferredFromRaw
        : undefined;

    if (!chosenInvoice) {
      const sorted = [...linkedInvoices].sort((a, b) => {
        const ca = parseTimestampMs(a.input.createdAt);
        const cb = parseTimestampMs(b.input.createdAt);
        if (ca !== cb) return ca - cb;
        const cs = compareAscNullableStr(a.input.createdAt ?? '', b.input.createdAt ?? '');
        if (cs !== 0) return cs;
        const issueCmp = compareAscNullableStr(a.input.issueDate, b.input.issueDate);
        if (issueCmp !== 0) return issueCmp;
        const numCmp = compareAscNullableStr(
          a.input.invoiceNumber.toLowerCase(),
          b.input.invoiceNumber.toLowerCase()
        );
        if (numCmp !== 0) return numCmp;
        return compareAscNullableStr(a.input.id, b.input.id);
      });
      chosenInvoice = sorted[0];
    }

    qMeta.input.convertedInvoiceId = chosenInvoice.input.id;
    reservedInvoiceUuids.add(chosenInvoice.input.id);

    // If quotation's raw convertedInvoiceId pointed elsewhere, report the conflict
    if (
      qMeta.rawConvertedInvoiceId &&
      (!preferredFromRaw || preferredFromRaw.input.id !== chosenInvoice.input.id)
    ) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_CONVERTED_INVOICE_CLAIM',
          severity: 'warning',
          stage: 'relationship',
          entityType: 'quotation',
          recordId: qMeta.input.id,
          field: 'convertedInvoiceId',
          originalValue: qMeta.rawConvertedInvoiceId,
          message: `Quotation ${qMeta.input.quotationNumber} stale convertedInvoiceId was superseded by explicit invoice quotationId link.`,
          suggestedAction: 'Confirm canonical converted invoice on the quotation after migration.',
        })
      );
    }
  }

  // Pass 3: Resolve remaining valid forward convertedInvoiceId claims (order-independent)
  const forwardClaimantsByInvoiceUuid = new Map<string, NormalizedQuoteMeta[]>();

  for (const qMeta of quoteMetas) {
    if (quotesHandledInPass2.has(qMeta.input.id)) continue;
    if (!qMeta.rawConvertedInvoiceId) continue;

    const targetInv = resolveInvoiceByRef(qMeta.rawConvertedInvoiceId);
    if (!targetInv) {
      // Dangling target -> handled in Pass 5 unlinked restoration
      qMeta.input.convertedInvoiceId = null;
      continue;
    }

    // Cannot claim an invoice already owned by another quotation or reserved in Pass 2
    if (targetInv.input.quotationId !== null || reservedInvoiceUuids.has(targetInv.input.id)) {
      qMeta.input.convertedInvoiceId = null;
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_CONVERTED_INVOICE_CLAIM',
          severity: 'warning',
          stage: 'relationship',
          entityType: 'quotation',
          recordId: qMeta.input.id,
          field: 'convertedInvoiceId',
          originalValue: qMeta.rawConvertedInvoiceId,
          message: `Quotation ${qMeta.input.quotationNumber} forward convertedInvoiceId claim conflicted with an invoice already linked to another quotation.`,
          suggestedAction: 'Review quotation-to-invoice linkage after migration.',
        })
      );
      continue;
    }

    const list = forwardClaimantsByInvoiceUuid.get(targetInv.input.id) ?? [];
    list.push(qMeta);
    forwardClaimantsByInvoiceUuid.set(targetInv.input.id, list);
  }

  for (const [invoiceUuid, claimants] of forwardClaimantsByInvoiceUuid.entries()) {
    const sorted = [...claimants].sort((a, b) => {
      const ua = parseTimestampMs(a.input.updatedAt);
      const ub = parseTimestampMs(b.input.updatedAt);
      if (ua !== ub) return ub - ua; // updatedAt DESC
      const uStr = compareAscNullableStr(b.input.updatedAt ?? '', a.input.updatedAt ?? '');
      if (uStr !== 0) return uStr;

      const ca = parseTimestampMs(a.input.createdAt);
      const cb = parseTimestampMs(b.input.createdAt);
      if (ca !== cb) return cb - ca; // createdAt DESC
      const cStr = compareAscNullableStr(b.input.createdAt ?? '', a.input.createdAt ?? '');
      if (cStr !== 0) return cStr;

      const numCmp = compareAscNullableStr(
        a.input.quotationNumber.toLowerCase(),
        b.input.quotationNumber.toLowerCase()
      );
      if (numCmp !== 0) return numCmp;
      return compareAscNullableStr(a.input.id, b.input.id);
    });

    const winner = sorted[0];
    winner.input.convertedInvoiceId = invoiceUuid;
    reservedInvoiceUuids.add(invoiceUuid);
    // Explicitly NEVER invent invoice.quotationId for forward-only claims!

    for (let i = 1; i < sorted.length; i++) {
      const loser = sorted[i];
      loser.input.convertedInvoiceId = null;
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_CONVERTED_INVOICE_CLAIM',
          severity: 'warning',
          stage: 'relationship',
          entityType: 'quotation',
          recordId: loser.input.id,
          field: 'convertedInvoiceId',
          originalValue: loser.rawConvertedInvoiceId,
          message: `Cleared competing convertedInvoiceId claim on quotation ${loser.input.quotationNumber}; kept winner ${winner.input.quotationNumber}.`,
          suggestedAction: 'Verify the converted quotation link if multiple quotations referenced the same invoice.',
        })
      );
    }
  }

  // Pass 4 & Pass 5: Remaining unlinked quotations & status normalization
  for (const qMeta of quoteMetas) {
    const q = qMeta.input;
    const hasLinkedInvoices = (invoicesByQuoteUuid.get(q.id)?.length ?? 0) > 0;
    const hasHistoricalLink = q.convertedInvoiceId !== null || hasLinkedInvoices;

    if (hasHistoricalLink) {
      if (q.status === 'declined') {
        diagnostics.push(
          makeDiagnostic({
            code: 'DECLINED_LINKED_QUOTATION',
            severity: 'warning',
            stage: 'relationship',
            entityType: 'quotation',
            recordId: q.id,
            field: 'status',
            originalValue: q.status,
            message: `Quotation ${q.quotationNumber} is declined yet historically linked to an invoice; preserved declined status.`,
            suggestedAction: 'Review historical declined-and-invoiced quotation if status update is desired.',
          })
        );
      } else if (q.status !== 'accepted') {
        const previousStatus = q.status;
        q.preConversionStatus = q.preConversionStatus ?? previousStatus;
        q.status = 'accepted';
        diagnostics.push(
          makeDiagnostic({
            code: 'QUOTATION_STATUS_NORMALIZED',
            severity: 'info',
            stage: 'relationship',
            entityType: 'quotation',
            recordId: q.id,
            field: 'status',
            originalValue: previousStatus,
            message: `Normalized linked quotation ${q.quotationNumber} status from '${previousStatus}' to 'accepted'.`,
            suggestedAction: 'No action required; preConversionStatus preserved.',
          })
        );
      }
    } else {
      q.convertedInvoiceId = null;
      if (qMeta.rawConvertedInvoiceId !== null || q.preConversionStatus !== null) {
        const prevStatus = q.status;
        const restored = restoreUnlinkedQuotationStatus(
          q.status,
          q.expiryDate ?? undefined,
          q.preConversionStatus ?? undefined
        );
        q.status = restored;
        q.preConversionStatus = null;
        diagnostics.push(
          makeDiagnostic({
            code: 'UNLINKED_QUOTATION_RESTORED',
            severity: 'warning',
            stage: 'relationship',
            entityType: 'quotation',
            recordId: q.id,
            field: 'convertedInvoiceId',
            originalValue: qMeta.rawConvertedInvoiceId ?? prevStatus,
            message: `Cleared stale conversion link on quotation ${q.quotationNumber} and restored status to '${restored}'.`,
            suggestedAction: 'Confirm quotation status is accurate after migration.',
          })
        );
      }
    }
  }

  // ============================================================
  // Activity Logs Normalization
  // ============================================================
  const activityLogs: CreateActivityLogInput[] = [];
  const seenRawActivityIds = new Set<string>();

  for (let idx = 0; idx < (parsed.activities ?? []).length; idx++) {
    const raw = (parsed.activities ?? [])[idx];
    if (!isPlainObject(raw)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'extract',
          entityType: 'activity_log',
          recordId: `index:${idx}`,
          field: 'activities',
          originalValue: raw,
          message: `Activity log entry at index ${idx} is not an object.`,
          suggestedAction: 'Repair malformed activity log entry before migrating.',
        })
      );
      continue;
    }

    const rawId = asString(raw.id).trim();
    if (!rawId) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_ID',
          severity: 'error',
          stage: 'validate',
          entityType: 'activity_log',
          recordId: `index:${idx}`,
          field: 'id',
          originalValue: raw.id,
          message: `Activity log at index ${idx} is missing a valid id.`,
          suggestedAction: 'Assign a unique id to the activity log entry before migrating.',
        })
      );
      continue;
    }
    if (seenRawActivityIds.has(rawId)) {
      diagnostics.push(
        makeDiagnostic({
          code: 'DUPLICATE_ID',
          severity: 'error',
          stage: 'validate',
          entityType: 'activity_log',
          recordId: rawId,
          field: 'id',
          originalValue: rawId,
          message: `Duplicate activity log id '${rawId}' detected.`,
          suggestedAction: 'Deduplicate activity log IDs before migrating.',
        })
      );
      continue;
    }
    seenRawActivityIds.add(rawId);

    const uuid = isUuid(rawId) ? rawId : generateId('act');
    const rawType = asString(raw.type).trim();
    if (!VALID_ACTIVITY_TYPES.has(rawType as CreateActivityLogInput['type'])) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'validate',
          entityType: 'activity_log',
          recordId: uuid,
          field: 'type',
          originalValue: raw.type,
          message: `Unsupported activity log type '${rawType}'.`,
          suggestedAction: 'Fix activity log type to a valid Bizora activity event type before migrating.',
        })
      );
      continue;
    }

    const actType = rawType as CreateActivityLogInput['type'];
    const title = asString(raw.title).trim();
    if (!title) {
      diagnostics.push(
        makeDiagnostic({
          code: 'CORRUPTED_JSON',
          severity: 'error',
          stage: 'validate',
          entityType: 'activity_log',
          recordId: uuid,
          field: 'title',
          originalValue: raw.title,
          message: `Activity log '${rawId}' title cannot be blank.`,
          suggestedAction: 'Provide a non-empty activity log title before migrating.',
        })
      );
    }

    const rawRefId = asOptionalTrimmedNull(raw.referenceId);
    let mappedRefId: string | null = null;
    let referenceType: string | null = null;

    if (rawRefId) {
      if (rawRefId === rawBizId) {
        mappedRefId = bizUuid;
        referenceType = 'business';
      } else if (clientIdByRawId.has(rawRefId)) {
        mappedRefId = clientIdByRawId.get(rawRefId) ?? null;
        referenceType = 'client';
      } else if (quoteMetaByRawId.has(rawRefId)) {
        mappedRefId = quoteMetaByRawId.get(rawRefId)?.input.id ?? null;
        referenceType = 'quotation';
      } else if (invoiceMetaByRawId.has(rawRefId)) {
        mappedRefId = invoiceMetaByRawId.get(rawRefId)?.input.id ?? null;
        referenceType = 'invoice';
      } else if (paymentUuidByRawId.has(rawRefId)) {
        mappedRefId = paymentUuidByRawId.get(rawRefId) ?? null;
        referenceType = 'payment';
      } else if (isUuid(rawRefId)) {
        mappedRefId = rawRefId;
      }
    }

    if (!referenceType) {
      if (actType === 'quote_created' || actType === 'quote_converted' || actType === 'quote_status') {
        referenceType = 'quotation';
      } else if (actType === 'invoice_created' || actType === 'payment_recorded' || actType === 'invoice_status') {
        referenceType = 'invoice';
      } else if (actType === 'client_created') {
        referenceType = 'client';
      } else if (actType === 'settings_updated') {
        referenceType = 'business';
      }
    }

    const timestamp = isValidTimestampString(raw.timestamp) ? raw.timestamp.trim() : nowIso;

    activityLogs.push({
      id: uuid,
      businessId: bizUuid,
      legacyId: rawId !== uuid ? rawId : null,
      type: actType,
      title: title || 'Activity',
      description: asString(raw.description),
      timestamp,
      referenceId: mappedRefId,
      referenceType,
      actorLocalProfileId: null,
    });
  }

  // ============================================================
  // Theme Preference Setting Normalization
  // ============================================================
  const settings: SaveAppSettingInput[] = [];
  if (parsed.themeRaw !== null) {
    let themeCandidate: unknown = parsed.themeRaw.trim();
    if (
      typeof themeCandidate === 'string' &&
      themeCandidate.startsWith('"') &&
      themeCandidate.endsWith('"')
    ) {
      try {
        themeCandidate = JSON.parse(themeCandidate);
      } catch {
        // leave unparsed candidate for validation
      }
    }

    if (isValidThemeMode(themeCandidate)) {
      settings.push({
        key: 'theme_preference',
        valueJson: JSON.stringify(themeCandidate),
        updatedAt: nowIso,
      });
    } else {
      diagnostics.push(
        makeDiagnostic({
          code: 'INVALID_THEME_PREFERENCE',
          severity: 'warning',
          stage: 'normalize',
          entityType: 'setting',
          recordId: THEME_STORAGE_KEY,
          field: 'theme_preference',
          originalValue: parsed.themeRaw,
          message: 'Ignored unrecognized theme preference value; fell back to system default.',
          suggestedAction: 'Choose preferred theme in Settings if needed.',
        })
      );
    }
  }

  // ============================================================
  // Exact Scaled Expected Financial Sums (BigInt)
  // ============================================================
  const quotations = quoteMetas.map((m) => m.input);
  const invoices = invoiceMetas.map((m) => m.input);

  let quotationGrandTotalSum = 0n;
  for (const q of quotations) {
    quotationGrandTotalSum += parseSafeInt64(q.grandTotalMinor);
  }
  let invoiceGrandTotalSum = 0n;
  let invoiceAmountPaidSum = 0n;
  for (const inv of invoices) {
    invoiceGrandTotalSum += parseSafeInt64(inv.grandTotalMinor);
    invoiceAmountPaidSum += parseSafeInt64(inv.amountPaidMinor);
  }
  let paymentAmountSum = 0n;
  for (const pay of allPayments) {
    paymentAmountSum += parseSafeInt64(pay.amountMinor);
  }

  let expectedFinancialSums: ExpectedFinancialSumsInput | null = null;
  try {
    expectedFinancialSums = {
      quotationGrandTotalSumMinor: toSafeInt64(quotationGrandTotalSum),
      invoiceGrandTotalSumMinor: toSafeInt64(invoiceGrandTotalSum),
      invoiceAmountPaidSumMinor: toSafeInt64(invoiceAmountPaidSum),
      paymentAmountSumMinor: toSafeInt64(paymentAmountSum),
    };
  } catch (err) {
    diagnostics.push(
      makeDiagnostic({
        code: 'NUMERIC_OVERFLOW',
        severity: 'error',
        stage: 'validate',
        entityType: 'workspace',
        recordId: bizUuid,
        field: 'expectedFinancialSums',
        originalValue: null,
        message: err instanceof Error ? err.message : 'Workspace financial sum overflowed signed 64-bit integer.',
        suggestedAction: 'Inspect extreme financial values before migrating.',
      })
    );
  }

  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  if (hasErrors) {
    return {
      classification,
      payload: null,
      diagnostics,
      hasErrors: true,
    };
  }

  return {
    classification,
    payload: {
      localProfile,
      business,
      assets: Array.from(assetByHash.values()),
      clients,
      quotations,
      invoices,
      payments: allPayments,
      activityLogs,
      settings,
      diagnostics,
      expectedFinancialSums,
    },
    diagnostics,
    hasErrors: false,
  };
}

// ============================================================
// Explicit Migration Runner (Backup-Before-Validation)
// ============================================================

export async function runExplicitLocalStorageMigration(
  options?: RunMigrationOptions
): Promise<ExplicitMigrationOutcome> {
  const getRawSnapshot = options?.deps?.getRawSnapshot ?? (() => StorageService.getRawMigrationSnapshot());
  const getMigrationStatus =
    options?.deps?.getMigrationStatus ?? (() => DesktopDatabaseService.getMigrationStatus());
  const backupLegacyLocalstorage =
    options?.deps?.backupLegacyLocalstorage ??
    ((input: BackupLegacyStorageInput) => DesktopDatabaseService.backupLegacyLocalstorage(input));
  const migrateLegacyWorkspace =
    options?.deps?.migrateLegacyWorkspace ??
    ((input: LegacyWorkspaceMigrationInput) => DesktopDatabaseService.migrateLegacyWorkspace(input));

  // 1. Capture unmodified raw snapshot (never mutates LocalStorage or calls StorageService.init())
  const snapshot = getRawSnapshot();

  // 2. Check existing SQLite migration state BEFORE writing or importing anything
  const status = await getMigrationStatus();
  if (status.state === 'completed') {
    return {
      outcome: 'already_completed',
      status,
      diagnostics: [],
    };
  }
  if (status.state === 'conflict_existing_data') {
    return {
      outcome: 'conflict_existing_data',
      status,
      diagnostics: status.lastError ? [status.lastError] : [],
    };
  }

  // Classify empties without unnecessary empty backup only if truly absent
  const preClassification = classifyWorkspace(snapshot);
  if (preClassification === 'empty_fresh_install') {
    return {
      outcome: 'empty_fresh_install',
      classification: preClassification,
      diagnostics: [],
    };
  }

  // 3. Create & verify raw LocalStorage backup BEFORE JSON parsing or validation!
  let backup: BackupLegacyStorageResult;
  try {
    const rawBackupInput = buildRawBackupPayload(snapshot);
    backup = await backupLegacyLocalstorage(rawBackupInput);
    if (!backup.verified) {
      return {
        outcome: 'backup_failed',
        classification: preClassification,
        diagnostics: [
          makeDiagnostic({
            code: 'BACKUP_FAILED',
            severity: 'error',
            stage: 'backup',
            entityType: 'backup',
            recordId: backup.backupFilename || null,
            field: 'verified',
            originalValue: false,
            message: 'Pre-migration raw LocalStorage backup could not be verified on disk.',
            suggestedAction: 'Check disk space and app data directory permissions before retrying.',
          }),
        ],
      };
    }
  } catch (err) {
    return {
      outcome: 'backup_failed',
      classification: preClassification,
      diagnostics: [
        makeDiagnostic({
          code: 'BACKUP_FAILED',
          severity: 'error',
          stage: 'backup',
          entityType: 'backup',
          recordId: null,
          field: null,
          originalValue: null,
          message: err instanceof Error ? err.message : 'Pre-migration raw backup failed.',
          suggestedAction: 'Resolve the backup I/O failure before retrying migration.',
        }),
      ],
    };
  }

  // 4. Parse, normalize, resolve relationships, and validate
  const prepared = prepareMigrationPayload(snapshot, { nowIso: options?.nowIso });

  if (prepared.classification === 'demo_seed_only' && !options?.migrateDemoSeed) {
    return {
      outcome: 'demo_seed_only',
      classification: prepared.classification,
      backup,
      diagnostics: prepared.diagnostics,
    };
  }

  if (prepared.hasErrors || !prepared.payload) {
    return {
      outcome: 'validation_failed',
      classification: prepared.classification,
      backup,
      diagnostics: prepared.diagnostics,
    };
  }

  // 5. Commit atomically inside one SQLite transaction via Rust command
  const result = await migrateLegacyWorkspace({
    ...prepared.payload,
    backupVerification: backup,
  });

  return {
    outcome: 'completed',
    classification: prepared.classification,
    backup,
    result,
    diagnostics: result.diagnostics,
  };
}
