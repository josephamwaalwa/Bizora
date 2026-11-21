import type {
  Client,
  Invoice,
  InvoiceStatus,
  PaymentMethod,
  PaymentRecord,
  Quotation,
  QuotationStatus,
} from '../types';
import type { PersistenceAdapter } from '../services/persistence/types';
import {
  calculateInvoiceBalances,
  determineUpdatedInvoiceStatus,
  getLocalTodayDateString,
} from './calculations';
import { formatCurrency, getPaymentMethodLabel } from './formatters';

export const CANONICAL_PAYMENT_METHODS: readonly PaymentMethod[] = [
  'bank_transfer',
  'cash',
  'credit_card',
  'eft',
  'mobile_money',
  'cheque',
  'other',
] as const;

export const PAYMENT_METHOD_SELECT_OPTIONS: ReadonlyArray<{
  value: PaymentMethod;
  label: string;
}> = [
  { value: 'eft', label: getPaymentMethodLabel('eft') },
  { value: 'bank_transfer', label: getPaymentMethodLabel('bank_transfer') },
  { value: 'credit_card', label: getPaymentMethodLabel('credit_card') },
  { value: 'cash', label: getPaymentMethodLabel('cash') },
  { value: 'mobile_money', label: getPaymentMethodLabel('mobile_money') },
  { value: 'cheque', label: getPaymentMethodLabel('cheque') },
  { value: 'other', label: getPaymentMethodLabel('other') },
];

export interface StrictAmountParseResult {
  ok: boolean;
  amount?: number;
  amountMinor?: number;
  error?: string;
}

