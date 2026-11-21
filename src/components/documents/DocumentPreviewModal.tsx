import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { PrintableDocument } from './PrintableDocument';
import { InvoicePaymentsPanel } from './InvoicePaymentsPanel';
import { Button } from '../common/Button';
import { generateDocumentPdfBytes } from '../../services/pdfGenerator';
import { buildDocumentPdfFilename, exportPdfFile } from '../../services/fileOperations';
import {
  Printer,
  Download,
  Edit2,
  Copy,
  ArrowRight,
  CreditCard,
  History,
  X,
  FileCheck,
} from 'lucide-react';
import type { Quotation, Invoice, QuotationStatus, InvoiceStatus } from '../../types';
import { getInvoiceStatusOptionsForUi } from '../../utils/documentWorkflow';

export const DocumentPreviewModal: React.FC = () => {
  const {
    previewDocument,
    quotations,
    invoices,
    closeDocumentPreview,
    setActiveView,
    duplicateQuotation,
    duplicateInvoice,
    convertQuotationToInvoice,
    updateQuotationStatus,
    updateInvoiceStatus,
    openPaymentModal,
    addToast,
  } = useApp();

  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [showPaymentsPanel, setShowPaymentsPanel] = useState(true);

  if (!previewDocument) return null;

  const { type, data } = previewDocument;
  const isInvoice = type === 'invoice';

  // Always resolve the latest stored copy if available so edits/payments stay fresh
  const liveDocument = isInvoice
    ? invoices.find((inv) => inv.id === data.id) || (data as Invoice)
    : quotations.find((quo) => quo.id === data.id) || (data as Quotation);

  const invoice = isInvoice ? (liveDocument as Invoice) : null;
  const quote = !isInvoice ? (liveDocument as Quotation) : null;

  const documentNumber = isInvoice
    ? invoice?.invoiceNumber || ''
    : quote?.quotationNumber || '';

  // Resolve linked quotation number (handles both IDs like UUID/'quo_1' and legacy human numbers like 'QUO-0001')
  const resolvedQuoteRef = (() => {
    if (!isInvoice || !invoice?.quotationId) return undefined;
    const rawRef = invoice.quotationId.trim();
    if (!rawRef) return undefined;
    const normalizedRef = rawRef.toLowerCase();
    const matchedQuote = quotations.find(
      (q) => q.id === rawRef || q.quotationNumber.trim().toLowerCase() === normalizedRef
    );
    return matchedQuote ? matchedQuote.quotationNumber : rawRef;
  })();

  const handleDownloadPdf = async () => {
    if (isExportingPdf) return;
    setIsExportingPdf(true);

    try {
      const pdfBytes = await generateDocumentPdfBytes({
        type,
        document: liveDocument,
        quoteRefLabel: resolvedQuoteRef,
      });
      const fileName = buildDocumentPdfFilename(type, documentNumber);
      const result = await exportPdfFile(fileName, pdfBytes);

      if (result === 'saved') {
        addToast({
          type: 'success',
          title: 'PDF Saved',
          message: `${fileName} has been saved successfully.`,
        });
      }
    } catch (error) {
      console.error('Failed to generate or save PDF:', error);
      addToast({
        type: 'error',
        title: 'PDF Export Failed',
        message: 'Could not generate or save the PDF file. Please try again.',
      });
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleEdit = () => {
    closeDocumentPreview();
    if (isInvoice) {
      setActiveView('invoice-edit', invoice?.id);
    } else {
      setActiveView('quotation-edit', quote?.id);
    }
  };

  const handleDuplicate = async () => {
    if (isMutating) return;
    setIsMutating(true);
    try {
      if (isInvoice && invoice) {
        const dup = await duplicateInvoice(invoice.id);
        if (dup) closeDocumentPreview();
      } else if (quote) {
        const dup = await duplicateQuotation(quote.id);
        if (dup) closeDocumentPreview();
      }
    } finally {
      setIsMutating(false);
    }
  };

  const handleConvertToInvoice = async () => {
    if (isMutating || !quote) return;
    setIsMutating(true);
    try {
      await convertQuotationToInvoice(quote.id);
    } finally {
      setIsMutating(false);
    }
  };

  const handleRecordPayment = () => {
    if (invoice) {
      openPaymentModal(invoice);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/70 backdrop-blur-xs document-preview-backdrop">
      {/* Top action toolbar (hidden on print) */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-slate-700 bg-slate-900 px-4 sm:px-8 py-3 text-white no-print shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {isInvoice ? 'Invoice' : 'Quotation'}
          </span>
          <span className="font-mono text-sm font-bold text-white tracking-wide">
            {documentNumber}
          </span>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Status quick changer */}
          <div className="flex items-center gap-1.5 bg-slate-800 rounded px-2 py-1 border border-slate-700">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Status:</span>
            {isInvoice && invoice ? (
              <select
                value={invoice.status}
                disabled={isMutating}
                onChange={(e) => void updateInvoiceStatus(invoice.id, e.target.value as InvoiceStatus)}
                className="bg-transparent text-xs font-semibold text-white focus:outline-none cursor-pointer disabled:opacity-60"
              >
                {getInvoiceStatusOptionsForUi(invoice).map((opt) => (
                  <option
                    key={opt.value}
                    value={opt.value}
                    disabled={opt.disabled}
                    className="bg-slate-900 text-white disabled:text-slate-500"
                  >
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : quote ? (
              <select
                value={quote.status}
                disabled={isMutating || Boolean(quote.convertedInvoiceId)}
                title={
                  quote.convertedInvoiceId
                    ? 'Converted quotations remain Accepted while linked to an invoice'
                    : undefined
                }
                onChange={(e) => void updateQuotationStatus(quote.id, e.target.value as QuotationStatus)}
                className="bg-transparent text-xs font-semibold text-white focus:outline-none cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <option
                  value="draft"
                  disabled={Boolean(quote.convertedInvoiceId)}
                  className="bg-slate-900 text-white disabled:text-slate-500"
                >
                  Draft
                </option>
                <option
                  value="sent"
                  disabled={Boolean(quote.convertedInvoiceId)}
                  className="bg-slate-900 text-white disabled:text-slate-500"
                >
                  Sent
                </option>
                <option value="accepted" className="bg-slate-900 text-white">
                  Accepted
                </option>
                <option
                  value="declined"
                  disabled={Boolean(quote.convertedInvoiceId)}
                  className="bg-slate-900 text-white disabled:text-slate-500"
                >
                  Declined
                </option>
                <option
                  value="expired"
                  disabled={Boolean(quote.convertedInvoiceId)}
                  className="bg-slate-900 text-white disabled:text-slate-500"
                >
                  Expired
                </option>
              </select>
            ) : null}
          </div>

          {/* Quotation: Convert to Invoice */}
          {!isInvoice && quote?.status !== 'declined' && !quote?.convertedInvoiceId && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<ArrowRight className="w-3.5 h-3.5 text-teal-600" />}
              onClick={handleConvertToInvoice}
              disabled={isMutating}
            >
              Convert to Invoice
            </Button>
          )}

          {/* Quotation already converted indicator */}
          {!isInvoice && quote?.convertedInvoiceId && (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium bg-slate-800 text-slate-300 border border-slate-700 rounded">
              <FileCheck className="w-3.5 h-3.5 text-teal-400" />
              Converted
            </span>
          )}

          {/* Invoice: Record Payment */}
          {isInvoice && invoice?.status !== 'paid' && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<CreditCard className="w-3.5 h-3.5 text-emerald-600" />}
              onClick={handleRecordPayment}
            >
              Record Payment
            </Button>
          )}

          {/* Invoice: Toggle Payment History Panel (available for unpaid, partial, and paid) */}
          {isInvoice && invoice && (
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={showPaymentsPanel}
              leftIcon={<History className="w-3.5 h-3.5 text-teal-600" />}
              onClick={() => setShowPaymentsPanel((prev) => !prev)}
            >
              Payments ({invoice.payments?.length ?? 0})
            </Button>
          )}

          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Edit2 className="w-3.5 h-3.5" />}
            onClick={handleEdit}
          >
            Edit
          </Button>

          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Copy className="w-3.5 h-3.5" />}
            onClick={handleDuplicate}
            disabled={isMutating}
            isLoading={isMutating}
          >
            Duplicate
          </Button>

          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Printer className="w-3.5 h-3.5" />}
            onClick={handlePrint}
          >
            Print
          </Button>

          <Button
            variant="primary"
            size="sm"
            leftIcon={<Download className="w-3.5 h-3.5" />}
            onClick={handleDownloadPdf}
            disabled={isExportingPdf}
            isLoading={isExportingPdf}
          >
            {isExportingPdf ? 'Generating PDF...' : 'Download PDF'}
          </Button>

          <button
            onClick={closeDocumentPreview}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors ml-1"
            title="Close Preview"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Desk Preview Container */}
      <div className="document-preview-sheet py-8 sm:py-12 px-3 sm:px-6 flex flex-col items-center gap-6 bg-slate-200/60 dark:bg-[#0B1220] print:bg-white print:p-0">
        {isInvoice && invoice && showPaymentsPanel && (
          <div className="w-[210mm] max-w-full no-print">
            <InvoicePaymentsPanel
              invoice={invoice}
              showRecordButton={invoice.status !== 'paid'}
            />
          </div>
        )}

        <PrintableDocument
          document={liveDocument}
          type={type}
          quoteRefLabel={resolvedQuoteRef}
        />
      </div>
    </div>
  );
};
