import React from 'react';
import type { Quotation } from '../../types';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { getLogoOptions } from '../../utils/logo';
import { DocumentLogo } from '../common/DocumentLogo';

interface QuotationPrintableDocumentProps {
  document: Quotation;
}

export const QuotationPrintableDocument: React.FC<QuotationPrintableDocumentProps> = ({ document }) => {
  const business = document.businessSnapshot;
  const client = document.clientSnapshot;
  const logo = getLogoOptions(business);

  const businessLocation = [business.city, business.postalCode, business.country].filter(Boolean).join(', ');
  const businessContacts = [business.email, business.phone, business.website].filter(Boolean).join('  ·  ');
  const businessRegistrations = [
    business.taxNumber && `Tax / VAT: ${business.taxNumber}`,
    business.registrationNumber && `Reg No: ${business.registrationNumber}`,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const clientLocality = [client.city, client.country].filter(Boolean).join(', ');
  const clientContacts = [client.email, client.phone].filter(Boolean);

  const bank = business.bankDetails;
  const hasBankDetails = Boolean(
    bank && (bank.bankName || bank.accountName || bank.accountNumber || bank.branchCode || bank.swiftCode)
  );

  const maxLogoWidth = Math.min(Math.max(logo.size, 44), 116);

  return (
    <article
      className="quote-document-container print-document-container bg-white text-slate-900 mx-auto font-sans"
      aria-label={`Quotation ${document.quotationNumber}`}
    >
      <div className="quote-top-rule" aria-hidden="true" />

      {/* Company Identity & Document Header */}
      <div className="quote-header">
        <div className="quote-company-block">
          <DocumentLogo business={business} maxWidth={maxLogoWidth} maxHeight={52} />

          <div className="quote-company-info">
            <h1 className="quote-company-name">{business.name}</h1>
            {business.tagline && <p className="quote-company-tagline">{business.tagline}</p>}

            <div className="quote-company-meta">
              {business.address && <p>{business.address}</p>}
              {businessLocation && <p>{businessLocation}</p>}
              {businessContacts && <p>{businessContacts}</p>}
              {businessRegistrations && <p className="quote-company-reg">{businessRegistrations}</p>}
            </div>
          </div>
        </div>

        <div className="quote-doc-identity">
          <p className="quote-doc-title">QUOTATION</p>
          <p className="quote-doc-number">{document.quotationNumber}</p>

          <dl className="quote-doc-dates">
            <div className="quote-doc-date-row">
              <dt>Issue Date</dt>
              <dd>{formatDate(document.issueDate)}</dd>
            </div>
            <div className="quote-doc-date-row">
              <dt>Valid Until</dt>
              <dd>{formatDate(document.expiryDate)}</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Client Information (Bill To) */}
      <section className="quote-bill-to" aria-label="Client Information">
        <h2 className="quote-section-kicker">Bill To</h2>
        <div className="quote-client-block">
          <p className="quote-client-name">{client.name}</p>
          {client.companyName && <p className="quote-client-company">{client.companyName}</p>}
          {client.address && <p className="quote-client-line">{client.address}</p>}
          {clientLocality && <p className="quote-client-line">{clientLocality}</p>}
          {clientContacts.length > 0 && (
            <p className="quote-client-line">{clientContacts.join('  ·  ')}</p>
          )}
          {client.vatNumber && <p className="quote-client-vat">VAT No: {client.vatNumber}</p>}
        </div>
      </section>

      {/* Quotation Items Table */}
      <section className="quote-items-section" aria-label="Quotation Line Items">
        <table className="quote-items-table">
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
            <span>Total Amount Due</span>
            <span className="quote-grand-total-value">
              {formatCurrency(document.grandTotal, document.currency, document.currencySymbol)}
            </span>
          </div>
        </div>
      </section>

      {/* Payment Details, Notes & Terms */}
      {(hasBankDetails || document.notes || document.terms) && (
        <section className="quote-details-section" aria-label="Payment Details and Terms">
          {(hasBankDetails || document.notes) && (
            <div
              className={`quote-payment-notes-grid ${
                hasBankDetails && document.notes ? 'has-two-columns' : ''
              }`}
            >
              {hasBankDetails && bank && (
                <div className="quote-detail-block">
                  <h2 className="quote-section-kicker">Payment Details</h2>
                  <dl className="quote-bank-list">
                    {bank.bankName && (
                      <div className="quote-bank-row">
                        <dt>Bank</dt>
                        <dd>{bank.bankName}</dd>
                      </div>
                    )}
                    {bank.accountName && (
                      <div className="quote-bank-row">
                        <dt>Account Name</dt>
                        <dd>{bank.accountName}</dd>
                      </div>
                    )}
                    {bank.accountNumber && (
                      <div className="quote-bank-row">
                        <dt>Account Number</dt>
                        <dd className="quote-mono">{bank.accountNumber}</dd>
                      </div>
                    )}
                    {bank.branchCode && (
                      <div className="quote-bank-row">
                        <dt>Branch Code</dt>
                        <dd className="quote-mono">{bank.branchCode}</dd>
                      </div>
                    )}
                    {bank.accountType && (
                      <div className="quote-bank-row">
                        <dt>Account Type</dt>
                        <dd>{bank.accountType}</dd>
                      </div>
                    )}
                    {bank.swiftCode && (
                      <div className="quote-bank-row">
                        <dt>SWIFT / BIC</dt>
                        <dd className="quote-mono">{bank.swiftCode}</dd>
                      </div>
                    )}
                    <div className="quote-bank-row">
                      <dt>Reference</dt>
                      <dd className="quote-mono">{document.quotationNumber}</dd>
                    </div>
                  </dl>
                </div>
              )}

              {document.notes && (
                <div className="quote-detail-block">
                  <h2 className="quote-section-kicker">Notes</h2>
                  <p className="quote-prose">{document.notes}</p>
                </div>
              )}
            </div>
          )}

          {document.terms && (
            <div className={`quote-terms-block ${hasBankDetails || document.notes ? 'has-top-gap' : ''}`}>
              <h2 className="quote-section-kicker">Terms &amp; Conditions</h2>
              <p className="quote-prose">{document.terms}</p>
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
            <p className="quote-signature-sub">{business.name}</p>
          </div>

          <div className="quote-signature-slot">
            <div className="quote-signature-rule" />
            <p className="quote-signature-label">Client Acceptance / Signature</p>
            <p className="quote-signature-sub">
              {client.companyName ? `${client.name} · ${client.companyName}` : client.name}
            </p>
          </div>

          <div className="quote-signature-slot">
            <div className="quote-signature-rule" />
            <p className="quote-signature-label">Date</p>
            <p className="quote-signature-sub">DD / MM / YYYY</p>
          </div>
        </section>

        <div className="quote-stationery-footer">
          <span>{business.name}</span>
          {(business.email || business.phone || business.website) && (
            <span>
              {[business.email, business.phone, business.website].filter(Boolean).join('  ·  ')}
            </span>
          )}
        </div>
      </div>
    </article>
  );
};
