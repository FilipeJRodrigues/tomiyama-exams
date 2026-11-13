import { createContext } from 'react';

import type { AuthUser, ConfirmSignUpResult, SignInInput, SignInStep } from './types';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  supportsRoleChoice: boolean;
  signIn: (input: SignInInput) => Promise<SignInStep>;
  confirmNewPassword: (newPassword: string) => Promise<SignInStep>;
  /** Ends the session; never rejects, even if the login service fails. */
  signOut: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  /** Confirms the e-mail; on `SIGNED_IN` the session is already loaded. */
  confirmSignUp: (email: string, code: string) => Promise<ConfirmSignUpResult>;
  resendSignUpCode: (email: string) => Promise<void>;
  /** Sends the recovery code; resolves the same way whether or not the account exists. */
  resetPassword: (email: string) => Promise<void>;
  confirmResetPassword: (email: string, code: string, newPassword: string) => Promise<void>;
  getIdToken: () => Promise<string | null>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
