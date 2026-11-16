import React, { createContext, useContext, useState, useEffect, type ReactNode, useCallback } from 'react';
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
  PaymentRecord,
} from '../types';
import { StorageService } from '../services/storage';
import { generateId, formatDocNumber } from '../utils/idGenerator';
import { calculateDocumentFinancials } from '../utils/calculations';

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDestructive?: boolean;
  onConfirm: () => void;
}

interface AppContextType {
  // Navigation
  activeView: ActiveView;
  activeEntityId: string | null;
  setActiveView: (view: ActiveView, entityId?: string | null) => void;

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
  updateBusinessProfile: (profile: BusinessProfile) => void;

  // Client Actions
  saveClient: (client: Partial<Client> & { name: string; email: string }) => Client;
  deleteClient: (id: string) => void;

  // Quotation Actions
  saveQuotation: (quote: Quotation) => Quotation | undefined;
  deleteQuotation: (id: string) => void;
  duplicateQuotation: (id: string) => Quotation | undefined;
  convertQuotationToInvoice: (quotationId: string) => Invoice | undefined;
  updateQuotationStatus: (id: string, status: QuotationStatus) => void;

  // Invoice Actions
  saveInvoice: (invoice: Invoice) => Invoice | undefined;
  deleteInvoice: (id: string) => void;
  duplicateInvoice: (id: string) => Invoice | undefined;
  updateInvoiceStatus: (id: string, status: InvoiceStatus) => void;
  recordPayment: (invoiceId: string, payment: Omit<PaymentRecord, 'id' | 'invoiceId' | 'recordedAt'>) => void;

  // Document Numbering Helpers
  getNextQuoteNumber: () => string;
  getNextInvoiceNumber: () => string;
  commitQuoteNumber: (docNumber: string) => void;
  commitInvoiceNumber: (docNumber: string) => void;
  isQuotationNumberTaken: (docNumber: string, excludeId?: string) => boolean;
  isInvoiceNumberTaken: (docNumber: string, excludeId?: string) => boolean;

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

  // System
  resetToDemoData: () => void;
  clearAllData: () => void;
  refreshData: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [activeView, setActiveViewInternal] = useState<ActiveView>('dashboard');
  const [activeEntityId, setActiveEntityId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Domain states
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile>(() => {
    StorageService.init();
    return StorageService.getBusinessProfile();
  });
  const [clients, setClients] = useState<Client[]>(() => StorageService.getClients());
  const [quotations, setQuotations] = useState<Quotation[]>(() => StorageService.getQuotations());
  const [invoices, setInvoices] = useState<Invoice[]>(() => StorageService.getInvoices());
  const [activities, setActivities] = useState<ActivityLog[]>(() => StorageService.getActivities());

  // Modals & Feedback
  const [previewDocument, setPreviewDocument] = useState<{ type: 'quote' | 'invoice'; data: Quotation | Invoice } | null>(null);
  const [paymentModalInvoice, setPaymentModalInvoice] = useState<Invoice | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const refreshData = useCallback(() => {
    setBusinessProfile(StorageService.getBusinessProfile());
    setClients(StorageService.getClients());
    setQuotations(StorageService.getQuotations());
    setInvoices(StorageService.getInvoices());
    setActivities(StorageService.getActivities());
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

  // Business Profile
  const updateBusinessProfile = useCallback((profile: BusinessProfile) => {
    const saved = StorageService.saveBusinessProfile(profile);
    const persisted = StorageService.lastWritePersisted;
    setBusinessProfile(saved);
    refreshData();
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
        message: 'Settings updated in memory, but browser storage could not persist them across reloads (check logo file size).',
      });
    }
  }, [refreshData, addToast]);

  // Clients
  const saveClient = useCallback((clientData: Partial<Client> & { name: string; email: string }) => {
    const saved = StorageService.saveClient(clientData);
    const persisted = StorageService.lastWritePersisted;
    refreshData();
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
  }, [refreshData, addToast]);

  const deleteClient = useCallback((id: string) => {
    const client = clients.find((c) => c.id === id);
    const success = StorageService.deleteClient(id);
    if (success) {
      const persisted = StorageService.lastWritePersisted;
      refreshData();
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
    }
  }, [clients, refreshData, addToast, activeView, activeEntityId, setActiveView]);

