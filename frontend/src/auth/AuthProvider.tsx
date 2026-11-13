import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { forgetRecentWrites } from '../api/recentWrites';
import { AuthContext, type AuthContextValue, type AuthStatus } from './context';
import type { AuthService, AuthUser, SignInInput } from './types';

interface Props {
  service: AuthService;
  children: ReactNode;
}

export function AuthProvider({ service, children }: Props) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    const current = await service.getCurrentUser();
    setUser(current);
    setStatus(current ? 'signedIn' : 'signedOut');
  }, [service]);

  useEffect(() => {
    let active = true;
    void service.getCurrentUser().then((current) => {
      if (!active) return;
      setUser(current);
      setStatus(current ? 'signedIn' : 'signedOut');
    });
    return () => {
      active = false;
    };
  }, [service]);

  const signIn = useCallback(
    async (input: SignInInput) => {
      const step = await service.signIn(input);
      if (step === 'DONE') await refresh();
      return step;
    },
    [service, refresh],
  );

  const confirmNewPassword = useCallback(
    async (newPassword: string) => {
      const step = await service.confirmNewPassword(newPassword);
      if (step === 'DONE') await refresh();
      return step;
    },
    [service, refresh],
  );

  // Never rejects: callers ("Sair" and the 401 handler) fire and forget it, and the end
  // of session must finish even when the login service fails (e.g. a network error while
  // revoking the token; Amplify still drops the local tokens). The error is ignored on
  // purpose: nothing goes to the console (LGPD), and the user is signed out either way.
  const signOut = useCallback(async () => {
    try {
      await service.signOut();
    } catch {
      // See above.
    } finally {
      // Every end of session (Sair or a 401 from the API) drops the cached data, so the
      // next user of this browser never sees the previous one's students (LGPD).
      queryClient.clear();
      forgetRecentWrites(queryClient);
      setUser(null);
      setStatus('signedOut');
    }
  }, [service, queryClient]);

  const signUp = useCallback(
    (email: string, password: string) => service.signUp(email, password),
    [service],
  );

  const confirmSignUp = useCallback(
    async (email: string, code: string) => {
      const result = await service.confirmSignUp(email, code);
      if (result === 'SIGNED_IN') await refresh();
      return result;
    },
    [service, refresh],
  );

  const resendSignUpCode = useCallback(
    (email: string) => service.resendSignUpCode(email),
    [service],
  );

  const resetPassword = useCallback((email: string) => service.resetPassword(email), [service]);

  const confirmResetPassword = useCallback(
    (email: string, code: string, newPassword: string) =>
      service.confirmResetPassword(email, code, newPassword),
    [service],
  );

  const getIdToken = useCallback(() => service.getIdToken(), [service]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      supportsRoleChoice: service.supportsRoleChoice,
      signIn,
      confirmNewPassword,
      signOut,
      signUp,
      confirmSignUp,
      resendSignUpCode,
      resetPassword,
      confirmResetPassword,
      getIdToken,
    }),
    [
      status,
      user,
      service,
      signIn,
      confirmNewPassword,
      signOut,
      signUp,
      confirmSignUp,
      resendSignUpCode,
      resetPassword,
      confirmResetPassword,
      getIdToken,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
