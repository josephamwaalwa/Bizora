import type { BusinessProfile, Client, Quotation, Invoice, ActivityLog, PaymentRecord, QuotationStatus } from '../types';
import {
  initialBusinessProfile,
  initialClients,
  initialQuotations,
  initialInvoices,
  initialActivities,
} from './seedData';
import { calculateInvoiceBalances, determineUpdatedInvoiceStatus } from '../utils/calculations';
import { formatCurrency } from '../utils/formatters';
import { validatePaymentInput } from '../utils/documentWorkflow';
import { formatDocNumber, generateId } from '../utils/idGenerator';
import { THEME_STORAGE_KEY } from '../utils/theme';
import { PersistenceError } from './persistence/types';

const KEYS = {
  PROFILE: 'bizora_business_profile_v1',
  CLIENTS: 'bizora_clients_v1',
  QUOTATIONS: 'bizora_quotations_v1',
  INVOICES: 'bizora_invoices_v1',
  ACTIVITIES: 'bizora_activities_v1',
  INITIALIZED: 'bizora_has_initialized_v1',
  LOGO_CACHE: 'bizora_logo_cache_v1',
};

export const LEGACY_STORAGE_KEYS = [
  KEYS.PROFILE,
  KEYS.CLIENTS,
  KEYS.QUOTATIONS,
  KEYS.INVOICES,
  KEYS.ACTIVITIES,
  KEYS.INITIALIZED,
  KEYS.LOGO_CACHE,
  THEME_STORAGE_KEY,
] as const;

export type LegacyStorageKey = (typeof LEGACY_STORAGE_KEYS)[number];

export interface RawLegacySnapshotEntry {
  key: LegacyStorageKey;
  present: boolean;
  presentInLocalStorage: boolean;
  presentInMemoryFallback: boolean;
  rawValue: string | null;
}

export interface RawLegacyStorageSnapshot {
  capturedAt: string;
  source: string;
  entries: RawLegacySnapshotEntry[];
}

const PROFILE_LOGO_MARKER = '__BIZORA_PROFILE_LOGO__';
const LOGO_REF_PREFIX = '__BIZORA_LOGO__:';
const LARGE_LOGO_THRESHOLD = 2048;

