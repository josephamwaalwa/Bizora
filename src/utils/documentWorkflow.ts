import type {
  Client,
  Invoice,
  InvoiceStatus,
  PaymentMethod,
  Quotation,
  QuotationStatus,
} from '../types';
import { determineUpdatedInvoiceStatus, getLocalTodayDateString } from './calculations';

export interface PaymentModalFormState {
  amount: number;
  amountInput: string;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  reference: string;
  notes: string;
  error: string;
}

export function formatInitialPaymentAmount(balance: number): string {
  const safeBalance = Math.max(0, Math.round((Number(balance) || 0) * 100) / 100);
  if (safeBalance === 0) return '';
  return Number.isInteger(safeBalance) ? String(safeBalance) : safeBalance.toFixed(2);
}

export function createInitialPaymentFormState(
  invoice: Pick<Invoice, 'outstandingBalance'>,
  today?: string
): PaymentModalFormState {
  const balance = Math.max(0, Math.round((Number(invoice.outstandingBalance) || 0) * 100) / 100);
  return {
    amount: balance,
    amountInput: formatInitialPaymentAmount(balance),
    paymentDate: today || getLocalTodayDateString(),
    paymentMethod: 'eft',
    reference: '',
    notes: '',
    error: '',
  };
}

export function getPaymentModalResetKey(
  invoice: Pick<Invoice, 'id' | 'outstandingBalance' | 'payments' | 'updatedAt'>
): string {
  return `${invoice.id}:${invoice.outstandingBalance}:${invoice.payments?.length ?? 0}:${invoice.updatedAt}`;
}

export function hasRecordedInvoicePayment(
  invoice: Pick<Invoice, 'amountPaid' | 'payments'>
): boolean {
  return (invoice.payments?.length ?? 0) > 0 || (Number(invoice.amountPaid) || 0) > 0;
}

export interface WorkflowValidationResult {
  valid: boolean;
  title?: string;
  message?: string;
}

export function validateManualInvoiceStatusChange(
  invoice: Pick<Invoice, 'amountPaid' | 'payments' | 'grandTotal' | 'status' | 'dueDate'>,
  nextStatus: InvoiceStatus
): WorkflowValidationResult {
  const hasPayments = hasRecordedInvoicePayment(invoice);

  if (!hasPayments && (nextStatus === 'paid' || nextStatus === 'partially_paid')) {
    return {
      valid: false,
      title: 'Payment Required',
      message:
        'Unpaid invoices with no recorded payments cannot be marked Paid or Partially Paid. Use Record Payment instead.',
    };
  }

  if (hasPayments) {
    const derivedStatus = determineUpdatedInvoiceStatus(
      invoice.status,
      invoice.grandTotal,
      invoice.amountPaid,
      invoice.dueDate
    );
    if (nextStatus !== derivedStatus) {
      if (nextStatus === 'paid') {
        return {
          valid: false,
          title: 'Payment Required',
          message:
            'This invoice still has a remaining balance. Use Record Payment to settle it in full.',
        };
      }
      return {
        valid: false,
        title: 'Status Governed by Payments',
        message:
          'Invoices with recorded payments automatically derive their status from payment totals.',
      };
    }
  }

  return { valid: true };
}

export interface InvoiceStatusOption {
  value: InvoiceStatus;
  label: string;
  disabled: boolean;
}

export function getInvoiceStatusOptionsForUi(
  invoice: Pick<Invoice, 'amountPaid' | 'payments' | 'grandTotal' | 'status' | 'dueDate'>,
  labels: Partial<Record<InvoiceStatus, string>> = {}
): InvoiceStatusOption[] {
  const hasPayments = hasRecordedInvoicePayment(invoice);
  const derivedStatus = hasPayments
    ? determineUpdatedInvoiceStatus(invoice.status, invoice.grandTotal, invoice.amountPaid, invoice.dueDate)
    : null;

  const definitions: Array<{ value: InvoiceStatus; defaultLabel: string }> = [
    { value: 'draft', defaultLabel: 'Draft' },
    { value: 'sent', defaultLabel: 'Sent' },
    { value: 'partially_paid', defaultLabel: 'Partially Paid' },
    { value: 'paid', defaultLabel: 'Paid' },
    { value: 'overdue', defaultLabel: 'Overdue' },
  ];

  return definitions.map(({ value, defaultLabel }) => {
    const label = labels[value] ?? defaultLabel;
    if (!hasPayments) {
      return {
        value,
        label,
        disabled: value === 'partially_paid' || value === 'paid',
      };
    }
    return {
      value,
      label,
      disabled: value !== derivedStatus,
    };
  });
}

export function findLinkedInvoiceForQuotationRecord<
  T extends Pick<Invoice, 'id' | 'invoiceNumber' | 'quotationId'>
>(
  quote: Pick<Quotation, 'id' | 'quotationNumber' | 'convertedInvoiceId'>,
  invoices: T[]
): T | undefined {
  const normalizedQuoteNum = quote.quotationNumber.trim().toLowerCase();
  return invoices.find(
    (inv) =>
      inv.id === quote.convertedInvoiceId ||
      inv.quotationId === quote.id ||
      (inv.quotationId && inv.quotationId.trim().toLowerCase() === normalizedQuoteNum)
  );
}

