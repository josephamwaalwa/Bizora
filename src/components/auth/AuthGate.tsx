import React from 'react';
import { Loader2 } from 'lucide-react';
import { useCloudAuth } from '../../hooks/useCloudAuth';
import { resolveAuthGateView } from './authGateState';
import { AuthScreen } from './AuthScreen';

interface AuthGateProps {
  children: React.ReactNode;
}

export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const { authState, isRestoringSession } = useCloudAuth();
  const gateView = resolveAuthGateView(authState, isRestoringSession);

  if (gateView === 'initializing') {
    return (
      <div
        data-testid="auth-loading-screen"
        className="flex min-h-screen items-center justify-center bg-paper px-6 text-ink"
      >
        <div className="flex flex-col items-center text-center space-y-3 max-w-sm">
          <img src="/favicon.svg" alt="Bizora" className="h-10 w-10" />
          <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-600 dark:text-indigo-400" />
            <span>Opening Bizora...</span>
          </div>
          <p className="text-[13px] text-ink-secondary">
            Checking your sign-in status.
          </p>
        </div>
      </div>
    );
  }

  if (gateView === 'unauthenticated' || gateView === 'recovery') {
    return <AuthScreen />;
  }

  return <>{children}</>;
};
