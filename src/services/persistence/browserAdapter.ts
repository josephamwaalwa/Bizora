import type {
  ActivityLog,
  BusinessProfile,
  Client,
  Invoice,
  PaymentRecord,
  Quotation,
} from '../../types';
import {
  calculateInvoiceBalances,
  determineUpdatedInvoiceStatus,
} from '../../utils/calculations';
import {
  getStoredTheme,
  isValidThemeMode,
  saveStoredTheme,
  THEME_STORAGE_KEY,
} from '../../utils/theme';
import type { BusinessAssetDto } from '../database';
import { StorageService } from '../storage';
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

export interface BrowserStorageBackend {
  lastWritePersisted: boolean;
  lastImportError: string | null;
  getBusinessProfile(): BusinessProfile;
  saveBusinessProfile(profile: BusinessProfile): BusinessProfile;
  getClients(): Client[];
  getClientById(id: string): Client | undefined;
  saveClient(client: SaveClientInput): Client;
  deleteClient(id: string): boolean;
  getQuotations(): Quotation[];
  getQuotationById(id: string): Quotation | undefined;
  saveQuotation(quote: Quotation): Quotation;
  deleteQuotation(id: string): boolean;
  isQuotationNumberTaken(quotationNumber: string, excludeId?: string, existingQuotes?: Quotation[]): boolean;
  getNextAvailableQuoteNumber(): number;
  commitUsedQuoteNumber(savedQuoteNumber: string): boolean;
  getInvoices(): Invoice[];
  getInvoiceById(id: string): Invoice | undefined;
  saveInvoice(invoice: Invoice): Invoice;
  deleteInvoice(id: string): boolean;
  isInvoiceNumberTaken(invoiceNumber: string, excludeId?: string, existingInvoices?: Invoice[]): boolean;
  getNextAvailableInvoiceNumber(): number;
  commitUsedInvoiceNumber(savedInvoiceNumber: string): boolean;
  recordPayment(invoiceId: string, paymentData: NewPaymentInput): Invoice | undefined;
  getActivities(): ActivityLog[];
  addActivity(activity: NewActivityInput): void;
  exportBackupJson(): string;
  importBackupJson(jsonString: string): boolean;
  resetToDemoData(): void;
  clearAllData(): void;
}

export interface BrowserThemeStore {
  getTheme(): string;
  setTheme(mode: string): void;
  clearTheme(): void;
}

export interface BrowserPersistenceAdapterOptions {
  storage?: BrowserStorageBackend;
  themeStore?: BrowserThemeStore;
}

const DEFAULT_THEME_STORE: BrowserThemeStore = {
  getTheme: () => getStoredTheme(),
  setTheme: (mode) => {
    if (isValidThemeMode(mode)) {
      saveStoredTheme(mode);
    }
  },
  clearTheme: () => {
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined') {
        globalThis.localStorage.removeItem(THEME_STORAGE_KEY);
      }
    } catch {
      // Ignore storage access errors in restricted browser environments
    }
  },
};

const THEME_SETTING_KEY = 'theme_preference';

function assertAllowedBrowserSettingKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new PersistenceError('VALIDATION_ERROR', 'Setting key cannot be empty.');
  }
  if (trimmed !== THEME_SETTING_KEY) {
    throw new PersistenceError(
      'UNSUPPORTED_OPERATION',
      `Browser LocalStorage persistence only supports the '${THEME_SETTING_KEY}' setting key; '${trimmed}' is reserved for desktop SQLite.`
    );
  }
  return trimmed;
}

/**
 * Browser LocalStorage persistence adapter.
 *
 * Delegates directly to the existing `StorageService` without changing any LocalStorage keys,
 * synchronous data formats, or initialization behavior. Construction is completely side-effect-free.
 */
export class BrowserPersistenceAdapter implements PersistenceAdapter {
  public readonly backend = 'localStorage' as const;
  public readonly capabilities: PersistenceCapabilities = {
    backend: 'localStorage',
    isAsync: false,
    supportsStandaloneAssets: false,
    supportsArbitrarySettings: false,
    supportsAtomicWorkspaceReplace: false,
  };

