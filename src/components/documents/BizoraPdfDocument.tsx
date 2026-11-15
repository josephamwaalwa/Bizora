import React from 'react';
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer';
import type { Invoice, Quotation } from '../../types';
import { formatCurrency, formatDate } from '../../utils/formatters';

export interface PreparedPdfLogo {
  src: string;
  width?: number;
  height?: number;
}

export interface BizoraPdfDocumentProps {
  type: 'quote' | 'invoice';
  document: Quotation | Invoice;
  quoteRefLabel?: string;
  preparedLogo?: PreparedPdfLogo;
}

const styles = StyleSheet.create({
  page: {
    flexDirection: 'column',
    paddingTop: 36,
    paddingBottom: 30,
    paddingHorizontal: 42,
    backgroundColor: '#ffffff',
    color: '#1e293b',
    fontFamily: 'Geist',
    fontSize: 8.2,
    lineHeight: 1.4,
  },
  topRule: {
    width: '100%',
    height: 2,
    backgroundColor: '#0f172a',
    marginBottom: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 18,
    paddingBottom: 12,
    borderBottomWidth: 0.75,
    borderBottomColor: '#cbd5e1',
  },
  companyBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    flex: 1,
  },
  logoWrapper: {
    flexShrink: 0,
    paddingTop: 1,
  },
  logoImage: {
    objectFit: 'contain',
  },
  companyInfo: {
    flex: 1,
  },
  companyName: {
    color: '#0f172a',
    fontSize: 13.8,
    fontWeight: 600,
    lineHeight: 1.2,
    letterSpacing: -0.2,
  },
  companyTagline: {
    marginTop: 2,
    color: '#64748b',
    fontSize: 7.6,
    lineHeight: 1.35,
  },
  companyMeta: {
    marginTop: 5,
    color: '#475569',
    fontSize: 7.6,
    lineHeight: 1.4,
  },
  companyReg: {
    marginTop: 2,
    color: '#64748b',
    fontSize: 7.2,
    lineHeight: 1.35,
  },
  docIdentity: {
    minWidth: 142,
    alignItems: 'flex-end',
  },
  docTitle: {
    color: '#0f172a',
    fontSize: 17.5,
    fontWeight: 700,
    lineHeight: 1.05,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  docNumber: {
    marginTop: 3.5,
    marginBottom: 8,
    color: '#0f172a',
    fontFamily: 'GeistMono',
    fontSize: 9,
    fontWeight: 600,
  },
  docDates: {
    alignItems: 'flex-end',
    gap: 3,
  },
  docDateRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'baseline',
    gap: 10,
    fontSize: 7.6,
  },
  docDateLabel: {
    color: '#64748b',
    fontWeight: 500,
  },
  docDateValue: {
    minWidth: 60,
    textAlign: 'right',
    color: '#0f172a',
    fontWeight: 500,
  },
  docDateValueMono: {
    minWidth: 60,
    textAlign: 'right',
    color: '#0f172a',
    fontFamily: 'GeistMono',
    fontWeight: 500,
  },
  sectionKicker: {
    marginBottom: 4,
    color: '#64748b',
    fontSize: 6.9,
    fontWeight: 600,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  billTo: {
    paddingTop: 11,
    paddingBottom: 12,
  },
  clientName: {
    color: '#0f172a',
    fontSize: 9,
    fontWeight: 600,
    lineHeight: 1.35,
  },
  clientCompany: {
    marginTop: 1,
    color: '#1e293b',
    fontSize: 8.3,
    fontWeight: 500,
    lineHeight: 1.35,
  },
  clientLine: {
    marginTop: 1.5,
    color: '#475569',
    fontSize: 7.9,
    lineHeight: 1.4,
  },
  clientVat: {
    marginTop: 2,
    color: '#64748b',
    fontSize: 7.2,
    lineHeight: 1.35,
  },
  tableHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1.2,
    borderTopColor: '#0f172a',
    borderBottomWidth: 0.8,
    borderBottomColor: '#0f172a',
    paddingVertical: 5.5,
  },
  tableHeaderCell: {
    color: '#334155',
    fontSize: 6.9,
    fontWeight: 600,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: 0.6,
    borderBottomColor: '#e2e8f0',
    paddingVertical: 6.5,
  },
  colDesc: {
    width: '52%',
    paddingRight: 8,
  },
  colQty: {
    width: '12%',
    paddingHorizontal: 6,
    textAlign: 'right',
  },
  colPrice: {
    width: '18%',
    paddingHorizontal: 6,
    textAlign: 'right',
  },
  colAmount: {
    width: '18%',
    paddingLeft: 6,
    textAlign: 'right',
  },
  cellDesc: {
    color: '#0f172a',
    fontSize: 8.2,
    lineHeight: 1.4,
  },
  cellQty: {
    color: '#334155',
    fontSize: 8.2,
    lineHeight: 1.4,
    textAlign: 'right',
  },
  cellMoney: {
    color: '#334155',
    fontSize: 8.2,
    lineHeight: 1.4,
    textAlign: 'right',
  },
  cellAmount: {
    color: '#0f172a',
    fontSize: 8.2,
    fontWeight: 600,
    lineHeight: 1.4,
    textAlign: 'right',
  },
  financialRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingTop: 10,
  },
  totalsPanel: {
    width: 194,
  },
  totalLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 2.8,
    fontSize: 8.2,
    color: '#475569',
  },
  totalValue: {
    color: '#1e293b',
    fontWeight: 500,
    textAlign: 'right',
  },
  grandTotalLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 5,
    paddingVertical: 6,
    borderTopWidth: 0.8,
    borderTopColor: '#0f172a',
    borderBottomWidth: 1.5,
    borderBottomColor: '#0f172a',
    color: '#0f172a',
    fontSize: 8.6,
    fontWeight: 600,
    letterSpacing: 0.25,
    textTransform: 'uppercase',
  },
  grandTotalValue: {
    color: '#0f172a',
    fontSize: 10.6,
    fontWeight: 700,
    textAlign: 'right',
  },
  balanceSection: {
    marginTop: 4,
  },
  balanceDueLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 2.5,
    paddingTop: 4.5,
    borderTopWidth: 0.75,
    borderTopColor: '#cbd5e1',
    color: '#0f172a',
    fontSize: 8.6,
    fontWeight: 600,
  },
  balanceDueValue: {
    color: '#0f172a',
    fontSize: 9.8,
    fontWeight: 700,
    textAlign: 'right',
  },
  detailsSection: {
    marginTop: 14,
    paddingTop: 10,
    borderTopWidth: 0.75,
    borderTopColor: '#e2e8f0',
  },
  paymentNotesRow: {
    flexDirection: 'row',
    gap: 22,
  },
  paymentCol: {
    flex: 1.15,
  },
  notesCol: {
    flex: 0.85,
  },
  singleCol: {
    flex: 1,
  },
  bankGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  bankItem: {
    width: '50%',
    paddingRight: 8,
    marginBottom: 4,
  },
  bankLabel: {
    color: '#64748b',
    fontSize: 6.9,
    fontWeight: 500,
    lineHeight: 1.25,
  },
  bankValue: {
    marginTop: 0.5,
    color: '#0f172a',
    fontSize: 7.6,
    fontWeight: 500,
    lineHeight: 1.3,
  },
  bankValueMono: {
    marginTop: 0.5,
    color: '#0f172a',
    fontFamily: 'GeistMono',
    fontSize: 7.6,
    fontWeight: 500,
    lineHeight: 1.3,
  },
  prose: {
    color: '#475569',
    fontSize: 7.6,
    lineHeight: 1.45,
  },
  termsBlockWithGap: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 0.75,
    borderTopColor: '#f1f5f9',
  },
  bottomRegion: {
    marginTop: 'auto',
    paddingTop: 16,
  },
  signaturesRow: {
    flexDirection: 'row',
    gap: 18,
    paddingTop: 4,
  },
  sigSlotPrimary: {
    flex: 1.2,
  },
  sigSlotDate: {
    flex: 0.75,
  },
  sigRule: {
    height: 18,
    borderBottomWidth: 0.75,
    borderBottomColor: '#94a3b8',
    marginBottom: 4,
  },
  sigLabel: {
    color: '#0f172a',
    fontSize: 7.3,
    fontWeight: 600,
    lineHeight: 1.3,
  },
  sigSub: {
    marginTop: 1,
    color: '#64748b',
    fontSize: 6.9,
    lineHeight: 1.3,
  },
  stationeryFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginTop: 11,
    paddingTop: 6,
    borderTopWidth: 0.75,
    borderTopColor: '#e2e8f0',
    color: '#94a3b8',
    fontSize: 6.9,
  },
});

