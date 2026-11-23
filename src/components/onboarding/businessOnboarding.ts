import type { BusinessProfile, CurrencyCode } from '../../types';
import { generateId } from '../../utils/idGenerator';

export interface OnboardingCurrencyOption {
  value: CurrencyCode;
  symbol: string;
  label: string;
}

export const ONBOARDING_CURRENCY_OPTIONS: OnboardingCurrencyOption[] = [
  { value: 'NAD', symbol: 'N$', label: 'Namibian Dollar (NAD - N$)' },
  { value: 'ZAR', symbol: 'R', label: 'South African Rand (ZAR - R)' },
  { value: 'USD', symbol: '$', label: 'US Dollar (USD - $)' },
  { value: 'EUR', symbol: '€', label: 'Euro (EUR - €)' },
  { value: 'GBP', symbol: '£', label: 'British Pound (GBP - £)' },
];

const CURRENCY_SYMBOL_MAP: Record<CurrencyCode, string> = {
  NAD: 'N$',
  ZAR: 'R',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

export function getCurrencySymbol(currency: CurrencyCode): string {
  return CURRENCY_SYMBOL_MAP[currency] ?? currency;
}

export interface OnboardingFormValues {
  name: string;
  ownerName: string;
  email: string;
  phone: string;
  address: string;
  logoUrl: string;
  defaultCurrency: CurrencyCode;
}

export function createInitialOnboardingValues(ownerFullName?: string | null): OnboardingFormValues {
  return {
    name: '',
    ownerName: (ownerFullName ?? '').trim(),
    email: '',
    phone: '',
    address: '',
    logoUrl: '',
    defaultCurrency: 'NAD',
  };
}

export interface OnboardingValidationErrors {
  name?: string;
  email?: string;
}

export type OnboardingValidationResult =
  | { ok: true; fieldErrors: OnboardingValidationErrors }
  | { ok: false; fieldErrors: OnboardingValidationErrors; message: string };

const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateBusinessOnboarding(values: OnboardingFormValues): OnboardingValidationResult {
  const fieldErrors: OnboardingValidationErrors = {};

  if (!values.name.trim()) {
    fieldErrors.name = 'Business name is required.';
  }

  const trimmedEmail = values.email.trim();
  if (trimmedEmail && !BASIC_EMAIL_PATTERN.test(trimmedEmail)) {
    fieldErrors.email = 'Enter a valid email address or leave this blank.';
  }

  if (fieldErrors.name || fieldErrors.email) {
    return {
      ok: false,
      fieldErrors,
      message: fieldErrors.name ?? fieldErrors.email ?? 'Please check your business details.',
    };
  }

  return { ok: true, fieldErrors };
}

export function createEmptyBusinessProfileDraft(nowIso: string = new Date().toISOString()): BusinessProfile {
  return {
    id: '',
    name: '',
    ownerName: undefined,
    tagline: '',
    logoUrl: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: '',
    postalCode: '',
    website: '',
    taxNumber: '',
    registrationNumber: '',
    defaultCurrency: 'NAD',
    currencySymbol: 'N$',
    defaultTaxName: 'VAT',
    defaultTaxRate: 15,
    isTaxEnabled: true,
    quotePrefix: 'QUO-',
    invoicePrefix: 'INV-',
    nextQuoteNumber: 1,
    nextInvoiceNumber: 1,
    defaultTermsQuotation: 'This quotation is valid for 30 calendar days from issue date.',
    defaultTermsInvoice:
      'Payment is due within 14 days of invoice date. Please use the invoice number as payment reference.',
    defaultNotes: 'Thank you for your business.',
    bankDetails: {
      bankName: '',
      accountName: '',
      accountNumber: '',
      branchCode: '',
      accountType: '',
      swiftCode: '',
    },
    updatedAt: nowIso,
  };
}

export function buildNewBusinessProfile(
  values: OnboardingFormValues,
  options?: { id?: string; nowIso?: string }
): BusinessProfile {
  const validation = validateBusinessOnboarding(values);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const nowIso = options?.nowIso ?? new Date().toISOString();
  const currency = values.defaultCurrency || 'NAD';
  const trimmedOwner = values.ownerName.trim();

  return {
    ...createEmptyBusinessProfileDraft(nowIso),
    id: options?.id?.trim() || generateId('biz'),
    name: values.name.trim(),
    ownerName: trimmedOwner || undefined,
    logoUrl: values.logoUrl.trim(),
    email: values.email.trim(),
    phone: values.phone.trim(),
    address: values.address.trim(),
    defaultCurrency: currency,
    currencySymbol: getCurrencySymbol(currency),
    updatedAt: nowIso,
  };
}

export type WorkspaceScreenView = 'loading' | 'blocked' | 'onboarding' | 'workspace';

export function resolveWorkspaceScreenView(params: {
  isWorkspaceLoading: boolean;
  hasStartupBlock: boolean;
  needsBusinessSetup: boolean;
}): WorkspaceScreenView {
  if (params.isWorkspaceLoading) {
    return 'loading';
  }
  if (params.hasStartupBlock) {
    return 'blocked';
  }
  if (params.needsBusinessSetup) {
    return 'onboarding';
  }
  return 'workspace';
}
