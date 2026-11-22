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
import { isDesktopTauriRuntime } from '../../services/persistence';
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

const GoogleIcon: React.FC = () => (
  <svg
    className="w-4 h-4 shrink-0"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      fill="#4285F4"
      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
    />
    <path
      fill="#FBBC05"
      d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
    />
    <path
      fill="#EA4335"
      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
    />
  </svg>
);

export const CloudAccountSection: React.FC = () => {
  const {
    authState,
    isRestoringSession,
    signInWithGoogle,
    signOut,
    refreshSession,
    cancelPendingSignIn,
    clearNotice,
  } = useCloudAuth();

  const [isActionBusy, setIsActionBusy] = useState(false);
  const [avatarLoadError, setAvatarLoadError] = useState(false);

  const isDesktop = isDesktopTauriRuntime();
  const { session, availability, isAuthenticating, lastNotice, error } = authState;
  const safeAvatarUrl = !avatarLoadError ? getSafeHttpsAvatarUrl(session?.avatarUrl ?? null) : null;
  const formattedExpiry = formatSessionExpiry(session?.expiresAt ?? null);

  const isUnconfigured = availability.status === 'unconfigured';
  const isConfigUnavailable =
    availability.status === 'unavailable' || availability.status === 'error';
  const isOffline = availability.status === 'offline';

  const handleSignIn = async () => {
    if (isActionBusy || isAuthenticating) return;
    setIsActionBusy(true);
    try {
      await signInWithGoogle();
    } finally {
      setIsActionBusy(false);
    }
  };

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

  const handleCancel = async () => {
    await cancelPendingSignIn();
  };

  const displayName = session?.fullName || session?.email || 'Connected Account';
  const avatarInitial = displayName.charAt(0).toUpperCase();

  return (
    <Card padding="md" className="space-y-4 border-line-strong">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
        <div className="flex items-center gap-2">
          {isOffline || isUnconfigured || isConfigUnavailable ? (
            <CloudOff className="w-5 h-5 text-ink-muted shrink-0" />
          ) : (
            <Cloud className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
          )}
          <div>
            <h3 className="text-sm font-bold text-ink uppercase tracking-wider">
              Cloud Account &amp; Google Sign-In
            </h3>
            <p className="text-xs text-ink-secondary">
              Optional cloud account connection via Supabase Auth. Local SQLite data remains available offline.
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
              Offline (session saved)
            </>
          ) : session ? (
            <>
              <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
              Signed in
            </>
          ) : isOffline ? (
            <>
              <CloudOff className="w-3 h-3 text-amber-600 dark:text-amber-400" />
              Offline
            </>
          ) : isUnconfigured ? (
            'Not configured'
          ) : isConfigUnavailable ? (
            'Unavailable'
          ) : (
            'Signed out'
          )}
        </span>
      </div>

      {/* Cancellation or Auth Error Notice */}
      {(lastNotice || (error && !isUnconfigured)) && (
        <div
          role="alert"
          className={`flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-xs ${
            lastNotice?.kind === 'cancelled'
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
            aria-label="Dismiss authentication notice"
            className="rounded p-0.5 opacity-75 hover:opacity-100 transition-opacity"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Signed-in Account View (Online or Preserved Offline) */}
      {session ? (
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
                    {session.provider ? `Provider: ${session.provider}` : 'Supabase session'}
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
              >
                Sign Out
              </Button>
            </div>
          </div>

          {isOffline && (
            <p className="text-xs text-ink-secondary">
              You are currently offline. Your saved session remains stored securely in the desktop credential store, and local SQLite business records remain fully accessible.
            </p>
          )}
        </div>
      ) : isAuthenticating ? (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-line bg-paper-sunken p-3.5">
          <div className="flex items-center gap-2.5 text-xs text-ink">
            <Loader2 className="w-4 h-4 animate-spin text-indigo-600 dark:text-indigo-400 shrink-0" />
            <div>
              <p className="font-semibold">Waiting for Google sign-in in your browser...</p>
              <p className="text-ink-secondary">
                Complete authentication in your default browser to return to Bizora automatically.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCancel}
          >
            Cancel Sign-In
          </Button>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-line bg-paper-sunken p-3.5">
          <div className="space-y-1 text-xs">
            <p className="font-semibold text-ink">
              {isUnconfigured
                ? 'Supabase environment is not configured'
                : isOffline
                  ? 'Offline — cloud sign-in paused'
                  : isConfigUnavailable
                    ? 'Cloud authentication unavailable'
                    : !isDesktop
                      ? 'Desktop app required for Google OAuth callback'
                      : 'Sign in optionally with your Google account'}
            </p>
            <p className="text-ink-secondary">
              {isUnconfigured
                ? 'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to enable Google sign-in. Local SQLite storage works without an account.'
                : isOffline
                  ? 'No internet connection detected. Your local clients, quotations, and invoices remain available.'
                  : isConfigUnavailable
                    ? availability.reason || 'Verify Supabase configuration and retry.'
                    : !isDesktop
                      ? 'Google desktop OAuth opens your system browser and returns via the bizora:// protocol in the Windows desktop app.'
                      : 'Opens your system browser using OAuth PKCE and stores session tokens in the OS credential store.'}
            </p>
          </div>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleSignIn}
            disabled={
              isActionBusy ||
              isRestoringSession ||
              isUnconfigured ||
              isOffline ||
              isConfigUnavailable ||
              !isDesktop
            }
            isLoading={isActionBusy}
            leftIcon={<GoogleIcon />}
            className="shrink-0"
          >
            Sign in with Google
          </Button>
        </div>
      )}
    </Card>
  );
};