export const BizoraPdfDocument: React.FC<BizoraPdfDocumentProps> = ({
  type,
  document,
  quoteRefLabel,
  preparedLogo,
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
  const bankEntries: Array<{ label: string; value: string; mono?: boolean }> = [];
  if (bank?.bankName?.trim()) bankEntries.push({ label: 'Bank', value: bank.bankName.trim() });
  if (bank?.accountName?.trim()) bankEntries.push({ label: 'Account Name', value: bank.accountName.trim() });
  if (bank?.accountNumber?.trim()) {
    bankEntries.push({ label: 'Account Number', value: bank.accountNumber.trim(), mono: true });
  }
  if (bank?.branchCode?.trim()) {
    bankEntries.push({ label: 'Branch Code', value: bank.branchCode.trim(), mono: true });
  }
  if (bank?.accountType?.trim()) bankEntries.push({ label: 'Account Type', value: bank.accountType.trim() });
  if (bank?.swiftCode?.trim()) {
    bankEntries.push({ label: 'SWIFT / BIC', value: bank.swiftCode.trim(), mono: true });
  }
  const hasBankDetails = bankEntries.length > 0;
  if (hasBankDetails && docNumber) {
    bankEntries.push({ label: 'Reference', value: docNumber, mono: true });
  }

  const trimmedNotes = document.notes?.trim();
  const trimmedTerms = document.terms?.trim();
  const resolvedQuoteRef = quoteRefLabel?.trim() || '';

  return (
    <Document
      title={`${docTitle} ${docNumber}`.trim()}
      author={businessName}
      creator={businessName}
    >
      <Page size="A4" wrap style={styles.page}>
        <View style={styles.topRule} />

        {/* Company Identity & Document Header */}
        <View style={styles.header}>
          <View style={styles.companyBlock}>
            {preparedLogo && (
              <View style={styles.logoWrapper}>
                <Image
                  src={preparedLogo.src}
                  style={{
                    ...styles.logoImage,
                    ...(preparedLogo.width ? { width: preparedLogo.width } : { maxWidth: 87 }),
                    ...(preparedLogo.height ? { height: preparedLogo.height } : { maxHeight: 39 }),
                  }}
                />
              </View>
            )}

            <View style={styles.companyInfo}>
              <Text style={styles.companyName}>{businessName}</Text>
              {businessTagline && <Text style={styles.companyTagline}>{businessTagline}</Text>}

              {(businessAddress || businessLocation || businessContacts || businessRegistrations) && (
                <View style={styles.companyMeta}>
                  {businessAddress && <Text>{businessAddress}</Text>}
                  {businessLocation && <Text>{businessLocation}</Text>}
                  {businessContacts && <Text>{businessContacts}</Text>}
                  {businessRegistrations && <Text style={styles.companyReg}>{businessRegistrations}</Text>}
                </View>
              )}
            </View>
          </View>

          <View style={styles.docIdentity}>
            <Text style={styles.docTitle}>{docTitle}</Text>
            <Text style={styles.docNumber}>{docNumber}</Text>

            <View style={styles.docDates}>
              <View style={styles.docDateRow}>
                <Text style={styles.docDateLabel}>Issue Date</Text>
                <Text style={styles.docDateValue}>{formatDate(document.issueDate)}</Text>
              </View>
              <View style={styles.docDateRow}>
                <Text style={styles.docDateLabel}>{isInvoice ? 'Due Date' : 'Valid Until'}</Text>
                <Text style={styles.docDateValue}>
                  {formatDate(isInvoice ? invoice?.dueDate : quotation?.expiryDate)}
                </Text>
              </View>
              {isInvoice && resolvedQuoteRef && (
                <View style={styles.docDateRow}>
                  <Text style={styles.docDateLabel}>Quote Ref</Text>
                  <Text style={styles.docDateValueMono}>{resolvedQuoteRef}</Text>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Client Information */}
        <View style={styles.billTo}>
          <Text style={styles.sectionKicker}>Bill To</Text>
          <Text style={styles.clientName}>{clientName}</Text>
          {clientCompany && <Text style={styles.clientCompany}>{clientCompany}</Text>}
          {clientAddress && <Text style={styles.clientLine}>{clientAddress}</Text>}
          {clientLocality && <Text style={styles.clientLine}>{clientLocality}</Text>}
          {clientContacts.length > 0 && (
            <Text style={styles.clientLine}>{clientContacts.join('  ·  ')}</Text>
          )}
          {clientVat && <Text style={styles.clientVat}>VAT No: {clientVat}</Text>}
        </View>

        {/* Line Items Table Header (repeats on continuation pages) */}
        <View fixed style={styles.tableHeaderRow}>
          <Text style={[styles.tableHeaderCell, styles.colDesc]}>Description</Text>
          <Text style={[styles.tableHeaderCell, styles.colQty]}>Quantity</Text>
          <Text style={[styles.tableHeaderCell, styles.colPrice]}>Unit Price</Text>
          <Text style={[styles.tableHeaderCell, styles.colAmount]}>Amount</Text>
        </View>

        {/* Line Items */}
        {document.items.map((item) => (
          <View key={item.id} wrap={false} style={styles.tableRow}>
            <Text style={[styles.cellDesc, styles.colDesc]}>{item.description}</Text>
            <Text style={[styles.cellQty, styles.colQty]}>{String(item.quantity)}</Text>
            <Text style={[styles.cellMoney, styles.colPrice]}>
              {formatCurrency(item.unitPrice, document.currency, document.currencySymbol)}
            </Text>
            <Text style={[styles.cellAmount, styles.colAmount]}>
              {formatCurrency(item.total, document.currency, document.currencySymbol)}
            </Text>
          </View>
        ))}

        {/* Financial Summary */}
        <View wrap={false} style={styles.financialRow}>
          <View style={styles.totalsPanel}>
            <View style={styles.totalLine}>
              <Text>Subtotal</Text>
              <Text style={styles.totalValue}>
                {formatCurrency(document.subtotal, document.currency, document.currencySymbol)}
              </Text>
            </View>

            {document.discountAmount > 0 && (
              <View style={styles.totalLine}>
                <Text>
                  Discount{document.discountType === 'percentage' ? ` (${document.discountValue}%)` : ''}
                </Text>
                <Text style={styles.totalValue}>
                  - {formatCurrency(document.discountAmount, document.currency, document.currencySymbol)}
                </Text>
              </View>
            )}

            {document.taxAmount > 0 && (
              <View style={styles.totalLine}>
                <Text>
                  {document.taxName || 'Tax'} ({document.taxRate}%)
                </Text>
                <Text style={styles.totalValue}>
                  {formatCurrency(document.taxAmount, document.currency, document.currencySymbol)}
                </Text>
              </View>
            )}

            <View style={styles.grandTotalLine}>
              <Text>{isInvoice ? 'Total' : 'Total Amount Due'}</Text>
              <Text style={styles.grandTotalValue}>
                {formatCurrency(document.grandTotal, document.currency, document.currencySymbol)}
              </Text>
            </View>

            {isInvoice && invoice && (
              <View style={styles.balanceSection}>
                <View style={styles.totalLine}>
                  <Text>Amount Paid</Text>
                  <Text style={styles.totalValue}>
                    {formatCurrency(invoice.amountPaid || 0, document.currency, document.currencySymbol)}
                  </Text>
                </View>
                <View style={styles.balanceDueLine}>
                  <Text>Balance Due</Text>
                  <Text style={styles.balanceDueValue}>
                    {formatCurrency(
                      invoice.outstandingBalance ?? invoice.grandTotal,
                      document.currency,
                      document.currencySymbol
                    )}
                  </Text>
                </View>
              </View>
            )}
          </View>
        </View>

        {/* Payment Details, Notes & Terms */}
        {(hasBankDetails || trimmedNotes || trimmedTerms) && (
          <View style={styles.detailsSection}>
            {(hasBankDetails || trimmedNotes) && (
              <View wrap={false} style={styles.paymentNotesRow}>
                {hasBankDetails && (
                  <View style={trimmedNotes ? styles.paymentCol : styles.singleCol}>
                    <Text style={styles.sectionKicker}>Payment Details</Text>
                    <View style={styles.bankGrid}>
                      {bankEntries.map((entry) => (
                        <View key={entry.label} style={styles.bankItem}>
                          <Text style={styles.bankLabel}>{entry.label}</Text>
                          <Text style={entry.mono ? styles.bankValueMono : styles.bankValue}>
                            {entry.value}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}

                {trimmedNotes && (
                  <View style={hasBankDetails ? styles.notesCol : styles.singleCol}>
                    <Text style={styles.sectionKicker}>Notes</Text>
                    <Text style={styles.prose}>{trimmedNotes}</Text>
                  </View>
                )}
              </View>
            )}

            {trimmedTerms && (
              <View
                wrap={false}
                style={hasBankDetails || trimmedNotes ? styles.termsBlockWithGap : undefined}
              >
                <Text style={styles.sectionKicker}>Terms & Conditions</Text>
                <Text style={styles.prose}>{trimmedTerms}</Text>
              </View>
            )}
          </View>
        )}

        {/* Signature Block & Stationery Footer */}
        <View wrap={false} style={styles.bottomRegion}>
          <View style={styles.signaturesRow}>
            <View style={styles.sigSlotPrimary}>
              <View style={styles.sigRule} />
              <Text style={styles.sigLabel}>Authorised Representative</Text>
              <Text style={styles.sigSub}>{businessName}</Text>
            </View>

            <View style={styles.sigSlotPrimary}>
              <View style={styles.sigRule} />
              <Text style={styles.sigLabel}>Client Acceptance / Signature</Text>
              <Text style={styles.sigSub}>
                {clientCompany ? `${clientName} · ${clientCompany}` : clientName}
              </Text>
            </View>

            <View style={styles.sigSlotDate}>
              <View style={styles.sigRule} />
              <Text style={styles.sigLabel}>Date</Text>
              <Text style={styles.sigSub}>DD / MM / YYYY</Text>
            </View>
          </View>

          <View style={styles.stationeryFooter}>
            <Text>{businessName}</Text>
            {businessContacts && <Text>{businessContacts}</Text>}
          </View>
        </View>
      </Page>
    </Document>
  );
};
