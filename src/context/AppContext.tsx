import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  type ReactNode,
  useCallback,
} from 'react';
import type {
  BusinessProfile,
  Client,
  Quotation,
  Invoice,
  ActivityLog,
  ActiveView,
  Toast,
  QuotationStatus,
  InvoiceStatus,
} from '../types';
import type { MigrationDiagnosticDto } from '../services/database';
import {
  BrowserPersistenceAdapter,
  type NewPaymentInput,
  type PersistenceAdapter,
  type PersistenceBackend,
  type SaveClientInput,
} from '../services/persistence';
import { initialBusinessProfile } from '../services/seedData';
import {
  coordinateRuntimeStartup,
  type RuntimeStartupResult,
  type StartupBlockedReason,
  type StartupNotice,
} from '../services/runtimeStartup';
import { generateId, formatDocNumber } from '../utils/idGenerator';
import { calculateDocumentFinancials } from '../utils/calculations';
import {
  findLinkedInvoiceForQuotationRecord,
  resolveClientReferenceWithSnapshotFallback,
  validateConvertedQuotationEdit,
  validateManualInvoiceStatusChange,
  validateQuotationStatusChange,
} from '../utils/documentWorkflow';
import { useTheme } from '../hooks/useTheme';

export interface AppBackupImportResult {
  ok: boolean;
  error?: string;
  persisted?: boolean;
}

export interface SaveDocumentOptions {
  commitNumber?: boolean;
}

export interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDestructive?: boolean;
  onConfirm: () => unknown | Promise<unknown>;
}

export interface StartupBlockState {
  reason: StartupBlockedReason;
  title: string;
  message: string;
  backupFilename?: string | null;
  diagnostics: MigrationDiagnosticDto[];
}

export interface AppContextType {
  // Navigation
  activeView: ActiveView;
  activeEntityId: string | null;
  setActiveView: (view: ActiveView, entityId?: string | null) => void;

  // Workspace Lifecycle & Async Readiness
  isWorkspaceLoading: boolean;
  isSaving: boolean;
  persistenceBackend: PersistenceBackend;
  persistenceError: string | null;
  clearPersistenceError: () => void;
  startupBlockState: StartupBlockState | null;
  migrationNotice: StartupNotice | null;
  dismissMigrationNotice: () => void;
  retryWorkspaceStartup: () => Promise<void>;

  // Data
  businessProfile: BusinessProfile;
  clients: Client[];
  quotations: Quotation[];
  invoices: Invoice[];
  activities: ActivityLog[];

  // Search
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  // Business Actions
  updateBusinessProfile: (profile: BusinessProfile) => Promise<boolean>;

  // Client Actions
  saveClient: (client: SaveClientInput) => Promise<Client | undefined>;
  deleteClient: (id: string) => Promise<boolean>;

  // Quotation Actions
  saveQuotation: (quote: Quotation, options?: SaveDocumentOptions) => Promise<Quotation | undefined>;
  deleteQuotation: (id: string) => Promise<boolean>;
  duplicateQuotation: (id: string) => Promise<Quotation | undefined>;
  convertQuotationToInvoice: (quotationId: string) => Promise<Invoice | undefined>;
  updateQuotationStatus: (id: string, status: QuotationStatus) => Promise<boolean>;

  // Invoice Actions
  saveInvoice: (invoice: Invoice, options?: SaveDocumentOptions) => Promise<Invoice | undefined>;
  deleteInvoice: (id: string) => Promise<boolean>;
  duplicateInvoice: (id: string) => Promise<Invoice | undefined>;
  updateInvoiceStatus: (id: string, status: InvoiceStatus) => Promise<boolean>;
  recordPayment: (invoiceId: string, payment: NewPaymentInput) => Promise<Invoice | undefined>;

  // Document Numbering Helpers
  getNextQuoteNumber: () => Promise<string>;
  getNextInvoiceNumber: () => Promise<string>;
  commitQuoteNumber: (docNumber: string) => Promise<void>;
  commitInvoiceNumber: (docNumber: string) => Promise<void>;
  isQuotationNumberTaken: (docNumber: string, excludeId?: string) => Promise<boolean>;
  isInvoiceNumberTaken: (docNumber: string, excludeId?: string) => Promise<boolean>;

  // Document Preview Modal
  previewDocument: { type: 'quote' | 'invoice'; data: Quotation | Invoice } | null;
  openDocumentPreview: (type: 'quote' | 'invoice', data: Quotation | Invoice) => void;
  closeDocumentPreview: () => void;

  // Payment Recording Modal
  paymentModalInvoice: Invoice | null;
  openPaymentModal: (invoice: Invoice) => void;
  closePaymentModal: () => void;

  // Confirm Dialog
  confirmDialog: ConfirmDialogState;
  showConfirmDialog: (params: Omit<ConfirmDialogState, 'isOpen'>) => void;
  hideConfirmDialog: () => void;

  // Toasts
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;

  // Backup & System
  exportBackupJson: () => Promise<string>;
  importBackupJson: (jsonString: string) => Promise<AppBackupImportResult>;
  resetToDemoData: () => Promise<void>;
  clearAllData: () => Promise<void>;
  refreshData: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

let sharedInFlightStartup: Promise<RuntimeStartupResult> | null = null;

function runStartupDeduplicated(): Promise<RuntimeStartupResult> {
  if (!sharedInFlightStartup) {
    sharedInFlightStartup = coordinateRuntimeStartup().finally(() => {
      sharedInFlightStartup = null;
    });
  }
  return sharedInFlightStartup;
}

function didAdapterPersistLastWrite(adapter: PersistenceAdapter): boolean {
  return adapter instanceof BrowserPersistenceAdapter ? adapter.lastWritePersisted : true;
}

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { theme, hydrateTheme } = useTheme();

