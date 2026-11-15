import React from 'react';
import type { Invoice, Quotation } from '../../types';
import { QuotationPrintableDocument } from './QuotationPrintableDocument';
import { InvoicePrintableDocument } from './InvoicePrintableDocument';

interface PrintableDocumentProps {
  document: Quotation | Invoice;
  type: 'quote' | 'invoice';
  quoteRefLabel?: string;
}

export const PrintableDocument: React.FC<PrintableDocumentProps> = ({
  document,
  type,
  quoteRefLabel,
}) => {
  if (type === 'quote') {
    return <QuotationPrintableDocument document={document as Quotation} />;
  }

  return (
    <InvoicePrintableDocument
      document={document as Invoice}
      quoteRefLabel={quoteRefLabel}
    />
  );
};