  private readonly storage: BrowserStorageBackend;
  private readonly themeStore: BrowserThemeStore;

  constructor(options?: BrowserPersistenceAdapterOptions) {
    this.storage = options?.storage ?? StorageService;
    this.themeStore = options?.themeStore ?? DEFAULT_THEME_STORE;
  }

  get lastWritePersisted(): boolean {
    return this.storage.lastWritePersisted;
  }

  // Business Profile
  async getBusinessProfile(): Promise<BusinessProfile> {
    return this.storage.getBusinessProfile();
  }

  async saveBusinessProfile(profile: BusinessProfile): Promise<BusinessProfile> {
    return this.storage.saveBusinessProfile(profile);
  }

  // Business Assets (Browser uses inline/cached logoUrl on BusinessProfile and snapshots)
  async getBusinessAssets(): Promise<BusinessAssetDto[]> {
    return [];
  }

  async getBusinessAssetById(_id: string): Promise<BusinessAssetDto | null> {
    return null;
  }

  async saveBusinessAsset(_input: SaveBusinessAssetInput): Promise<BusinessAssetDto> {
    throw new PersistenceError(
      'UNSUPPORTED_OPERATION',
      'Standalone business asset records are only supported in the desktop SQLite persistence backend; browser persistence stores logos on BusinessProfile.logoUrl.'
    );
  }

  async deleteBusinessAsset(_id: string): Promise<void> {
    throw new PersistenceError(
      'UNSUPPORTED_OPERATION',
      'Standalone business asset deletion is only supported in the desktop SQLite persistence backend.'
    );
  }

  // Clients
  async getClients(): Promise<Client[]> {
    return this.storage.getClients();
  }

  async getClientById(id: string): Promise<Client | null> {
    return this.storage.getClientById(id) ?? null;
  }

  async saveClient(client: SaveClientInput): Promise<Client> {
    return this.storage.saveClient(client);
  }

  async deleteClient(id: string): Promise<boolean> {
    return this.storage.deleteClient(id);
  }

  // Quotations
  async getQuotations(): Promise<Quotation[]> {
    return this.storage.getQuotations();
  }

  async getQuotationById(id: string): Promise<Quotation | null> {
    return this.storage.getQuotationById(id) ?? null;
  }

  async saveQuotation(quotation: Quotation): Promise<Quotation> {
    return this.storage.saveQuotation(quotation);
  }

  async deleteQuotation(id: string): Promise<boolean> {
    return this.storage.deleteQuotation(id);
  }

  async isQuotationNumberTaken(quotationNumber: string, excludeId?: string): Promise<boolean> {
    return this.storage.isQuotationNumberTaken(quotationNumber, excludeId);
  }

  async getNextAvailableQuoteNumber(): Promise<number> {
    return this.storage.getNextAvailableQuoteNumber();
  }

  async commitUsedQuoteNumber(savedQuoteNumber: string): Promise<boolean> {
    return this.storage.commitUsedQuoteNumber(savedQuoteNumber);
  }

  // Invoices
  async getInvoices(): Promise<Invoice[]> {
    return this.storage.getInvoices();
  }

  async getInvoiceById(id: string): Promise<Invoice | null> {
    return this.storage.getInvoiceById(id) ?? null;
  }

  async saveInvoice(invoice: Invoice): Promise<Invoice> {
    return this.storage.saveInvoice(invoice);
  }

  async deleteInvoice(id: string): Promise<boolean> {
    return this.storage.deleteInvoice(id);
  }

  async isInvoiceNumberTaken(invoiceNumber: string, excludeId?: string): Promise<boolean> {
    return this.storage.isInvoiceNumberTaken(invoiceNumber, excludeId);
  }

  async getNextAvailableInvoiceNumber(): Promise<number> {
    return this.storage.getNextAvailableInvoiceNumber();
  }

  async commitUsedInvoiceNumber(savedInvoiceNumber: string): Promise<boolean> {
    return this.storage.commitUsedInvoiceNumber(savedInvoiceNumber);
  }