// In-memory fallback store for environments where localStorage is restricted or full
const memoryStorage = new Map<string, string>();
const fallbackOnlyKeys = new Set<string>();

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${input.length}_${(hash >>> 0).toString(36)}`;
}

function readRaw(key: string): string | null {
  if (fallbackOnlyKeys.has(key) && memoryStorage.has(key)) {
    return memoryStorage.get(key) ?? null;
  }
  try {
    const val = localStorage.getItem(key);
    if (val !== null) {
      memoryStorage.set(key, val);
      return val;
    }
    memoryStorage.delete(key);
    return null;
  } catch (error) {
    console.warn(`Unable to read ${key} from localStorage, using memory fallback:`, error);
  }
  return memoryStorage.get(key) ?? null;
}

function writeRaw(key: string, serialized: string): boolean {
  memoryStorage.set(key, serialized);
  try {
    localStorage.setItem(key, serialized);
    fallbackOnlyKeys.delete(key);
    return true;
  } catch (error) {
    console.error(`Error saving ${key} to localStorage:`, error);
    return false;
  }
}

function safeGet<T>(key: string, fallback: T): T {
  try {
    const raw = readRaw(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`Error parsing ${key} from storage:`, error);
    return fallback;
  }
}

function getLogoCache(): Record<string, string> {
  return safeGet<Record<string, string>>(KEYS.LOGO_CACHE, {});
}

function saveLogoCache(cache: Record<string, string>): boolean {
  return writeRaw(KEYS.LOGO_CACHE, JSON.stringify(cache));
}

function cacheLogo(logoUrl: string, cache: Record<string, string>): string {
  const key = `logo_${hashString(logoUrl)}`;
  cache[key] = logoUrl;
  return `${LOGO_REF_PREFIX}${key}`;
}

function resolveLogoUrl(logoUrl: string | undefined, profileLogoUrl: string, cache: Record<string, string>): string {
  if (!logoUrl) return '';
  if (logoUrl === PROFILE_LOGO_MARKER) {
    return profileLogoUrl || '';
  }
  if (logoUrl.startsWith(LOGO_REF_PREFIX)) {
    const key = logoUrl.slice(LOGO_REF_PREFIX.length);
    return cache[key] || profileLogoUrl || '';
  }
  return logoUrl;
}

function dehydrateSnapshotLogo<T extends { businessSnapshot: BusinessProfile }>(
  doc: T,
  profileLogoUrl: string,
  cache: Record<string, string>,
  forceCacheForAllDataUrls: boolean = false
): T {
  const docLogo = doc.businessSnapshot?.logoUrl;
  if (!docLogo || docLogo === PROFILE_LOGO_MARKER || docLogo.startsWith(LOGO_REF_PREFIX)) {
    return doc;
  }

  if (docLogo.length <= LARGE_LOGO_THRESHOLD) {
    return doc;
  }

  if (profileLogoUrl && docLogo === profileLogoUrl) {
    return {
      ...doc,
      businessSnapshot: {
        ...doc.businessSnapshot,
        logoUrl: PROFILE_LOGO_MARKER,
      },
    };
  }

  if (forceCacheForAllDataUrls || docLogo.startsWith('data:')) {
    const ref = cacheLogo(docLogo, cache);
    return {
      ...doc,
      businessSnapshot: {
        ...doc.businessSnapshot,
        logoUrl: ref,
      },
    };
  }

  return doc;
}

function hydrateDocument<T extends { businessSnapshot: BusinessProfile }>(
  doc: T,
  profile: BusinessProfile,
  cache: Record<string, string>
): T {
  const profileLogoUrl = profile?.logoUrl || '';
  const rawLogo = doc.businessSnapshot?.logoUrl;
  if (!rawLogo) {
    if (profileLogoUrl && doc.businessSnapshot?.id === profile.id) {
      return {
        ...doc,
        businessSnapshot: {
          ...doc.businessSnapshot,
          logoUrl: profileLogoUrl,
        },
      };
    }
    return doc;
  }
  const resolved = resolveLogoUrl(rawLogo, profileLogoUrl, cache);
  if (resolved === rawLogo) return doc;
  return {
    ...doc,
    businessSnapshot: {
      ...doc.businessSnapshot,
      logoUrl: resolved,
    },
  };
}

function compactStoredDocuments(): void {
  const profile = safeGet<BusinessProfile>(KEYS.PROFILE, initialBusinessProfile);
  const profileLogoUrl = profile?.logoUrl || '';
  const cache = getLogoCache();

  const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
  const compactedQuotes = rawQuotes.map((q) => dehydrateSnapshotLogo(q, profileLogoUrl, cache, true));

  const rawInvoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
  const compactedInvoices = rawInvoices.map((inv) => dehydrateSnapshotLogo(inv, profileLogoUrl, cache, true));

  // Garbage-collect unreferenced logo cache entries
  const referencedKeys = new Set<string>();
  for (const doc of [...compactedQuotes, ...compactedInvoices]) {
    const url = doc.businessSnapshot?.logoUrl;
    if (url && url.startsWith(LOGO_REF_PREFIX)) {
      referencedKeys.add(url.slice(LOGO_REF_PREFIX.length));
    }
  }
  const prunedCache: Record<string, string> = {};
  for (const key of referencedKeys) {
    if (cache[key]) prunedCache[key] = cache[key];
  }

  if (Object.keys(prunedCache).length > 0) {
    saveLogoCache(prunedCache);
  } else {
    memoryStorage.delete(KEYS.LOGO_CACHE);
    try {
      localStorage.removeItem(KEYS.LOGO_CACHE);
    } catch {
      // ignore
    }
  }

  writeRaw(KEYS.QUOTATIONS, JSON.stringify(compactedQuotes));
  writeRaw(KEYS.INVOICES, JSON.stringify(compactedInvoices));

  // Trim activity log if needed to free space without losing core documents
  const activities = safeGet<ActivityLog[]>(KEYS.ACTIVITIES, []);
  if (activities.length > 20) {
    writeRaw(KEYS.ACTIVITIES, JSON.stringify(activities.slice(0, 20)));
  }
}

function safeSet<T>(key: string, value: T): boolean {
  const serialized = JSON.stringify(value);
  if (writeRaw(key, serialized)) {
    return true;
  }

  // Attempt lossless logo deduplication & compaction if quota was exceeded
  try {
    compactStoredDocuments();
    if (writeRaw(key, serialized)) {
      return true;
    }
  } catch (compactionError) {
    console.error('Storage compaction failed:', compactionError);
  }

  // Keep in memory fallback so current session continues working
  fallbackOnlyKeys.add(key);
  return false;
}

function normalizeDocNumber(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function resolveQuotationFromList(rawRef: string | undefined, quotes: Quotation[]): Quotation | undefined {
  const trimmed = rawRef?.trim();
  if (!trimmed) return undefined;

  const byId = quotes.find((q) => q.id === trimmed);
  if (byId) return byId;

  const normalizedRef = normalizeDocNumber(trimmed);
  return quotes.find((q) => normalizeDocNumber(q.quotationNumber) === normalizedRef);
}

function resolveInvoiceFromList(rawRef: string | undefined, invoices: Invoice[]): Invoice | undefined {
  const trimmed = rawRef?.trim();
  if (!trimmed) return undefined;

  const byId = invoices.find((inv) => inv.id === trimmed);
  if (byId) return byId;

  const normalizedRef = normalizeDocNumber(trimmed);
  return invoices.find((inv) => normalizeDocNumber(inv.invoiceNumber) === normalizedRef);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDateBeforeToday(dateString: string | undefined): boolean {
  if (!dateString) return false;
  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString.trim())) {
    return dateString.trim() < todayLocal;
  }
  const parsed = new Date(dateString);
  if (isNaN(parsed.getTime())) return false;
  const midnightToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return parsed < midnightToday;
}

export function restoreUnlinkedQuotationStatus(
  status: QuotationStatus,
  expiryDate?: string,
  preConversionStatus?: QuotationStatus
): QuotationStatus {
  if (status === 'declined') return 'declined';
  if (status !== 'accepted') return status;

  if (preConversionStatus) {
    if (preConversionStatus === 'declined') return 'declined';
    if (preConversionStatus === 'draft') return 'draft';
    if (preConversionStatus === 'accepted') return 'accepted';
    return isDateBeforeToday(expiryDate) ? 'expired' : 'sent';
  }

  return isDateBeforeToday(expiryDate) ? 'expired' : 'sent';
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
  const num = parseInt(suffix, 10);
  return Number.isFinite(num) && num >= 1 ? num : null;
}

export const StorageService = {
  lastWritePersisted: true,
  lastImportError: null as string | null,

  /**
   * Normalizes legacy relationship fields on existing records without auto-seeding
   * demo data on uninitialized fresh installs.
   */
  init(): void {
    const hasInitialized = readRaw(KEYS.INITIALIZED);
    const hasProfile = readRaw(KEYS.PROFILE);
    if (!hasInitialized && !hasProfile) {
      return;
    }
    this.normalizeLegacyRelationships();
  },

  hasBusinessProfile(): boolean {
    const raw = readRaw(KEYS.PROFILE);
    if (!raw) return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      return (
        isPlainObject(parsed) &&
        typeof parsed.name === 'string' &&
        parsed.name.trim().length > 0
      );
    } catch {
      return false;
    }
  },

  /**
   * Resolves legacy quotationNumber references inside Invoice.quotationId
   * and legacy invoiceNumber references inside Quotation.convertedInvoiceId
   * without mutating record primary IDs or unrelated snapshots.
   */
  normalizeLegacyRelationships(): void {
    const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    const rawInvoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
    if (rawQuotes.length === 0 && rawInvoices.length === 0) {
      this.lastWritePersisted = true;
      return;
    }

    let quotesChanged = false;
    let invoicesChanged = false;
    const now = new Date().toISOString();

    const updatedQuotes = rawQuotes.map((q) => ({ ...q }));
    const updatedInvoices = rawInvoices.map((inv) => ({ ...inv }));

    // Pass 1: Normalize Invoice.quotationId -> Quotation.id and record first live claim per quote
    const claimedQuoteToInvoice = new Map<string, string>();
    for (let i = 0; i < updatedInvoices.length; i++) {
      const inv = updatedInvoices[i];
      if (!inv.quotationId || !inv.quotationId.trim()) continue;

      const matchedQuote = resolveQuotationFromList(inv.quotationId, updatedQuotes);
      if (!matchedQuote) continue;

      if (inv.quotationId !== matchedQuote.id) {
        updatedInvoices[i] = {
          ...inv,
          quotationId: matchedQuote.id,
        };
        invoicesChanged = true;
      }

      if (!claimedQuoteToInvoice.has(matchedQuote.id)) {
        claimedQuoteToInvoice.set(matchedQuote.id, inv.id);
      }
    }

    // Pass 2: Normalize Quotation.convertedInvoiceId -> Invoice.id, clear dangling refs, and keep status safe
    for (let i = 0; i < updatedQuotes.length; i++) {
      const q = updatedQuotes[i];
      const claimedInvId = claimedQuoteToInvoice.get(q.id);
      const rawConvertedRef = q.convertedInvoiceId?.trim();

      if (rawConvertedRef) {
        const matchedInv = resolveInvoiceFromList(rawConvertedRef, updatedInvoices);
        const matchedInvQuote = matchedInv?.quotationId
          ? resolveQuotationFromList(matchedInv.quotationId, updatedQuotes)
          : undefined;
        const pointsToDifferentQuote = Boolean(matchedInvQuote && matchedInvQuote.id !== q.id);

        if (matchedInv && !pointsToDifferentQuote) {
          let quoteModified = false;
          if (q.convertedInvoiceId !== matchedInv.id) {
            q.convertedInvoiceId = matchedInv.id;
            quoteModified = true;
          }
          if (q.status !== 'declined' && q.status !== 'accepted') {
            q.preConversionStatus = q.preConversionStatus ?? q.status;
            q.status = 'accepted';
            quoteModified = true;
          }
          if (quoteModified) {
            q.updatedAt = now;
            quotesChanged = true;
          }
          continue;
        }

        // Converted reference points to an invoice that no longer exists (or belongs to another quote)
        if (claimedInvId) {
          q.convertedInvoiceId = claimedInvId;
          if (q.status !== 'declined' && q.status !== 'accepted') {
            q.preConversionStatus = q.preConversionStatus ?? q.status;
            q.status = 'accepted';
          }
          q.updatedAt = now;
          quotesChanged = true;
        } else {
          const restoredStatus = restoreUnlinkedQuotationStatus(q.status, q.expiryDate, q.preConversionStatus);
          q.convertedInvoiceId = undefined;
          q.preConversionStatus = undefined;
          q.status = restoredStatus;
          q.updatedAt = now;
          quotesChanged = true;
        }
        continue;
      }

      // Quotation has no convertedInvoiceId, check if an invoice references it
      if (claimedInvId) {
        q.convertedInvoiceId = claimedInvId;
        if (q.status !== 'declined' && q.status !== 'accepted') {
          q.preConversionStatus = q.preConversionStatus ?? q.status;
          q.status = 'accepted';
        }
        q.updatedAt = now;
        quotesChanged = true;
      } else if (q.preConversionStatus !== undefined) {
        q.preConversionStatus = undefined;
        q.updatedAt = now;
        quotesChanged = true;
      }
    }

    let persisted = true;
    if (invoicesChanged) {
      persisted = safeSet(KEYS.INVOICES, updatedInvoices) && persisted;
    }
    if (quotesChanged) {
      persisted = safeSet(KEYS.QUOTATIONS, updatedQuotes) && persisted;
    }
    this.lastWritePersisted = persisted;
  },

  resetToDemoData(): void {
    memoryStorage.delete(KEYS.LOGO_CACHE);
    try {
      localStorage.removeItem(KEYS.LOGO_CACHE);
    } catch {
      // ignore
    }
    const p1 = safeSet(KEYS.PROFILE, initialBusinessProfile);
    const p2 = safeSet(KEYS.CLIENTS, initialClients);
    const p3 = safeSet(KEYS.QUOTATIONS, initialQuotations);
    const p4 = safeSet(KEYS.INVOICES, initialInvoices);
    const p5 = safeSet(KEYS.ACTIVITIES, initialActivities);
    const p6 = writeRaw(KEYS.INITIALIZED, 'true');
    this.lastWritePersisted = p1 && p2 && p3 && p4 && p5 && p6;
  },

  clearAllData(): void {
    const emptyProfile: BusinessProfile = {
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
      updatedAt: new Date().toISOString(),
    };
    memoryStorage.delete(KEYS.LOGO_CACHE);
    try {
      localStorage.removeItem(KEYS.LOGO_CACHE);
    } catch {
      // ignore
    }
    const p1 = safeSet(KEYS.PROFILE, emptyProfile);
    const p2 = safeSet(KEYS.CLIENTS, []);
    const p3 = safeSet(KEYS.QUOTATIONS, []);
    const p4 = safeSet(KEYS.INVOICES, []);
    const p5 = safeSet(KEYS.ACTIVITIES, [
      {
        id: generateId('act'),
        type: 'settings_updated',
        title: 'Workspace Initialized',
        description: 'Clean slate started.',
        timestamp: new Date().toISOString(),
      },
    ]);
    const p6 = writeRaw(KEYS.INITIALIZED, 'true');
    this.lastWritePersisted = p1 && p2 && p3 && p4 && p5 && p6;
  },

  // Business Profile
  getBusinessProfile(): BusinessProfile {
    return safeGet<BusinessProfile>(KEYS.PROFILE, initialBusinessProfile);
  },

  saveBusinessProfile(profile: BusinessProfile): BusinessProfile {
    const hadSavedProfile = Boolean(readRaw(KEYS.PROFILE));
    const previousProfile = hadSavedProfile ? this.getBusinessProfile() : null;
    const updated = { ...profile, updatedAt: new Date().toISOString() };
    let persisted = true;

    // Preserve historical snapshots that referenced the previous profile logo
    if (
      previousProfile?.logoUrl &&
      previousProfile.logoUrl.length > LARGE_LOGO_THRESHOLD &&
      previousProfile.logoUrl !== updated.logoUrl
    ) {
      const cache = getLogoCache();
      const historicalRef = cacheLogo(previousProfile.logoUrl, cache);
      persisted = saveLogoCache(cache) && persisted;

      const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
      let quotesChanged = false;
      const updatedQuotes = rawQuotes.map((q) => {
        if (q.businessSnapshot?.logoUrl === PROFILE_LOGO_MARKER) {
          quotesChanged = true;
          return {
            ...q,
            businessSnapshot: { ...q.businessSnapshot, logoUrl: historicalRef },
          };
        }
        return q;
      });
      if (quotesChanged) {
        persisted = safeSet(KEYS.QUOTATIONS, updatedQuotes) && persisted;
      }

      const rawInvoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
      let invoicesChanged = false;
      const updatedInvoices = rawInvoices.map((inv) => {
        if (inv.businessSnapshot?.logoUrl === PROFILE_LOGO_MARKER) {
          invoicesChanged = true;
          return {
            ...inv,
            businessSnapshot: { ...inv.businessSnapshot, logoUrl: historicalRef },
          };
        }
        return inv;
      });
      if (invoicesChanged) {
        persisted = safeSet(KEYS.INVOICES, updatedInvoices) && persisted;
      }
    }

    persisted = safeSet(KEYS.PROFILE, updated) && persisted;
    persisted = writeRaw(KEYS.INITIALIZED, 'true') && persisted;
    this.addActivity({
      type: 'settings_updated',
      title: hadSavedProfile ? 'Business Profile Updated' : 'Business Profile Created',
      description: hadSavedProfile
        ? `Settings updated for ${profile.name}`
        : `Workspace configured for ${profile.name}`,
    });
    this.lastWritePersisted = persisted;
    return updated;
  },

  isQuotationNumberTaken(quotationNumber: string, excludeId?: string, existingQuotes?: Quotation[]): boolean {
    const target = normalizeDocNumber(quotationNumber);
    if (!target) return false;
    const quotes = existingQuotes || safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    return quotes.some((q) => q.id !== excludeId && normalizeDocNumber(q.quotationNumber) === target);
  },

  isInvoiceNumberTaken(invoiceNumber: string, excludeId?: string, existingInvoices?: Invoice[]): boolean {
    const target = normalizeDocNumber(invoiceNumber);
    if (!target) return false;
    const invoices = existingInvoices || safeGet<Invoice[]>(KEYS.INVOICES, []);
    return invoices.some((inv) => inv.id !== excludeId && normalizeDocNumber(inv.invoiceNumber) === target);
  },

  getNextAvailableQuoteNumber(): number {
    const profile = this.getBusinessProfile();
    const quotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    const prefix = profile.quotePrefix || 'QUO-';
    let candidate = Math.max(1, Number(profile.nextQuoteNumber) || 1);

    while (this.isQuotationNumberTaken(formatDocNumber(prefix, candidate), undefined, quotes)) {
      candidate += 1;
    }
    return candidate;
  },

  getNextAvailableInvoiceNumber(): number {
    const profile = this.getBusinessProfile();
    const invoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
    const prefix = profile.invoicePrefix || 'INV-';
    let candidate = Math.max(1, Number(profile.nextInvoiceNumber) || 1);

    while (this.isInvoiceNumberTaken(formatDocNumber(prefix, candidate), undefined, invoices)) {
      candidate += 1;
    }
    return candidate;
  },

  commitUsedQuoteNumber(savedQuoteNumber: string): boolean {
    const profile = this.getBusinessProfile();
    const prefix = profile.quotePrefix || 'QUO-';
    const currentNext = Math.max(1, Number(profile.nextQuoteNumber) || 1);
    const parsed = parseSequentialDocNumber(savedQuoteNumber, prefix);
    if (parsed !== null && parsed >= currentNext) {
      profile.nextQuoteNumber = parsed + 1;
      const persisted = safeSet(KEYS.PROFILE, profile);
      this.lastWritePersisted = persisted;
      return persisted;
    }
    return true;
  },

  commitUsedInvoiceNumber(savedInvoiceNumber: string): boolean {
    const profile = this.getBusinessProfile();
    const prefix = profile.invoicePrefix || 'INV-';
    const currentNext = Math.max(1, Number(profile.nextInvoiceNumber) || 1);
    const parsed = parseSequentialDocNumber(savedInvoiceNumber, prefix);
    if (parsed !== null && parsed >= currentNext) {
      profile.nextInvoiceNumber = parsed + 1;
      const persisted = safeSet(KEYS.PROFILE, profile);
      this.lastWritePersisted = persisted;
      return persisted;
    }
    return true;
  },

  // Clients
  getClients(): Client[] {
    return safeGet<Client[]>(KEYS.CLIENTS, []);
  },

  getClientById(id: string): Client | undefined {
    return this.getClients().find((c) => c.id === id);
  },

  saveClient(client: Partial<Client> & { name: string; email: string }): Client {
    const clients = this.getClients();
    const now = new Date().toISOString();
    let saved: Client;
    let isNew = false;

    if (client.id) {
      const idx = clients.findIndex((c) => c.id === client.id);
      if (idx !== -1) {
        saved = { ...clients[idx], ...client, updatedAt: now } as Client;
        clients[idx] = saved;
      } else {
        isNew = true;
        saved = {
          ...client,
          id: client.id,
          phone: client.phone || '',
          address: client.address || '',
          createdAt: now,
          updatedAt: now,
        } as Client;
        clients.unshift(saved);
      }
    } else {
      isNew = true;
      saved = {
        ...client,
        id: generateId('cli'),
        phone: client.phone || '',
        address: client.address || '',
        createdAt: now,
        updatedAt: now,
      } as Client;
      clients.unshift(saved);
    }

    const persisted = safeSet(KEYS.CLIENTS, clients);
    if (isNew && !client.id) {
      this.addActivity({
        type: 'client_created',
        title: `Client Added: ${saved.name}`,
        description: saved.companyName ? `Company: ${saved.companyName}` : `Email: ${saved.email}`,
        referenceId: saved.id,
      });
    }
    this.lastWritePersisted = persisted;
    return saved;
  },

  deleteClient(id: string): boolean {
    const clients = this.getClients();
    const filtered = clients.filter((c) => c.id !== id);
    if (filtered.length !== clients.length) {
      let persisted = safeSet(KEYS.CLIENTS, filtered);
      const now = new Date().toISOString();

      const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
      let quotesChanged = false;
      const detachedQuotes = rawQuotes.map((q) => {
        if (q.clientId === id) {
          quotesChanged = true;
          return { ...q, clientId: '', updatedAt: now };
        }
        return q;
      });
      if (quotesChanged) {
        persisted = safeSet(KEYS.QUOTATIONS, detachedQuotes) && persisted;
      }

      const rawInvoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
      let invoicesChanged = false;
      const detachedInvoices = rawInvoices.map((inv) => {
        if (inv.clientId === id) {
          invoicesChanged = true;
          return { ...inv, clientId: '', updatedAt: now };
        }
        return inv;
      });
      if (invoicesChanged) {
        persisted = safeSet(KEYS.INVOICES, detachedInvoices) && persisted;
      }

      this.lastWritePersisted = persisted;
      return true;
    }
    return false;
  },

  // Quotations
  getQuotations(): Quotation[] {
    const profile = this.getBusinessProfile();
    const cache = getLogoCache();
    const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    return rawQuotes.map((q) => hydrateDocument(q, profile, cache));
  },

  getQuotationById(id: string): Quotation | undefined {
    return this.getQuotations().find((q) => q.id === id);
  },

  saveQuotation(quote: Quotation): Quotation {
    const trimmedNumber = (quote.quotationNumber || '').trim();
    if (!trimmedNumber) {
      throw new Error('Quotation number is required.');
    }

    const profileLogoUrl = this.getBusinessProfile().logoUrl || '';
    const cache = getLogoCache();
    const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);

    if (this.isQuotationNumberTaken(trimmedNumber, quote.id, rawQuotes)) {
      throw new Error(`Quotation number "${trimmedNumber}" already exists.`);
    }

    const idx = rawQuotes.findIndex((q) => q.id === quote.id);
    const existingRaw = idx !== -1 ? rawQuotes[idx] : undefined;
    if (!existingRaw && quote.convertedInvoiceId) {
      throw new Error('New quotations cannot specify convertedInvoiceId directly.');
    }
    if (existingRaw && (quote.convertedInvoiceId ?? undefined) !== (existingRaw.convertedInvoiceId ?? undefined)) {
      throw new Error('convertedInvoiceId cannot be modified directly through quotation update.');
    }

    const now = new Date().toISOString();
    const itemToSave: Quotation = {
      ...quote,
      quotationNumber: trimmedNumber,
      preConversionStatus: quote.convertedInvoiceId ? quote.preConversionStatus : undefined,
      updatedAt: now,
    };
    const storableItem = dehydrateSnapshotLogo(itemToSave, profileLogoUrl, cache);

    let persisted = true;
    if (Object.keys(cache).length > 0) {
      persisted = saveLogoCache(cache) && persisted;
    }

    if (idx !== -1) {
      rawQuotes[idx] = storableItem;
    } else {
      rawQuotes.unshift(storableItem);
    }

    persisted = safeSet(KEYS.QUOTATIONS, rawQuotes) && persisted;

    if (idx === -1) {
      this.addActivity({
        type: 'quote_created',
        title: `Quotation ${trimmedNumber} Created`,
        description: `For ${quote.clientSnapshot.name || 'Client'} (${quote.currencySymbol} ${quote.grandTotal.toLocaleString()})`,
        referenceId: quote.id,
      });
    }

    this.lastWritePersisted = persisted;
    return itemToSave;
  },

  deleteQuotation(id: string): boolean {
    const quotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    const targetQuote = quotes.find((q) => q.id === id);
    if (!targetQuote) return false;

    const filtered = quotes.filter((q) => q.id !== id);
    let persisted = safeSet(KEYS.QUOTATIONS, filtered);

    // Clear quotationId from any linked invoices while preserving the invoice and its snapshots
    const rawInvoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
    const targetDocNum = normalizeDocNumber(targetQuote.quotationNumber);
    const now = new Date().toISOString();
    let invoicesChanged = false;

    const updatedInvoices = rawInvoices.map((inv) => {
      const ref = inv.quotationId?.trim();
      if (!ref) return inv;
      if (ref === id || (targetDocNum && normalizeDocNumber(ref) === targetDocNum)) {
        invoicesChanged = true;
        return {
          ...inv,
          quotationId: undefined,
          updatedAt: now,
        };
      }
      return inv;
    });

    if (invoicesChanged) {
      persisted = safeSet(KEYS.INVOICES, updatedInvoices) && persisted;
    }

    this.lastWritePersisted = persisted;
    return true;
  },

  // Invoices
  getInvoices(): Invoice[] {
    const profile = this.getBusinessProfile();
    const cache = getLogoCache();
    const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    const rawInvoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
    return rawInvoices.map((inv) => {
      const hydrated = hydrateDocument(inv, profile, cache);
      if (hydrated.quotationId) {
        const resolvedQuote = resolveQuotationFromList(hydrated.quotationId, rawQuotes);
        if (resolvedQuote && resolvedQuote.id !== hydrated.quotationId) {
          return { ...hydrated, quotationId: resolvedQuote.id };
        }
      }
      return hydrated;
    });
  },

  getInvoiceById(id: string): Invoice | undefined {
    return this.getInvoices().find((inv) => inv.id === id);
  },

  saveInvoice(invoice: Invoice): Invoice {
    const trimmedNumber = (invoice.invoiceNumber || '').trim();
    if (!trimmedNumber) {
      throw new Error('Invoice number is required.');
    }

    const profileLogoUrl = this.getBusinessProfile().logoUrl || '';
    const cache = getLogoCache();
    const rawInvoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
    const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    const clients = this.getClients();

    if (this.isInvoiceNumberTaken(trimmedNumber, invoice.id, rawInvoices)) {
      throw new Error(`Invoice number "${trimmedNumber}" already exists.`);
    }

    const idx = rawInvoices.findIndex((i) => i.id === invoice.id);
    const existingRaw = idx !== -1 ? rawInvoices[idx] : undefined;

    // Enforce client existence when a clientId is assigned; allow empty clientId when clientSnapshot is preserved
    const normalizedClientId = (invoice.clientId || '').trim();
    if (normalizedClientId && (idx === -1 || existingRaw?.clientId !== normalizedClientId)) {
      const clientExists = clients.some((c) => c.id === normalizedClientId);
      if (!clientExists) {
        throw new Error('Cannot save invoice: the selected client record does not exist.');
      }
    } else if (!normalizedClientId && !invoice.clientSnapshot?.name?.trim()) {
      throw new Error('Cannot save invoice: client details are missing.');
    }

    // Resolve and validate quotation link (must store Quotation.id, never quotationNumber)
    let resolvedQuotationId: string | undefined;
    if (invoice.quotationId && invoice.quotationId.trim()) {
      const matchedQuote = resolveQuotationFromList(invoice.quotationId, rawQuotes);
      if (!matchedQuote) {
        throw new Error('Cannot save invoice: the selected quotation record no longer exists.');
      }

      const existingLinkedQuote = existingRaw?.quotationId
        ? resolveQuotationFromList(existingRaw.quotationId, rawQuotes)
        : undefined;
      const wasAlreadyLinkedToThisInvoice =
        existingLinkedQuote?.id === matchedQuote.id || matchedQuote.convertedInvoiceId === invoice.id;

      if (!wasAlreadyLinkedToThisInvoice && matchedQuote.status === 'declined') {
        throw new Error(`Quotation ${matchedQuote.quotationNumber} is declined and cannot be linked to an invoice.`);
      }

      const conflictingInvoice = rawInvoices.find((other) => {
        if (other.id === invoice.id) return false;
        const otherResolved = resolveQuotationFromList(other.quotationId, rawQuotes);
        return otherResolved?.id === matchedQuote.id;
      });

      const existingConvertedTarget =
        matchedQuote.convertedInvoiceId &&
        matchedQuote.convertedInvoiceId !== invoice.id &&
        rawInvoices.some((other) => other.id === matchedQuote.convertedInvoiceId && other.id !== invoice.id);

      if (conflictingInvoice || existingConvertedTarget) {
        throw new Error(`Quotation ${matchedQuote.quotationNumber} is already linked to another invoice.`);
      }

      resolvedQuotationId = matchedQuote.id;
    }

    const now = new Date().toISOString();

    // Recalculate balances and auto status
    const { amountPaid, outstandingBalance } = calculateInvoiceBalances(invoice.grandTotal, invoice.payments || []);
    const workflowBaseStatus =
      amountPaid <= 0 && (invoice.status === 'paid' || invoice.status === 'partially_paid')
        ? existingRaw?.status === 'draft'
          ? 'draft'
          : 'sent'
        : invoice.status;
    const updatedStatus = determineUpdatedInvoiceStatus(
      workflowBaseStatus,
      invoice.grandTotal,
      amountPaid,
      invoice.dueDate
    );

    const itemToSave: Invoice = {
      ...invoice,
      clientId: normalizedClientId,
      invoiceNumber: trimmedNumber,
      quotationId: resolvedQuotationId,
      amountPaid,
      outstandingBalance,
      status: updatedStatus,
      updatedAt: now,
    };
    const storableItem = dehydrateSnapshotLogo(itemToSave, profileLogoUrl, cache);

    let persisted = true;
    if (Object.keys(cache).length > 0) {
      persisted = saveLogoCache(cache) && persisted;
    }

    if (idx !== -1) {
      rawInvoices[idx] = storableItem;
    } else {
      rawInvoices.unshift(storableItem);
    }

    persisted = safeSet(KEYS.INVOICES, rawInvoices) && persisted;

    // Synchronize bidirectional convertedInvoiceId & status on quotations
    let quotesChanged = false;
    const syncedQuotes = rawQuotes.map((q) => {
      if (resolvedQuotationId && q.id === resolvedQuotationId) {
        if (q.status === 'declined') {
          if (q.convertedInvoiceId !== itemToSave.id) {
            quotesChanged = true;
            return {
              ...q,
              convertedInvoiceId: itemToSave.id,
              updatedAt: now,
            };
          }
          return q;
        }

        const nextPreStatus = q.preConversionStatus ?? q.status;
        if (
          q.convertedInvoiceId !== itemToSave.id ||
          q.status !== 'accepted' ||
          q.preConversionStatus !== nextPreStatus
        ) {
          quotesChanged = true;
          return {
            ...q,
            convertedInvoiceId: itemToSave.id,
            preConversionStatus: nextPreStatus,
            status: 'accepted' as QuotationStatus,
            updatedAt: now,
          };
        }
        return q;
      }

      const pointedToThisInvoice =
        q.convertedInvoiceId === itemToSave.id ||
        (existingRaw?.invoiceNumber && q.convertedInvoiceId === existingRaw.invoiceNumber);

      if (pointedToThisInvoice) {
        const otherReferencingInvoice = rawInvoices.find(
          (other) =>
            other.id !== itemToSave.id &&
            resolveQuotationFromList(other.quotationId, rawQuotes)?.id === q.id
        );

        quotesChanged = true;
        if (otherReferencingInvoice) {
          return {
            ...q,
            convertedInvoiceId: otherReferencingInvoice.id,
            updatedAt: now,
          };
        }

        const restoredStatus = restoreUnlinkedQuotationStatus(q.status, q.expiryDate, q.preConversionStatus);
        return {
          ...q,
          convertedInvoiceId: undefined,
          preConversionStatus: undefined,
          status: restoredStatus,
          updatedAt: now,
        };
      }

      return q;
    });

    if (quotesChanged) {
      persisted = safeSet(KEYS.QUOTATIONS, syncedQuotes) && persisted;
    }

    if (idx === -1) {
      this.addActivity({
        type: 'invoice_created',
        title: `Invoice ${trimmedNumber} Created`,
        description: `For ${invoice.clientSnapshot.name || 'Client'} (${invoice.currencySymbol} ${invoice.grandTotal.toLocaleString()})`,
        referenceId: invoice.id,
      });
    }

    this.lastWritePersisted = persisted;
    return itemToSave;
  },

  deleteInvoice(id: string): boolean {
    const invoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
    const targetInvoice = invoices.find((i) => i.id === id);
    if (!targetInvoice) return false;

    const filtered = invoices.filter((i) => i.id !== id);
    let persisted = safeSet(KEYS.INVOICES, filtered);

    // Clear convertedInvoiceId on matching quotation and restore status if no other invoice references it
    const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    const linkedQuote = resolveQuotationFromList(targetInvoice.quotationId, rawQuotes);
    const now = new Date().toISOString();
    let quotesChanged = false;

    const updatedQuotes = rawQuotes.map((q) => {
      const matchesConvertedId =
        q.convertedInvoiceId === id ||
        (targetInvoice.invoiceNumber && q.convertedInvoiceId === targetInvoice.invoiceNumber);
      const matchesLinked = Boolean(linkedQuote && q.id === linkedQuote.id);

      if (!matchesConvertedId && !matchesLinked) {
        return q;
      }

      const otherReferencingInvoice = filtered.find(
        (other) => resolveQuotationFromList(other.quotationId, rawQuotes)?.id === q.id
      );

      if (otherReferencingInvoice) {
        if (q.convertedInvoiceId !== otherReferencingInvoice.id) {
          quotesChanged = true;
          return {
            ...q,
            convertedInvoiceId: otherReferencingInvoice.id,
            updatedAt: now,
          };
        }
        return q;
      }

      const restoredStatus = restoreUnlinkedQuotationStatus(q.status, q.expiryDate, q.preConversionStatus);
      if (
        q.convertedInvoiceId !== undefined ||
        q.preConversionStatus !== undefined ||
        q.status !== restoredStatus
      ) {
        quotesChanged = true;
        return {
          ...q,
          convertedInvoiceId: undefined,
          preConversionStatus: undefined,
          status: restoredStatus,
          updatedAt: now,
        };
      }
      return q;
    });

    if (quotesChanged) {
      persisted = safeSet(KEYS.QUOTATIONS, updatedQuotes) && persisted;
    }

    this.lastWritePersisted = persisted;
    return true;
  },

  recordPayment(invoiceId: string, paymentData: Omit<PaymentRecord, 'id' | 'invoiceId' | 'recordedAt'>): Invoice | undefined {
    const invoice = this.getInvoiceById(invoiceId);
    if (!invoice) return undefined;

    const currentBalances = calculateInvoiceBalances(invoice.grandTotal, invoice.payments || []);
    const storedBalance =
      typeof invoice.outstandingBalance === 'number' && Number.isFinite(invoice.outstandingBalance)
        ? Math.max(0, invoice.outstandingBalance)
        : currentBalances.outstandingBalance;
    const effectiveBalance = Math.min(storedBalance, currentBalances.outstandingBalance);

    const validation = validatePaymentInput(
      {
        status: invoice.status,
        grandTotal: invoice.grandTotal,
        outstandingBalance: effectiveBalance,
        currency: invoice.currency,
        currencySymbol: invoice.currencySymbol,
        payments: invoice.payments,
      },
      {
        amount: paymentData.amount,
        paymentDate: paymentData.paymentDate,
        paymentMethod: paymentData.paymentMethod,
        reference: paymentData.reference,
        notes: paymentData.notes,
      },
      { requireExplicitDate: false }
    );

    if (!validation.ok) {
      throw new PersistenceError('VALIDATION_ERROR', validation.error);
    }

    const newPayment: PaymentRecord = {
      id: generateId('pay'),
      invoiceId,
      amount: validation.value.amount,
      paymentDate: validation.value.paymentDate,
      paymentMethod: validation.value.paymentMethod,
      reference: validation.value.reference,
      notes: validation.value.notes,
      recordedAt: new Date().toISOString(),
    };

    const updatedPayments = [...(invoice.payments || []), newPayment];
    const { amountPaid, outstandingBalance } = calculateInvoiceBalances(invoice.grandTotal, updatedPayments);
    const updatedStatus = determineUpdatedInvoiceStatus(invoice.status, invoice.grandTotal, amountPaid, invoice.dueDate);

    const updatedInvoice: Invoice = {
      ...invoice,
      payments: updatedPayments,
      amountPaid,
      outstandingBalance,
      status: updatedStatus,
      updatedAt: new Date().toISOString(),
    };

    const saved = this.saveInvoice(updatedInvoice);
    const invoicePersisted = this.lastWritePersisted;

    this.addActivity({
      type: 'payment_recorded',
      title: `Payment of ${formatCurrency(newPayment.amount, invoice.currency, invoice.currencySymbol)} Recorded`,
      description: `Applied to ${invoice.invoiceNumber}. Remaining balance: ${formatCurrency(outstandingBalance, invoice.currency, invoice.currencySymbol)}`,
      referenceId: invoice.id,
    });

    this.lastWritePersisted = invoicePersisted;
    return saved;
  },

  // Activity Logs
  getActivities(): ActivityLog[] {
    return safeGet<ActivityLog[]>(KEYS.ACTIVITIES, []);
  },

  addActivity(activity: Omit<ActivityLog, 'id' | 'timestamp'>): void {
    const activities = this.getActivities();
    const newLog: ActivityLog = {
      ...activity,
      id: generateId('act'),
      timestamp: new Date().toISOString(),
    };
    activities.unshift(newLog);
    // Keep last 40 logs
    this.lastWritePersisted = safeSet(KEYS.ACTIVITIES, activities.slice(0, 40));
  },

  exportBackupJson(): string {
    const data = {
      profile: this.getBusinessProfile(),
      clients: this.getClients(),
      quotations: this.getQuotations(),
      invoices: this.getInvoices(),
      activities: this.getActivities(),
      exportedAt: new Date().toISOString(),
      version: '1.0',
    };
    return JSON.stringify(data, null, 2);
  },

  importBackupJson(jsonString: string): boolean {
    this.lastImportError = null;
    try {
      const data: unknown = JSON.parse(jsonString);
      if (!isPlainObject(data)) {
        this.lastImportError = 'The selected file does not contain a valid Bizora backup object.';
        return false;
      }

      if (!isPlainObject(data.profile) || typeof data.profile.name !== 'string') {
        this.lastImportError = 'Backup is missing a valid business profile.';
        return false;
      }

      if (
        !Array.isArray(data.clients) ||
        !data.clients.every((c) => isPlainObject(c) && typeof c.id === 'string' && typeof c.name === 'string')
      ) {
        this.lastImportError = 'Backup contains missing or malformed client records.';
        return false;
      }

      if (
        data.quotations !== undefined &&
        (!Array.isArray(data.quotations) ||
          !data.quotations.every(
            (q) => isPlainObject(q) && typeof q.id === 'string' && typeof q.quotationNumber === 'string'
          ))
      ) {
        this.lastImportError = 'Backup contains malformed quotation records.';
        return false;
      }

      if (
        data.invoices !== undefined &&
        (!Array.isArray(data.invoices) ||
          !data.invoices.every(
            (inv) => isPlainObject(inv) && typeof inv.id === 'string' && typeof inv.invoiceNumber === 'string'
          ))
      ) {
        this.lastImportError = 'Backup contains malformed invoice records.';
        return false;
      }

      if (
        data.activities !== undefined &&
        (!Array.isArray(data.activities) ||
          !data.activities.every((act) => isPlainObject(act) && typeof act.id === 'string' && typeof act.title === 'string'))
      ) {
        this.lastImportError = 'Backup contains malformed activity log records.';
        return false;
      }

      const profile = data.profile as unknown as BusinessProfile;
      const clients = data.clients as unknown as Client[];
      const profileLogoUrl = profile.logoUrl || '';
      const cache: Record<string, string> = {};
      const quotes = ((data.quotations ?? []) as unknown as Quotation[]).map((q) =>
        dehydrateSnapshotLogo(q, profileLogoUrl, cache)
      );
      const invoices = ((data.invoices ?? []) as unknown as Invoice[]).map((inv) =>
        dehydrateSnapshotLogo(inv, profileLogoUrl, cache)
      );
      const activities = (data.activities ?? []) as unknown as ActivityLog[];

      let persisted = true;
      if (Object.keys(cache).length > 0) {
        persisted = saveLogoCache(cache) && persisted;
      } else {
        memoryStorage.delete(KEYS.LOGO_CACHE);
        try {
          localStorage.removeItem(KEYS.LOGO_CACHE);
        } catch {
          // ignore
        }
      }

      persisted = safeSet(KEYS.PROFILE, profile) && persisted;
      persisted = safeSet(KEYS.CLIENTS, clients) && persisted;
      persisted = safeSet(KEYS.QUOTATIONS, quotes) && persisted;
      persisted = safeSet(KEYS.INVOICES, invoices) && persisted;
      persisted = safeSet(KEYS.ACTIVITIES, activities) && persisted;
      persisted = writeRaw(KEYS.INITIALIZED, 'true') && persisted;

      this.normalizeLegacyRelationships();
      this.lastWritePersisted = persisted && this.lastWritePersisted;
      return true;
    } catch (e) {
      console.error('Failed to import data:', e);
      this.lastImportError =
        e instanceof SyntaxError
          ? 'The selected file is not valid JSON.'
          : 'Could not read or validate the selected backup file.';
      return false;
    }
  },

  /**
   * Captures the exact raw values of the 8 legacy LocalStorage keys without calling init(),
   * without parsing JSON, and without mutating localStorage or memoryStorage.
   */
  getRawMigrationSnapshot(): RawLegacyStorageSnapshot {
    let localStorageUsed = false;
    let memoryFallbackUsed = false;

    const entries: RawLegacySnapshotEntry[] = LEGACY_STORAGE_KEYS.map((key) => {
      let localValue: string | null = null;
      if (typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined') {
        try {
          localValue = globalThis.localStorage.getItem(key);
        } catch {
          localValue = null;
        }
      }

      const memoryValue = memoryStorage.has(key) ? (memoryStorage.get(key) ?? null) : null;
      const presentInLocalStorage = localValue !== null;
      const presentInMemoryFallback = memoryValue !== null;

      let rawValue: string | null = null;
      if (fallbackOnlyKeys.has(key) && presentInMemoryFallback) {
        rawValue = memoryValue;
        memoryFallbackUsed = true;
      } else if (presentInLocalStorage) {
        rawValue = localValue;
        localStorageUsed = true;
      } else if (presentInMemoryFallback) {
        rawValue = memoryValue;
        memoryFallbackUsed = true;
      }

      return {
        key,
        present: rawValue !== null,
        presentInLocalStorage,
        presentInMemoryFallback,
        rawValue,
      };
    });

    const source =
      localStorageUsed && memoryFallbackUsed
        ? 'localStorage+memoryFallback'
        : memoryFallbackUsed
          ? 'memoryFallback'
          : 'localStorage';

    return {
      capturedAt: new Date().toISOString(),
      source,
      entries,
    };
  },
};

