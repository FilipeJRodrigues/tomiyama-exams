import { MOCK_TEMPORARY_PASSWORD, MOCK_USER_IDS } from './mockConstants';
import { encodeMockToken } from './mockToken';
import {
  AuthError,
  EXAMINER_GROUP,
  GUARDIAN_GROUP,
  type AuthService,
  type AuthUser,
  type Role,
  type SignInInput,
  type SignInStep,
} from './types';

export const MOCK_SESSION_KEY = 'tomiyama.mock-session';
const MIN_PASSWORD_LENGTH = 8;

function isRole(value: unknown): value is Role {
  return value === 'examiner' || value === 'guardian';
}

function readStored(storage: Storage | null): AuthUser | null {
  if (!storage) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(MOCK_SESSION_KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.email !== 'string' || !isRole(record.role)) return null;
    return { id: MOCK_USER_IDS[record.role], email: record.email, role: record.role };
  } catch {
    return null;
  }
}

function defaultStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage;
}

/**
 * Simulated login: any e-mail signs in with the chosen profile. The session (e-mail and
 * profile only) lives in `sessionStorage`, so it ends when the tab closes.
 */
export function createMockAuth(storage: Storage | null = defaultStorage()): AuthService {
  let user = readStored(storage);
  let pending: AuthUser | null = null;

  function finish(next: AuthUser): SignInStep {
    user = next;
    pending = null;
    storage?.setItem(MOCK_SESSION_KEY, JSON.stringify({ email: next.email, role: next.role }));
    return 'DONE';
  }

  return {
    supportsRoleChoice: true,

    getCurrentUser() {
      return Promise.resolve(user);
    },

    signIn({ email, password, role = 'examiner' }: SignInInput) {
      const cleanEmail = email.trim();
      if (!cleanEmail || !password) {
        return Promise.reject(new AuthError('Informe o e-mail e a senha.'));
      }
      const next: AuthUser = { id: MOCK_USER_IDS[role], email: cleanEmail, role };
      if (password === MOCK_TEMPORARY_PASSWORD) {
        pending = next;
        return Promise.resolve<SignInStep>('NEW_PASSWORD_REQUIRED');
      }
      return Promise.resolve(finish(next));
    },

    confirmNewPassword(newPassword: string) {
      if (!pending) {
        return Promise.reject(new AuthError('Entre de novo para definir a senha.'));
      }
      if (!newPassword.trim()) {
        return Promise.reject(new AuthError('Informe a nova senha.'));
      }
      if (newPassword !== newPassword.trim()) {
        // Same rule as Cognito: no space at the start or the end.
        return Promise.reject(new AuthError('A senha não pode começar nem terminar com espaço.'));
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return Promise.reject(
          new AuthError(`A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`),
        );
      }
      return Promise.resolve(finish(pending));
    },

    signOut() {
      user = null;
      pending = null;
      storage?.removeItem(MOCK_SESSION_KEY);
      return Promise.resolve();
    },

    getIdToken() {
      if (!user) return Promise.resolve(null);
      return Promise.resolve(
        encodeMockToken({
          sub: user.id,
          email: user.email,
          'cognito:groups': [user.role === 'examiner' ? EXAMINER_GROUP : GUARDIAN_GROUP],
        }),
      );
    },
  };
}
