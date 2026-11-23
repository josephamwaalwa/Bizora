import React, { useRef, useState } from 'react';
import { AlertCircle, ArrowRight, LogOut, Trash2, Upload } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useCloudAuth } from '../../hooks/useCloudAuth';
import type { CurrencyCode } from '../../types';
import { BusinessAvatar } from '../common/BusinessAvatar';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import {
  createInitialOnboardingValues,
  ONBOARDING_CURRENCY_OPTIONS,
  validateBusinessOnboarding,
  type OnboardingFormValues,
  type OnboardingValidationErrors,
} from './businessOnboarding';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export const BusinessSetupScreen: React.FC = () => {
  const { completeBusinessSetup, isSaving } = useApp();
  const { authState, signOut } = useCloudAuth();

  const [values, setValues] = useState<OnboardingFormValues>(() =>
    createInitialOnboardingValues(authState.session?.fullName)
  );
  const [fieldErrors, setFieldErrors] = useState<OnboardingValidationErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFieldChange = <K extends keyof OnboardingFormValues>(
    field: K,
    nextValue: OnboardingFormValues[K]
  ) => {
    setValues((prev) => ({ ...prev, [field]: nextValue }));
    if (field === 'name' && fieldErrors.name) {
      setFieldErrors((prev) => ({ ...prev, name: undefined }));
    }
    if (field === 'email' && fieldErrors.email) {
      setFieldErrors((prev) => ({ ...prev, email: undefined }));
    }
    if (formError) {
      setFormError(null);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLogoError(null);
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError('Please choose an image under 2MB.');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (result) {
        setValues((prev) => ({ ...prev, logoUrl: result }));
      }
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    setLogoError(null);
    setValues((prev) => ({ ...prev, logoUrl: '' }));
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;

    const validation = validateBusinessOnboarding(values);
    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      return;
    }

    setFieldErrors({});
    setFormError(null);

    const ok = await completeBusinessSetup(values);
    if (!ok) {
      setFormError('Could not save your business profile. Please try again.');
    }
  };

  return (
    <div
      data-testid="business-setup-screen"
      className="flex min-h-screen w-full items-center justify-center bg-paper px-5 py-10 text-ink sm:px-8"
    >
      <main className="w-full max-w-[600px]">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="Bizora" className="h-9 w-9 shrink-0" />
            <div>
              <span className="block text-[18px] font-semibold tracking-[-0.02em] text-ink leading-none">
                Bizora
              </span>
              <span className="mt-1 block text-[12px] text-ink-muted leading-none">
                Business Made Simpler
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 text-[13px] text-ink-secondary">
            {authState.session?.email && (
              <span className="hidden sm:inline truncate max-w-[220px]">
                {authState.session.email}
              </span>
            )}
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={isSaving}
              data-testid="onboarding-signout-button"
              className="inline-flex items-center gap-1.5 font-medium text-ink-secondary transition-colors hover:text-ink disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign out</span>
            </button>
          </div>
        </div>

        <div className="w-full border border-line bg-surface p-7 sm:p-9 shadow-subtle">
          <div className="mb-6 space-y-1.5">
            <span className="block text-[12px] font-medium uppercase tracking-wider text-ink-muted">
              Business Setup
            </span>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">
              Set up your business profile
            </h1>
            <p className="text-[14px] text-ink-secondary leading-relaxed">
              Add your business details for quotations and invoices. You can update everything later in Settings.
            </p>
          </div>

          {formError && (
            <div
              role="alert"
              data-testid="onboarding-error-banner"
              className="mb-5 flex items-start gap-2.5 border border-rose-200 bg-rose-50/70 px-3.5 py-2.5 text-[13px] text-rose-950 dark:border-rose-800/70 dark:bg-rose-950/40 dark:text-rose-200"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            {/* Optional Business Logo */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 border border-line bg-paper-sunken p-4">
              <div className="flex h-16 w-16 items-center justify-center shrink-0">
                <BusinessAvatar
                  name={values.name || 'Bizora'}
                  logoUrl={values.logoUrl}
                  size={64}
                  tone="light"
                />
              </div>

              <div className="flex-1 min-w-0 space-y-2">
                <div>
                  <span className="block text-[14px] font-medium text-ink">
                    Business logo <span className="text-[13px] font-normal text-ink-muted">(optional)</span>
                  </span>
                  <p className="text-[13px] text-ink-secondary">
                    PNG, JPG, or SVG under 2MB.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="hidden"
                    data-testid="onboarding-logo-input"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isSaving}
                    leftIcon={<Upload className="h-3.5 w-3.5" />}
                  >
                    {values.logoUrl ? 'Change Logo' : 'Upload Logo'}
                  </Button>
                  {values.logoUrl && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleRemoveLogo}
                      disabled={isSaving}
                      leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                    >
                      Remove
                    </Button>
                  )}
                </div>

                {logoError && (
                  <p className="text-[13px] font-medium text-[#8E3B32] dark:text-rose-400">
                    {logoError}
                  </p>
                )}
              </div>
            </div>

            <Input
              id="onboarding-business-name"
              label="Business name"
              type="text"
              value={values.name}
              onChange={(e) => handleFieldChange('name', e.target.value)}
              placeholder="e.g. Namib Creative Works"
              error={fieldErrors.name}
              autoFocus
              required
              disabled={isSaving}
              data-testid="onboarding-business-name"
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                id="onboarding-owner-name"
                label="Owner's full name"
                type="text"
                value={values.ownerName}
                onChange={(e) => handleFieldChange('ownerName', e.target.value)}
                placeholder="Optional"
                autoComplete="name"
                disabled={isSaving}
                data-testid="onboarding-owner-name"
              />

              <Select
                id="onboarding-currency"
                label="Currency"
                value={values.defaultCurrency}
                onChange={(e) =>
                  handleFieldChange('defaultCurrency', e.target.value as CurrencyCode)
                }
                options={ONBOARDING_CURRENCY_OPTIONS.map((opt) => ({
                  value: opt.value,
                  label: opt.label,
                }))}
                disabled={isSaving}
                data-testid="onboarding-currency"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                id="onboarding-business-email"
                label="Business email"
                type="email"
                value={values.email}
                onChange={(e) => handleFieldChange('email', e.target.value)}
                placeholder="hello@company.com (optional)"
                autoComplete="email"
                error={fieldErrors.email}
                disabled={isSaving}
                data-testid="onboarding-email"
              />

              <Input
                id="onboarding-business-phone"
                label="Phone number"
                type="tel"
                value={values.phone}
                onChange={(e) => handleFieldChange('phone', e.target.value)}
                placeholder="+264 61 000 0000 (optional)"
                autoComplete="tel"
                disabled={isSaving}
                data-testid="onboarding-phone"
              />
            </div>

            <Input
              id="onboarding-business-address"
              label="Business address"
              type="text"
              value={values.address}
              onChange={(e) => handleFieldChange('address', e.target.value)}
              placeholder="Street address, city (optional)"
              autoComplete="street-address"
              disabled={isSaving}
              data-testid="onboarding-address"
            />

            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-line pt-5">
              <p className="text-[13px] text-ink-secondary">
                Optional fields can be skipped and filled in later.
              </p>
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={isSaving}
                isLoading={isSaving}
                rightIcon={<ArrowRight className="h-4 w-4" />}
                data-testid="onboarding-submit-button"
              >
                Continue to Dashboard
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
};
