import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNewBusinessProfile,
  createEmptyBusinessProfileDraft,
  createInitialOnboardingValues,
  getCurrencySymbol,
  resolveWorkspaceScreenView,
  validateBusinessOnboarding,
} from './businessOnboarding';

test('onboarding defaults currency to NAD and resolves supported currency symbols', () => {
  const defaults = createInitialOnboardingValues('  Elena Shikongo  ');
  assert.equal(defaults.defaultCurrency, 'NAD');
  assert.equal(defaults.ownerName, 'Elena Shikongo');
  assert.equal(defaults.name, '');

  assert.equal(getCurrencySymbol('NAD'), 'N$');
  assert.equal(getCurrencySymbol('ZAR'), 'R');
  assert.equal(getCurrencySymbol('USD'), '$');
  assert.equal(getCurrencySymbol('EUR'), '€');
  assert.equal(getCurrencySymbol('GBP'), '£');
});

test('validateBusinessOnboarding enforces required business name and allows skipping optional fields', () => {
  const emptyName = validateBusinessOnboarding({
    name: '   ',
    ownerName: '',
    email: '',
    phone: '',
    address: '',
    logoUrl: '',
    defaultCurrency: 'NAD',
  });
  assert.equal(emptyName.ok, false);
  if (!emptyName.ok) {
    assert.equal(emptyName.fieldErrors.name, 'Business name is required.');
  }

  const invalidEmail = validateBusinessOnboarding({
    name: 'Namib Builders',
    ownerName: '',
    email: 'invalid-email',
    phone: '',
    address: '',
    logoUrl: '',
    defaultCurrency: 'NAD',
  });
  assert.equal(invalidEmail.ok, false);
  if (!invalidEmail.ok) {
    assert.equal(invalidEmail.fieldErrors.email, 'Enter a valid email address or leave this blank.');
  }

  const minimalValid = validateBusinessOnboarding({
    name: 'Namib Builders',
    ownerName: '',
    email: '',
    phone: '',
    address: '',
    logoUrl: '',
    defaultCurrency: 'NAD',
  });
  assert.equal(minimalValid.ok, true);
});

test('buildNewBusinessProfile builds clean starter profile with NAD defaults and trims fields', () => {
  const profile = buildNewBusinessProfile(
    {
      name: '  Erongo Logistics CC  ',
      ownerName: '  Johannes Amupanda  ',
      email: '  accounts@erongo.na  ',
      phone: '  +264 64 200 100  ',
      address: '  12 Sam Nujoma Ave, Walvis Bay  ',
      logoUrl: 'data:image/png;base64,abc123',
      defaultCurrency: 'NAD',
    },
    { id: 'biz_test_1', nowIso: '2026-11-23T09:00:00.000Z' }
  );

  assert.equal(profile.id, 'biz_test_1');
  assert.equal(profile.name, 'Erongo Logistics CC');
  assert.equal(profile.ownerName, 'Johannes Amupanda');
  assert.equal(profile.email, 'accounts@erongo.na');
  assert.equal(profile.phone, '+264 64 200 100');
  assert.equal(profile.address, '12 Sam Nujoma Ave, Walvis Bay');
  assert.equal(profile.logoUrl, 'data:image/png;base64,abc123');
  assert.equal(profile.defaultCurrency, 'NAD');
  assert.equal(profile.currencySymbol, 'N$');
  assert.equal(profile.nextQuoteNumber, 1);
  assert.equal(profile.nextInvoiceNumber, 1);
  assert.equal(profile.updatedAt, '2026-11-23T09:00:00.000Z');

  const skippedOptionals = buildNewBusinessProfile(
    {
      name: 'Solo Studio',
      ownerName: '   ',
      email: '',
      phone: '',
      address: '',
      logoUrl: '',
      defaultCurrency: 'ZAR',
    },
    { id: 'biz_test_2', nowIso: '2026-11-23T09:00:00.000Z' }
  );
  assert.equal(skippedOptionals.ownerName, undefined);
  assert.equal(skippedOptionals.defaultCurrency, 'ZAR');
  assert.equal(skippedOptionals.currencySymbol, 'R');
});

test('createEmptyBusinessProfileDraft never leaks demo seed branding', () => {
  const draft = createEmptyBusinessProfileDraft('2026-11-23T09:00:00.000Z');
  assert.equal(draft.name, '');
  assert.equal(draft.defaultCurrency, 'NAD');
  assert.equal(draft.currencySymbol, 'N$');
});

test('resolveWorkspaceScreenView transitions cleanly between loading, blocked, onboarding, and workspace', () => {
  assert.equal(
    resolveWorkspaceScreenView({
      isWorkspaceLoading: true,
      hasStartupBlock: false,
      needsBusinessSetup: true,
    }),
    'loading'
  );
  assert.equal(
    resolveWorkspaceScreenView({
      isWorkspaceLoading: false,
      hasStartupBlock: true,
      needsBusinessSetup: true,
    }),
    'blocked'
  );
  assert.equal(
    resolveWorkspaceScreenView({
      isWorkspaceLoading: false,
      hasStartupBlock: false,
      needsBusinessSetup: true,
    }),
    'onboarding'
  );
  assert.equal(
    resolveWorkspaceScreenView({
      isWorkspaceLoading: false,
      hasStartupBlock: false,
      needsBusinessSetup: false,
    }),
    'workspace'
  );
});
