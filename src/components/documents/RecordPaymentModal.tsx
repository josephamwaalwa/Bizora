import React, { useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Textarea } from '../common/Textarea';
import { formatCurrency } from '../../utils/formatters';
import {
  createInitialPaymentFormState,
  getInvoiceRemainingBalanceMinor,
  getPaymentModalResetKey,
  PAYMENT_METHOD_SELECT_OPTIONS,
  validatePaymentInput,
  type PaymentValidationFieldErrors,
} from '../../utils/documentWorkflow';
import type { Invoice, PaymentMethod } from '../../types';
import type { NewPaymentInput } from '../../services/persistence';
import { CreditCard } from 'lucide-react';

interface RecordPaymentModalContentProps {
  invoice: Invoice;
  onClose: () => void;
  onSubmit: (invoiceId: string, paymentData: NewPaymentInput) => Promise<Invoice | undefined>;
}

const RecordPaymentModalContent: React.FC<RecordPaymentModalContentProps> = ({
  invoice,
  onClose,
  onSubmit,
}) => {
  const balanceMinor = getInvoiceRemainingBalanceMinor(invoice);
  const balance = balanceMinor / 100;
  const grandTotalMinor = Math.max(0, Math.round((Number(invoice.grandTotal) || 0) * 100));
  const hasAvailableBalance =
    invoice.status !== 'paid' && grandTotalMinor > 0 && balanceMinor > 0;
  const initialState = createInitialPaymentFormState(invoice);

  const [amountInput, setAmountInput] = useState<string>(initialState.amountInput);
  const [paymentDate, setPaymentDate] = useState<string>(initialState.paymentDate);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(initialState.paymentMethod);
  const [reference, setReference] = useState<string>(initialState.reference);
  const [notes, setNotes] = useState<string>(initialState.notes);
  const [fieldErrors, setFieldErrors] = useState<PaymentValidationFieldErrors>({});
  const [submitError, setSubmitError] = useState<string>(initialState.error);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const unavailableBalanceMessage =
    invoice.status === 'paid'
      ? 'This invoice is already paid and cannot accept additional payments.'
      : grandTotalMinor <= 0 || balanceMinor <= 0
        ? 'This invoice has no outstanding balance remaining.'
        : '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || isSubmitting) return;

    const validation = validatePaymentInput(
      invoice,
      {
        amount: amountInput,
        paymentDate,
        paymentMethod,
        reference,
        notes,
      },
      { requireExplicitDate: true }
    );

    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      setSubmitError(validation.fieldErrors.balance ? validation.error : '');
      return;
    }

    setFieldErrors({});
    setSubmitError('');
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await onSubmit(invoice.id, {
        amount: validation.value.amount,
        paymentDate: validation.value.paymentDate,
        paymentMethod: validation.value.paymentMethod,
        reference: validation.value.reference,
        notes: validation.value.notes,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to record payment.');
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const bannerMessage = fieldErrors.balance || submitError || unavailableBalanceMessage;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-ink-secondary" />
          <span>Record Payment • {invoice.invoiceNumber}</span>
        </div>
      }
      subtitle={`Customer Account: ${invoice.clientSnapshot.name || 'Client'}`}
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {/* Balance Card: Flat and Structured */}
        <div className="rounded border border-line bg-paper-sunken p-3.5 flex justify-between items-center text-xs">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted block">Total Invoiced</span>
            <span className="money font-semibold text-ink text-sm">
              {formatCurrency(invoice.grandTotal, invoice.currency, invoice.currencySymbol)}
            </span>
          </div>
          <div className="text-right">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted block">Balance Outstanding</span>
            <span className="money font-bold text-sm text-ink">
              {formatCurrency(balance, invoice.currency, invoice.currencySymbol)}
            </span>
          </div>
        </div>

        {bannerMessage && (
          <div
            role="alert"
            className="rounded border border-[#8E3B32]/30 bg-rose-50/70 dark:bg-rose-950/30 dark:border-rose-500/40 px-3 py-2 text-xs font-medium text-[#8E3B32] dark:text-rose-300"
          >
            {bannerMessage}
          </div>
        )}

        <Input
          label="Payment Amount"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amountInput}
          onChange={(e) => {
            setAmountInput(e.target.value);
            if (fieldErrors.amount || submitError) {
              setFieldErrors((prev) => ({ ...prev, amount: undefined }));
              setSubmitError('');
            }
          }}
          leftAddon={invoice.currencySymbol}
          error={fieldErrors.amount}
          disabled={!hasAvailableBalance || isSubmitting}
          required
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Payment Date"
            type="date"
            value={paymentDate}
            onChange={(e) => {
              setPaymentDate(e.target.value);
              if (fieldErrors.paymentDate || submitError) {
                setFieldErrors((prev) => ({ ...prev, paymentDate: undefined }));
                setSubmitError('');
              }
            }}
            error={fieldErrors.paymentDate}
            disabled={!hasAvailableBalance || isSubmitting}
            required
          />

          <Select
            label="Payment Method"
            value={paymentMethod}
            onChange={(e) => {
              setPaymentMethod(e.target.value as PaymentMethod);
              if (fieldErrors.paymentMethod || submitError) {
                setFieldErrors((prev) => ({ ...prev, paymentMethod: undefined }));
                setSubmitError('');
              }
            }}
            error={fieldErrors.paymentMethod}
            disabled={!hasAvailableBalance || isSubmitting}
            options={PAYMENT_METHOD_SELECT_OPTIONS.map((opt) => ({
              value: opt.value,
              label: opt.label,
            }))}
          />
        </div>

        <Input
          label="Reference / Transaction ID"
          placeholder="e.g. FNB-EFT-99410"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          disabled={!hasAvailableBalance || isSubmitting}
          helperText="Bank statement or payment receipt reference"
        />

        <Textarea
          label="Payment Notes"
          placeholder="Optional notes regarding this installment..."
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={!hasAvailableBalance || isSubmitting}
        />

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            disabled={!hasAvailableBalance || isSubmitting}
            isLoading={isSubmitting}
          >
            Confirm Payment
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export const RecordPaymentModal: React.FC = () => {
  const { paymentModalInvoice, closePaymentModal, recordPayment } = useApp();

  if (!paymentModalInvoice) return null;

  return (
    <RecordPaymentModalContent
      key={getPaymentModalResetKey(paymentModalInvoice)}
      invoice={paymentModalInvoice}
      onClose={closePaymentModal}
      onSubmit={recordPayment}
    />
  );
};
