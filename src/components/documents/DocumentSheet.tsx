import React from 'react';
import type { Invoice, Quotation } from '../../types';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { DocumentLogo } from '../common/DocumentLogo';

interface DocumentSheetProps {
  type: 'quote' | 'invoice';
  document: Quotation | Invoice;
  quoteRefLabel?: string;
}

export const DocumentSheet: React.FC<DocumentSheetProps> = ({
  type,
  document,
  quoteRefLabel,
}) => {
  const isInvoice = type === 'invoice';
  const invoice = isInvoice ? (document as Invoice) : null;
  const quotation = !isInvoice ? (document as Quotation) : null;

  const business = document.businessSnapshot;
  const client = document.clientSnapshot;

  const docTitle = isInvoice ? 'INVOICE' : 'QUOTATION';
  const docNumber = isInvoice
    ? invoice?.invoiceNumber || ''
    : quotation?.quotationNumber || '';

  const businessName = business.name?.trim() || 'Business Name';
  const businessTagline = business.tagline?.trim();
  const businessAddress = business.address?.trim();
  const businessLocation = [business.city, business.postalCode, business.country]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
  const businessContacts = [business.email, business.phone, business.website]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('  ·  ');
  const businessRegistrations = [
    business.taxNumber?.trim() && `Tax / VAT: ${business.taxNumber.trim()}`,
    business.registrationNumber?.trim() && `Reg No: ${business.registrationNumber.trim()}`,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const clientName = client.name?.trim() || 'Client';
  const clientCompany = client.companyName?.trim();
  const clientAddress = client.address?.trim();
  const clientLocality = [client.city, client.country]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
  const clientContacts = [client.email, client.phone]
    .map((part) => part?.trim())
    .filter(Boolean);
  const clientVat = client.vatNumber?.trim();

  const bank = business.bankDetails;
  const hasBankDetails = Boolean(
    bank &&
      (bank.bankName?.trim() ||
        bank.accountName?.trim() ||
        bank.accountNumber?.trim() ||
        bank.branchCode?.trim() ||
        bank.accountType?.trim() ||
        bank.swiftCode?.trim())
  );

  const trimmedNotes = document.notes?.trim();
  const trimmedTerms = document.terms?.trim();

  const resolvedQuoteRef = quoteRefLabel?.trim() || '';

  return (
    <article
      className="quote-document-container print-document-container bg-white text-slate-900 mx-auto font-sans"
      aria-label={`${isInvoice ? 'Invoice' : 'Quotation'} ${docNumber}`}
    >
      <div className="quote-top-rule" aria-hidden="true" />

      {/* Company Identity & Document Header */}
      <div className="quote-header">
        <div className="quote-company-block">
          <DocumentLogo business={business} maxWidth={112} maxHeight={52} />

          <div className="quote-company-info">
            <h1 className="quote-company-name">{businessName}</h1>
            {businessTagline && <p className="quote-company-tagline">{businessTagline}</p>}

            {(businessAddress || businessLocation || businessContacts || businessRegistrations) && (
              <div className="quote-company-meta">
                {businessAddress && <p>{businessAddress}</p>}
                {businessLocation && <p>{businessLocation}</p>}
                {businessContacts && <p>{businessContacts}</p>}
                {businessRegistrations && <p className="quote-company-reg">{businessRegistrations}</p>}
              </div>
            )}
          </div>
        </div>

        <div className="quote-doc-identity">
          <p className="quote-doc-title">{docTitle}</p>
          <p className="quote-doc-number">{docNumber}</p>

          <dl className="quote-doc-dates">
            <div className="quote-doc-date-row">
              <dt>Issue Date</dt>
              <dd>{formatDate(document.issueDate)}</dd>
            </div>
            <div className="quote-doc-date-row">
              <dt>{isInvoice ? 'Due Date' : 'Valid Until'}</dt>
              <dd>{formatDate(isInvoice ? invoice?.dueDate : quotation?.expiryDate)}</dd>
            </div>
            {isInvoice && resolvedQuoteRef && (
              <div className="quote-doc-date-row">
                <dt>Quote Ref</dt>
                <dd className="quote-mono">{resolvedQuoteRef}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* Client Information (Bill To) */}
      <section className="quote-bill-to" aria-label="Client Information">
        <h2 className="quote-section-kicker">Bill To</h2>
        <div className="quote-client-block">
          <p className="quote-client-name">{clientName}</p>
          {clientCompany && <p className="quote-client-company">{clientCompany}</p>}
          {clientAddress && <p className="quote-client-line">{clientAddress}</p>}
          {clientLocality && <p className="quote-client-line">{clientLocality}</p>}
          {clientContacts.length > 0 && (
            <p className="quote-client-line">{clientContacts.join('  ·  ')}</p>
          )}
          {clientVat && <p className="quote-client-vat">VAT No: {clientVat}</p>}
        </div>
      </section>

      {/* Line Items Table */}
      <section className="quote-items-section" aria-label="Document Line Items">
        <table className="quote-items-table stationery-table">
          <colgroup>
            <col className="quote-col-desc" />
            <col className="quote-col-qty" />
            <col className="quote-col-price" />
            <col className="quote-col-amount" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="text-left">Description</th>
              <th scope="col" className="text-right">Quantity</th>
              <th scope="col" className="text-right">Unit Price</th>
              <th scope="col" className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {document.items.map((item) => (
              <tr key={item.id}>
                <td className="quote-cell-desc">{item.description}</td>
                <td className="quote-cell-qty">{item.quantity}</td>
                <td className="quote-cell-money">
                  {formatCurrency(item.unitPrice, document.currency, document.currencySymbol)}
                </td>
                <td className="quote-cell-money quote-cell-amount">
                  {formatCurrency(item.total, document.currency, document.currencySymbol)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Financial Summary */}
      <section className="quote-financial-row" aria-label="Financial Summary">
        <div className="quote-totals-panel">
          <div className="quote-total-line">
            <span>Subtotal</span>
            <span className="quote-total-value">
              {formatCurrency(document.subtotal, document.currency, document.currencySymbol)}
            </span>
          </div>

          {document.discountAmount > 0 && (
            <div className="quote-total-line">
              <span>
                Discount{document.discountType === 'percentage' ? ` (${document.discountValue}%)` : ''}
              </span>
              <span className="quote-total-value">
                - {formatCurrency(document.discountAmount, document.currency, document.currencySymbol)}
              </span>
            </div>
          )}

          {document.taxAmount > 0 && (
            <div className="quote-total-line">
              <span>
                {document.taxName || 'Tax'} ({document.taxRate}%)
              </span>
              <span className="quote-total-value">
                {formatCurrency(document.taxAmount, document.currency, document.currencySymbol)}
              </span>
            </div>
          )}

          <div className="quote-total-line quote-grand-total-line">
            <span>{isInvoice ? 'Total' : 'Quoted Total'}</span>
            <span className="quote-grand-total-value">
              {formatCurrency(document.grandTotal, document.currency, document.currencySymbol)}
            </span>
          </div>

          {isInvoice && invoice && (
            <div className="quote-balance-section">
              <div className="quote-total-line">
                <span>Amount Paid</span>
                <span className="quote-total-value">
                  {formatCurrency(invoice.amountPaid || 0, document.currency, document.currencySymbol)}
                </span>
              </div>
              <div className="quote-total-line quote-balance-due-line">
                <span>Balance Due</span>
                <span className="quote-balance-due-value">
                  {formatCurrency(
                    invoice.outstandingBalance ?? invoice.grandTotal,
                    document.currency,
                    document.currencySymbol
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Payment Details, Notes & Terms */}
      {(hasBankDetails || trimmedNotes || trimmedTerms) && (
        <section className="quote-details-section" aria-label="Payment Details and Terms">
          {(hasBankDetails || trimmedNotes) && (
            <div
              className={`quote-payment-notes-grid ${
                hasBankDetails && trimmedNotes ? 'has-two-columns' : ''
              }`}
            >
              {hasBankDetails && bank && (
                <div className="quote-detail-block">
                  <h2 className="quote-section-kicker">Payment Details</h2>
                  <dl className="quote-bank-list">
                    {bank.bankName?.trim() && (
                      <div className="quote-bank-row">
                        <dt>Bank</dt>
                        <dd>{bank.bankName.trim()}</dd>
                      </div>
                    )}
                    {bank.accountName?.trim() && (
                      <div className="quote-bank-row">
                        <dt>Account Name</dt>
                        <dd>{bank.accountName.trim()}</dd>
                      </div>
                    )}
                    {bank.accountNumber?.trim() && (
                      <div className="quote-bank-row">
                        <dt>Account Number</dt>
                        <dd className="quote-mono">{bank.accountNumber.trim()}</dd>
                      </div>
                    )}
                    {bank.branchCode?.trim() && (
                      <div className="quote-bank-row">
                        <dt>Branch Code</dt>
                        <dd className="quote-mono">{bank.branchCode.trim()}</dd>
                      </div>
                    )}
                    {bank.accountType?.trim() && (
                      <div className="quote-bank-row">
                        <dt>Account Type</dt>
                        <dd>{bank.accountType.trim()}</dd>
                      </div>
                    )}
                    {bank.swiftCode?.trim() && (
                      <div className="quote-bank-row">
                        <dt>SWIFT / BIC</dt>
                        <dd className="quote-mono">{bank.swiftCode.trim()}</dd>
                      </div>
                    )}
                    {docNumber && (
                      <div className="quote-bank-row">
                        <dt>Reference</dt>
                        <dd className="quote-mono">{docNumber}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}

              {trimmedNotes && (
                <div className="quote-detail-block">
                  <h2 className="quote-section-kicker">Notes</h2>
                  <p className="quote-prose">{trimmedNotes}</p>
                </div>
              )}
            </div>
          )}

          {trimmedTerms && (
            <div
              className={`quote-terms-block ${
                hasBankDetails || trimmedNotes ? 'has-top-gap' : ''
              }`}
            >
              <h2 className="quote-section-kicker">Terms &amp; Conditions</h2>
              <p className="quote-prose">{trimmedTerms}</p>
            </div>
          )}
        </section>
      )}

      {/* Lower Signature & Footer Anchor */}
      <div className="quote-bottom-region">
        <section className="quote-signatures-grid" aria-label="Signatures">
          <div className="quote-signature-slot">
            <div className="quote-signature-rule" />
            <p className="quote-signature-label">Authorised Representative</p>
            <p className="quote-signature-sub">{businessName}</p>
          </div>

          <div className="quote-signature-slot">
            <div className="quote-signature-rule" />
            <p className="quote-signature-label">Client Acceptance / Signature</p>
            <p className="quote-signature-sub">
              {clientCompany ? `${clientName} · ${clientCompany}` : clientName}
            </p>
          </div>

          <div className="quote-signature-slot">
            <div className="quote-signature-rule" />
            <p className="quote-signature-label">Date</p>
            <p className="quote-signature-sub">DD / MM / YYYY</p>
          </div>
        </section>

        <div className="quote-stationery-footer">
          <span>{businessName}</span>
          {businessContacts && <span>{businessContacts}</span>}
        </div>
      </div>
    </article>
  );
};