  const [activeView, setActiveViewInternal] = useState<ActiveView>('dashboard');
  const [activeEntityId, setActiveEntityId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Workspace lifecycle & error states
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [persistenceBackend, setPersistenceBackend] = useState<PersistenceBackend>('localStorage');
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [startupBlockState, setStartupBlockState] = useState<StartupBlockState | null>(null);
  const [migrationNotice, setMigrationNotice] = useState<StartupNotice | null>(null);

  // Active persistence adapter and mutation concurrency tracking
  const adapterRef = useRef<PersistenceAdapter | null>(null);
  const pendingSavesRef = useRef(0);
  const desktopThemeHydratedRef = useRef(false);

  // Domain states
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile>(initialBusinessProfile);
  const [clients, setClients] = useState<Client[]>([]);
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [activities, setActivities] = useState<ActivityLog[]>([]);

  // Modals & Feedback
  const [previewDocument, setPreviewDocument] = useState<{
    type: 'quote' | 'invoice';
    data: Quotation | Invoice;
  } | null>(null);
  const [paymentModalInvoice, setPaymentModalInvoice] = useState<Invoice | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const clearPersistenceError = useCallback(() => {
    setPersistenceError(null);
  }, []);

  const dismissMigrationNotice = useCallback(() => {
    setMigrationNotice(null);
  }, []);

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = generateId('toast');
    const newToast = { ...toast, id };
    setToasts((prev) => [...prev, newToast]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showConfirmDialog = useCallback((params: Omit<ConfirmDialogState, 'isOpen'>) => {
    setConfirmDialog({ ...params, isOpen: true });
  }, []);

  const hideConfirmDialog = useCallback(() => {
    setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const setActiveView = useCallback((view: ActiveView, entityId: string | null = null) => {
    setActiveViewInternal(view);
    setActiveEntityId(entityId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const reloadWorkspaceFromAdapter = useCallback(async (adapter: PersistenceAdapter) => {
    const [nextProfile, nextClients, nextQuotations, nextInvoices, nextActivities] =
      await Promise.all([
        adapter.getBusinessProfile(),
        adapter.getClients(),
        adapter.getQuotations(),
        adapter.getInvoices(),
        adapter.getActivities(),
      ]);

    setBusinessProfile(nextProfile);
    setClients(nextClients);
    setQuotations(nextQuotations);
    setInvoices(nextInvoices);
    setActivities(nextActivities);
    setPersistenceError(null);
  }, []);

  const runMutation = useCallback(
    async <T,>(fn: (adapter: PersistenceAdapter) => Promise<T>): Promise<T> => {
      const adapter = adapterRef.current;
      if (!adapter) {
        throw new Error('Workspace persistence layer is not initialized yet.');
      }

      pendingSavesRef.current += 1;
      if (pendingSavesRef.current === 1) {
        setIsSaving(true);
      }

      try {
        return await fn(adapter);
      } finally {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        if (pendingSavesRef.current === 0) {
          setIsSaving(false);
        }
      }
    },
    []
  );

  const applyStartupResult = useCallback(
    (result: RuntimeStartupResult) => {
      if (result.status === 'blocked') {
        adapterRef.current = null;
        setPersistenceBackend('sqlite');
        setStartupBlockState({
          reason: result.reason,
          title: result.title,
          message: result.message,
          backupFilename: result.backupFilename,
          diagnostics: result.diagnostics,
        });
        setPersistenceError(result.message);
        setIsWorkspaceLoading(false);
        return;
      }

      adapterRef.current = result.adapter;
      setPersistenceBackend(result.backend);
      setStartupBlockState(null);
      setBusinessProfile(result.businessProfile);
      setClients(result.clients);
      setQuotations(result.quotations);
      setInvoices(result.invoices);
      setActivities(result.activities);
      setMigrationNotice(result.migrationNotice);
      setPersistenceError(null);

      if (result.backend === 'sqlite') {
        if (result.themePreference) {
          hydrateTheme(result.themePreference);
        }
        desktopThemeHydratedRef.current = true;
      }

      setIsWorkspaceLoading(false);
    },
    [hydrateTheme]
  );

  const retryWorkspaceStartup = useCallback(async () => {
    setIsWorkspaceLoading(true);
    setPersistenceError(null);
    try {
      const result = await runStartupDeduplicated();
      applyStartupResult(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to initialize application persistence.';
      setPersistenceError(message);
      setIsWorkspaceLoading(false);
    }
  }, [applyStartupResult]);

  // Initial mount hydration (Browser LocalStorage via BrowserPersistenceAdapter OR Desktop SQLite gate)
  useEffect(() => {
    let cancelled = false;
    runStartupDeduplicated().then(
      (result) => {
        if (!cancelled) {
          applyStartupResult(result);
        }
      },
      (err) => {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : 'Failed to initialize application persistence.';
          setPersistenceError(message);
          setIsWorkspaceLoading(false);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [applyStartupResult]);

  // Persist user theme selection to SQLite app_settings when running on desktop
  useEffect(() => {
    if (
      persistenceBackend !== 'sqlite' ||
      !desktopThemeHydratedRef.current ||
      isWorkspaceLoading ||
      !adapterRef.current
    ) {
      return;
    }

    const adapter = adapterRef.current;
    void adapter.saveAppSetting('theme_preference', theme).catch(() => {
      // Theme preference persistence failure should not interrupt workspace usage
    });
  }, [persistenceBackend, isWorkspaceLoading, theme]);

  const refreshData = useCallback(async () => {
    const adapter = adapterRef.current;
    if (!adapter) {
      await retryWorkspaceStartup();
      return;
    }

    try {
      await reloadWorkspaceFromAdapter(adapter);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reload workspace records.';
      setPersistenceError(message);
      addToast({
        type: 'error',
        title: 'Sync Failed',
        message,
      });
    }
  }, [reloadWorkspaceFromAdapter, retryWorkspaceStartup, addToast]);

  // Business Profile
  const updateBusinessProfile = useCallback(
    async (profile: BusinessProfile): Promise<boolean> => {
      try {
        await runMutation(async (adapter) => {
          const saved = await adapter.saveBusinessProfile(profile);
          const persisted = didAdapterPersistLastWrite(adapter);
          setBusinessProfile(saved);
          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'success',
              title: 'Settings Saved',
              message: 'Business profile and preferences updated successfully.',
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Saved to Active Session',
              message:
                'Settings updated in memory, but browser storage could not persist them across reloads (check logo file size).',
            });
          }
        });
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to save business settings.';
        setPersistenceError(message);
        addToast({
          type: 'error',
          title: 'Cannot Save Settings',
          message,
        });
        return false;
      }
    },
    [runMutation, reloadWorkspaceFromAdapter, addToast]
  );

  // Clients
  const saveClient = useCallback(
    async (clientData: SaveClientInput): Promise<Client | undefined> => {
      try {
        return await runMutation(async (adapter) => {
          const saved = await adapter.saveClient(clientData);
          const persisted = didAdapterPersistLastWrite(adapter);
          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'success',
              title: clientData.id ? 'Client Updated' : 'Client Added',
              message: `${saved.name} has been saved.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Saved to Active Session',
              message: `${saved.name} was saved in memory, but browser storage could not persist it across reloads.`,
            });
          }
          return saved;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to save client.';
        setPersistenceError(message);
        addToast({
          type: 'error',
          title: 'Cannot Save Client',
          message,
        });
        return undefined;
      }
    },
    [runMutation, reloadWorkspaceFromAdapter, addToast]
  );

  const deleteClient = useCallback(
    async (id: string): Promise<boolean> => {
      const client = clients.find((c) => c.id === id);
      try {
        return await runMutation(async (adapter) => {
          const success = await adapter.deleteClient(id);
          if (!success) return false;

          const persisted = didAdapterPersistLastWrite(adapter);
          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'info',
              title: 'Client Removed',
              message: `${client?.name || 'Client'} was removed.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Updated Active Session',
              message: `${client?.name || 'Client'} was removed in memory, but browser storage could not persist the change.`,
            });
          }

          if (activeView === 'client-detail' && activeEntityId === id) {
            setActiveView('clients');
          }
          return true;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete client.';
        setPersistenceError(message);
        addToast({
          type: 'error',
          title: 'Cannot Remove Client',
          message,
        });
        return false;
      }
    },
    [clients, runMutation, reloadWorkspaceFromAdapter, addToast, activeView, activeEntityId, setActiveView]
  );

  // Document Numbering Helpers
  const getNextQuoteNumber = useCallback(async (): Promise<string> => {
    const adapter = adapterRef.current;
    if (!adapter) {
      return formatDocNumber(
        businessProfile.quotePrefix || 'QUO-',
        businessProfile.nextQuoteNumber || 1
      );
    }
    const [profile, nextNum] = await Promise.all([
      adapter.getBusinessProfile(),
      adapter.getNextAvailableQuoteNumber(),
    ]);
    return formatDocNumber(profile.quotePrefix || 'QUO-', nextNum);
  }, [businessProfile.quotePrefix, businessProfile.nextQuoteNumber]);

  const getNextInvoiceNumber = useCallback(async (): Promise<string> => {
    const adapter = adapterRef.current;
    if (!adapter) {
      return formatDocNumber(
        businessProfile.invoicePrefix || 'INV-',
        businessProfile.nextInvoiceNumber || 1
      );
    }
    const [profile, nextNum] = await Promise.all([
      adapter.getBusinessProfile(),
      adapter.getNextAvailableInvoiceNumber(),
    ]);
    return formatDocNumber(profile.invoicePrefix || 'INV-', nextNum);
  }, [businessProfile.invoicePrefix, businessProfile.nextInvoiceNumber]);

  const commitQuoteNumber = useCallback(
    async (docNumber: string): Promise<void> => {
      try {
        await runMutation(async (adapter) => {
          await adapter.commitUsedQuoteNumber(docNumber);
          await reloadWorkspaceFromAdapter(adapter);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update quote counter.';
        addToast({
          type: 'error',
          title: 'Numbering Sync Failed',
          message,
        });
      }
    },
    [runMutation, reloadWorkspaceFromAdapter, addToast]
  );

  const commitInvoiceNumber = useCallback(
    async (docNumber: string): Promise<void> => {
      try {
        await runMutation(async (adapter) => {
          await adapter.commitUsedInvoiceNumber(docNumber);
          await reloadWorkspaceFromAdapter(adapter);
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to update invoice counter.';
        addToast({
          type: 'error',
          title: 'Numbering Sync Failed',
          message,
        });
      }
    },
    [runMutation, reloadWorkspaceFromAdapter, addToast]
  );

  const isQuotationNumberTaken = useCallback(
    async (docNumber: string, excludeId?: string): Promise<boolean> => {
      const adapter = adapterRef.current;
      if (!adapter) return false;
      return adapter.isQuotationNumberTaken(docNumber, excludeId);
    },
    []
  );

  const isInvoiceNumberTaken = useCallback(
    async (docNumber: string, excludeId?: string): Promise<boolean> => {
      const adapter = adapterRef.current;
      if (!adapter) return false;
      return adapter.isInvoiceNumberTaken(docNumber, excludeId);
    },
    []
  );

  // Quotations
  const saveQuotation = useCallback(
    async (quote: Quotation, options?: SaveDocumentOptions): Promise<Quotation | undefined> => {
      try {
        let validationError: { title: string; message: string } | null = null;
        const savedResult = await runMutation(async (adapter) => {
          const existing = await adapter.getQuotationById(quote.id);
          if (existing?.convertedInvoiceId) {
            const currentInvoices = await adapter.getInvoices();
            const linkedInv = findLinkedInvoiceForQuotationRecord(existing, currentInvoices);
            const validation = validateConvertedQuotationEdit(existing, quote, linkedInv?.invoiceNumber);
            if (!validation.valid) {
              validationError = {
                title: validation.title || 'Converted Quotation Locked',
                message:
                  validation.message ||
                  'Converted quotations cannot have their financial contents or status modified.',
              };
              return undefined;
            }
          }

          const saved = await adapter.saveQuotation(quote);
          const persisted = didAdapterPersistLastWrite(adapter);

          if (options?.commitNumber && persisted) {
            try {
              await adapter.commitUsedQuoteNumber(saved.quotationNumber);
            } catch (counterErr) {
              console.warn('Failed to advance quotation sequence counter:', counterErr);
            }
          }

          if (existing && saved.status !== existing.status) {
            try {
              await adapter.addActivity({
                type: 'quote_status',
                title: `Quotation ${saved.quotationNumber} Status Updated`,
                description: `Status changed from ${existing.status} to ${saved.status}.`,
                referenceId: saved.id,
              });
            } catch (activityErr) {
              console.warn('Failed to log quotation status activity:', activityErr);
            }
          }

          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'success',
              title: 'Quotation Saved',
              message: `${saved.quotationNumber} has been saved successfully.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Saved to Active Session',
              message: `${saved.quotationNumber} was saved in memory, but browser storage could not persist it across page reloads.`,
            });
          }
          return saved;
        });

        if (validationError) {
          addToast({
            type: 'error',
            title: (validationError as { title: string; message: string }).title,
            message: (validationError as { title: string; message: string }).message,
          });
        }
        return savedResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to save quotation.';
        addToast({
          type: 'error',
          title: 'Cannot Save Quotation',
          message,
        });
        return undefined;
      }
    },
    [runMutation, reloadWorkspaceFromAdapter, addToast]
  );

  const deleteQuotation = useCallback(
    async (id: string): Promise<boolean> => {
      const quote = quotations.find((q) => q.id === id);
      try {
        return await runMutation(async (adapter) => {
          const success = await adapter.deleteQuotation(id);
          if (!success) return false;

          const persisted = didAdapterPersistLastWrite(adapter);
          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'info',
              title: 'Quotation Deleted',
              message: `Quotation ${quote?.quotationNumber || id} was deleted.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Updated Active Session',
              message: `Quotation ${quote?.quotationNumber || id} was removed in memory, but browser storage could not persist the change.`,
            });
          }

          if (previewDocument?.data.id === id) {
            setPreviewDocument(null);
          }
          if (activeView === 'quotation-edit' && activeEntityId === id) {
            setActiveView('quotations');
          }
          return true;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete quotation.';
        addToast({
          type: 'error',
          title: 'Cannot Delete Quotation',
          message,
        });
        return false;
      }
    },
    [
      quotations,
      runMutation,
      reloadWorkspaceFromAdapter,
      addToast,
      previewDocument,
      activeView,
      activeEntityId,
      setActiveView,
    ]
  );

  const duplicateQuotation = useCallback(
    async (id: string): Promise<Quotation | undefined> => {
      const original = quotations.find((q) => q.id === id);
      if (!original) return undefined;

      try {
        let clientErrorMessage: string | null = null;
        const result = await runMutation(async (adapter) => {
          const [currentClients, currentProfile, nextNum] = await Promise.all([
            adapter.getClients(),
            adapter.getBusinessProfile(),
            adapter.getNextAvailableQuoteNumber(),
          ]);

          const clientRef = resolveClientReferenceWithSnapshotFallback(
            original,
            currentClients,
            'duplicate'
          );
          if (!clientRef.ok) {
            clientErrorMessage = clientRef.message || 'Cannot duplicate quotation: missing client details.';
            return undefined;
          }

          const newNumber = formatDocNumber(currentProfile.quotePrefix || 'QUO-', nextNum);
          const now = new Date().toISOString();

          const duplicated: Quotation = {
            ...original,
            id: generateId('quo'),
            quotationNumber: newNumber,
            clientId: clientRef.clientId,
            clientSnapshot: clientRef.clientSnapshot,
            businessSnapshot: currentProfile,
            status: 'draft',
            preConversionStatus: undefined,
            issueDate: now.split('T')[0],
            expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
              .toISOString()
              .split('T')[0],
            items: original.items.map((item) => ({
              ...item,
              id: generateId('item'),
            })),
            convertedInvoiceId: undefined,
            createdAt: now,
            updatedAt: now,
          };

          const saved = await adapter.saveQuotation(duplicated);
          const persisted = didAdapterPersistLastWrite(adapter);
          if (persisted) {
            try {
              await adapter.commitUsedQuoteNumber(saved.quotationNumber);
            } catch (counterErr) {
              console.warn('Failed to advance quotation sequence counter:', counterErr);
            }
          }
          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'success',
              title: 'Quotation Duplicated',
              message: `Created duplicate ${saved.quotationNumber} from ${original.quotationNumber}.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Saved to Active Session',
              message: `Duplicate ${saved.quotationNumber} was created in memory, but browser storage could not persist it across reloads.`,
            });
          }
          return saved;
        });

        if (clientErrorMessage) {
          addToast({
            type: 'error',
            title: 'Cannot Duplicate Quotation',
            message: clientErrorMessage,
          });
        }
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to duplicate quotation.';
        addToast({
          type: 'error',
          title: 'Cannot Duplicate Quotation',
          message,
        });
        return undefined;
      }
    },
    [quotations, runMutation, reloadWorkspaceFromAdapter, addToast]
  );

  const updateQuotationStatus = useCallback(
    async (id: string, status: QuotationStatus): Promise<boolean> => {
      const quote = quotations.find((q) => q.id === id);
      if (!quote) return false;

      if (quote.status === status) return true;

      const linkedInv = findLinkedInvoiceForQuotationRecord(quote, invoices);
      const validation = validateQuotationStatusChange(quote, status, linkedInv?.invoiceNumber);
      if (!validation.valid) {
        addToast({
          type: 'error',
          title: validation.title || 'Status Update Blocked',
          message: validation.message || 'This quotation status cannot be changed.',
        });
        return false;
      }

      const updated: Quotation = {
        ...quote,
        status,
        preConversionStatus: quote.convertedInvoiceId ? quote.preConversionStatus : undefined,
      };

      try {
        return await runMutation(async (adapter) => {
          const saved = await adapter.saveQuotation(updated);
          const persisted = didAdapterPersistLastWrite(adapter);

          if (saved.status !== quote.status) {
            try {
              await adapter.addActivity({
                type: 'quote_status',
                title: `Quotation ${saved.quotationNumber} Status Updated`,
                description: `Status changed from ${quote.status} to ${saved.status}.`,
                referenceId: saved.id,
              });
            } catch (activityErr) {
              console.warn('Failed to log quotation status activity:', activityErr);
            }
          }

          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'info',
              title: 'Status Updated',
              message: `${saved.quotationNumber} status changed to ${saved.status}.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Updated Active Session',
              message: `${saved.quotationNumber} status changed in memory, but browser storage could not persist it across reloads.`,
            });
          }

          if (previewDocument && previewDocument.data.id === id) {
            setPreviewDocument({ type: 'quote', data: saved });
          }
          return true;
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to update quotation status.';
        addToast({
          type: 'error',
          title: 'Status Update Failed',
          message,
        });
        return false;
      }
    },
    [quotations, invoices, runMutation, reloadWorkspaceFromAdapter, addToast, previewDocument]
  );

  const convertQuotationToInvoice = useCallback(
    async (quotationId: string): Promise<Invoice | undefined> => {
      const quote = quotations.find((q) => q.id === quotationId);
      if (!quote) return undefined;

      if (quote.status === 'declined') {
        addToast({
          type: 'error',
          title: 'Cannot Convert Quotation',
          message: `Quotation ${quote.quotationNumber} is declined and cannot be converted to an invoice.`,
        });
        return undefined;
      }

      const existingLinkedInvoice = findLinkedInvoiceForQuotationRecord(quote, invoices);
      if (existingLinkedInvoice) {
        addToast({
          type: 'info',
          title: 'Already Converted',
          message: `${quote.quotationNumber} is already linked to Invoice ${existingLinkedInvoice.invoiceNumber}.`,
        });
        setPreviewDocument({ type: 'invoice', data: existingLinkedInvoice });
        return existingLinkedInvoice;
      }

      try {
        let clientErrorMessage: string | null = null;
        let alreadyLinkedResult: Invoice | undefined;

        const createdResult = await runMutation(async (adapter) => {
          const [liveQuote, currentInvoices, currentClients] = await Promise.all([
            adapter.getQuotationById(quotationId),
            adapter.getInvoices(),
            adapter.getClients(),
          ]);

          const effectiveQuote = liveQuote || quote;
          const liveLinkedInvoice = findLinkedInvoiceForQuotationRecord(
            effectiveQuote,
            currentInvoices
          );
          if (liveLinkedInvoice) {
            alreadyLinkedResult = liveLinkedInvoice;
            return liveLinkedInvoice;
          }

          if (effectiveQuote.status === 'declined') {
            clientErrorMessage = `Quotation ${effectiveQuote.quotationNumber} is declined and cannot be converted to an invoice.`;
            return undefined;
          }

          const clientRef = resolveClientReferenceWithSnapshotFallback(
            effectiveQuote,
            currentClients,
            'convert'
          );
          if (!clientRef.ok) {
            clientErrorMessage =
              clientRef.message ||
              'The client for this quotation no longer exists. Please assign a client first.';
            return undefined;
          }

          const [currentProfile, nextNum] = await Promise.all([
            adapter.getBusinessProfile(),
            adapter.getNextAvailableInvoiceNumber(),
          ]);
          const newInvoiceNumber = formatDocNumber(
            currentProfile.invoicePrefix || 'INV-',
            nextNum
          );

          const now = new Date().toISOString();
          const issueDate = now.split('T')[0];
          const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split('T')[0];

          const copiedItems = effectiveQuote.items.map((item) => ({
            ...item,
            id: generateId('item'),
          }));

          const financials = calculateDocumentFinancials({
            items: copiedItems,
            discountType: effectiveQuote.discountType,
            discountValue: effectiveQuote.discountValue,
            isTaxEnabled: effectiveQuote.taxRate > 0,
            taxRate: effectiveQuote.taxRate,
            taxName: effectiveQuote.taxName,
          });

          const newInvoice: Invoice = {
            id: generateId('inv'),
            invoiceNumber: newInvoiceNumber,
            quotationId: effectiveQuote.id,
            clientId: clientRef.clientId,
            clientSnapshot: clientRef.clientSnapshot,
            businessSnapshot: currentProfile,
            issueDate,
            dueDate,
            currency: effectiveQuote.currency,
            currencySymbol: effectiveQuote.currencySymbol,
            items: copiedItems,
            subtotal: financials.subtotal,
            discountType: effectiveQuote.discountType,
            discountValue: effectiveQuote.discountValue,
            discountAmount: financials.discountAmount,
            taxName: effectiveQuote.taxName,
            taxRate: effectiveQuote.taxRate,
            taxAmount: financials.taxAmount,
            grandTotal: financials.grandTotal,
            amountPaid: 0,
            outstandingBalance: financials.grandTotal,
            status: 'sent',
            notes: effectiveQuote.notes,
            terms: currentProfile.defaultTermsInvoice,
            payments: [],
            createdAt: now,
            updatedAt: now,
          };

          // Both SQLite (in create_invoice Immediate tx) and BrowserStorage atomically link
          // and mark the quotation as 'accepted' with convertedInvoiceId inside saveInvoice.
          const savedInvoice = await adapter.saveInvoice(newInvoice);
          const persisted = didAdapterPersistLastWrite(adapter);

          if (persisted) {
            try {
              await adapter.commitUsedInvoiceNumber(savedInvoice.invoiceNumber);
            } catch (counterErr) {
              console.warn('Failed to advance invoice sequence counter:', counterErr);
            }
          }

          try {
            await adapter.addActivity({
              type: 'quote_converted',
              title: `Quotation ${effectiveQuote.quotationNumber} Converted`,
              description: `Created Invoice ${savedInvoice.invoiceNumber} for ${clientRef.clientSnapshot.name}`,
              referenceId: savedInvoice.id,
            });
          } catch (activityErr) {
            console.warn('Failed to log quotation conversion activity:', activityErr);
          }

          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'success',
              title: 'Converted to Invoice',
              message: `${effectiveQuote.quotationNumber} was successfully converted into ${savedInvoice.invoiceNumber}.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Converted in Active Session',
              message: `${savedInvoice.invoiceNumber} was created in memory, but browser storage could not persist it across reloads.`,
            });
          }

          setPreviewDocument({ type: 'invoice', data: savedInvoice });
          return savedInvoice;
        });

        if (alreadyLinkedResult) {
          addToast({
            type: 'info',
            title: 'Already Converted',
            message: `${quote.quotationNumber} is already linked to Invoice ${alreadyLinkedResult.invoiceNumber}.`,
          });
          setPreviewDocument({ type: 'invoice', data: alreadyLinkedResult });
          return alreadyLinkedResult;
        }

        if (clientErrorMessage) {
          addToast({
            type: 'error',
            title: 'Cannot Convert Quotation',
            message: clientErrorMessage,
          });
        }
        return createdResult;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to convert quotation to invoice.';
        addToast({
          type: 'error',
          title: 'Conversion Failed',
          message,
        });
        return undefined;
      }
    },
    [quotations, invoices, runMutation, reloadWorkspaceFromAdapter, addToast]
  );

  // Invoices
  const saveInvoice = useCallback(
    async (invoice: Invoice, options?: SaveDocumentOptions): Promise<Invoice | undefined> => {
      try {
        return await runMutation(async (adapter) => {
          const existing = await adapter.getInvoiceById(invoice.id);
          const saved = await adapter.saveInvoice(invoice);
          const persisted = didAdapterPersistLastWrite(adapter);

          if (options?.commitNumber && persisted) {
            try {
              await adapter.commitUsedInvoiceNumber(saved.invoiceNumber);
            } catch (counterErr) {
              console.warn('Failed to advance invoice sequence counter:', counterErr);
            }
          }

          if (existing && saved.status !== existing.status) {
            try {
              await adapter.addActivity({
                type: 'invoice_status',
                title: `Invoice ${saved.invoiceNumber} Status Updated`,
                description: `Status changed from ${existing.status} to ${saved.status}.`,
                referenceId: saved.id,
              });
            } catch (activityErr) {
              console.warn('Failed to log invoice status activity:', activityErr);
            }
          }

          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'success',
              title: 'Invoice Saved',
              message: `${saved.invoiceNumber} has been saved successfully.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Saved to Active Session',
              message: `${saved.invoiceNumber} was saved in memory, but browser storage could not persist it across page reloads.`,
            });
          }
          return saved;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to save invoice.';
        addToast({
          type: 'error',
          title: 'Cannot Save Invoice',
          message,
        });
        return undefined;
      }
    },
    [runMutation, reloadWorkspaceFromAdapter, addToast]
  );

  const deleteInvoice = useCallback(
    async (id: string): Promise<boolean> => {
      const invoice = invoices.find((i) => i.id === id);
      try {
        return await runMutation(async (adapter) => {
          const success = await adapter.deleteInvoice(id);
          if (!success) return false;

          const persisted = didAdapterPersistLastWrite(adapter);
          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'info',
              title: 'Invoice Deleted',
              message: `Invoice ${invoice?.invoiceNumber || id} was deleted.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Updated Active Session',
              message: `Invoice ${invoice?.invoiceNumber || id} was removed in memory, but browser storage could not persist the change.`,
            });
          }

          if (previewDocument?.data.id === id) {
            setPreviewDocument(null);
          }
          if (activeView === 'invoice-edit' && activeEntityId === id) {
            setActiveView('invoices');
          }
          return true;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete invoice.';
        addToast({
          type: 'error',
          title: 'Cannot Delete Invoice',
          message,
        });
        return false;
      }
    },
    [
      invoices,
      runMutation,
      reloadWorkspaceFromAdapter,
      addToast,
      previewDocument,
      activeView,
      activeEntityId,
      setActiveView,
    ]
  );

  const duplicateInvoice = useCallback(
    async (id: string): Promise<Invoice | undefined> => {
      const original = invoices.find((i) => i.id === id);
      if (!original) return undefined;

      try {
        let clientErrorMessage: string | null = null;
        const result = await runMutation(async (adapter) => {
          const [currentClients, currentProfile, nextNum] = await Promise.all([
            adapter.getClients(),
            adapter.getBusinessProfile(),
            adapter.getNextAvailableInvoiceNumber(),
          ]);

          const clientRef = resolveClientReferenceWithSnapshotFallback(
            original,
            currentClients,
            'duplicate'
          );
          if (!clientRef.ok) {
            clientErrorMessage = clientRef.message || 'Cannot duplicate invoice: missing client details.';
            return undefined;
          }

          const newNumber = formatDocNumber(currentProfile.invoicePrefix || 'INV-', nextNum);
          const now = new Date().toISOString();

          const duplicated: Invoice = {
            ...original,
            id: generateId('inv'),
            invoiceNumber: newNumber,
            clientId: clientRef.clientId,
            clientSnapshot: clientRef.clientSnapshot,
            businessSnapshot: currentProfile,
            status: 'draft',
            items: original.items.map((item) => ({
              ...item,
              id: generateId('item'),
            })),
            payments: [],
            amountPaid: 0,
            outstandingBalance: original.grandTotal,
            quotationId: undefined,
            issueDate: now.split('T')[0],
            dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
              .toISOString()
              .split('T')[0],
            createdAt: now,
            updatedAt: now,
          };

          const saved = await adapter.saveInvoice(duplicated);
          const persisted = didAdapterPersistLastWrite(adapter);
          if (persisted) {
            try {
              await adapter.commitUsedInvoiceNumber(saved.invoiceNumber);
            } catch (counterErr) {
              console.warn('Failed to advance invoice sequence counter:', counterErr);
            }
          }
          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'success',
              title: 'Invoice Duplicated',
              message: `Created duplicate ${saved.invoiceNumber} from ${original.invoiceNumber}.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Saved to Active Session',
              message: `Duplicate ${saved.invoiceNumber} was created in memory, but browser storage could not persist it across reloads.`,
            });
          }
          return saved;
        });

        if (clientErrorMessage) {
          addToast({
            type: 'error',
            title: 'Cannot Duplicate Invoice',
            message: clientErrorMessage,
          });
        }
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to duplicate invoice.';
        addToast({
          type: 'error',
          title: 'Cannot Duplicate Invoice',
          message,
        });
        return undefined;
      }
    },
    [invoices, runMutation, reloadWorkspaceFromAdapter, addToast]
  );

  const updateInvoiceStatus = useCallback(
    async (id: string, status: InvoiceStatus): Promise<boolean> => {
      const invoice = invoices.find((i) => i.id === id);
      if (!invoice) return false;

      if (invoice.status === status) return true;

      const validation = validateManualInvoiceStatusChange(invoice, status);
      if (!validation.valid) {
        addToast({
          type: 'error',
          title: validation.title || 'Status Update Blocked',
          message: validation.message || 'This invoice status cannot be changed manually.',
        });
        return false;
      }

      const updated: Invoice = { ...invoice, status };
      try {
        return await runMutation(async (adapter) => {
          const saved = await adapter.saveInvoice(updated);
          const persisted = didAdapterPersistLastWrite(adapter);

          if (saved.status !== invoice.status) {
            try {
              await adapter.addActivity({
                type: 'invoice_status',
                title: `Invoice ${saved.invoiceNumber} Status Updated`,
                description: `Status changed from ${invoice.status} to ${saved.status}.`,
                referenceId: saved.id,
              });
            } catch (activityErr) {
              console.warn('Failed to log invoice status activity:', activityErr);
            }
          }

          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'info',
              title: 'Status Updated',
              message: `${saved.invoiceNumber} status changed to ${saved.status}.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Updated Active Session',
              message: `${saved.invoiceNumber} status changed in memory, but browser storage could not persist it across reloads.`,
            });
          }

          if (previewDocument && previewDocument.data.id === id) {
            setPreviewDocument({ type: 'invoice', data: saved });
          }
          return true;
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to update invoice status.';
        addToast({
          type: 'error',
          title: 'Status Update Failed',
          message,
        });
        return false;
      }
    },
    [invoices, runMutation, reloadWorkspaceFromAdapter, addToast, previewDocument]
  );

  const recordPayment = useCallback(
    async (invoiceId: string, paymentData: NewPaymentInput): Promise<Invoice | undefined> => {
      try {
        return await runMutation(async (adapter) => {
          const updated = await adapter.recordPayment(invoiceId, paymentData);
          if (!updated) {
            addToast({
              type: 'error',
              title: 'Payment Failed',
              message: 'The target invoice could not be found.',
            });
            return undefined;
          }

          const persisted = didAdapterPersistLastWrite(adapter);
          await reloadWorkspaceFromAdapter(adapter);

          if (persisted) {
            addToast({
              type: 'success',
              title: 'Payment Recorded',
              message: `${updated.currencySymbol} ${paymentData.amount.toLocaleString()} received for ${updated.invoiceNumber}.`,
            });
          } else {
            addToast({
              type: 'warning',
              title: 'Recorded in Active Session',
              message: `Payment recorded in memory for ${updated.invoiceNumber}, but browser storage could not persist it across reloads.`,
            });
          }

          if (previewDocument && previewDocument.data.id === invoiceId) {
            setPreviewDocument({ type: 'invoice', data: updated });
          }
          setPaymentModalInvoice(null);
          return updated;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to record payment.';
        addToast({
          type: 'error',
          title: 'Payment Failed',
          message,
        });
        return undefined;
      }
    },
    [runMutation, reloadWorkspaceFromAdapter, addToast, previewDocument]
  );

  // Preview & Payment Modals
  const openDocumentPreview = useCallback((type: 'quote' | 'invoice', data: Quotation | Invoice) => {
    setPreviewDocument({ type, data });
  }, []);

  const closeDocumentPreview = useCallback(() => {
    setPreviewDocument(null);
  }, []);

  const openPaymentModal = useCallback((invoice: Invoice) => {
    setPaymentModalInvoice(invoice);
  }, []);

  const closePaymentModal = useCallback(() => {
    setPaymentModalInvoice(null);
  }, []);

  // Backup & System Resets
  const exportBackupJson = useCallback(async (): Promise<string> => {
    const adapter = adapterRef.current;
    if (!adapter) {
      throw new Error('Workspace persistence adapter is not ready yet.');
    }
    return adapter.exportBackupJson();
  }, []);

  const importBackupJson = useCallback(
    async (jsonString: string): Promise<AppBackupImportResult> => {
      try {
        return await runMutation(async (adapter) => {
          const result = await adapter.importBackupJson(jsonString);
          if (!result.ok) {
            return {
              ok: false,
              error: result.error || 'The selected file is not a valid Bizora backup JSON.',
              persisted: result.persisted ?? false,
            };
          }

          await reloadWorkspaceFromAdapter(adapter);
          return {
            ok: true,
            persisted: result.persisted ?? didAdapterPersistLastWrite(adapter),
          };
        });
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error ? error.message : 'Failed to import the selected backup file.',
          persisted: false,
        };
      }
    },
    [runMutation, reloadWorkspaceFromAdapter]
  );

  const resetToDemoData = useCallback(async (): Promise<void> => {
    try {
      await runMutation(async (adapter) => {
        await adapter.resetToDemoData();
        const persisted = didAdapterPersistLastWrite(adapter);
        await reloadWorkspaceFromAdapter(adapter);
        if (persisted) {
          addToast({
            type: 'success',
            title: 'Demo Data Restored',
            message:
              'Workspace has been repopulated with sample clients, quotations, and invoices.',
          });
        } else {
          addToast({
            type: 'warning',
            title: 'Demo Data Loaded in Active Session',
            message:
              'Sample data loaded in memory, but browser storage could not persist it across reloads.',
          });
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restore demo data.';
      setPersistenceError(message);
      addToast({
        type: 'error',
        title: 'Restore Demo Data Failed',
        message,
      });
    }
  }, [runMutation, reloadWorkspaceFromAdapter, addToast]);

  const clearAllData = useCallback(async (): Promise<void> => {
    try {
      await runMutation(async (adapter) => {
        await adapter.clearAllData();
        const persisted = didAdapterPersistLastWrite(adapter);
        await reloadWorkspaceFromAdapter(adapter);
        setActiveView('dashboard');
        if (persisted) {
          addToast({
            type: 'warning',
            title: 'Workspace Cleared',
            message: 'All records have been reset. You now have a clean slate.',
          });
        } else {
          addToast({
            type: 'warning',
            title: 'Cleared in Active Session',
            message:
              'Workspace cleared in memory, but browser storage could not persist the reset.',
          });
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clear workspace data.';
      setPersistenceError(message);
      addToast({
        type: 'error',
        title: 'Clear Data Failed',
        message,
      });
    }
  }, [runMutation, reloadWorkspaceFromAdapter, setActiveView, addToast]);

  // Keep state in sync on cross-tab updates ONLY when running in Browser LocalStorage mode
  useEffect(() => {
    if (persistenceBackend !== 'localStorage' || isWorkspaceLoading) {
      return;
    }
    const handleStorageChange = () => {
      void refreshData();
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [persistenceBackend, isWorkspaceLoading, refreshData]);

  return (
    <AppContext.Provider
      value={{
        activeView,
        activeEntityId,
        setActiveView,
        isWorkspaceLoading,
        isSaving,
        persistenceBackend,
        persistenceError,
        clearPersistenceError,
        startupBlockState,
        migrationNotice,
        dismissMigrationNotice,
        retryWorkspaceStartup,
        businessProfile,
        clients,
        quotations,
        invoices,
        activities,
        searchQuery,
        setSearchQuery,
        updateBusinessProfile,
        saveClient,
        deleteClient,
        saveQuotation,
        deleteQuotation,
        duplicateQuotation,
        convertQuotationToInvoice,
        updateQuotationStatus,
        saveInvoice,
        deleteInvoice,
        duplicateInvoice,
        updateInvoiceStatus,
        recordPayment,
        getNextQuoteNumber,
        getNextInvoiceNumber,
        commitQuoteNumber,
        commitInvoiceNumber,
        isQuotationNumberTaken,
        isInvoiceNumberTaken,
        previewDocument,
        openDocumentPreview,
        closeDocumentPreview,
        paymentModalInvoice,
        openPaymentModal,
        closePaymentModal,
        confirmDialog,
        showConfirmDialog,
        hideConfirmDialog,
        toasts,
        addToast,
        removeToast,
        exportBackupJson,
        importBackupJson,
        resetToDemoData,
        clearAllData,
        refreshData,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
