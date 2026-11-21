import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { Textarea } from '../components/common/Textarea';
import type { LineItem, Quotation, Client, QuotationStatus } from '../types';
import { calculateDocumentFinancials, calculateLineItemTotal } from '../utils/calculations';
import {
  findLinkedInvoiceForQuotationRecord,
  validateConvertedQuotationEdit,
} from '../utils/documentWorkflow';
import { formatCurrency } from '../utils/formatters';
import { generateId } from '../utils/idGenerator';
import {
  Plus,
  Trash2,
  ArrowLeft,
  AlertCircle,
  Eye,
  Lock,
} from 'lucide-react';

export const QuotationFormPage: React.FC = () => {
  const {
    activeEntityId,
    setActiveView,
    quotations,
    invoices,
    clients,
    businessProfile,
    saveQuotation,
    saveClient,
    getNextQuoteNumber,
    isQuotationNumberTaken,
    openDocumentPreview,
    addToast,
  } = useApp();

  const isEditing = Boolean(activeEntityId);
  const existingQuote = isEditing ? quotations.find((q) => q.id === activeEntityId) : null;
  const isConverted = Boolean(existingQuote?.convertedInvoiceId);
  const linkedInvoice = existingQuote
    ? findLinkedInvoiceForQuotationRecord(existingQuote, invoices)
    : undefined;

  // Selected Client
  const [selectedClientId, setSelectedClientId] = useState<string>(() => {
    if (existingQuote) return existingQuote.clientId;
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

  // Quotation Meta
  const hasManuallyEditedNumberRef = useRef(false);
  const [quotationNumber, setQuotationNumber] = useState<string>(() => {
    return existingQuote ? existingQuote.quotationNumber : '';
  });

  useEffect(() => {
    if (isEditing) return;
    let cancelled = false;
    void getNextQuoteNumber().then((nextNumber) => {
      if (!cancelled && !hasManuallyEditedNumberRef.current) {
        setQuotationNumber(nextNumber);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isEditing, getNextQuoteNumber]);

  const [issueDate, setIssueDate] = useState<string>(() => {
    return existingQuote?.issueDate || new Date().toISOString().split('T')[0];
  });

  const [expiryDate, setExpiryDate] = useState<string>(() => {
    if (existingQuote?.expiryDate) return existingQuote.expiryDate;
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().split('T')[0];
  });

  const [status, setStatus] = useState<QuotationStatus>(() => {
    return existingQuote?.status || 'draft';
  });

  const [currency, setCurrency] = useState(existingQuote?.currency || businessProfile.defaultCurrency || 'NAD');
  const [currencySymbol, setCurrencySymbol] = useState(existingQuote?.currencySymbol || businessProfile.currencySymbol || 'N$');

  // Line items
  const [items, setItems] = useState<LineItem[]>(() => {
    if (existingQuote && existingQuote.items.length > 0) {
      return existingQuote.items;
    }
    return [
      {
        id: generateId('item'),
        description: 'Professional Consulting / Project Services',
        quantity: 1,
        unitPrice: 5000,
        total: 5000,
      },
    ];
  });

  // Discounts & Tax
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>(
    existingQuote?.discountType || 'percentage'
  );
  const [discountValue, setDiscountValue] = useState<number>(existingQuote?.discountValue || 0);

  const [isTaxEnabled, setIsTaxEnabled] = useState<boolean>(() => {
    if (existingQuote) return existingQuote.taxRate > 0;
    return businessProfile.isTaxEnabled ?? true;
  });
  const [taxName, setTaxName] = useState<string>(existingQuote?.taxName || businessProfile.defaultTaxName || 'VAT');
  const [taxRate, setTaxRate] = useState<number>(() => {
    if (existingQuote) return existingQuote.taxRate;
    return businessProfile.defaultTaxRate ?? 15;
  });

  // Notes & Terms
  const [notes, setNotes] = useState<string>(
    existingQuote ? existingQuote.notes || '' : businessProfile.defaultNotes
  );
  const [terms, setTerms] = useState<string>(
    existingQuote ? existingQuote.terms || '' : businessProfile.defaultTermsQuotation
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

  const matchedClient = clients.find((c) => c.id === selectedClientId);
  const currentClient = matchedClient || existingQuote?.clientSnapshot;
  const hasPreservedSnapshotFallback = Boolean(
    isEditing && existingQuote?.clientSnapshot?.name?.trim() && !matchedClient
  );

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
      title: 'Cannot Save Quotation',
      message,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

      const resolvedClientSnapshot = clientToUse || (hasPreservedSnapshotFallback ? existingQuote?.clientSnapshot : undefined);
      const resolvedClientId = clientToUse ? clientToUse.id : '';

      if (!resolvedClientSnapshot?.name?.trim()) {
        reportValidationError('Please select or add a client before saving.');
        return;
      }

      if (items.length === 0 || items.some((item) => !item.description.trim())) {
        reportValidationError('Please enter a description for all line items.');
        return;
      }

      const finalQuoteNumber =
        quotationNumber.trim() ||
        (existingQuote ? existingQuote.quotationNumber : await getNextQuoteNumber());

      if (await isQuotationNumberTaken(finalQuoteNumber, existingQuote?.id)) {
        reportValidationError(
          `Quotation number "${finalQuoteNumber}" already exists. Please enter a unique quotation number.`
        );
        return;
      }

      const quoteToSave: Quotation = {
        id: existingQuote?.id || generateId('quo'),
        quotationNumber: finalQuoteNumber,
        clientId: resolvedClientId,
        clientSnapshot: resolvedClientSnapshot,
        businessSnapshot: existingQuote?.businessSnapshot || businessProfile,
        issueDate,
        expiryDate,
        currency,
        currencySymbol,
        items,
        subtotal: financials.subtotal,
        discountType,
        discountValue: Number(discountValue) || 0,
        discountAmount: financials.discountAmount,
        taxName: isTaxEnabled ? taxName : 'None',
        taxRate: isTaxEnabled ? Number(taxRate) || 0 : 0,
        taxAmount: financials.taxAmount,
        grandTotal: financials.grandTotal,
        status,
        notes: notes.trim() || undefined,
        terms: terms.trim() || undefined,
        convertedInvoiceId: existingQuote?.convertedInvoiceId,
        preConversionStatus: existingQuote?.preConversionStatus,
        createdAt: existingQuote?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (existingQuote?.convertedInvoiceId) {
        const conversionValidation = validateConvertedQuotationEdit(
          existingQuote,
          quoteToSave,
          linkedInvoice?.invoiceNumber
        );
        if (!conversionValidation.valid) {
          reportValidationError(
            conversionValidation.message ||
              'Converted quotations cannot have their line items, pricing, client, or status modified.'
          );
          return;
        }
      }

      const saved = await saveQuotation(quoteToSave, { commitNumber: !isEditing });
      if (!saved) {
        return;
      }

      if (viewAfterSave) {
        openDocumentPreview('quote', saved);
      }
      setActiveView('quotations');
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
            onClick={() => setActiveView('quotations')}
            leftIcon={<ArrowLeft className="w-3.5 h-3.5" />}
          >
            Back
          </Button>
          <div>
            <span className="page-kicker block mb-1">
              Quotation Editor
            </span>
            <h2 className="page-title">
              {isEditing ? `Edit Quotation ${quotationNumber}` : 'Create New Quotation'}
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void handleSave(false)} disabled={isSubmitting}>
            {isEditing ? 'Save Changes' : 'Save Draft'}
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

      {isConverted && existingQuote && (
        <div
          role="status"
          className="p-3.5 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 font-medium"
        >
          <div className="flex items-start sm:items-center gap-2">
            <Lock className="w-4 h-4 shrink-0 mt-0.5 sm:mt-0" />
            <span>
              Converted to{' '}
              <strong>{linkedInvoice ? `Invoice ${linkedInvoice.invoiceNumber}` : 'an invoice'}</strong>.
              Line items, pricing, client assignment, and status are locked to protect conversion integrity.
              Notes, terms, and expiry date can still be updated.
            </span>
          </div>
          {linkedInvoice && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => openDocumentPreview('invoice', linkedInvoice)}
            >
              View Linked Invoice
            </Button>
          )}
        </div>
      )}

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
                Sender Information
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
                <span className="text-xs uppercase font-bold text-ink-muted block">Location</span>
                <span className="text-ink">
                  {businessProfile.address ||
                    [businessProfile.city, businessProfile.country].filter(Boolean).join(', ') ||
                    'Address not set'}
                </span>
                {businessProfile.phone && <p className="text-ink-secondary">{businessProfile.phone}</p>}
              </div>
              <div>
                <span className="text-xs uppercase font-bold text-ink-muted block">Tax / Registration</span>
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
              {!isConverted && (
                <button
                  type="button"
                  onClick={() => setIsAddingNewClient(!isAddingNewClient)}
                  className="text-xs font-semibold text-ink-secondary hover:text-ink"
                >
                  {isAddingNewClient ? 'Select existing client' : '+ Quick add client'}
                </button>
              )}
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
                    disabled={isConverted}
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
                      <p className="pt-1 text-[#8A5A12] dark:text-amber-400 font-medium">
                        {hasPreservedSnapshotFallback
                          ? 'Original client record was removed. Saving preserves this client snapshot.'
                          : 'Original client record was removed. Select an existing client or quick-add a client to save.'}
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
                Itemised Services & Products
              </span>
              {!isConverted && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleAddItem}
                  leftIcon={<Plus className="w-3 h-3" />}
                >
                  Add Item
                </Button>
              )}
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
                        label="Description of Service / Product"
                        value={item.description}
                        disabled={isConverted}
                        onChange={(e) => handleItemChange(item.id, 'description', e.target.value)}
                        placeholder="e.g. Website Redesign & Technical SEO Audit"
                        required
                      />
                    </div>
                    {items.length > 1 && !isConverted && (
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
                      disabled={isConverted}
                      onChange={(e) => handleItemChange(item.id, 'quantity', parseFloat(e.target.value) || 0)}
                      required
                    />
                    <Input
                      label={`Unit Price (${currencySymbol})`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unitPrice}
                      disabled={isConverted}
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

          {/* SECTION F: Terms & Notes */}
          <div className="border border-line rounded-md bg-surface p-5 shadow-subtle space-y-4">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans block border-b border-line pb-2">
              Proposal Notes & Contractual Terms
            </span>
            <Textarea
              label="Notes to Client"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Provide scope context or delivery expectations..."
              rows={2}
            />
            <Textarea
              label="Terms & Conditions"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Specify payment schedule, validity, scope revisions, etc."
              rows={3}
            />
          </div>
        </div>

        {/* Right Sidebar: Meta & Financials (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Metadata Card */}
          <div className="border border-line rounded-md bg-surface p-4 shadow-subtle space-y-3">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-muted font-sans block border-b border-line pb-2">
              Quotation Metadata
            </span>

            <Input
              label="Quotation Number"
              value={quotationNumber}
              disabled={isConverted}
              onChange={(e) => {
                hasManuallyEditedNumberRef.current = true;
                setQuotationNumber(e.target.value);
              }}
              placeholder={existingQuote ? existingQuote.quotationNumber : 'Auto-assigned if blank'}
              helperText={
                isConverted
                  ? 'Locked after conversion to invoice.'
                  : isEditing
                    ? 'Leave blank to keep the current quotation number.'
                    : 'Leave blank to auto-assign the next sequential number.'
              }
            />

            <Select
              label="Quotation Status"
              value={status}
              disabled={isConverted}
              onChange={(e) => setStatus(e.target.value as QuotationStatus)}
              options={[
                { value: 'draft', label: 'Draft', disabled: isConverted },
                { value: 'sent', label: 'Sent to Client', disabled: isConverted },
                { value: 'accepted', label: 'Accepted' },
                { value: 'declined', label: 'Declined', disabled: isConverted },
                { value: 'expired', label: 'Expired', disabled: isConverted },
              ]}
              helperText={isConverted ? 'Locked to Accepted while linked to an invoice.' : undefined}
            />

            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Issue Date"
                type="date"
                value={issueDate}
                disabled={isConverted}
                onChange={(e) => setIssueDate(e.target.value)}
                required
              />
              <Input
                label="Expiry Date"
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Currency"
                value={currency}
                disabled={isConverted}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                placeholder="NAD"
              />
              <Input
                label="Symbol"
                value={currencySymbol}
                disabled={isConverted}
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
                  disabled={isConverted}
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
                  disabled={isConverted}
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
                <label className={`flex items-center gap-1.5 text-xs text-ink-secondary ${isConverted ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={isTaxEnabled}
                    disabled={isConverted}
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
                    disabled={isConverted}
                    onChange={(e) => setTaxName(e.target.value)}
                    placeholder="VAT"
                  />
                  <Input
                    label="Rate (%)"
                    type="number"
                    min="0"
                    step="0.1"
                    value={taxRate}
                    disabled={isConverted}
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
                Save & Preview Quotation
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