export function validateQuotationStatusChange(
  quote: Pick<Quotation, 'id' | 'quotationNumber' | 'convertedInvoiceId' | 'status'>,
  nextStatus: QuotationStatus,
  linkedInvoiceNumber?: string
): WorkflowValidationResult {
  if (quote.convertedInvoiceId && nextStatus !== 'accepted') {
    const invoiceLabel = linkedInvoiceNumber ? `Invoice ${linkedInvoiceNumber}` : 'an invoice';
    return {
      valid: false,
      title: 'Quotation Already Converted',
      message: `Quotation ${quote.quotationNumber} has already been converted to ${invoiceLabel} and must remain Accepted.`,
    };
  }
  return { valid: true };
}

function areLineItemsFinanciallyEqual(a: Quotation['items'], b: Quotation['items']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.description.trim() !== right.description.trim() ||
      Number(left.quantity) !== Number(right.quantity) ||
      Number(left.unitPrice) !== Number(right.unitPrice) ||
      Number(left.total) !== Number(right.total)
    ) {
      return false;
    }
  }
  return true;
}

export function validateConvertedQuotationEdit(
  existingQuote: Quotation,
  nextQuote: Quotation,
  linkedInvoiceNumber?: string
): WorkflowValidationResult {
  if (!existingQuote.convertedInvoiceId) {
    return { valid: true };
  }

  const invoiceLabel = linkedInvoiceNumber ? `Invoice ${linkedInvoiceNumber}` : 'its linked invoice';

  if (nextQuote.convertedInvoiceId !== existingQuote.convertedInvoiceId) {
    return {
      valid: false,
      title: 'Converted Quotation Locked',
      message: `Quotation ${existingQuote.quotationNumber} is linked to ${invoiceLabel} and its conversion link cannot be removed manually.`,
    };
  }

  if (nextQuote.status !== existingQuote.status && nextQuote.status !== 'accepted') {
    return {
      valid: false,
      title: 'Quotation Already Converted',
      message: `Quotation ${existingQuote.quotationNumber} has been converted to ${invoiceLabel} and cannot be changed to ${nextQuote.status}.`,
    };
  }

  const normalizedExistingNumber = existingQuote.quotationNumber.trim().toLowerCase();
  const normalizedNextNumber = nextQuote.quotationNumber.trim().toLowerCase();
  const sameClient = (existingQuote.clientId || '') === (nextQuote.clientId || '');
  const sameCurrency =
    existingQuote.currency === nextQuote.currency &&
    existingQuote.currencySymbol === nextQuote.currencySymbol;
  const sameFinancials =
    existingQuote.discountType === nextQuote.discountType &&
    Number(existingQuote.discountValue) === Number(nextQuote.discountValue) &&
    Number(existingQuote.taxRate) === Number(nextQuote.taxRate) &&
    existingQuote.taxName === nextQuote.taxName &&
    Number(existingQuote.subtotal) === Number(nextQuote.subtotal) &&
    Number(existingQuote.discountAmount) === Number(nextQuote.discountAmount) &&
    Number(existingQuote.taxAmount) === Number(nextQuote.taxAmount) &&
    Number(existingQuote.grandTotal) === Number(nextQuote.grandTotal);
  const sameItems = areLineItemsFinanciallyEqual(existingQuote.items, nextQuote.items);

  if (
    normalizedExistingNumber !== normalizedNextNumber ||
    !sameClient ||
    !sameCurrency ||
    !sameFinancials ||
    !sameItems
  ) {
    return {
      valid: false,
      title: 'Converted Quotation Locked',
      message: `Quotation ${existingQuote.quotationNumber} has already been converted to ${invoiceLabel}. Pricing, line items, client, and document number are locked.`,
    };
  }

  return { valid: true };
}

export interface ClientReferenceResolution {
  ok: boolean;
  clientId: string;
  clientSnapshot: Client;
  usedDeletedClientSnapshot: boolean;
  message?: string;
}

export function resolveClientReferenceWithSnapshotFallback(
  doc: { clientId?: string; clientSnapshot?: Client },
  liveClients: Array<Pick<Client, 'id'>>,
  actionLabel: 'duplicate' | 'convert'
): ClientReferenceResolution {
  const rawClientId = (doc.clientId || '').trim();
  const hasLiveClient = Boolean(rawClientId && liveClients.some((c) => c.id === rawClientId));

  if (hasLiveClient && doc.clientSnapshot) {
    return {
      ok: true,
      clientId: rawClientId,
      clientSnapshot: doc.clientSnapshot,
      usedDeletedClientSnapshot: false,
    };
  }

  if (doc.clientSnapshot && doc.clientSnapshot.name?.trim()) {
    return {
      ok: true,
      clientId: '',
      clientSnapshot: doc.clientSnapshot,
      usedDeletedClientSnapshot: true,
    };
  }

  return {
    ok: false,
    clientId: '',
    clientSnapshot: doc.clientSnapshot || {
      id: '',
      name: '',
      email: '',
      phone: '',
      address: '',
      createdAt: '',
      updatedAt: '',
    },
    usedDeletedClientSnapshot: false,
    message:
      actionLabel === 'convert'
        ? 'The client for this quotation no longer exists and no client snapshot is preserved.'
        : 'Cannot duplicate document because both the client record and client snapshot are missing.',
  };
}
