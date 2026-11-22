import { useCallback, useEffect, useState } from 'react';
import {
  cloudAuthService,
  type CloudAuthResult,
  type CloudAuthSession,
  type CloudAuthState,
  type CloudSignUpInput,
  type CloudSignUpOutcome,
} from '../services/cloud';

export interface UseCloudAuthReturn {
  authState: CloudAuthState;
  isRestoringSession: boolean;
  signInWithGoogle: () => Promise<CloudAuthResult<{ authorizationUrl: string }>>;
  signInWithEmailPassword: (
    email: string,
    password: string
  ) => Promise<CloudAuthResult<CloudAuthSession>>;
  signUpWithEmailPassword: (
    input: CloudSignUpInput
  ) => Promise<CloudAuthResult<CloudSignUpOutcome>>;
  requestPasswordReset: (email: string) => Promise<CloudAuthResult<{ email: string }>>;
  updatePassword: (newPassword: string) => Promise<CloudAuthResult<CloudAuthSession>>;
  cancelPasswordRecovery: () => Promise<void>;
  signOut: () => Promise<CloudAuthResult>;
  refreshSession: () => Promise<CloudAuthResult<CloudAuthSession>>;
  cancelPendingSignIn: () => Promise<void>;
  clearNotice: () => void;
}

export function useCloudAuth(): UseCloudAuthReturn {
  const [authState, setAuthState] = useState<CloudAuthState>(() =>
    cloudAuthService.getSnapshot()
  );
  const [isRestoringSession, setIsRestoringSession] = useState<boolean>(true);

  useEffect(() => {
    let active = true;
    const unsubscribe = cloudAuthService.onAuthStateChange((nextState) => {
      if (active) {
        setAuthState(nextState);
      }
    });

    void cloudAuthService
      .initialize()
      .then((initialState) => {
        if (active) {
          setAuthState(initialState);
        }
      })
      .finally(() => {
        if (active) {
          setIsRestoringSession(false);
        }
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const signInWithGoogle = useCallback(() => cloudAuthService.signInWithGoogle(), []);
  const signInWithEmailPassword = useCallback(
    (email: string, password: string) =>
      cloudAuthService.signInWithEmailPassword(email, password),
    []
  );
  const signUpWithEmailPassword = useCallback(
    (input: CloudSignUpInput) => cloudAuthService.signUpWithEmailPassword(input),
    []
  );
  const requestPasswordReset = useCallback(
    (email: string) => cloudAuthService.requestPasswordReset(email),
    []
  );
  const updatePassword = useCallback(
    (newPassword: string) => cloudAuthService.updatePassword(newPassword),
    []
  );
  const cancelPasswordRecovery = useCallback(
    () => cloudAuthService.cancelPasswordRecovery(),
    []
  );
  const signOut = useCallback(() => cloudAuthService.signOut(), []);
  const refreshSession = useCallback(() => cloudAuthService.refreshSession(), []);
  const cancelPendingSignIn = useCallback(
    () => cloudAuthService.cancelPendingSignIn(),
    []
  );
  const clearNotice = useCallback(() => cloudAuthService.clearNotice(), []);

  return {
    authState,
    isRestoringSession,
    signInWithGoogle,
    signInWithEmailPassword,
    signUpWithEmailPassword,
    requestPasswordReset,
    updatePassword,
    cancelPasswordRecovery,
    signOut,
    refreshSession,
    cancelPendingSignIn,
    clearNotice,
  };
}
