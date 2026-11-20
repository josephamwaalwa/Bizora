import type {
  ActivityLog,
  BusinessProfile,
  Client,
  Invoice,
  PaymentRecord,
  Quotation,
} from '../../types';
import type {
  BusinessAssetDto,
  CreateBusinessAssetInput,
} from '../database';

export type PersistenceBackend = 'localStorage' | 'sqlite';

export type PersistenceErrorCode =
  | 'UNSUPPORTED_OPERATION'
  | 'WORKSPACE_NOT_INITIALIZED'
  | 'PROTECTED_SETTING'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND';

export class PersistenceError extends Error {
  public readonly code: PersistenceErrorCode;
  public readonly cause?: unknown;

  constructor(code: PersistenceErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    this.cause = cause;
  }
}

export function isPersistenceError(error: unknown): error is PersistenceError {
  return error instanceof PersistenceError;
}

export interface PersistenceCapabilities {
  backend: PersistenceBackend;
  isAsync: boolean;
  supportsStandaloneAssets: boolean;
  supportsArbitrarySettings: boolean;
  supportsAtomicWorkspaceReplace: boolean;
}

export type SaveClientInput = Partial<Client> & {
  name: string;
  email: string;
};

export type NewPaymentInput = Omit<PaymentRecord, 'id' | 'invoiceId' | 'recordedAt'>;

export type NewActivityInput = Omit<ActivityLog, 'id' | 'timestamp'>;

export type SaveBusinessAssetInput = Omit<CreateBusinessAssetInput, 'businessId'> & {
  businessId?: string;
};

export interface BackupImportResult {
  ok: boolean;
  error?: string;
  persisted?: boolean;
}

export interface PersistenceAdapter {
  readonly backend: PersistenceBackend;
  readonly capabilities: PersistenceCapabilities;

  // Business Profile
  getBusinessProfile(): Promise<BusinessProfile>;
  saveBusinessProfile(profile: BusinessProfile): Promise<BusinessProfile>;

  // Business Assets
  getBusinessAssets(): Promise<BusinessAssetDto[]>;
  getBusinessAssetById(id: string): Promise<BusinessAssetDto | null>;
  saveBusinessAsset(input: SaveBusinessAssetInput): Promise<BusinessAssetDto>;
  deleteBusinessAsset(id: string): Promise<void>;

  // Clients
  getClients(): Promise<Client[]>;
  getClientById(id: string): Promise<Client | null>;
  saveClient(client: SaveClientInput): Promise<Client>;
  deleteClient(id: string): Promise<boolean>;

  // Quotations
  getQuotations(): Promise<Quotation[]>;
  getQuotationById(id: string): Promise<Quotation | null>;
  saveQuotation(quotation: Quotation): Promise<Quotation>;
  deleteQuotation(id: string): Promise<boolean>;
  isQuotationNumberTaken(quotationNumber: string, excludeId?: string): Promise<boolean>;
  getNextAvailableQuoteNumber(): Promise<number>;
  commitUsedQuoteNumber(savedQuoteNumber: string): Promise<boolean>;

  // Invoices
  getInvoices(): Promise<Invoice[]>;
  getInvoiceById(id: string): Promise<Invoice | null>;
  saveInvoice(invoice: Invoice): Promise<Invoice>;
  deleteInvoice(id: string): Promise<boolean>;
  isInvoiceNumberTaken(invoiceNumber: string, excludeId?: string): Promise<boolean>;
  getNextAvailableInvoiceNumber(): Promise<number>;
  commitUsedInvoiceNumber(savedInvoiceNumber: string): Promise<boolean>;

  // Payments
  getPaymentsByInvoice(invoiceId: string): Promise<PaymentRecord[]>;
  getPaymentsByBusiness(): Promise<PaymentRecord[]>;
  recordPayment(invoiceId: string, paymentData: NewPaymentInput): Promise<Invoice | undefined>;
  deletePayment(paymentId: string): Promise<void>;

  // Activity Logs
  getActivities(limit?: number): Promise<ActivityLog[]>;
  addActivity(activity: NewActivityInput): Promise<ActivityLog | void>;

  // Application Settings
  getAppSetting<T = unknown>(key: string): Promise<T | null>;
  saveAppSetting(key: string, value: unknown): Promise<void>;
  deleteAppSetting(key: string): Promise<void>;

  // Workspace Backup & Lifecycle
  exportBackupJson(): Promise<string>;
  importBackupJson(jsonString: string): Promise<BackupImportResult>;
  resetToDemoData(): Promise<void>;
  clearAllData(): Promise<void>;
}
