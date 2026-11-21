import type { LineItem, InvoiceStatus, PaymentRecord } from '../types';

export function calculateLineItemTotal(quantity: number, unitPrice: number): number {
  const q = Number(quantity) || 0;
  const p = Number(unitPrice) || 0;
  return Math.round((q * p) * 100) / 100;
}

export interface CalculationInput {
  items: LineItem[];
  discountType?: 'percentage' | 'fixed';
  discountValue?: number;
  isTaxEnabled?: boolean;
  taxRate?: number;
  taxName?: string;
}

export interface FinancialCalculationResult {
  subtotal: number;
  discountAmount: number;
  taxableAmount: number;
  taxAmount: number;
  grandTotal: number;
}

export function calculateDocumentFinancials(input: CalculationInput): FinancialCalculationResult {
  const subtotal = (input.items || []).reduce((sum, item) => {
    return sum + (Number(item.total) || 0);
  }, 0);

  const discountType = input.discountType || 'percentage';
  const discountVal = Math.max(0, Number(input.discountValue) || 0);

  let discountAmount = 0;
  if (discountType === 'percentage') {
    discountAmount = (subtotal * Math.min(100, discountVal)) / 100;
  } else {
    discountAmount = Math.min(subtotal, discountVal);
  }
  discountAmount = Math.round(discountAmount * 100) / 100;

  const taxableAmount = Math.max(0, subtotal - discountAmount);

  let taxAmount = 0;
  if (input.isTaxEnabled && input.taxRate && input.taxRate > 0) {
    taxAmount = (taxableAmount * Number(input.taxRate)) / 100;
    taxAmount = Math.round(taxAmount * 100) / 100;
  }

  const grandTotal = Math.round((taxableAmount + taxAmount) * 100) / 100;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discountAmount,
    taxableAmount,
    taxAmount,
    grandTotal,
  };
}

export function calculateInvoiceBalances(grandTotal: number, payments: PaymentRecord[] = []): {
  amountPaid: number;
  outstandingBalance: number;
} {
  const totalPaid = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const roundedPaid = Math.round(totalPaid * 100) / 100;
  const balance = Math.max(0, Math.round((grandTotal - roundedPaid) * 100) / 100);

  return {
    amountPaid: roundedPaid,
    outstandingBalance: balance,
  };
}

export function getLocalTodayDateString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeDateOnly(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (match) return match[1];
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return getLocalTodayDateString(parsed);
}

export function isDateBeforeLocalToday(dateString?: string | null, todayString?: string): boolean {
  const normalized = normalizeDateOnly(dateString);
  if (!normalized) return false;
  const today = todayString || getLocalTodayDateString();
  return normalized < today;
}

export function determineUpdatedInvoiceStatus(
  currentStatus: InvoiceStatus,
  grandTotal: number,
  amountPaid: number,
  dueDateString?: string,
  todayString?: string
): InvoiceStatus {
  const safeTotal = Math.max(0, Number(grandTotal) || 0);
  const safePaid = Math.max(0, Number(amountPaid) || 0);

  if (currentStatus === 'draft' && safePaid <= 0) {
    return 'draft';
  }

  if ((safeTotal > 0 && safePaid >= safeTotal - 0.001) || (safeTotal === 0 && safePaid > 0)) {
    return 'paid';
  }

  if (safePaid > 0 && safePaid < safeTotal) {
    return 'partially_paid';
  }

  const normalizedDue = normalizeDateOnly(dueDateString);
  const today = todayString || getLocalTodayDateString();

  // Zero-total invoices with no recorded payments owe nothing and must never be marked overdue.
  if (safeTotal === 0) {
    if (
      currentStatus === 'overdue' ||
      currentStatus === 'paid' ||
      currentStatus === 'partially_paid'
    ) {
      return 'sent';
    }
    return currentStatus || 'sent';
  }

  // No recorded payments (safePaid <= 0): never allow 'paid' or 'partially_paid'
  if (normalizedDue && normalizedDue < today && safePaid < safeTotal) {
    return 'overdue';
  }

  if (currentStatus === 'overdue' && normalizedDue && normalizedDue >= today) {
    return 'sent';
  }

  if (currentStatus === 'paid' || currentStatus === 'partially_paid') {
    return 'sent';
  }

  return currentStatus || 'sent';
}
