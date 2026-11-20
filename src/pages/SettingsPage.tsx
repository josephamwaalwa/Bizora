import React, { useState, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { Textarea } from '../components/common/Textarea';
import type { BusinessProfile, CurrencyCode } from '../types';
import { exportJsonBackupFile, pickAndReadJsonBackupInTauri } from '../services/fileOperations';
import { BusinessAvatar } from '../components/common/BusinessAvatar';
import {
  Building2,
  Upload,
  Trash2,
  DollarSign,
  Receipt,
  FileText,
  CreditCard,
  Database,
  Download,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';

export const SettingsPage: React.FC = () => {
  const {
    businessProfile,
    persistenceBackend,
    isSaving,
    updateBusinessProfile,
    exportBackupJson,
    importBackupJson,
    resetToDemoData,
    clearAllData,
    showConfirmDialog,
    addToast,
  } = useApp();

  const [syncedProfile, setSyncedProfile] = useState<BusinessProfile>(businessProfile);
  const [profile, setProfile] = useState<BusinessProfile>(() => ({ ...businessProfile }));
  const [logoPreview, setLogoPreview] = useState<string>(businessProfile.logoUrl || '');
  const [isBackupBusy, setIsBackupBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  if (syncedProfile !== businessProfile) {
    setSyncedProfile(businessProfile);
    setProfile({ ...businessProfile });
    setLogoPreview(businessProfile.logoUrl || '');
  }

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        addToast({
          type: 'warning',
          title: 'Logo too large',
          message: 'Please choose an image under 2MB.',
        });
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        setLogoPreview(base64);
        setProfile((prev) => ({ ...prev, logoUrl: base64 }));
      };
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveLogo = () => {
    setLogoPreview('');
    setProfile((prev) => ({ ...prev, logoUrl: '' }));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleChange = <K extends keyof BusinessProfile,>(field: K, value: BusinessProfile[K]) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
  };

  const handleBankChange = (field: keyof BusinessProfile['bankDetails'], value: string) => {
    setProfile((prev) => ({
      ...prev,
      bankDetails: {
        ...prev.bankDetails,
        [field]: value,
      },
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    await updateBusinessProfile(profile);
  };

  const applyImportedBackupContent = async (content: string) => {
    const result = await importBackupJson(content);
    if (!result.ok) {
      addToast({
        type: 'error',
        title: 'Invalid Backup File',
        message: result.error || 'The selected file is not a valid Bizora backup JSON.',
      });
      return;
    }

    if (result.persisted !== false) {
      addToast({
        type: 'success',
        title: 'Backup Restored',
        message: 'All clients, documents, and settings have been imported.',
      });
    } else {
      addToast({
        type: 'warning',
        title: 'Loaded in Active Session Only',
        message: 'Backup records were loaded into memory, but browser storage could not persist all data across reloads.',
      });
    }
  };

  // Export JSON Backup
  const handleExportBackup = async () => {
    if (isBackupBusy) return;
    setIsBackupBusy(true);
    try {
      const jsonStr = await exportBackupJson();
      const fileName = `bizora-backup-${new Date().toISOString().split('T')[0]}.json`;
      const result = await exportJsonBackupFile(fileName, jsonStr);
      if (result === 'cancelled') return;

      addToast({
        type: 'success',
        title: 'Backup Exported',
        message: 'Saved complete business backup file.',
      });
    } catch (error) {
      console.error('Failed to export backup:', error);
      addToast({
        type: 'error',
        title: 'Export Failed',
        message: 'Could not save the backup file.',
      });
    } finally {
      setIsBackupBusy(false);
    }
  };

  // Trigger Import JSON Backup (native dialog in Tauri, file input in browser)
  const handleTriggerImport = async () => {
    if (isBackupBusy) return;
    setIsBackupBusy(true);
    try {
      const tauriResult = await pickAndReadJsonBackupInTauri();
      if (tauriResult === null) {
        importFileRef.current?.click();
        return;
      }
      if (tauriResult.status === 'cancelled') return;
      await applyImportedBackupContent(tauriResult.content);
    } catch (error) {
      console.error('Failed to import backup:', error);
      addToast({
        type: 'error',
        title: 'Import Failed',
        message: 'Could not read the selected backup file.',
      });
    } finally {
      setIsBackupBusy(false);
    }
  };

  // Browser <input type="file"> Import Handler
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result as string;
        setIsBackupBusy(true);
        try {
          await applyImportedBackupContent(content);
        } finally {
          setIsBackupBusy(false);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-6 pb-20">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-line">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-widest text-ink-muted block mb-0.5">
            System Preferences
          </span>
          <h2 className="text-xl font-bold text-ink tracking-tight">Business Settings</h2>
          <p className="text-xs text-ink-secondary mt-0.5">
            Configure enterprise profile, tax parameters, currency formatting, and document numbering.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={isSaving} isLoading={isSaving}>
          Save Settings
        </Button>
      </div>

      <form onSubmit={handleSubmit} className="settings-form space-y-6">
        {/* 1. Brand & Business Profile */}
        <Card padding="md" className="space-y-5">
          <div className="flex items-center gap-2 border-b border-line pb-3">
            <Building2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <div>
              <h3 className="text-sm font-bold text-ink uppercase tracking-wider">
                Business Information & Branding
              </h3>
              <p className="text-xs text-ink-secondary">Appears on all exported quotations and invoices.</p>
            </div>
          </div>

          {/* Logo Upload Section */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-5 p-4 rounded-xl border border-line bg-paper-sunken">
            <div className="flex h-20 w-24 items-center justify-center shrink-0">
              <BusinessAvatar
                name={profile.name}
                logoUrl={logoPreview}
                size={72}
                tone="light"
              />
            </div>

            <div className="space-y-2">
              <span className="text-xs font-semibold text-ink block">Business Logo</span>
              <p className="text-xs text-ink-secondary">
                Recommended: PNG, SVG, or JPG with a transparent or white background (max 2MB).
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleLogoUpload}
                  accept="image/*"
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  leftIcon={<Upload className="w-3.5 h-3.5" />}
                >
                  Upload Logo
                </Button>
                {logoPreview && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleRemoveLogo}
                    className="text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/50 border-rose-200 dark:border-rose-800/70"
                    leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Business Name"
              value={profile.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="e.g. Kalahari Creative Studio"
              required
            />
            <Input
              label="Tagline / Subtitle"
              value={profile.tagline}
              onChange={(e) => handleChange('tagline', e.target.value)}
              placeholder="e.g. Design, Branding & Digital Products"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="Business Email"
              type="email"
              value={profile.email}
              onChange={(e) => handleChange('email', e.target.value)}
              placeholder="hello@business.com.na"
              required
            />
            <Input
              label="Phone Number"
              value={profile.phone}
              onChange={(e) => handleChange('phone', e.target.value)}
              placeholder="+264 61 245 8900"
            />
            <Input
              label="Website"
              value={profile.website || ''}
              onChange={(e) => handleChange('website', e.target.value)}
              placeholder="https://business.com.na"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="sm:col-span-2">
              <Input
                label="Physical Address"
                value={profile.address}
                onChange={(e) => handleChange('address', e.target.value)}
                placeholder="Unit 4B, Maerua Park"
              />
            </div>
            <Input
              label="City"
              value={profile.city}
              onChange={(e) => handleChange('city', e.target.value)}
              placeholder="Windhoek"
            />
            <Input
              label="Country"
              value={profile.country}
              onChange={(e) => handleChange('country', e.target.value)}
              placeholder="Namibia"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Tax Registration (TIN / VAT No)"
              value={profile.taxNumber || ''}
              onChange={(e) => handleChange('taxNumber', e.target.value)}
              placeholder="TIN-9842103-01"
              helperText="Printed on tax invoices for VAT registered entities"
            />
            <Input
              label="Company Registration Number"
              value={profile.registrationNumber || ''}
              onChange={(e) => handleChange('registrationNumber', e.target.value)}
              placeholder="CC/2023/04891"
            />
          </div>
        </Card>

        {/* 2. Currency & Configurable Tax Settings */}
        <Card padding="md" className="space-y-5">
          <div className="flex items-center gap-2 border-b border-line pb-3">
            <DollarSign className="w-5 h-5 text-teal-600 dark:text-teal-400" />
            <div>
              <h3 className="text-sm font-bold text-ink uppercase tracking-wider">
                Currency & Tax Preferences
              </h3>
              <p className="text-xs text-ink-secondary">Default financial configuration for all new documents.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Default Currency (Default: NAD)"
              value={profile.defaultCurrency}
              onChange={(e) => {
                const c = e.target.value as CurrencyCode;
                const symbols: Record<CurrencyCode, string> = {
                  NAD: 'N$',
                  ZAR: 'R',
                  USD: '$',
                  EUR: '€',
                  GBP: '£',
                };
                handleChange('defaultCurrency', c);
                handleChange('currencySymbol', symbols[c] || c);
              }}
              options={[
                { value: 'NAD', label: 'Namibian Dollar (NAD - N$)' },
                { value: 'ZAR', label: 'South African Rand (ZAR - R)' },
                { value: 'USD', label: 'US Dollar (USD - $)' },
                { value: 'EUR', label: 'Euro (EUR - €)' },
                { value: 'GBP', label: 'British Pound (GBP - £)' },
              ]}
              helperText="Namibian Dollars is pre-configured as primary SaaS currency."
            />

            <Input
              label="Currency Display Symbol"
              value={profile.currencySymbol}
              onChange={(e) => handleChange('currencySymbol', e.target.value)}
              placeholder="N$"
              helperText="e.g. N$ 1,250.00"
            />
          </div>

          {/* Configurable Tax Section */}
          <div className="p-4 rounded-xl border border-line bg-paper-sunken space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-ink uppercase tracking-wider block">
                  Configurable Tax Rate
                </span>
                <p className="text-xs text-ink-secondary">
                  Tax rates are not hardcoded. Configure your applicable rate (e.g. 15% VAT in Namibia, or 0% for non-registered entities).
                </p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-ink">
                <input
                  type="checkbox"
                  checked={profile.isTaxEnabled}
                  onChange={(e) => handleChange('isTaxEnabled', e.target.checked)}
                  className="rounded border-line-strong text-indigo-600 focus:ring-indigo-500"
                />
                <span>Enable Tax</span>
              </label>
            </div>

            {profile.isTaxEnabled && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                <Input
                  label="Tax Label"
                  value={profile.defaultTaxName}
                  onChange={(e) => handleChange('defaultTaxName', e.target.value)}
                  placeholder="VAT"
                  helperText="Name displayed on quote/invoice summaries (e.g. VAT, GST, Sales Tax)"
                />
                <Input
                  label="Tax Rate Percentage (%)"
                  type="number"
                  step="0.1"
                  min="0"
                  value={profile.defaultTaxRate}
                  onChange={(e) => handleChange('defaultTaxRate', parseFloat(e.target.value) || 0)}
                  placeholder="15"
                  helperText="Configurable percentage applied to line items after discounts"
                />
              </div>
            )}
          </div>
        </Card>

        {/* 3. Document Numbering Preferences */}
        <Card padding="md" className="space-y-5">
          <div className="flex items-center gap-2 border-b border-line pb-3">
            <Receipt className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <div>
              <h3 className="text-sm font-bold text-ink uppercase tracking-wider">
                Document Numbering Preferences
              </h3>
              <p className="text-xs text-ink-secondary">Control sequential numbering for quotes and invoices.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="space-y-3 p-4 rounded-xl border border-line bg-paper-sunken">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-900 dark:text-indigo-300 block">
                Quotations Numbering
              </span>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Prefix"
                  value={profile.quotePrefix}
                  onChange={(e) => handleChange('quotePrefix', e.target.value)}
                  placeholder="QUO-"
                />
                <Input
                  label="Next Number"
                  type="number"
                  min="1"
                  value={profile.nextQuoteNumber}
                  onChange={(e) => handleChange('nextQuoteNumber', parseInt(e.target.value, 10) || 1)}
                />
              </div>
              <p className="text-[11px] text-ink-secondary">
                Next quote preview: <strong className="text-ink">{profile.quotePrefix}{String(profile.nextQuoteNumber).padStart(4, '0')}</strong>
              </p>
            </div>

            <div className="space-y-3 p-4 rounded-xl border border-line bg-paper-sunken">
              <span className="text-xs font-bold uppercase tracking-wider text-teal-900 dark:text-teal-300 block">
                Invoices Numbering
              </span>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Prefix"
                  value={profile.invoicePrefix}
                  onChange={(e) => handleChange('invoicePrefix', e.target.value)}
                  placeholder="INV-"
                />
                <Input
                  label="Next Number"
                  type="number"
                  min="1"
                  value={profile.nextInvoiceNumber}
                  onChange={(e) => handleChange('nextInvoiceNumber', parseInt(e.target.value, 10) || 1)}
                />
              </div>
              <p className="text-[11px] text-ink-secondary">
                Next invoice preview: <strong className="text-ink">{profile.invoicePrefix}{String(profile.nextInvoiceNumber).padStart(4, '0')}</strong>
              </p>
            </div>
          </div>
        </Card>

        {/* 4. Banking & Payment Instructions */}
        <Card padding="md" className="space-y-5">
          <div className="flex items-center gap-2 border-b border-line pb-3">
            <CreditCard className="w-5 h-5 text-teal-600 dark:text-teal-400" />
            <div>
              <h3 className="text-sm font-bold text-ink uppercase tracking-wider">
                Bank & Payment Instructions
              </h3>
              <p className="text-xs text-ink-secondary">Rendered in the payment details box of generated documents.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Bank Name"
              value={profile.bankDetails.bankName}
              onChange={(e) => handleBankChange('bankName', e.target.value)}
              placeholder="e.g. First National Bank Namibia (FNB)"
            />
            <Input
              label="Account Name"
              value={profile.bankDetails.accountName}
              onChange={(e) => handleBankChange('accountName', e.target.value)}
              placeholder="e.g. Kalahari Creative Studio CC"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="Account Number"
              value={profile.bankDetails.accountNumber}
              onChange={(e) => handleBankChange('accountNumber', e.target.value)}
              placeholder="62849104822"
            />
            <Input
              label="Branch Code"
              value={profile.bankDetails.branchCode}
              onChange={(e) => handleBankChange('branchCode', e.target.value)}
              placeholder="280172"
            />
            <Input
              label="SWIFT / BIC Code (Optional)"
              value={profile.bankDetails.swiftCode || ''}
              onChange={(e) => handleBankChange('swiftCode', e.target.value)}
              placeholder="FIRNNANX"
            />
          </div>
        </Card>

        {/* 5. Default Terms & Conditions */}
        <Card padding="md" className="space-y-4">
          <div className="flex items-center gap-2 border-b border-line pb-3">
            <FileText className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <div>
              <h3 className="text-sm font-bold text-ink uppercase tracking-wider">
                Default Terms & Notes
              </h3>
              <p className="text-xs text-ink-secondary">Pre-populated into newly created quotes and invoices.</p>
            </div>
          </div>

          <Textarea
            label="Default Quotation Terms & Conditions"
            value={profile.defaultTermsQuotation}
            onChange={(e) => handleChange('defaultTermsQuotation', e.target.value)}
            rows={2}
          />

          <Textarea
            label="Default Invoice Payment Terms"
            value={profile.defaultTermsInvoice}
            onChange={(e) => handleChange('defaultTermsInvoice', e.target.value)}
            rows={2}
          />

          <Textarea
            label="Default Thank You Note / Instructions"
            value={profile.defaultNotes}
            onChange={(e) => handleChange('defaultNotes', e.target.value)}
            rows={2}
          />
        </Card>

        {/* 6. Data Management & LocalStorage Architecture */}
        <Card padding="md" className="space-y-4 border-line-strong">
          <div className="flex items-center gap-2 border-b border-line pb-3">
            <Database className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <div>
              <h3 className="text-sm font-bold text-ink uppercase tracking-wider">
                Data Storage & Supabase Cloud Readiness
              </h3>
              <p className="text-xs text-ink-secondary">
                Current data persistence mode:{' '}
                <strong className="text-ink">
                  {persistenceBackend === 'sqlite' ? 'Local SQLite Database' : 'Browser LocalStorage'}
                </strong>
                .
              </p>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-800/60 text-xs text-indigo-950 dark:text-indigo-200 space-y-1.5 leading-relaxed">
            <p className="font-semibold flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>Architected for Seamless Supabase Integration</span>
            </p>
            <p className="text-indigo-900/80 dark:text-indigo-200/80">
              All documents, clients, items, and settings are decoupled through an abstraction repository. In a future update, connecting your Supabase project URL and API key will enable multi-user cloud synchronization without changing domain models.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleExportBackup}
                leftIcon={<Download className="w-3.5 h-3.5" />}
              >
                Export JSON Backup
              </Button>

              <input
                type="file"
                ref={importFileRef}
                onChange={handleImportFile}
                accept=".json"
                className="hidden"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleTriggerImport}
                leftIcon={<Upload className="w-3.5 h-3.5" />}
              >
                Restore from Backup
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  showConfirmDialog({
                    title: 'Restore Sample Demo Data?',
                    message: 'This will reset sample clients, quotations and invoices for Kalahari Creative Studio. Useful for testing.',
                    confirmLabel: 'Restore Demo Data',
                    onConfirm: resetToDemoData,
                  });
                }}
                leftIcon={<RefreshCw className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
              >
                Restore Demo Data
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 border-rose-200 dark:border-rose-800/70"
                onClick={() => {
                  showConfirmDialog({
                    title: 'Clear All Data & Start Fresh?',
                    message: 'This will delete all quotations, invoices, clients and reset settings to an empty slate. Make sure you export a backup first if needed.',
                    confirmLabel: 'Clear All Data',
                    isDestructive: true,
                    onConfirm: clearAllData,
                  });
                }}
                leftIcon={<AlertTriangle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />}
              >
                Clear All Data
              </Button>
            </div>
          </div>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end pt-4">
          <Button variant="primary" size="md" type="submit" disabled={isSaving} isLoading={isSaving}>
            Save All Preferences
          </Button>
        </div>
      </form>
    </div>
  );
};
