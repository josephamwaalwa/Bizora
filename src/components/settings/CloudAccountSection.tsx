import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  CloudOff,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useCloudAuth } from '../../hooks/useCloudAuth';
import { Button } from '../common/Button';
import { Card } from '../common/Card';

function getSafeHttpsAvatarUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function formatSessionExpiry(expiresAt: number | null): string | null {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return null;
  }
  try {
    return new Date(expiresAt * 1000).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return null;
  }
}

function formatProviderLabel(provider: string | null): string {
  if (!provider) return 'Supabase Auth';
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'google') return 'Google OAuth';
  if (normalized === 'email') return 'Email & Password';
  return provider;
}

export const CloudAccountSection: React.FC = () => {
  const {
    authState,
    isRestoringSession,
    signOut,
    refreshSession,
    clearNotice,
  } = useCloudAuth();

  const [isActionBusy, setIsActionBusy] = useState(false);
  const [avatarLoadError, setAvatarLoadError] = useState(false);

  const { session, availability, lastNotice, error } = authState;
  const safeAvatarUrl = !avatarLoadError ? getSafeHttpsAvatarUrl(session?.avatarUrl ?? null) : null;
  const formattedExpiry = formatSessionExpiry(session?.expiresAt ?? null);

  const isOffline = availability.status === 'offline';
  const isConfigUnavailable =
    availability.status === 'unavailable' || availability.status === 'error';

  const handleSignOut = async () => {
    if (isActionBusy) return;
    setIsActionBusy(true);
    try {
      await signOut();
      setAvatarLoadError(false);
    } finally {
      setIsActionBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (isActionBusy) return;
    setIsActionBusy(true);
    try {
      await refreshSession();
    } finally {
      setIsActionBusy(false);
    }
  };

  const displayName = session?.fullName || session?.email || 'Authenticated User';
  const avatarInitial = displayName.charAt(0).toUpperCase();

  return (
    <Card padding="md" className="space-y-4 border-line-strong">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
        <div className="flex items-center gap-2">
          {isOffline ? (
            <CloudOff className="w-5 h-5 text-ink-muted shrink-0" />
          ) : (
            <Cloud className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
          )}
          <div>
            <h3 className="text-sm font-bold text-ink uppercase tracking-wider">
              Account &amp; Session
            </h3>
            <p className="text-xs text-ink-secondary">
              Manage your active Bizora account session. Local SQLite business records stay preserved on this device.
            </p>
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 rounded border border-line bg-paper-sunken px-2.5 py-1 text-[11px] font-medium text-ink-secondary">
          {isRestoringSession ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Checking session
            </>
          ) : session && isOffline ? (
            <>
              <CloudOff className="w-3 h-3 text-amber-600 dark:text-amber-400" />
              Offline (session active)
            </>
          ) : session ? (
            <>
              <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
              Signed in
            </>
          ) : (
            'Session inactive'
          )}
        </span>
      </div>

      {(lastNotice || error) && (
        <div
          role="alert"
          className={`flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-xs ${
            lastNotice?.kind === 'info'
              ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200'
              : lastNotice?.kind === 'cancelled'
                ? 'border-amber-200 bg-amber-50/70 text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200'
                : 'border-rose-200 bg-rose-50/70 text-rose-900 dark:border-rose-800/70 dark:bg-rose-950/40 dark:text-rose-200'
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{lastNotice?.message || error}</span>
          </div>
          <button
            type="button"
            onClick={clearNotice}
            aria-label="Dismiss account notice"
            className="rounded p-0.5 opacity-75 hover:opacity-100 transition-opacity"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {session && (
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border border-line bg-paper-sunken p-3.5">
            <div className="flex items-center gap-3 min-w-0">
              {safeAvatarUrl ? (
                <img
                  src={safeAvatarUrl}
                  alt={displayName}
                  onError={() => setAvatarLoadError(true)}
                  className="w-10 h-10 rounded-lg border border-line object-cover shrink-0"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-sm font-bold text-ink">
                  {avatarInitial}
                </div>
              )}

              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-semibold text-ink truncate">{displayName}</p>
                {session.email && session.fullName && (
                  <p className="text-xs text-ink-secondary truncate">{session.email}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
                  <span className="inline-flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    {formatProviderLabel(session.provider)}
                  </span>
                  {formattedExpiry && (
                    <span>
                      {session.isExpired ? 'Expired: ' : 'Session expires: '}
                      {formattedExpiry}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleRefresh}
                disabled={isActionBusy || isOffline || isConfigUnavailable}
                leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
              >
                Refresh Session
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSignOut}
                disabled={isActionBusy}
                isLoading={isActionBusy}
                leftIcon={<LogOut className="w-3.5 h-3.5" />}
                data-testid="settings-signout-button"
              >
                Sign Out
              </Button>
            </div>
          </div>

          <p className="text-xs text-ink-secondary">
            {isOffline
              ? 'You are currently offline. Your saved session remains in the desktop credential store, and your local SQLite business records remain available.'
              : 'Signing out locks the workspace and clears your session tokens without deleting or modifying any local SQLite quotations, invoices, or client records.'}
          </p>
        </div>
      )}
    </Card>
  );
};
