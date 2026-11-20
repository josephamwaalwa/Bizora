import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { Textarea } from '../components/common/Textarea';
import type { LineItem, Invoice, Client, InvoiceStatus } from '../types';
import { calculateDocumentFinancials, calculateLineItemTotal, calculateInvoiceBalances } from '../utils/calculations';
import { formatCurrency } from '../utils/formatters';
import { generateId } from '../utils/idGenerator';
import {
  Plus,
  Trash2,
  ArrowLeft,
  AlertCircle,
  Eye,
} from 'lucide-react';

export const InvoiceFormPage: React.FC = () => {
  const {
    activeEntityId,
    setActiveView,
    invoices,
    clients,
    quotations,
    businessProfile,
    saveInvoice,
    saveClient,
    getNextInvoiceNumber,
    isInvoiceNumberTaken,
    openDocumentPreview,
    addToast,
  } = useApp();

  const isEditing = Boolean(activeEntityId);
  const existingInvoice = isEditing ? invoices.find((i) => i.id === activeEntityId) : null;

  // Selected Client
  const [selectedClientId, setSelectedClientId] = useState<string>(() => {
    if (existingInvoice) return existingInvoice.clientId;
    if (clients.length > 0) return clients[0].id;
    return '';
  });

  // Client quick creation toggle
  const [isAddingNewClient, setIsAddingNewClient] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientCompany, setNewClientCompany] = useState('');
  const [newClientEmail, setNewClientEmail] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [newClientAddress, setNewClientAddress] = useState('');

  // Invoice Meta
  const hasManuallyEditedNumberRef = useRef(false);
  const [invoiceNumber, setInvoiceNumber] = useState<string>(() => {
    return existingInvoice ? existingInvoice.invoiceNumber : '';
  });

  useEffect(() => {
    if (isEditing) return;
    let cancelled = false;
    void getNextInvoiceNumber().then((nextNumber) => {
      if (!cancelled && !hasManuallyEditedNumberRef.current) {
        setInvoiceNumber(nextNumber);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isEditing, getNextInvoiceNumber]);

  const [quotationId, setQuotationId] = useState<string>(() => {
    const rawRef = existingInvoice?.quotationId?.trim();
    if (!rawRef) return '';
    const matchedQuote = quotations.find(
      (q) => q.id === rawRef || q.quotationNumber.trim().toLowerCase() === rawRef.toLowerCase()
    );
    return matchedQuote ? matchedQuote.id : '';
  });

  const [issueDate, setIssueDate] = useState<string>(() => {
    return existingInvoice?.issueDate || new Date().toISOString().split('T')[0];
  });

  const [dueDate, setDueDate] = useState<string>(() => {
    if (existingInvoice?.dueDate) return existingInvoice.dueDate;
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().split('T')[0];
  });

  const [status, setStatus] = useState<InvoiceStatus>(() => {
    return existingInvoice?.status || 'sent';
  });

  const [currency, setCurrency] = useState(existingInvoice?.currency || businessProfile.defaultCurrency || 'NAD');
  const [currencySymbol, setCurrencySymbol] = useState(existingInvoice?.currencySymbol || businessProfile.currencySymbol || 'N$');

  // Line items
  const [items, setItems] = useState<LineItem[]>(() => {
    if (existingInvoice && existingInvoice.items.length > 0) {
      return existingInvoice.items;
    }
    return [
      {
        id: generateId('item'),
        description: 'Professional Services / Development Retainer',
        quantity: 1,
        unitPrice: 8500,
        total: 8500,
      },
    ];
  });

  // Discounts & Tax
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>(
    existingInvoice?.discountType || 'percentage'
  );
  const [discountValue, setDiscountValue] = useState<number>(existingInvoice?.discountValue || 0);

  const [isTaxEnabled, setIsTaxEnabled] = useState<boolean>(() => {
    if (existingInvoice) return existingInvoice.taxRate > 0;
    return businessProfile.isTaxEnabled ?? true;
  });
  const [taxName, setTaxName] = useState<string>(existingInvoice?.taxName || businessProfile.defaultTaxName || 'VAT');
  const [taxRate, setTaxRate] = useState<number>(() => {
    if (existingInvoice) return existingInvoice.taxRate;
    return businessProfile.defaultTaxRate ?? 15;
  });

  // Notes & Terms
  const [notes, setNotes] = useState<string>(
    existingInvoice ? existingInvoice.notes || '' : businessProfile.defaultNotes
  );
  const [terms, setTerms] = useState<string>(
    existingInvoice ? existingInvoice.terms || '' : businessProfile.defaultTermsInvoice
  );

  const [errorMsg, setErrorMsg] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Live recalculations
  const financials = calculateDocumentFinancials({
    items,
    discountType,
    discountValue,
    isTaxEnabled,
    taxRate: isTaxEnabled ? taxRate : 0,
    taxName,
  });

  const currentPayments = existingInvoice?.payments || [];
  const { amountPaid, outstandingBalance } = calculateInvoiceBalances(financials.grandTotal, currentPayments);

  const matchedClient = clients.find((c) => c.id === selectedClientId);
  const currentClient = matchedClient || existingInvoice?.clientSnapshot;

  const handleAddItem = () => {
    setItems((prev) => [
      ...prev,
      {
        id: generateId('item'),
        description: '',
        quantity: 1,
        unitPrice: 0,
        total: 0,
      },
    ]);
  };

  const handleRemoveItem = (id: string) => {
    if (items.length <= 1) {
      addToast({
        type: 'warning',
        title: 'At least one line item is required.',
      });
      return;
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleItemChange = (id: string, field: 'description' | 'quantity' | 'unitPrice', val: string | number) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: val };
        const q = field === 'quantity' ? Number(val) : item.quantity;
        const p = field === 'unitPrice' ? Number(val) : item.unitPrice;
        updated.total = calculateLineItemTotal(q, p);
        return updated;
      })
    );
  };

  const handleQuickAddClient = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isSubmitting) return;
    if (!newClientName.trim()) {
      const msg = 'Client name is required.';
      setErrorMsg(msg);
      addToast({ type: 'error', title: 'Missing Client Name', message: msg });
      return;
    }
    setErrorMsg('');
    setIsSubmitting(true);
    try {
      const created = await saveClient({
        name: newClientName.trim(),
        companyName: newClientCompany.trim() || undefined,
        email: newClientEmail.trim() || `${newClientName.toLowerCase().replace(/\s+/g, '')}@example.com`,
        phone: newClientPhone.trim(),
        address: newClientAddress.trim(),
      });
      if (!created) return;
      setSelectedClientId(created.id);
      setIsAddingNewClient(false);
      setNewClientName('');
      setNewClientCompany('');
      setNewClientEmail('');
      setNewClientPhone('');
      setNewClientAddress('');
    } finally {
      setIsSubmitting(false);
    }
  };

  const reportValidationError = (message: string) => {
    setErrorMsg(message);
    addToast({
      type: 'error',
      title: 'Cannot Save Invoice',
      message,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const findLinkedInvoiceForQuotation = (quoteId: string, quoteNumber: string) => {
    const normalizedQuoteNum = quoteNumber.trim().toLowerCase();
    return invoices.find((inv) => {
      if (inv.id === existingInvoice?.id) return false;
      const invQuoteRef = inv.quotationId?.trim();
      const linkedByInvoiceRef =
        invQuoteRef === quoteId ||
        (invQuoteRef && invQuoteRef.toLowerCase() === normalizedQuoteNum);
      const quote = quotations.find((q) => q.id === quoteId);
      const linkedByQuotePtr = quote?.convertedInvoiceId === inv.id;
      return Boolean(linkedByInvoiceRef || linkedByQuotePtr);
    });
  };

  const handleSave = async (viewAfterSave: boolean = false) => {
    if (isSubmitting) return;
    setErrorMsg('');
    setIsSubmitting(true);

    try {
      let clientToUse: Client | undefined = matchedClient;

      if (isAddingNewClient) {
        if (newClientName.trim()) {
          const createdClient = await saveClient({
            name: newClientName.trim(),
            companyName: newClientCompany.trim() || undefined,
            email: newClientEmail.trim() || `${newClientName.toLowerCase().replace(/\s+/g, '')}@example.com`,
            phone: newClientPhone.trim(),
            address: newClientAddress.trim(),
          });
          if (!createdClient) return;
          clientToUse = createdClient;
          setSelectedClientId(createdClient.id);
          setIsAddingNewClient(false);
          setNewClientName('');
          setNewClientCompany('');
          setNewClientEmail('');
          setNewClientPhone('');
          setNewClientAddress('');
        } else if (!clientToUse) {
          reportValidationError('Please enter a client name or select an existing client.');
          return;
        }
      }

      if (!clientToUse) {
        reportValidationError(
          isEditing && existingInvoice?.clientSnapshot
            ? 'The original client record was deleted. Please select an existing client or quick-add a client before saving.'
            : 'Please select or add a client before saving.'
        );
        return;
      }

      if (items.length === 0 || items.some((item) => !item.description.trim())) {
        reportValidationError('Please enter a description for all line items.');
        return;
      }

      const finalInvoiceNumber =
        invoiceNumber.trim() ||
        (existingInvoice ? existingInvoice.invoiceNumber : await getNextInvoiceNumber());

      if (await isInvoiceNumberTaken(finalInvoiceNumber, existingInvoice?.id)) {
        reportValidationError(
          `Invoice number "${finalInvoiceNumber}" already exists. Please enter a unique invoice number.`
        );
        return;
      }

      let resolvedQuotationId: string | undefined;
      const rawQuotationRef = quotationId.trim();
      if (rawQuotationRef) {
        const matchedQuote = quotations.find(
          (q) =>
            q.id === rawQuotationRef ||
            q.quotationNumber.trim().toLowerCase() === rawQuotationRef.toLowerCase()
        );
        if (!matchedQuote) {
          reportValidationError('The selected quotation no longer exists. Please choose another quotation or clear the link.');
          return;
        }

        const isAlreadyLinkedToCurrent = Boolean(
          existingInvoice &&
            ((existingInvoice.quotationId &&
              (existingInvoice.quotationId === matchedQuote.id ||
                existingInvoice.quotationId.trim().toLowerCase() === matchedQuote.quotationNumber.trim().toLowerCase())) ||
              matchedQuote.convertedInvoiceId === existingInvoice.id)
        );

        if (matchedQuote.status === 'declined' && !isAlreadyLinkedToCurrent) {
          reportValidationError(
            `Quotation ${matchedQuote.quotationNumber} is declined and cannot be linked to an invoice.`
          );
          return;
        }

        const conflictingInvoice = findLinkedInvoiceForQuotation(matchedQuote.id, matchedQuote.quotationNumber);
        if (conflictingInvoice) {
          reportValidationError(
            `Quotation ${matchedQuote.quotationNumber} is already linked to Invoice ${conflictingInvoice.invoiceNumber}.`
          );
          return;
        }
        resolvedQuotationId = matchedQuote.id;
      }

      const invoiceToSave: Invoice = {
        id: existingInvoice?.id || generateId('inv'),
        invoiceNumber: finalInvoiceNumber,
        quotationId: resolvedQuotationId,
        clientId: clientToUse.id,
        clientSnapshot: clientToUse,
        businessSnapshot: businessProfile,
        issueDate,
        dueDate,
        currency,
        currencySymbol,
        items,
        subtotal: financials.subtotal,
        discountType,
        discountValue: Number(discountValue) || 0,
        discountAmount: financials.discountAmount,
        taxName: isTaxEnabled ? taxName : 'None',
        taxRate: isTaxEnabled ? Number(taxRate) : 0,
        taxAmount: financials.taxAmount,
        grandTotal: financials.grandTotal,
        amountPaid,
        outstandingBalance,
        status,
        notes: notes.trim() || undefined,
        terms: terms.trim() || undefined,
        payments: currentPayments,
        createdAt: existingInvoice?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const saved = await saveInvoice(invoiceToSave, { commitNumber: !isEditing });
      if (!saved) {
        return;
      }

      if (viewAfterSave) {
        openDocumentPreview('invoice', saved);
      }
      setActiveView('invoices');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 pb-20">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-line">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setActiveView('invoices')}
            leftIcon={<ArrowLeft className="w-3.5 h-3.5" />}
          >
            Back
          </Button>
          <div>
            <span className="page-kicker block mb-1">
              Invoice Editor
            </span>
            <h2 className="page-title">
              {isEditing ? `Edit Invoice ${invoiceNumber}` : 'Create Commercial Invoice'}
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void handleSave(false)} disabled={isSubmitting}>
            Save Draft
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void handleSave(true)}
            leftIcon={<Eye className="w-3.5 h-3.5" />}
            disabled={isSubmitting}
            isLoading={isSubmitting}
          >
            Save & Inspect
          </Button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 rounded bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-xs flex items-center gap-2 font-medium">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Form Area (8 cols) */}
        <div className="lg:col-span-8 space-y-6">
          {/* SECTION A: Business Information */}
          <div className="border border-line rounded-md bg-surface p-5 shadow-subtle space-y-3">
            <div className="flex items-center justify-between border-b border-line pb-2.5">
              <span className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans">
                Sender Business Entity
              </span>
              <button
                type="button"
                onClick={() => setActiveView('settings')}
                className="text-xs font-semibold text-ink-secondary hover:text-ink"
              >
                Configure in Settings
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-ink-secondary">
              <div>
                <span className="text-xs uppercase font-bold text-ink-muted block">Business</span>
                <span className="font-semibold text-ink">{businessProfile.name}</span>
                <p className="text-ink-secondary">{businessProfile.email}</p>
              </div>
              <div>
                <span className="text-xs uppercase font-bold text-ink-muted block">Bank Account</span>
                <span className="text-ink">{businessProfile.bankDetails.bankName || 'Not configured'}</span>
                <p className="font-mono text-ink-secondary">{businessProfile.bankDetails.accountNumber || 'Account not set'}</p>
              </div>
              <div>
                <span className="text-xs uppercase font-bold text-ink-muted block">Tax / TIN</span>
                <span className="text-ink font-mono">{businessProfile.taxNumber || 'No VAT set'}</span>
                <p className="text-ink-secondary font-mono">{businessProfile.defaultCurrency} ({businessProfile.currencySymbol})</p>
              </div>
            </div>
          </div>

          {/* SECTION B: Client Selection */}
          <div className="border border-line rounded-md bg-surface p-5 shadow-subtle space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-2.5">
              <span className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans">
                Client (Bill To)
              </span>
              <button
                type="button"
                onClick={() => setIsAddingNewClient(!isAddingNewClient)}
                className="text-xs font-semibold text-ink-secondary hover:text-ink"
              >
                {isAddingNewClient ? 'Select existing client' : '+ Quick add client'}
              </button>
            </div>

            {isAddingNewClient ? (
              <div className="p-4 rounded border border-line bg-paper-sunken space-y-3">
                <span className="text-xs font-bold text-ink uppercase tracking-wider block">
                  Quick Add Client Record
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Client Contact Name"
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    placeholder="e.g. Helena Shipanga"
                    required
                  />
                  <Input
                    label="Company Name"
                    value={newClientCompany}
                    onChange={(e) => setNewClientCompany(e.target.value)}
                    placeholder="e.g. Dunes Logistics CC"
                  />
                  <Input
                    label="Email Address"
                    type="email"
                    value={newClientEmail}
                    onChange={(e) => setNewClientEmail(e.target.value)}
                    placeholder="client@business.na"
                  />
                  <Input
                    label="Phone Number"
                    value={newClientPhone}
                    onChange={(e) => setNewClientPhone(e.target.value)}
                    placeholder="+264 61 000 000"
                  />
                </div>
                <Input
                  label="Billing Address"
                  value={newClientAddress}
                  onChange={(e) => setNewClientAddress(e.target.value)}
                  placeholder="Street, City, Namibia"
                />
                <div className="flex justify-end gap-2 pt-1">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setIsAddingNewClient(false)} disabled={isSubmitting}>
                    Cancel
                  </Button>
                  <Button type="button" variant="primary" size="sm" onClick={() => void handleQuickAddClient()} disabled={isSubmitting} isLoading={isSubmitting}>
                    Save & Select
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                {clients.length === 0 ? (
                  <div className="text-xs text-ink-secondary py-2">
                    No clients registered.{' '}
                    <button
                      type="button"
                      onClick={() => setIsAddingNewClient(true)}
                      className="font-semibold text-ink underline"
                    >
                      Click here to add one.
                    </button>
                  </div>
                ) : (
                  <Select
                    label="Select Client"
                    value={matchedClient ? selectedClientId : ''}
                    onChange={(e) => setSelectedClientId(e.target.value)}
                    options={[
                      ...(!matchedClient
                        ? [{ value: '', label: 'Select an existing client...' }]
                        : []),
                      ...clients.map((c) => ({
                        value: c.id,
                        label: `${c.name}${c.companyName ? ` (${c.companyName})` : ''}`,
                      })),
                    ]}
                  />
                )}

                {currentClient && (
                  <div className="mt-3 p-3 bg-paper-sunken rounded text-xs space-y-0.5 text-ink-secondary border border-line">
                    <p className="font-semibold text-ink">{currentClient.name}</p>
                    {currentClient.companyName && <p>{currentClient.companyName}</p>}
                    <p>{currentClient.email} • {currentClient.phone}</p>
                    {currentClient.address && <p>{currentClient.address}</p>}
                    {!matchedClient && (
                      <p className="pt-1 text-[#8E3B32] dark:text-rose-400 font-medium">
                        Original client record was removed. Select an existing client or quick-add a client to save.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* SECTION C & D: Line Items */}
          <div className="border border-line rounded-md bg-surface p-5 shadow-subtle space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-2.5">
              <span className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans">
                Itemised Billed Services & Products
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleAddItem}
                leftIcon={<Plus className="w-3 h-3" />}
              >
                Add Item
              </Button>
            </div>

            <div className="space-y-3">
              {items.map((item, index) => (
                <div
                  key={item.id}
                  className="p-3.5 rounded border border-line bg-paper-sunken space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-mono text-ink-muted mt-2 font-bold">
                      #{index + 1}
                    </span>
                    <div className="flex-1">
                      <Input
                        label="Item Description"
                        value={item.description}
                        onChange={(e) => handleItemChange(item.id, 'description', e.target.value)}
                        placeholder="e.g. Monthly Retainer & Support Agreement"
                        required
                      />
                    </div>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(item.id)}
                        className="mt-5 p-1.5 text-ink-muted hover:text-[#8E3B32] dark:hover:text-rose-400 transition-colors"
                        title="Remove item"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <Input
                      label="Quantity"
                      type="number"
                      min="1"
                      step="1"
                      value={item.quantity}
                      onChange={(e) => handleItemChange(item.id, 'quantity', parseFloat(e.target.value) || 0)}
                      required
                    />
                    <Input
                      label={`Unit Price (${currencySymbol})`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unitPrice}
                      onChange={(e) => handleItemChange(item.id, 'unitPrice', parseFloat(e.target.value) || 0)}
                      required
                    />
                    <div>
                      <span className="block text-xs font-bold uppercase tracking-wider text-ink-muted mb-1 font-sans">
                        Line Total
                      </span>
                      <div className="money h-11 flex items-center px-3 rounded border border-line bg-paper text-ink font-bold text-sm">
                        {formatCurrency(item.total, currency, currencySymbol)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Terms & Notes */}
          <div className="border border-line rounded-md bg-surface p-5 shadow-subtle space-y-4">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans block border-b border-line pb-2">
              Invoice Notes & Payment Conditions
            </span>
            <Textarea
              label="Notes to Customer"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Please use the invoice number as EFT payment reference..."
              rows={2}
            />
            <Textarea
              label="Terms & Conditions"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Specify interest on late payments, bank charges, etc."
              rows={3}
            />
          </div>
        </div>

        {/* Right Sidebar: Meta & Financials (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Metadata Card */}
          <div className="border border-line rounded-md bg-surface p-4 shadow-subtle space-y-3">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans block border-b border-line pb-2">
              Invoice Settings
            </span>

            <Input
              label="Invoice Number"
              value={invoiceNumber}
              onChange={(e) => {
                hasManuallyEditedNumberRef.current = true;
                setInvoiceNumber(e.target.value);
              }}
              placeholder={existingInvoice ? existingInvoice.invoiceNumber : 'Auto-assigned if blank'}
              helperText={
                isEditing
                  ? 'Leave blank to keep the current invoice number.'
                  : 'Leave blank to auto-assign the next sequential number.'
              }
            />

            <Select
              className="money"
              label="Linked Quotation (Optional)"
              value={quotationId}
              onChange={(e) => setQuotationId(e.target.value)}
            >
              <option value="">No linked quotation</option>
              {quotations.map((q) => {
                const linkedInvoice = findLinkedInvoiceForQuotation(q.id, q.quotationNumber);
                const isAlreadyLinkedToCurrent = Boolean(
                  existingInvoice &&
                    ((existingInvoice.quotationId &&
                      (existingInvoice.quotationId === q.id ||
                        existingInvoice.quotationId.trim().toLowerCase() === q.quotationNumber.trim().toLowerCase())) ||
                      q.convertedInvoiceId === existingInvoice.id)
                );
                const isDeclinedBlocked = q.status === 'declined' && !isAlreadyLinkedToCurrent;

                return (
                  <option key={q.id} value={q.id} disabled={Boolean(linkedInvoice) || isDeclinedBlocked}>
                    {q.quotationNumber} — {q.clientSnapshot.name} ({formatCurrency(q.grandTotal, q.currency, q.currencySymbol)})
                    {linkedInvoice ? ` [Linked to ${linkedInvoice.invoiceNumber}]` : ''}
                    {isDeclinedBlocked ? ' [Declined]' : ''}
                  </option>
                );
              })}
            </Select>

            <Select
              label="Invoice Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as InvoiceStatus)}
              options={[
                { value: 'draft', label: 'Draft' },
                { value: 'sent', label: 'Sent to Client' },
                { value: 'partially_paid', label: 'Partially Paid' },
                { value: 'paid', label: 'Paid in Full' },
                { value: 'overdue', label: 'Overdue' },
              ]}
            />

            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Issue Date"
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                required
              />
              <Input
                label="Due Date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                placeholder="NAD"
              />
              <Input
                label="Symbol"
                value={currencySymbol}
                onChange={(e) => setCurrencySymbol(e.target.value)}
                placeholder="N$"
              />
            </div>
          </div>

          {/* Financial Breakdown Card */}
          <div className="border border-line rounded-md bg-surface p-4 shadow-subtle space-y-4">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans block border-b border-line pb-2">
              Financial Summary
            </span>

            {/* Discount Configuration */}
            <div className="space-y-1.5">
              <span className="block text-xs font-bold uppercase tracking-wider text-ink-muted font-sans">
                Discount
              </span>
              <div className="grid grid-cols-2 gap-2">
                <Select
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value as any)}
                  options={[
                    { value: 'percentage', label: 'Percent (%)' },
                    { value: 'fixed', label: `Fixed (${currencySymbol})` },
                  ]}
                />
                <Input
                  type="number"
                  min="0"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(parseFloat(e.target.value) || 0)}
                  placeholder="0"
                />
              </div>
            </div>

            {/* Tax Configuration */}
            <div className="space-y-2 pt-2 border-t border-line">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans">
                  Tax Calculation
                </span>
                <label className="flex items-center gap-1.5 cursor-pointer text-xs text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={isTaxEnabled}
                    onChange={(e) => setIsTaxEnabled(e.target.checked)}
                    className="rounded border-line-strong text-indigo-600 focus:ring-indigo-500"
                  />
                  <span>Apply</span>
                </label>
              </div>

              {isTaxEnabled && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <Input
                    label="Tax Name"
                    value={taxName}
                    onChange={(e) => setTaxName(e.target.value)}
                    placeholder="VAT"
                  />
                  <Input
                    label="Rate (%)"
                    type="number"
                    min="0"
                    step="0.1"
                    value={taxRate}
                    onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)}
                    placeholder="15"
                  />
                </div>
              )}
            </div>

            {/* Calculation Totals */}
            <div className="pt-3 border-t border-line space-y-1.5 text-xs">
              <div className="flex justify-between text-ink-secondary">
                <span>Subtotal</span>
                <span className="money font-medium text-ink">
                  {formatCurrency(financials.subtotal, currency, currencySymbol)}
                </span>
              </div>

              {financials.discountAmount > 0 && (
                <div className="flex justify-between text-ink-secondary">
                  <span>Discount</span>
                  <span className="money text-ink">
                    - {formatCurrency(financials.discountAmount, currency, currencySymbol)}
                  </span>
                </div>
              )}

              {isTaxEnabled && financials.taxAmount > 0 && (
                <div className="flex justify-between text-ink-secondary">
                  <span>
                    {taxName} ({taxRate}%)
                  </span>
                  <span className="money font-medium text-ink">
                    {formatCurrency(financials.taxAmount, currency, currencySymbol)}
                  </span>
                </div>
              )}

              <div className="pt-2 border-t border-ink flex justify-between items-baseline text-ink">
                <span className="font-bold text-xs uppercase tracking-wider">Grand Total</span>
                <span className="money font-extrabold text-base">
                  {formatCurrency(financials.grandTotal, currency, currencySymbol)}
                </span>
              </div>

              {currentPayments.length > 0 && (
                <div className="flex justify-between text-ink-secondary font-medium pt-1">
                  <span>Less: Payments</span>
                  <span className="money text-ink">
                    - {formatCurrency(amountPaid, currency, currencySymbol)}
                  </span>
                </div>
              )}

              <div className="pt-2 border-t border-line-strong flex justify-between items-baseline font-bold text-ink">
                <span className="text-[11px] uppercase tracking-wider">Balance Due</span>
                <span className="money text-base font-extrabold">
                  {formatCurrency(outstandingBalance, currency, currencySymbol)}
                </span>
              </div>
            </div>

            <div className="pt-2">
              <Button
                type="button"
                variant="primary"
                size="md"
                className="w-full"
                onClick={() => void handleSave(true)}
                disabled={isSubmitting}
                isLoading={isSubmitting}
              >
                Save & Preview Invoice
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