export function parseStrictPaymentAmount(rawAmount: unknown): StrictAmountParseResult {
  if (typeof rawAmount !== 'string' && typeof rawAmount !== 'number') {
    return {
      ok: false,
      error: 'Please enter a valid payment amount greater than zero.',
    };
  }

  let decimalText: string;
  if (typeof rawAmount === 'number') {
    if (!Number.isFinite(rawAmount)) {
      return {
        ok: false,
        error: 'Please enter a valid finite payment amount.',
      };
    }
    if (rawAmount <= 0) {
      return {
        ok: false,
        error: 'Payment amount must be greater than zero.',
      };
    }
    decimalText = String(rawAmount);
  } else {
    decimalText = rawAmount.trim();
    if (!decimalText) {
      return {
        ok: false,
        error: 'Please enter a payment amount greater than zero.',
      };
    }
  }

  if (/[eE]/.test(decimalText)) {
    return {
      ok: false,
      error: 'Scientific notation is not allowed. Please enter a standard decimal amount.',
    };
  }

  const match = /^(-)?(?:(\d+)(?:\.(\d+))?|\.(\d+))$/.exec(decimalText);
  if (!match) {
    return {
      ok: false,
      error: 'Please enter a valid numeric payment amount (up to 2 decimal places).',
    };
  }

  const isNegative = Boolean(match[1]);
  const wholeDigits = match[2] ?? '0';
  const fracDigits = match[3] ?? match[4] ?? '';

  if (isNegative) {
    return {
      ok: false,
      error: 'Payment amount must be greater than zero.',
    };
  }

  if (fracDigits.length > 2) {
    return {
      ok: false,
      error: 'Payment amount cannot have more than 2 decimal places.',
    };
  }

  const wholeValue = Number(wholeDigits);
  const centsPart = Number(fracDigits.padEnd(2, '0'));
  const amountMinor = wholeValue * 100 + centsPart;

  if (!Number.isSafeInteger(amountMinor) || amountMinor > 9007199254740991) {
    return {
      ok: false,
      error: 'Payment amount is too large.',
    };
  }

  if (amountMinor <= 0) {
    return {
      ok: false,
      error: 'Payment amount must be greater than zero.',
    };
  }

  return {
    ok: true,
    amount: Number((amountMinor / 100).toFixed(2)),
    amountMinor,
  };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function getDaysInCalendarMonth(year: number, month: number): number | null {
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

export interface PaymentDateValidationResult {
  ok: boolean;
  paymentDate?: string;
  error?: string;
}

export function validatePaymentDate(
  rawDate: unknown,
  options: { allowOmittedFallback?: boolean; today?: string } = {}
): PaymentDateValidationResult {
  const { allowOmittedFallback = true, today } = options;

  if (rawDate === undefined || rawDate === null) {
    if (allowOmittedFallback) {
      return {
        ok: true,
        paymentDate: today || getLocalTodayDateString(),
      };
    }
    return {
      ok: false,
      error: 'Payment date is required in YYYY-MM-DD format.',
    };
  }

  if (typeof rawDate !== 'string') {
    return {
      ok: false,
      error: 'Payment date must be a valid date in YYYY-MM-DD format.',
    };
  }

  if (rawDate.trim().length === 0) {
    return {
      ok: false,
      error: 'Payment date is required in YYYY-MM-DD format.',
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return {
      ok: false,
      error: 'Payment date must use strict YYYY-MM-DD format.',
    };
  }

  const year = Number(rawDate.slice(0, 4));
  const month = Number(rawDate.slice(5, 7));
  const day = Number(rawDate.slice(8, 10));

  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return {
      ok: false,
      error: 'Payment date has an out-of-range year.',
    };
  }

  const maxDay = getDaysInCalendarMonth(year, month);
  if (!maxDay) {
    return {
      ok: false,
      error: 'Payment date has an invalid month.',
    };
  }

  if (!Number.isInteger(day) || day < 1 || day > maxDay) {
    return {
      ok: false,
      error: 'Payment date is not a valid calendar date.',
    };
  }

  return {
    ok: true,
    paymentDate: rawDate,
  };
}

export function validatePaymentMethodValue(
  method: unknown
): { ok: boolean; paymentMethod?: PaymentMethod; error?: string } {
  if (
    typeof method === 'string' &&
    (CANONICAL_PAYMENT_METHODS as readonly string[]).includes(method)
  ) {
    return { ok: true, paymentMethod: method as PaymentMethod };
  }
  return {
    ok: false,
    error: 'Please select a valid payment method.',
  };
}

export interface PaymentValidationFieldErrors {
  balance?: string;
  amount?: string;
  paymentDate?: string;
  paymentMethod?: string;
}

export interface ValidatedPaymentPayload {
  amount: number;
  amountMinor: number;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  reference?: string;
  notes?: string;
}

export type PaymentValidationResult =
  | {
      ok: true;
      value: ValidatedPaymentPayload;
      fieldErrors: PaymentValidationFieldErrors;
    }
  | {
      ok: false;
      error: string;
      fieldErrors: PaymentValidationFieldErrors;
    };

export type PaymentValidationInvoice = Pick<
  Invoice,
  'status' | 'grandTotal' | 'outstandingBalance' | 'currency' | 'currencySymbol'
> & {
  payments?: PaymentRecord[];
};

export interface PaymentValidationRawInput {
  amount: string | number;
  paymentDate?: string | null;
  paymentMethod: unknown;
  reference?: string;
  notes?: string;
}

export function getInvoiceRemainingBalanceMinor(invoice: PaymentValidationInvoice): number {
  const hasFiniteBalance =
    typeof invoice.outstandingBalance === 'number' &&
    Number.isFinite(invoice.outstandingBalance);
  const rawBalance = hasFiniteBalance
    ? invoice.outstandingBalance
    : calculateInvoiceBalances(invoice.grandTotal, invoice.payments ?? []).outstandingBalance;
  return Math.max(0, Math.round((Number(rawBalance) || 0) * 100));
}

export function validatePaymentInput(
  invoice: PaymentValidationInvoice,
  input: PaymentValidationRawInput,
  options: { requireExplicitDate?: boolean; today?: string } = {}
): PaymentValidationResult {
  const fieldErrors: PaymentValidationFieldErrors = {};
  const grandTotalMinor = Math.max(0, Math.round((Number(invoice.grandTotal) || 0) * 100));
  const balanceMinor = getInvoiceRemainingBalanceMinor(invoice);
  const currency = invoice.currency || 'NAD';
  const currencySymbol = invoice.currencySymbol || 'N$';

  if (invoice.status === 'paid') {
    fieldErrors.balance = 'This invoice is already paid and cannot accept additional payments.';
  } else if (grandTotalMinor <= 0 || balanceMinor <= 0) {
    fieldErrors.balance = 'This invoice has no outstanding balance remaining.';
  }

  const amountResult = parseStrictPaymentAmount(input.amount);
  if (!amountResult.ok) {
    fieldErrors.amount = amountResult.error;
  } else if (
    !fieldErrors.balance &&
    amountResult.amountMinor !== undefined &&
    amountResult.amountMinor > balanceMinor + 1
  ) {
    const balanceDisplay = formatCurrency(balanceMinor / 100, currency, currencySymbol);
    fieldErrors.amount = `Amount cannot exceed the remaining balance of ${balanceDisplay}.`;
  }

  const dateResult = validatePaymentDate(input.paymentDate, {
    allowOmittedFallback: !options.requireExplicitDate,
    today: options.today,
  });
  if (!dateResult.ok) {
    fieldErrors.paymentDate = dateResult.error;
  }

  const methodResult = validatePaymentMethodValue(input.paymentMethod);
  if (!methodResult.ok) {
    fieldErrors.paymentMethod = methodResult.error;
  }

  const firstError =
    fieldErrors.balance ||
    fieldErrors.amount ||
    fieldErrors.paymentDate ||
    fieldErrors.paymentMethod;

  if (
    firstError ||
    !amountResult.ok ||
    amountResult.amount === undefined ||
    amountResult.amountMinor === undefined ||
    !dateResult.ok ||
    !dateResult.paymentDate ||
    !methodResult.ok ||
    !methodResult.paymentMethod
  ) {
    return {
      ok: false,
      error: firstError || 'Please check the payment details and try again.',
      fieldErrors,
    };
  }

  const trimmedReference =
    typeof input.reference === 'string' ? input.reference.trim() : undefined;
  const trimmedNotes = typeof input.notes === 'string' ? input.notes.trim() : undefined;

  return {
    ok: true,
    fieldErrors: {},
    value: {
      amount: amountResult.amount,
      amountMinor: amountResult.amountMinor,
      paymentDate: dateResult.paymentDate,
      paymentMethod: methodResult.paymentMethod,
      reference: trimmedReference ? trimmedReference : undefined,
      notes: trimmedNotes ? trimmedNotes : undefined,
    },
  };
}

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

export function sortPaymentsForDisplay(payments: readonly PaymentRecord[] = []): PaymentRecord[] {
  return [...payments].sort((a, b) => {
    const dateDiff = (b.paymentDate || '').localeCompare(a.paymentDate || '');
    if (dateDiff !== 0) return dateDiff;
    const recordedDiff = (b.recordedAt || '').localeCompare(a.recordedAt || '');
    if (recordedDiff !== 0) return recordedDiff;
    return (a.id || '').localeCompare(b.id || '');
  });
}

export interface PaymentDeletionConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  isDestructive: true;
}

export function buildPaymentDeletionConfirmCopy(
  invoice: Pick<Invoice, 'invoiceNumber' | 'currency' | 'currencySymbol'>,
  payment: Pick<PaymentRecord, 'amount'>
): PaymentDeletionConfirmCopy {
  const formattedAmount = formatCurrency(payment.amount, invoice.currency, invoice.currencySymbol);
  return {
    title: 'Remove Payment',
    message: `Are you sure you want to remove the ${formattedAmount} payment from invoice ${invoice.invoiceNumber}? The invoice amount paid, outstanding balance, and status will be recalculated automatically.`,
    confirmLabel: 'Remove Payment',
    cancelLabel: 'Cancel',
    isDestructive: true,
  };
}

export function getOverpaymentAdjustmentWarning(
  grandTotal: number,
  amountPaid: number,
  currency: string,
  currencySymbol: string
): string | null {
  const safeTotal = Math.max(0, Number(grandTotal) || 0);
  const safePaid = Math.max(0, Number(amountPaid) || 0);
  if (safePaid <= safeTotal + 0.01) {
    return null;
  }

  return `Recorded payments (${formatCurrency(safePaid, currency, currencySymbol)}) exceed the updated invoice total (${formatCurrency(safeTotal, currency, currencySymbol)}). Balance due will remain zero unless a payment is removed or the invoice total is increased.`;
}

export interface DeletePaymentWorkflowDeps {
  adapter: PersistenceAdapter;
  paymentId: string;
  knownInvoices: readonly Invoice[];
  didPersistLastWrite: (adapter: PersistenceAdapter) => boolean;
  reloadWorkspace: (adapter: PersistenceAdapter) => Promise<void>;
  onInvoiceUpdated?: (refreshedInvoice: Invoice) => void;
  onToast: (toast: {
    type: 'success' | 'error' | 'info' | 'warning';
    title: string;
    message?: string;
  }) => void;
  logWarn?: (message: string, err: unknown) => void;
}

export async function executeDeletePaymentWorkflow({
  adapter,
  paymentId,
  knownInvoices,
  didPersistLastWrite,
  reloadWorkspace,
  onInvoiceUpdated,
  onToast,
  logWarn = (msg, err) => console.warn(msg, err),
}: DeletePaymentWorkflowDeps): Promise<boolean> {
  const findTarget = (list: readonly Invoice[]) => {
    for (const inv of list) {
      const payment = (inv.payments ?? []).find((p) => p.id === paymentId);
      if (payment) {
        return { invoice: inv, payment };
      }
    }
    return null;
  };

  let target = findTarget(knownInvoices);
  if (!target) {
    const freshInvoices = await adapter.getInvoices();
    target = findTarget(freshInvoices);
  }

  if (!target) {
    onToast({
      type: 'error',
      title: 'Cannot Remove Payment',
      message: 'The selected payment record could not be found.',
    });
    return false;
  }

  const { invoice: parentInvoice, payment: targetPayment } = target;
  await adapter.deletePayment(paymentId);
  const persisted = didPersistLastWrite(adapter);

  const refreshedInvoice = await adapter.getInvoiceById(parentInvoice.id);
  const removedAmountText = formatCurrency(
    targetPayment.amount,
    parentInvoice.currency,
    parentInvoice.currencySymbol
  );

  try {
    const nextBalanceText = refreshedInvoice
      ? formatCurrency(
          refreshedInvoice.outstandingBalance,
          refreshedInvoice.currency,
          refreshedInvoice.currencySymbol
        )
      : '';
    await adapter.addActivity({
      type: 'invoice_status',
      title: `Payment Removed from ${parentInvoice.invoiceNumber}`,
      description: refreshedInvoice
        ? `Removed ${removedAmountText} payment. Updated balance: ${nextBalanceText} (status: ${refreshedInvoice.status}).`
        : `Removed ${removedAmountText} payment from ${parentInvoice.invoiceNumber}.`,
      referenceId: parentInvoice.id,
    });
  } catch (activityErr) {
    logWarn('Failed to log payment removal activity:', activityErr);
  }

  await reloadWorkspace(adapter);

  if (refreshedInvoice && onInvoiceUpdated) {
    onInvoiceUpdated(refreshedInvoice);
  }

  if (persisted) {
    onToast({
      type: 'success',
      title: 'Payment Removed',
      message: `Removed ${removedAmountText} from ${parentInvoice.invoiceNumber}. Balance and status have been recalculated.`,
    });
  } else {
    onToast({
      type: 'warning',
      title: 'Updated Active Session',
      message: `Payment removed from ${parentInvoice.invoiceNumber} in memory, but browser storage could not persist the change across reloads.`,
    });
  }

  return true;
}

