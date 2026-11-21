import React, { useRef, useState } from 'react';
import { Trash2, CreditCard } from 'lucide-react';
import { useApp, type ConfirmDialogState } from '../../context/AppContext';
import type { Invoice, PaymentRecord } from '../../types';
import { formatCurrency, formatDate, getPaymentMethodLabel } from '../../utils/formatters';
import {
  buildPaymentDeletionConfirmCopy,
  sortPaymentsForDisplay,
} from '../../utils/documentWorkflow';
import { Button } from '../common/Button';

export interface InvoicePaymentsPanelContentProps {
  invoice: Invoice;
  onDeletePayment: (paymentId: string) => Promise<boolean>;
  showConfirmDialog: (params: Omit<ConfirmDialogState, 'isOpen'>) => void;
  onRecordPayment?: (invoice: Invoice) => void;
  isBusy?: boolean;
  title?: string;
  className?: string;
}

export const InvoicePaymentsPanelContent: React.FC<InvoicePaymentsPanelContentProps> = ({
  invoice,
  onDeletePayment,
  showConfirmDialog,
  onRecordPayment,
  isBusy = false,
  title = 'Payment History',
  className = '',
}) => {
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null);
  const deletingPaymentRef = useRef<string | null>(null);

  const sortedPayments = sortPaymentsForDisplay(invoice.payments ?? []);
  const isDeletionLocked = isBusy || deletingPaymentId !== null;
  const canRecordMore = Boolean(onRecordPayment && invoice.status !== 'paid');

  const handleRequestDelete = (payment: PaymentRecord) => {
    if (deletingPaymentRef.current || isBusy) return;
    const confirmCopy = buildPaymentDeletionConfirmCopy(invoice, payment);

    showConfirmDialog({
      ...confirmCopy,
      onConfirm: async () => {
        if (deletingPaymentRef.current) return;
        deletingPaymentRef.current = payment.id;
        setDeletingPaymentId(payment.id);
        try {
          await onDeletePayment(payment.id);
        } finally {
          deletingPaymentRef.current = null;
          setDeletingPaymentId(null);
        }
      },
    });
  };

  return (
    <section
      aria-label={title}
      className={`border border-line rounded-md bg-surface shadow-subtle overflow-hidden ${className}`}
    >
      <div className="px-4 py-3 border-b border-line bg-paper-sunken flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans">
            {title}
          </h3>
          <span className="text-xs text-ink-secondary">
            {sortedPayments.length === 0
              ? 'No payments recorded'
              : `${sortedPayments.length} ${sortedPayments.length === 1 ? 'payment' : 'payments'}`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          <span className="text-ink-secondary">
            Paid:{' '}
            <span className="money font-semibold text-ink">
              {formatCurrency(invoice.amountPaid || 0, invoice.currency, invoice.currencySymbol)}
            </span>
          </span>
          <span className="text-ink-secondary">
            Balance:{' '}
            <span className="money font-semibold text-ink">
              {formatCurrency(
                invoice.outstandingBalance ?? invoice.grandTotal,
                invoice.currency,
                invoice.currencySymbol
              )}
            </span>
          </span>
          {canRecordMore && onRecordPayment && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leftIcon={<CreditCard className="w-3.5 h-3.5 text-teal-600" />}
              onClick={() => onRecordPayment(invoice)}
              disabled={isDeletionLocked}
            >
              Record Payment
            </Button>
          )}
        </div>
      </div>

      {sortedPayments.length === 0 ? (
        <div className="px-4 py-4 text-xs text-ink-secondary">
          No payments have been recorded for invoice {invoice.invoiceNumber} yet.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {sortedPayments.map((payment) => {
            const formattedAmount = formatCurrency(
              payment.amount,
              invoice.currency,
              invoice.currencySymbol
            );
            const formattedDate = formatDate(payment.paymentDate);
            const methodLabel = getPaymentMethodLabel(payment.paymentMethod);
            const trimmedReference = payment.reference?.trim();
            const trimmedNotes = payment.notes?.trim();
            const isDeletingThis = deletingPaymentId === payment.id;

            return (
              <li
                key={payment.id}
                className="px-4 py-3 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 hover:bg-paper-sunken/50 transition-colors"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs font-medium text-ink">
                      {formattedDate}
                    </span>
                    <span className="text-xs font-semibold text-ink">{methodLabel}</span>
                    {trimmedReference && (
                      <span className="font-mono text-[11px] text-ink-secondary bg-paper-sunken border border-line px-1.5 py-0.5 rounded-sm">
                        Ref: {trimmedReference}
                      </span>
                    )}
                  </div>
                  {trimmedNotes && (
                    <p className="text-xs text-ink-secondary leading-relaxed break-words">
                      {trimmedNotes}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                  <span className="money text-sm font-semibold text-ink">{formattedAmount}</span>
                  <button
                    type="button"
                    disabled={isDeletionLocked}
                    onClick={() => handleRequestDelete(payment)}
                    aria-label={`Remove payment of ${formattedAmount} from ${formattedDate}`}
                    title="Remove Payment"
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-ink-muted hover:text-[#8E3B32] hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isDeletingThis ? 'Removing...' : 'Remove'}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export interface InvoicePaymentsPanelProps {
  invoice: Invoice;
  showRecordButton?: boolean;
  title?: string;
  className?: string;
}

export const InvoicePaymentsPanel: React.FC<InvoicePaymentsPanelProps> = ({
  invoice,
  showRecordButton = false,
  title,
  className,
}) => {
  const { deletePayment, showConfirmDialog, openPaymentModal, isSaving } = useApp();

  return (
    <InvoicePaymentsPanelContent
      invoice={invoice}
      onDeletePayment={deletePayment}
      showConfirmDialog={showConfirmDialog}
      onRecordPayment={showRecordButton ? openPaymentModal : undefined}
      isBusy={isSaving}
      title={title}
      className={className}
    />
  );
};
