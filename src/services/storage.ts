import type { BusinessProfile, Client, Quotation, Invoice, ActivityLog, PaymentRecord } from '../types';
import {
  initialBusinessProfile,
  initialClients,
  initialQuotations,
  initialInvoices,
  initialActivities,
} from './seedData';
import { calculateInvoiceBalances, determineUpdatedInvoiceStatus } from '../utils/calculations';
import { generateId } from '../utils/idGenerator';

const KEYS = {
  PROFILE: 'bizora_business_profile_v1',
  CLIENTS: 'bizora_clients_v1',
  QUOTATIONS: 'bizora_quotations_v1',
  INVOICES: 'bizora_invoices_v1',
  ACTIVITIES: 'bizora_activities_v1',
  INITIALIZED: 'bizora_has_initialized_v1',
  LOGO_CACHE: 'bizora_logo_cache_v1',
};

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

export const StorageService = {
  lastWritePersisted: true,

  /**
   * Initializes local storage with rich sample data on first run
   */
  init(): void {
    const hasInitialized = readRaw(KEYS.INITIALIZED);
    if (!hasInitialized) {
      this.resetToDemoData();
    }
  },

  resetToDemoData(): void {
    safeSet(KEYS.PROFILE, initialBusinessProfile);
    safeSet(KEYS.CLIENTS, initialClients);
    safeSet(KEYS.QUOTATIONS, initialQuotations);
    safeSet(KEYS.INVOICES, initialInvoices);
    safeSet(KEYS.ACTIVITIES, initialActivities);
    writeRaw(KEYS.INITIALIZED, 'true');
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
    safeSet(KEYS.PROFILE, emptyProfile);
    safeSet(KEYS.CLIENTS, []);
    safeSet(KEYS.QUOTATIONS, []);
    safeSet(KEYS.INVOICES, []);
    memoryStorage.delete(KEYS.LOGO_CACHE);
    try {
      localStorage.removeItem(KEYS.LOGO_CACHE);
    } catch {
      // ignore
    }
    safeSet(KEYS.ACTIVITIES, [
      {
        id: generateId('act'),
        type: 'settings_updated',
        title: 'Workspace Initialized',
        description: 'Clean slate started.',
        timestamp: new Date().toISOString(),
      },
    ]);
  },

  // Business Profile
  getBusinessProfile(): BusinessProfile {
    return safeGet<BusinessProfile>(KEYS.PROFILE, initialBusinessProfile);
  },

  saveBusinessProfile(profile: BusinessProfile): BusinessProfile {
    const previousProfile = this.getBusinessProfile();
    const updated = { ...profile, updatedAt: new Date().toISOString() };

    // Preserve historical snapshots that referenced the previous profile logo
    if (
      previousProfile.logoUrl &&
      previousProfile.logoUrl.length > LARGE_LOGO_THRESHOLD &&
      previousProfile.logoUrl !== updated.logoUrl
    ) {
      const cache = getLogoCache();
      const historicalRef = cacheLogo(previousProfile.logoUrl, cache);
      saveLogoCache(cache);

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
      if (quotesChanged) safeSet(KEYS.QUOTATIONS, updatedQuotes);

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
      if (invoicesChanged) safeSet(KEYS.INVOICES, updatedInvoices);
    }

    this.lastWritePersisted = safeSet(KEYS.PROFILE, updated);
    this.addActivity({
      type: 'settings_updated',
      title: 'Business Profile Updated',
      description: `Settings updated for ${profile.name}`,
    });
    return updated;
  },

  incrementQuoteNumber(): number {
    const profile = this.getBusinessProfile();
    const current = profile.nextQuoteNumber || 1;
    profile.nextQuoteNumber = current + 1;
    safeSet(KEYS.PROFILE, profile);
    return current;
  },

  incrementInvoiceNumber(): number {
    const profile = this.getBusinessProfile();
    const current = profile.nextInvoiceNumber || 1;
    profile.nextInvoiceNumber = current + 1;
    safeSet(KEYS.PROFILE, profile);
    return current;
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

    if (client.id) {
      const idx = clients.findIndex((c) => c.id === client.id);
      if (idx !== -1) {
        saved = { ...clients[idx], ...client, updatedAt: now } as Client;
        clients[idx] = saved;
      } else {
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
      saved = {
        ...client,
        id: generateId('cli'),
        phone: client.phone || '',
        address: client.address || '',
        createdAt: now,
        updatedAt: now,
      } as Client;
      clients.unshift(saved);
      this.addActivity({
        type: 'client_created',
        title: `Client Added: ${saved.name}`,
        description: saved.companyName ? `Company: ${saved.companyName}` : `Email: ${saved.email}`,
        referenceId: saved.id,
      });
    }

    this.lastWritePersisted = safeSet(KEYS.CLIENTS, clients);
    return saved;
  },

  deleteClient(id: string): boolean {
    const clients = this.getClients();
    const filtered = clients.filter((c) => c.id !== id);
    if (filtered.length !== clients.length) {
      safeSet(KEYS.CLIENTS, filtered);
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
    const profileLogoUrl = this.getBusinessProfile().logoUrl || '';
    const cache = getLogoCache();
    const rawQuotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    const idx = rawQuotes.findIndex((q) => q.id === quote.id);
    const now = new Date().toISOString();
    const itemToSave: Quotation = { ...quote, updatedAt: now };
    const storableItem = dehydrateSnapshotLogo(itemToSave, profileLogoUrl, cache);

    if (Object.keys(cache).length > 0) {
      saveLogoCache(cache);
    }

    if (idx !== -1) {
      rawQuotes[idx] = storableItem;
    } else {
      rawQuotes.unshift(storableItem);
      this.addActivity({
        type: 'quote_created',
        title: `Quotation ${quote.quotationNumber} Created`,
        description: `For ${quote.clientSnapshot.name || 'Client'} (${quote.currencySymbol} ${quote.grandTotal.toLocaleString()})`,
        referenceId: quote.id,
      });
    }

    this.lastWritePersisted = safeSet(KEYS.QUOTATIONS, rawQuotes);
    return itemToSave;
  },

  deleteQuotation(id: string): boolean {
    const quotes = safeGet<Quotation[]>(KEYS.QUOTATIONS, []);
    const filtered = quotes.filter((q) => q.id !== id);
    if (filtered.length !== quotes.length) {
      safeSet(KEYS.QUOTATIONS, filtered);
      return true;
    }
    return false;
  },

  // Invoices
  getInvoices(): Invoice[] {
    const profile = this.getBusinessProfile();
    const cache = getLogoCache();
    const rawInvoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
    return rawInvoices.map((inv) => hydrateDocument(inv, profile, cache));
  },

  getInvoiceById(id: string): Invoice | undefined {
    return this.getInvoices().find((inv) => inv.id === id);
  },

  saveInvoice(invoice: Invoice): Invoice {
    const profileLogoUrl = this.getBusinessProfile().logoUrl || '';
    const cache = getLogoCache();
    const rawInvoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
    const idx = rawInvoices.findIndex((i) => i.id === invoice.id);
    const now = new Date().toISOString();

    // Recalculate balances and auto status
    const { amountPaid, outstandingBalance } = calculateInvoiceBalances(invoice.grandTotal, invoice.payments || []);
    const updatedStatus = determineUpdatedInvoiceStatus(invoice.status, invoice.grandTotal, amountPaid, invoice.dueDate);

    const itemToSave: Invoice = {
      ...invoice,
      amountPaid,
      outstandingBalance,
      status: updatedStatus,
      updatedAt: now,
    };
    const storableItem = dehydrateSnapshotLogo(itemToSave, profileLogoUrl, cache);

    if (Object.keys(cache).length > 0) {
      saveLogoCache(cache);
    }

    if (idx !== -1) {
      rawInvoices[idx] = storableItem;
    } else {
      rawInvoices.unshift(storableItem);
      this.addActivity({
        type: 'invoice_created',
        title: `Invoice ${invoice.invoiceNumber} Created`,
        description: `For ${invoice.clientSnapshot.name || 'Client'} (${invoice.currencySymbol} ${invoice.grandTotal.toLocaleString()})`,
        referenceId: invoice.id,
      });
    }

    this.lastWritePersisted = safeSet(KEYS.INVOICES, rawInvoices);
    return itemToSave;
  },

  deleteInvoice(id: string): boolean {
    const invoices = safeGet<Invoice[]>(KEYS.INVOICES, []);
    const filtered = invoices.filter((i) => i.id !== id);
    if (filtered.length !== invoices.length) {
      safeSet(KEYS.INVOICES, filtered);
      return true;
    }
    return false;
  },

  recordPayment(invoiceId: string, paymentData: Omit<PaymentRecord, 'id' | 'invoiceId' | 'recordedAt'>): Invoice | undefined {
    const invoice = this.getInvoiceById(invoiceId);
    if (!invoice) return undefined;

    const newPayment: PaymentRecord = {
      id: generateId('pay'),
      invoiceId,
      amount: Number(paymentData.amount) || 0,
      paymentDate: paymentData.paymentDate || new Date().toISOString().split('T')[0],
      paymentMethod: paymentData.paymentMethod,
      reference: paymentData.reference,
      notes: paymentData.notes,
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

    this.saveInvoice(updatedInvoice);

    this.addActivity({
      type: 'payment_recorded',
      title: `Payment of ${invoice.currencySymbol} ${newPayment.amount.toLocaleString()} Recorded`,
      description: `Applied to ${invoice.invoiceNumber}. Remaining balance: ${invoice.currencySymbol} ${outstandingBalance.toLocaleString()}`,
      referenceId: invoice.id,
    });

    return updatedInvoice;
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
    safeSet(KEYS.ACTIVITIES, activities.slice(0, 40));
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
    try {
      const data = JSON.parse(jsonString);
      if (data && data.profile && Array.isArray(data.clients)) {
        const profileLogoUrl = data.profile.logoUrl || '';
        const cache: Record<string, string> = {};
        const quotes = ((data.quotations || []) as Quotation[]).map((q) =>
          dehydrateSnapshotLogo(q, profileLogoUrl, cache)
        );
        const invoices = ((data.invoices || []) as Invoice[]).map((inv) =>
          dehydrateSnapshotLogo(inv, profileLogoUrl, cache)
        );

        if (Object.keys(cache).length > 0) {
          saveLogoCache(cache);
        }
        safeSet(KEYS.PROFILE, data.profile);
        safeSet(KEYS.CLIENTS, data.clients || []);
        safeSet(KEYS.QUOTATIONS, quotes);
        safeSet(KEYS.INVOICES, invoices);
        safeSet(KEYS.ACTIVITIES, data.activities || []);
        writeRaw(KEYS.INITIALIZED, 'true');
        return true;
      }
      return false;
    } catch (e) {
      console.error('Failed to import data:', e);
      return false;
    }
  },
};
