import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Textarea } from '../common/Textarea';
import { formatCurrency } from '../../utils/formatters';
import {
  createInitialPaymentFormState,
  getPaymentModalResetKey,
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
  const balance = Math.max(0, Number(invoice.outstandingBalance) || 0);
  const initialState = createInitialPaymentFormState(invoice);

  const [amountInput, setAmountInput] = useState<string>(initialState.amountInput);
  const [paymentDate, setPaymentDate] = useState<string>(initialState.paymentDate);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(initialState.paymentMethod);
  const [reference, setReference] = useState<string>(initialState.reference);
  const [notes, setNotes] = useState<string>(initialState.notes);
  const [error, setError] = useState<string>(initialState.error);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    const numAmount = parseFloat(amountInput);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      setError('Please enter a valid payment amount greater than zero.');
      return;
    }
    if (numAmount > balance + 0.01) {
      setError(
        `Amount cannot exceed the remaining balance of ${formatCurrency(balance, invoice.currency, invoice.currencySymbol)}`
      );
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(invoice.id, {
        amount: numAmount,
        paymentDate,
        paymentMethod,
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

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
      <form onSubmit={handleSubmit} className="space-y-4">
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

        <Input
          label="Payment Amount"
          type="number"
          step="0.01"
          min="0.01"
          max={balance > 0 ? Number((balance + 0.01).toFixed(2)) : undefined}
          value={amountInput}
          onChange={(e) => {
            setAmountInput(e.target.value);
            setError('');
          }}
          leftAddon={invoice.currencySymbol}
          error={error}
          required
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Payment Date"
            type="date"
            value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)}
            required
          />

          <Select
            label="Payment Method"
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
            options={[
              { value: 'eft', label: 'EFT / Bank Transfer' },
              { value: 'credit_card', label: 'Credit / Debit Card' },
              { value: 'cash', label: 'Cash' },
              { value: 'mobile_money', label: 'Mobile Money / eWallet' },
              { value: 'cheque', label: 'Cheque' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </div>

        <Input
          label="Reference / Transaction ID"
          placeholder="e.g. FNB-EFT-99410"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          helperText="Bank statement or payment receipt reference"
        />

        <Textarea
          label="Payment Notes"
          placeholder="Optional notes regarding this installment..."
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={isSubmitting} isLoading={isSubmitting}>
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
