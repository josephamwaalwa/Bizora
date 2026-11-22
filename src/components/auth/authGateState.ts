import type { CloudAuthState } from '../../services/cloud';

export type AuthGateView = 'initializing' | 'recovery' | 'unauthenticated' | 'authenticated';

/**
 * Pure auth-gate resolver determining whether the desktop shell should show:
 * - 'initializing': startup credential/session restoration loader
 * - 'recovery': password reset update flow inside AuthScreen
 * - 'unauthenticated': Sign In / Create Account / Forgot Password inside AuthScreen
 * - 'authenticated': Main Bizora workspace (Dashboard, Quotations, Invoices, Clients, Settings)
 */
export function resolveAuthGateView(
  authState: Pick<CloudAuthState, 'isAuthenticated' | 'isPasswordRecovery' | 'status'>,
  isRestoringSession: boolean
): AuthGateView {
  if (isRestoringSession) {
    return 'initializing';
  }
  if (authState.isPasswordRecovery || authState.status === 'recovery') {
    return 'recovery';
  }
  if (authState.isAuthenticated) {
    return 'authenticated';
  }
  return 'unauthenticated';
}