  // Document Numbering Helpers
  const getNextQuoteNumber = useCallback(() => {
    const profile = StorageService.getBusinessProfile();
    const nextNum = StorageService.getNextAvailableQuoteNumber();
    return formatDocNumber(profile.quotePrefix || 'QUO-', nextNum);
  }, []);

  const getNextInvoiceNumber = useCallback(() => {
    const profile = StorageService.getBusinessProfile();
    const nextNum = StorageService.getNextAvailableInvoiceNumber();
    return formatDocNumber(profile.invoicePrefix || 'INV-', nextNum);
  }, []);

  const commitQuoteNumber = useCallback((docNumber: string) => {
    StorageService.commitUsedQuoteNumber(docNumber);
    refreshData();
  }, [refreshData]);

  const commitInvoiceNumber = useCallback((docNumber: string) => {
    StorageService.commitUsedInvoiceNumber(docNumber);
    refreshData();
  }, [refreshData]);

  const isQuotationNumberTaken = useCallback((docNumber: string, excludeId?: string) => {
    return StorageService.isQuotationNumberTaken(docNumber, excludeId);
  }, []);

  const isInvoiceNumberTaken = useCallback((docNumber: string, excludeId?: string) => {
    return StorageService.isInvoiceNumberTaken(docNumber, excludeId);
  }, []);

  // Quotations
  const saveQuotation = useCallback((quote: Quotation) => {
    try {
      const saved = StorageService.saveQuotation(quote);
      const persisted = StorageService.lastWritePersisted;
      refreshData();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save quotation.';
      addToast({
        type: 'error',
        title: 'Cannot Save Quotation',
        message,
      });
      return undefined;
    }
  }, [refreshData, addToast]);

  const deleteQuotation = useCallback((id: string) => {
    const quote = quotations.find((q) => q.id === id);
    const success = StorageService.deleteQuotation(id);
    if (success) {
      const persisted = StorageService.lastWritePersisted;
      refreshData();
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
    }
  }, [quotations, refreshData, addToast, previewDocument, activeView, activeEntityId, setActiveView]);

  const duplicateQuotation = useCallback((id: string) => {
    const original = quotations.find((q) => q.id === id);
    if (!original) return undefined;

    const currentProfile = StorageService.getBusinessProfile();
    const nextNum = StorageService.getNextAvailableQuoteNumber();
    const newNumber = formatDocNumber(currentProfile.quotePrefix || 'QUO-', nextNum);
    const now = new Date().toISOString();

    const duplicated: Quotation = {
      ...original,
      id: generateId('quo'),
      quotationNumber: newNumber,
      businessSnapshot: currentProfile,
      status: 'draft',
      preConversionStatus: undefined,
      issueDate: now.split('T')[0],
      expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      items: original.items.map((item) => ({
        ...item,
        id: generateId('item'),
      })),
      convertedInvoiceId: undefined,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const saved = StorageService.saveQuotation(duplicated);
      const persisted = StorageService.lastWritePersisted;
      if (persisted) {
        StorageService.commitUsedQuoteNumber(saved.quotationNumber);
      }
      refreshData();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to duplicate quotation.';
      addToast({
        type: 'error',
        title: 'Cannot Duplicate Quotation',
        message,
      });
      return undefined;
    }
  }, [quotations, refreshData, addToast]);

