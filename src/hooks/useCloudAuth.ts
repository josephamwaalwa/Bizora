import { useCallback, useEffect, useState } from 'react';
import {
  cloudAuthService,
  type CloudAuthResult,
  type CloudAuthSession,
  type CloudAuthState,
} from '../services/cloud';

export interface UseCloudAuthReturn {
  authState: CloudAuthState;
  isRestoringSession: boolean;
  signInWithGoogle: () => Promise<CloudAuthResult<{ authorizationUrl: string }>>;
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
    signOut,
    refreshSession,
    cancelPendingSignIn,
    clearNotice,
  };
}
