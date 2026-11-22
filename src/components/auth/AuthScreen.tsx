import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  MailCheck,
  WifiOff,
  X,
} from 'lucide-react';
import { useCloudAuth } from '../../hooks/useCloudAuth';
import {
  MIN_PASSWORD_LENGTH,
  validateEmailAddress,
  validatePasswordStrength,
} from '../../services/cloud';
import { isDesktopTauriRuntime } from '../../services/persistence';
import { Button } from '../common/Button';
import { Input } from '../common/Input';

export type AuthScreenMode = 'signin' | 'signup' | 'forgot' | 'recovery';

const GoogleIcon: React.FC = () => (
  <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
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

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  helperText?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  testId?: string;
}

const PasswordField: React.FC<PasswordFieldProps> = ({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  helperText,
  error,
  disabled,
  required,
  testId,
}) => {
  const [visible, setVisible] = useState(false);

  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-2 block text-[14px] font-medium leading-snug text-ink">
        {label} {required && <span className="text-[#8E3B32] dark:text-rose-400">*</span>}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          disabled={disabled}
          required={required}
          data-testid={testId}
          className={`block h-11 w-full border bg-surface pl-3 pr-11 text-[16px] text-ink transition-colors placeholder:text-ink-muted focus:outline-none focus:border-indigo-600 dark:focus:border-indigo-500 disabled:bg-paper-sunken disabled:text-ink-muted disabled:cursor-not-allowed ${
            error
              ? 'border-[#8E3B32] dark:border-rose-500 focus:border-[#8E3B32] dark:focus:border-rose-500'
              : 'border-line'
          }`}
        />
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          disabled={disabled}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error ? (
        <p className="mt-1.5 text-[13px] font-medium text-[#8E3B32] dark:text-rose-400">{error}</p>
      ) : helperText ? (
        <p className="mt-1.5 text-[13px] text-ink-secondary">{helperText}</p>
      ) : null}
    </div>
  );
};

