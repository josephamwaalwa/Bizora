import React from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { AppProvider, useApp } from './context/AppContext';
import { AuthGate } from './components/auth/AuthGate';
import { AppLayout } from './components/layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { QuotationsPage } from './pages/QuotationsPage';
import { QuotationFormPage } from './pages/QuotationFormPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { InvoiceFormPage } from './pages/InvoiceFormPage';
import { ClientsPage } from './pages/ClientsPage';
import { ClientDetailPage } from './pages/ClientDetailPage';
import { SettingsPage } from './pages/SettingsPage';

const AppContent: React.FC = () => {
  const {
    activeView,
    activeEntityId,
    isWorkspaceLoading,
    persistenceError,
    clearPersistenceError,
    startupBlockState,
    migrationNotice,
    dismissMigrationNotice,
    retryWorkspaceStartup,
    refreshData,
  } = useApp();

  if (isWorkspaceLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6 text-ink">
        <div className="text-center space-y-2">
          <p className="text-[15px] font-medium text-ink">Loading workspace...</p>
          <p className="text-[13px] text-ink-secondary">
            Preparing your business records and persistence storage.
          </p>
        </div>
      </div>
    );
  }

  if (startupBlockState) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6 py-10 text-ink">
        <div className="w-full max-w-2xl rounded-lg border border-rose-300 bg-surface p-6 shadow-subtle space-y-4 dark:border-rose-800">
          <div className="space-y-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-rose-700 dark:text-rose-400">
              Desktop Data Protection Gate
            </span>
            <h1 className="text-lg font-bold text-ink">{startupBlockState.title}</h1>
            <p className="text-xs leading-relaxed text-ink-secondary">
              {startupBlockState.message}
            </p>
          </div>

          {startupBlockState.backupFilename && (
            <div className="rounded border border-line bg-paper-sunken px-3.5 py-2.5 text-xs text-ink-secondary">
              Pre-migration raw backup preserved on disk:{' '}
              <span className="font-mono font-semibold text-ink">
                {startupBlockState.backupFilename}
              </span>
            </div>
          )}

          {startupBlockState.diagnostics.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">
                Diagnostics ({startupBlockState.diagnostics.length})
              </h2>
              <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                {startupBlockState.diagnostics.slice(0, 12).map((diag, idx) => (
                  <div
                    key={`${diag.code}-${diag.recordId ?? idx}`}
                    className="rounded border border-line bg-paper-sunken p-3 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-ink">{diag.code}</span>
                      <span className="text-[11px] uppercase tracking-wider text-ink-muted">
                        {diag.stage} • {diag.entityType}
                      </span>
                    </div>
                    <p className="text-ink-secondary">{diag.message}</p>
                    {diag.suggestedAction && (
                      <p className="text-[11px] text-ink-muted">{diag.suggestedAction}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-line">
            <p className="text-[11px] text-ink-muted">
              Your existing LocalStorage and SQLite files were not overwritten.
            </p>
            <button
              type="button"
              onClick={() => void retryWorkspaceStartup()}
              className="rounded bg-ink px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 transition-opacity"
            >
              Retry Startup & Migration
            </button>
          </div>
        </div>
      </div>
    );
  }

  const renderActiveView = () => {
    switch (activeView) {
      case 'dashboard':
        return <DashboardPage />;
      case 'quotations':
        return <QuotationsPage />;
      case 'quotation-new':
      case 'quotation-edit':
        return <QuotationFormPage key={`${activeView}-${activeEntityId ?? 'new'}`} />;
      case 'invoices':
        return <InvoicesPage />;
      case 'invoice-new':
      case 'invoice-edit':
        return <InvoiceFormPage key={`${activeView}-${activeEntityId ?? 'new'}`} />;
      case 'clients':
        return <ClientsPage />;
      case 'client-detail':
        return <ClientDetailPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <DashboardPage />;
    }
  };

  return (
    <AppLayout>
      {migrationNotice && (
        <div
          className={`mb-4 flex flex-wrap items-start justify-between gap-3 rounded border px-4 py-3 text-xs ${
            migrationNotice.tone === 'warning'
              ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200'
          }`}
        >
          <div className="space-y-0.5">
            <p className="font-semibold">{migrationNotice.title}</p>
            <p className="opacity-90">{migrationNotice.message}</p>
          </div>
          <button
            type="button"
            onClick={dismissMigrationNotice}
            className="font-semibold underline hover:no-underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {persistenceError && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
          <span>{persistenceError}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                clearPersistenceError();
                void refreshData();
              }}
              className="font-semibold underline hover:no-underline"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={clearPersistenceError}
              className="text-rose-700 hover:text-rose-900 dark:text-rose-300 dark:hover:text-white"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {renderActiveView()}
    </AppLayout>
  );
};

export default function App() {
  return (
    <ThemeProvider>
      <AuthGate>
        <AppProvider>
          <AppContent />
        </AppProvider>
      </AuthGate>
    </ThemeProvider>
  );
}
