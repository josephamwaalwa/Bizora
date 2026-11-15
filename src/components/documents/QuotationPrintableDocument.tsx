import React from 'react';
import type { Quotation } from '../../types';
import { DocumentSheet } from './DocumentSheet';

interface QuotationPrintableDocumentProps {
  document: Quotation;
}

export const QuotationPrintableDocument: React.FC<QuotationPrintableDocumentProps> = ({
  document,
}) => {
  return <DocumentSheet type="quote" document={document} />;
};
