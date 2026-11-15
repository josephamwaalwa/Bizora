import React from 'react';
import type { Invoice } from '../../types';
import { DocumentSheet } from './DocumentSheet';

interface InvoicePrintableDocumentProps {
  document: Invoice;
  quoteRefLabel?: string;
}

export const InvoicePrintableDocument: React.FC<InvoicePrintableDocumentProps> = ({
  document,
  quoteRefLabel,
}) => {
  return <DocumentSheet type="invoice" document={document} quoteRefLabel={quoteRefLabel} />;
};