  // Payments
  async getPaymentsByInvoice(invoiceId: string): Promise<PaymentRecord[]> {
    const invoice = this.storage.getInvoiceById(invoiceId);
    return invoice?.payments ? [...invoice.payments] : [];
  }

  async getPaymentsByBusiness(): Promise<PaymentRecord[]> {
    const invoices = this.storage.getInvoices();
    const payments: PaymentRecord[] = [];
    for (const invoice of invoices) {
      if (Array.isArray(invoice.payments)) {
        payments.push(...invoice.payments);
      }
    }
    return payments.sort((a, b) => {
      const dateDiff = b.paymentDate.localeCompare(a.paymentDate);
      if (dateDiff !== 0) return dateDiff;
      return b.recordedAt.localeCompare(a.recordedAt);
    });
  }

  async recordPayment(invoiceId: string, paymentData: NewPaymentInput): Promise<Invoice | undefined> {
    return this.storage.recordPayment(invoiceId, paymentData);
  }

  async deletePayment(paymentId: string): Promise<void> {
    const invoices = this.storage.getInvoices();
    const targetInvoice = invoices.find((inv) =>
      (inv.payments ?? []).some((payment) => payment.id === paymentId)
    );
    if (!targetInvoice) {
      throw new PersistenceError('NOT_FOUND', `Payment record '${paymentId}' was not found.`);
    }

    const remainingPayments = (targetInvoice.payments ?? []).filter(
      (payment) => payment.id !== paymentId
    );
    const { amountPaid, outstandingBalance } = calculateInvoiceBalances(
      targetInvoice.grandTotal,
      remainingPayments
    );
    const updatedStatus = determineUpdatedInvoiceStatus(
      targetInvoice.status === 'paid' || targetInvoice.status === 'partially_paid'
        ? 'sent'
        : targetInvoice.status,
      targetInvoice.grandTotal,
      amountPaid,
      targetInvoice.dueDate
    );

    this.storage.saveInvoice({
      ...targetInvoice,
      payments: remainingPayments,
      amountPaid,
      outstandingBalance,
      status: updatedStatus,
    });
  }

  // Activity Logs
  async getActivities(limit?: number): Promise<ActivityLog[]> {
    const activities = this.storage.getActivities();
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return activities.slice(0, Math.floor(limit));
    }
    return activities;
  }

  async addActivity(activity: NewActivityInput): Promise<void> {
    this.storage.addActivity(activity);
  }

  // Application Settings
  async getAppSetting<T = unknown>(key: string): Promise<T | null> {
    const trimmed = key.trim();
    if (trimmed === THEME_SETTING_KEY) {
      return this.themeStore.getTheme() as unknown as T;
    }
    return null;
  }

  async saveAppSetting(key: string, value: unknown): Promise<void> {
    assertAllowedBrowserSettingKey(key);
    if (!isValidThemeMode(value)) {
      throw new PersistenceError(
        'VALIDATION_ERROR',
        "Invalid theme preference value; expected 'light', 'dark', or 'system'."
      );
    }
    this.themeStore.setTheme(value);
  }

  async deleteAppSetting(key: string): Promise<void> {
    assertAllowedBrowserSettingKey(key);
    this.themeStore.clearTheme();
  }

  // Workspace Backup & Lifecycle
  async exportBackupJson(): Promise<string> {
    return this.storage.exportBackupJson();
  }

  async importBackupJson(jsonString: string): Promise<BackupImportResult> {
    const ok = this.storage.importBackupJson(jsonString);
    if (!ok) {
      return {
        ok: false,
        error: this.storage.lastImportError ?? 'Could not import backup.',
        persisted: this.storage.lastWritePersisted,
      };
    }
    return {
      ok: true,
      persisted: this.storage.lastWritePersisted,
    };
  }

  async resetToDemoData(): Promise<void> {
    this.storage.resetToDemoData();
  }

  async clearAllData(): Promise<void> {
    this.storage.clearAllData();
  }
}