export const AuthScreen: React.FC = () => {
  const {
    authState,
    signInWithEmailPassword,
    signUpWithEmailPassword,
    signInWithGoogle,
    requestPasswordReset,
    updatePassword,
    cancelPasswordRecovery,
    cancelPendingSignIn,
    clearNotice,
  } = useCloudAuth();

  const [selectedMode, setSelectedMode] = useState<'signin' | 'signup' | 'forgot'>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);
  const [resetSentToEmail, setResetSentToEmail] = useState<string | null>(null);

  const mode: AuthScreenMode = authState.isPasswordRecovery ? 'recovery' : selectedMode;

  const isDesktop = isDesktopTauriRuntime();
  const { availability, isAuthenticating, lastNotice, error: authServiceError } = authState;

  const isUnconfigured = availability.status === 'unconfigured';
  const isConfigUnavailable =
    availability.status === 'unavailable' || availability.status === 'error';
  const isOffline = availability.status === 'offline';
  const isAuthBlockedByEnv = isUnconfigured || isConfigUnavailable;
  const isBusy = isSubmitting || isAuthenticating;

  const switchMode = (nextMode: 'signin' | 'signup' | 'forgot') => {
    setSelectedMode(nextMode);
    setFormError(null);
    setConfirmationEmail(null);
    setResetSentToEmail(null);
    setPassword('');
    setConfirmPassword('');
    clearNotice();
  };

  const handleSignInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;
    setFormError(null);
    clearNotice();

    const emailIssue = validateEmailAddress(email);
    if (emailIssue) {
      setFormError(emailIssue);
      return;
    }
    if (!password) {
      setFormError('Password is required to sign in.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await signInWithEmailPassword(email, password);
      if (!result.ok) {
        setFormError(result.error ?? 'Unable to sign in. Check your credentials and try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;
    setFormError(null);
    clearNotice();

    const trimmedName = fullName.trim();
    if (trimmedName.length < 2) {
      setFormError('Full name must be at least 2 characters.');
      return;
    }
    const emailIssue = validateEmailAddress(email);
    if (emailIssue) {
      setFormError(emailIssue);
      return;
    }
    const passwordIssue = validatePasswordStrength(password);
    if (passwordIssue) {
      setFormError(passwordIssue);
      return;
    }
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await signUpWithEmailPassword({
        fullName: trimmedName,
        email,
        password,
      });
      if (!result.ok) {
        setFormError(result.error ?? 'Could not create your account. Please try again.');
        return;
      }
      if (result.data?.status === 'confirmation_required') {
        setConfirmationEmail(result.data.email);
        setPassword('');
        setConfirmPassword('');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleForgotPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;
    setFormError(null);
    clearNotice();

    const emailIssue = validateEmailAddress(email);
    if (emailIssue) {
      setFormError(emailIssue);
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await requestPasswordReset(email);
      if (!result.ok) {
        setFormError(result.error ?? 'Failed to send password reset email.');
        return;
      }
      setResetSentToEmail(result.data?.email ?? email.trim());
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRecoveryUpdateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;
    setFormError(null);
    clearNotice();

    const passwordIssue = validatePasswordStrength(password);
    if (passwordIssue) {
      setFormError(passwordIssue);
      return;
    }
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await updatePassword(password);
      if (!result.ok) {
        setFormError(result.error ?? 'Failed to update password. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (isBusy) return;
    setFormError(null);
    clearNotice();

    const result = await signInWithGoogle();
    if (!result.ok && result.error) {
      setFormError(result.error);
    }
  };

  const bannerMessage =
    formError ||
    lastNotice?.message ||
    (!isUnconfigured && !isConfigUnavailable ? authServiceError : null);

  const bannerIsInfo = !formError && lastNotice?.kind === 'info';
  const bannerIsWarning = !formError && lastNotice?.kind === 'cancelled';

  return (
    <div
      data-testid="auth-screen"
      className="flex min-h-screen w-full items-center justify-center bg-paper px-5 py-10 text-ink sm:px-8"
    >
      {/* Centered authentication container */}
      <main className="w-full max-w-[440px]">
        <div className="w-full border border-line bg-surface p-7 sm:p-9 shadow-subtle">
          {/* Bizora Branding */}
          <div className="mb-7 flex items-center gap-3">
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

          {/* View Title & Description */}
          <div className="mb-6 space-y-1.5">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">
              {mode === 'signin'
                ? 'Sign in to Bizora'
                : mode === 'signup'
                  ? 'Create your account'
                  : mode === 'forgot'
                    ? 'Reset your password'
                    : 'Set a new password'}
            </h1>
            <p className="text-[14px] text-ink-secondary">
              {mode === 'signin'
                ? 'Sign in to your account to continue.'
                : mode === 'signup'
                  ? 'Enter your details to create a Bizora account.'
                  : mode === 'forgot'
                    ? 'Enter your account email and we will send you a password reset link.'
                    : 'Choose a new password for your Bizora account.'}
            </p>
          </div>

          {/* Service Unavailable Notice */}
          {isAuthBlockedByEnv && (
            <div
              role="alert"
              data-testid="auth-config-banner"
              className="mb-5 border border-rose-200 bg-rose-50/70 p-3.5 text-[13px] text-rose-950 dark:border-rose-800/70 dark:bg-rose-950/40 dark:text-rose-200 space-y-1"
            >
              <div className="flex items-center gap-2 font-semibold">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>Sign-in service is unavailable</span>
              </div>
              <p className="leading-relaxed opacity-90">
                Account services are not yet configured for this installation. Please contact support or verify your application setup.
              </p>
            </div>
          )}

          {/* Offline Notice */}
          {isOffline && !isAuthBlockedByEnv && (
            <div
              role="status"
              data-testid="auth-offline-banner"
              className="mb-5 flex items-start gap-2.5 border border-amber-200 bg-amber-50/70 p-3.5 text-[13px] text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-0.5">
                <p className="font-semibold">You appear to be offline</p>
                <p className="opacity-90">
                  Connect to the internet to sign in, create an account, or reset your password. Your saved business records remain safely on this computer.
                </p>
              </div>
            </div>
          )}

          {/* Validation / Auth Feedback */}
          {bannerMessage && (
            <div
              role="alert"
              data-testid="auth-feedback-banner"
              className={`mb-5 flex items-start justify-between gap-2.5 border px-3.5 py-2.5 text-[13px] ${
                bannerIsInfo
                  ? 'border-emerald-200 bg-emerald-50/70 text-emerald-950 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200'
                  : bannerIsWarning
                    ? 'border-amber-200 bg-amber-50/70 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200'
                    : 'border-rose-200 bg-rose-50/70 text-rose-950 dark:border-rose-800/70 dark:bg-rose-950/40 dark:text-rose-200'
              }`}
            >
              <div className="flex items-start gap-2">
                {bannerIsInfo ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{bannerMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  clearNotice();
                }}
                aria-label="Dismiss message"
                className="p-0.5 opacity-75 hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* SIGN IN VIEW */}
          {mode === 'signin' && (
            <div className="space-y-5">
              <form onSubmit={handleSignInSubmit} noValidate className="space-y-4">
                <Input
                  id="auth-signin-email"
                  label="Email address"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  autoComplete="email"
                  required
                  disabled={isBusy || isAuthBlockedByEnv}
                  data-testid="auth-email-input"
                />

                <div className="space-y-1.5">
                  <PasswordField
                    id="auth-signin-password"
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    required
                    disabled={isBusy || isAuthBlockedByEnv}
                    testId="auth-password-input"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => switchMode('forgot')}
                      disabled={isBusy}
                      data-testid="auth-forgot-link"
                      className="text-[13px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      Forgot password?
                    </button>
                  </div>
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="w-full"
                  disabled={isBusy || isOffline || isAuthBlockedByEnv}
                  isLoading={isSubmitting}
                  data-testid="auth-submit-button"
                >
                  Sign In
                </Button>
              </form>

              <div className="relative flex items-center py-1">
                <div className="flex-grow border-t border-line" />
                <span className="mx-3 shrink text-[12px] uppercase tracking-wider text-ink-muted">
                  or
                </span>
                <div className="flex-grow border-t border-line" />
              </div>

              {isAuthenticating ? (
                <div className="space-y-3 border border-line bg-paper-sunken p-3.5 text-[13px]">
                  <div className="flex items-start gap-2.5 text-ink">
                    <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-indigo-600 dark:text-indigo-400" />
                    <div>
                      <p className="font-semibold">Waiting for Google sign-in...</p>
                      <p className="mt-0.5 text-ink-secondary">
                        Finish signing in with Google in your browser to return to Bizora.
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => void cancelPendingSignIn()}
                  >
                    Cancel Google Sign-In
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  className="w-full"
                  onClick={() => void handleGoogleSignIn()}
                  disabled={isBusy || isOffline || isAuthBlockedByEnv || !isDesktop}
                  leftIcon={<GoogleIcon />}
                  data-testid="auth-google-button"
                >
                  Continue with Google
                </Button>
              )}

              <div className="border-t border-line pt-4 text-center text-[14px] text-ink-secondary">
                Don&apos;t have an account?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('signup')}
                  disabled={isBusy}
                  data-testid="auth-switch-signup"
                  className="font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  Create an account
                </button>
              </div>
            </div>
          )}

          {/* CREATE ACCOUNT VIEW */}
          {mode === 'signup' && (
            <div className="space-y-5">
              {confirmationEmail ? (
                <div
                  data-testid="auth-signup-confirmation"
                  className="space-y-4 border border-emerald-200 bg-emerald-50/60 p-4 text-[14px] text-emerald-950 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200"
                >
                  <div className="flex items-start gap-2.5">
                    <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div className="space-y-1">
                      <p className="font-semibold">Confirm your email address</p>
                      <p className="text-[13px] leading-relaxed">
                        We sent a confirmation link to{' '}
                        <span className="font-semibold">{confirmationEmail}</span>. Verify your email before signing in to Bizora.
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    className="w-full"
                    onClick={() => switchMode('signin')}
                  >
                    Back to Sign In
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleSignUpSubmit} noValidate className="space-y-4">
                  <Input
                    id="auth-signup-name"
                    label="Full name"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Elena Shikongo"
                    autoComplete="name"
                    required
                    disabled={isBusy || isAuthBlockedByEnv}
                    data-testid="auth-fullname-input"
                  />

                  <Input
                    id="auth-signup-email"
                    label="Email address"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    autoComplete="email"
                    required
                    disabled={isBusy || isAuthBlockedByEnv}
                    data-testid="auth-email-input"
                  />

                  <PasswordField
                    id="auth-signup-password"
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                    autoComplete="new-password"
                    helperText={`Use at least ${MIN_PASSWORD_LENGTH} characters.`}
                    required
                    disabled={isBusy || isAuthBlockedByEnv}
                    testId="auth-password-input"
                  />

                  <PasswordField
                    id="auth-signup-confirm"
                    label="Confirm password"
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    placeholder="Re-enter your password"
                    autoComplete="new-password"
                    required
                    disabled={isBusy || isAuthBlockedByEnv}
                    testId="auth-confirm-password-input"
                  />

                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    className="w-full"
                    disabled={isBusy || isOffline || isAuthBlockedByEnv}
                    isLoading={isSubmitting}
                    data-testid="auth-submit-button"
                  >
                    Create Account
                  </Button>
                </form>
              )}

              <div className="border-t border-line pt-4 text-center text-[14px] text-ink-secondary">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('signin')}
                  disabled={isBusy}
                  data-testid="auth-switch-signin"
                  className="font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  Sign in
                </button>
              </div>
            </div>
          )}

          {/* FORGOT PASSWORD VIEW */}
          {mode === 'forgot' && (
            <div className="space-y-5">
              {resetSentToEmail ? (
                <div
                  data-testid="auth-reset-confirmation"
                  className="space-y-4 border border-emerald-200 bg-emerald-50/60 p-4 text-[14px] text-emerald-950 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200"
                >
                  <div className="flex items-start gap-2.5">
                    <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div className="space-y-1">
                      <p className="font-semibold">Reset instructions sent</p>
                      <p className="text-[13px] leading-relaxed">
                        If an account exists for{' '}
                        <span className="font-semibold">{resetSentToEmail}</span>, we sent a password reset link to your email. Open the link to return to Bizora and choose a new password.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      className="flex-1"
                      onClick={() => switchMode('signin')}
                    >
                      Back to Sign In
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setResetSentToEmail(null)}
                    >
                      Send Again
                    </Button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleForgotPasswordSubmit} noValidate className="space-y-4">
                  <Input
                    id="auth-forgot-email"
                    label="Account email address"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    autoComplete="email"
                    required
                    disabled={isBusy || isAuthBlockedByEnv}
                    data-testid="auth-email-input"
                  />

                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    className="w-full"
                    disabled={isBusy || isOffline || isAuthBlockedByEnv}
                    isLoading={isSubmitting}
                    data-testid="auth-submit-button"
                  >
                    Send Reset Link
                  </Button>
                </form>
              )}

              <div className="border-t border-line pt-4">
                <button
                  type="button"
                  onClick={() => switchMode('signin')}
                  disabled={isBusy}
                  data-testid="auth-back-signin"
                  className="inline-flex items-center gap-1.5 text-[14px] font-medium text-ink-secondary hover:text-ink"
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span>Back to Sign In</span>
                </button>
              </div>
            </div>
          )}

          {/* PASSWORD RECOVERY UPDATE VIEW */}
          {mode === 'recovery' && (
            <form onSubmit={handleRecoveryUpdateSubmit} noValidate className="space-y-4">
              <PasswordField
                id="auth-recovery-password"
                label="New password"
                value={password}
                onChange={setPassword}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                autoComplete="new-password"
                helperText={`Use at least ${MIN_PASSWORD_LENGTH} characters.`}
                required
                disabled={isBusy || isAuthBlockedByEnv}
                testId="auth-password-input"
              />

              <PasswordField
                id="auth-recovery-confirm"
                label="Confirm new password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                placeholder="Re-enter your new password"
                autoComplete="new-password"
                required
                disabled={isBusy || isAuthBlockedByEnv}
                testId="auth-confirm-password-input"
              />

              <Button
                type="submit"
                variant="primary"
                size="md"
                className="w-full"
                disabled={isBusy || isOffline || isAuthBlockedByEnv}
                isLoading={isSubmitting}
                data-testid="auth-submit-button"
              >
                Update Password &amp; Continue
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                disabled={isBusy}
                onClick={() => void cancelPasswordRecovery()}
              >
                Cancel &amp; Return to Sign In
              </Button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
};
