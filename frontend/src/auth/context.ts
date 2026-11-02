import { createContext } from 'react';

import type { AuthUser, SignInInput, SignInStep } from './types';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  supportsRoleChoice: boolean;
  signIn: (input: SignInInput) => Promise<SignInStep>;
  confirmNewPassword: (newPassword: string) => Promise<SignInStep>;
  /** Ends the session; never rejects, even if the login service fails. */
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