  const updateQuotationStatus = useCallback((id: string, status: QuotationStatus) => {
    const quote = quotations.find((q) => q.id === id);
    if (!quote) return;

    const updated: Quotation = {
      ...quote,
      status,
      preConversionStatus: quote.convertedInvoiceId ? quote.preConversionStatus : undefined,
    };
    try {
      const saved = StorageService.saveQuotation(updated);
      const persisted = StorageService.lastWritePersisted;
      refreshData();
      if (persisted) {
        addToast({
          type: 'info',
          title: 'Status Updated',
          message: `${quote.quotationNumber} status changed to ${status}.`,
        });
      } else {
        addToast({
          type: 'warning',
          title: 'Updated Active Session',
          message: `${quote.quotationNumber} status changed in memory, but browser storage could not persist it across reloads.`,
        });
      }

      if (previewDocument && previewDocument.data.id === id) {
        setPreviewDocument({ type: 'quote', data: saved });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update quotation status.';
      addToast({
        type: 'error',
        title: 'Status Update Failed',
        message,
      });
    }
  }, [quotations, refreshData, addToast, previewDocument]);

  const convertQuotationToInvoice = useCallback((quotationId: string) => {
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

    // Prevent duplicate conversion if an active linked invoice already exists
    const existingLinkedInvoice = invoices.find(
      (inv) =>
        inv.id === quote.convertedInvoiceId ||
        inv.quotationId === quote.id ||
        (inv.quotationId && inv.quotationId.trim().toLowerCase() === quote.quotationNumber.trim().toLowerCase())
    );
    if (existingLinkedInvoice) {
      addToast({
        type: 'info',
        title: 'Already Converted',
        message: `${quote.quotationNumber} is already linked to Invoice ${existingLinkedInvoice.invoiceNumber}.`,
      });
      setPreviewDocument({ type: 'invoice', data: existingLinkedInvoice });
      return existingLinkedInvoice;
    }

    // Ensure the quotation's client still exists before creating an invoice
    const currentClients = StorageService.getClients();
    const clientExists = currentClients.some((c) => c.id === quote.clientId);
    if (!clientExists) {
      addToast({
        type: 'error',
        title: 'Cannot Convert Quotation',
        message: 'The client for this quotation no longer exists. Please recreate or assign a client first.',
      });
      return undefined;
    }

    const currentProfile = StorageService.getBusinessProfile();
    const nextNum = StorageService.getNextAvailableInvoiceNumber();
    const newInvoiceNumber = formatDocNumber(currentProfile.invoicePrefix || 'INV-', nextNum);

    const now = new Date().toISOString();
    const issueDate = now.split('T')[0];
    const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const copiedItems = quote.items.map((item) => ({
      ...item,
      id: generateId('item'),
    }));

    const financials = calculateDocumentFinancials({
      items: copiedItems,
      discountType: quote.discountType,
      discountValue: quote.discountValue,
      isTaxEnabled: quote.taxRate > 0,
      taxRate: quote.taxRate,
      taxName: quote.taxName,
    });

    const newInvoice: Invoice = {
      id: generateId('inv'),
      invoiceNumber: newInvoiceNumber,
      quotationId: quote.id,
      clientId: quote.clientId,
      clientSnapshot: quote.clientSnapshot,
      businessSnapshot: currentProfile,
      issueDate,
      dueDate,
      currency: quote.currency,
      currencySymbol: quote.currencySymbol,
      items: copiedItems,
      subtotal: financials.subtotal,
      discountType: quote.discountType,
      discountValue: quote.discountValue,
      discountAmount: financials.discountAmount,
      taxName: quote.taxName,
      taxRate: quote.taxRate,
      taxAmount: financials.taxAmount,
      grandTotal: financials.grandTotal,
      amountPaid: 0,
      outstandingBalance: financials.grandTotal,
      status: 'sent',
      notes: quote.notes,
      terms: currentProfile.defaultTermsInvoice,
      payments: [],
      createdAt: now,
      updatedAt: now,
    };

    try {
      // Save invoice first (also updates quote.convertedInvoiceId & status atomically)
      const savedInvoice = StorageService.saveInvoice(newInvoice);
      const persisted = StorageService.lastWritePersisted;
      if (persisted) {
        StorageService.commitUsedInvoiceNumber(savedInvoice.invoiceNumber);
      }

      StorageService.addActivity({
        type: 'quote_converted',
        title: `Quotation ${quote.quotationNumber} Converted`,
        description: `Created Invoice ${savedInvoice.invoiceNumber} for ${quote.clientSnapshot.name}`,
        referenceId: savedInvoice.id,
      });
      StorageService.lastWritePersisted = persisted;

      refreshData();
      if (persisted) {
        addToast({
          type: 'success',
          title: 'Converted to Invoice',
          message: `${quote.quotationNumber} was successfully converted into ${savedInvoice.invoiceNumber}.`,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to convert quotation to invoice.';
      addToast({
        type: 'error',
        title: 'Conversion Failed',
        message,
      });
      return undefined;
    }
  }, [quotations, invoices, refreshData, addToast]);

  // Invoices
  const saveInvoice = useCallback((invoice: Invoice) => {
    try {
      const saved = StorageService.saveInvoice(invoice);
      const persisted = StorageService.lastWritePersisted;
      refreshData();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save invoice.';
      addToast({
        type: 'error',
        title: 'Cannot Save Invoice',
        message,
      });
      return undefined;
    }
  }, [refreshData, addToast]);

  const deleteInvoice = useCallback((id: string) => {
    const invoice = invoices.find((i) => i.id === id);
    const success = StorageService.deleteInvoice(id);
    if (success) {
      const persisted = StorageService.lastWritePersisted;
      refreshData();
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
    }
  }, [invoices, refreshData, addToast, previewDocument, activeView, activeEntityId, setActiveView]);

  const duplicateInvoice = useCallback((id: string) => {
    const original = invoices.find((i) => i.id === id);
    if (!original) return undefined;

    const currentClients = StorageService.getClients();
    const clientExists = currentClients.some((c) => c.id === original.clientId);
    if (!clientExists) {
      addToast({
        type: 'error',
        title: 'Cannot Duplicate Invoice',
        message: 'The client for this invoice no longer exists. Please recreate or assign a client first.',
      });
      return undefined;
    }

    const currentProfile = StorageService.getBusinessProfile();
    const nextNum = StorageService.getNextAvailableInvoiceNumber();
    const newNumber = formatDocNumber(currentProfile.invoicePrefix || 'INV-', nextNum);
    const now = new Date().toISOString();

    const duplicated: Invoice = {
      ...original,
      id: generateId('inv'),
      invoiceNumber: newNumber,
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
      dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      createdAt: now,
      updatedAt: now,
    };

    try {
      const saved = StorageService.saveInvoice(duplicated);
      const persisted = StorageService.lastWritePersisted;
      if (persisted) {
        StorageService.commitUsedInvoiceNumber(saved.invoiceNumber);
      }
      refreshData();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to duplicate invoice.';
      addToast({
        type: 'error',
        title: 'Cannot Duplicate Invoice',
        message,
      });
      return undefined;
    }
  }, [invoices, refreshData, addToast]);

  const updateInvoiceStatus = useCallback((id: string, status: InvoiceStatus) => {
    const invoice = invoices.find((i) => i.id === id);
    if (!invoice) return;

    const updated = { ...invoice, status };
    try {
      const saved = StorageService.saveInvoice(updated);
      const persisted = StorageService.lastWritePersisted;
      refreshData();
      if (persisted) {
        addToast({
          type: 'info',
          title: 'Status Updated',
          message: `${invoice.invoiceNumber} status changed to ${status}.`,
        });
      } else {
        addToast({
          type: 'warning',
          title: 'Updated Active Session',
          message: `${invoice.invoiceNumber} status changed in memory, but browser storage could not persist it across reloads.`,
        });
      }

      if (previewDocument && previewDocument.data.id === id) {
        setPreviewDocument({ type: 'invoice', data: saved });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update invoice status.';
      addToast({
        type: 'error',
        title: 'Status Update Failed',
        message,
      });
    }
  }, [invoices, refreshData, addToast, previewDocument]);

  const recordPayment = useCallback((invoiceId: string, paymentData: Omit<PaymentRecord, 'id' | 'invoiceId' | 'recordedAt'>) => {
    try {
      const updated = StorageService.recordPayment(invoiceId, paymentData);
      if (!updated) {
        addToast({
          type: 'error',
          title: 'Payment Failed',
          message: 'The target invoice could not be found.',
        });
        return;
      }

      const persisted = StorageService.lastWritePersisted;
      refreshData();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to record payment.';
      addToast({
        type: 'error',
        title: 'Payment Failed',
        message,
      });
    }
  }, [refreshData, addToast, previewDocument]);

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

  // System Resets
  const resetToDemoData = useCallback(() => {
    StorageService.resetToDemoData();
    const persisted = StorageService.lastWritePersisted;
    refreshData();
    if (persisted) {
      addToast({
        type: 'success',
        title: 'Demo Data Restored',
        message: 'Workspace has been repopulated with sample clients, quotations, and invoices.',
      });
    } else {
      addToast({
        type: 'warning',
        title: 'Demo Data Loaded in Active Session',
        message: 'Sample data loaded in memory, but browser storage could not persist it across reloads.',
      });
    }
  }, [refreshData, addToast]);

  const clearAllData = useCallback(() => {
    StorageService.clearAllData();
    const persisted = StorageService.lastWritePersisted;
    refreshData();
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
        message: 'Workspace cleared in memory, but browser storage could not persist the reset.',
      });
    }
  }, [refreshData, setActiveView, addToast]);

  // Keep state in sync if window focuses or changes occur
  useEffect(() => {
    const handleStorageChange = () => refreshData();
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [refreshData]);

  return (
    <AppContext.Provider
      value={{
        activeView,
        activeEntityId,
        setActiveView,
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
