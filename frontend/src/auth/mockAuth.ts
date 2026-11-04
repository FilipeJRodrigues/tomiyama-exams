import { normalizeEmail } from './email';
import {
  MOCK_EXISTING_EMAIL,
  MOCK_EXPIRED_CODE,
  MOCK_MASTER_EMAIL,
  MOCK_MASTER_ID,
  MOCK_SIGN_UP_CODE,
  MOCK_TEMPORARY_PASSWORD,
  MOCK_USER_IDS,
} from './mockConstants';
import { encodeMockToken } from './mockToken';
import {
  AuthError,
  EXAMINER_GROUP,
  GUARDIAN_GROUP,
  MASTER_GROUP,
  type AuthService,
  type AuthUser,
  type ConfirmSignUpResult,
  type Role,
  type SignInInput,
  type SignInStep,
} from './types';

export const MOCK_SESSION_KEY = 'tomiyama.mock-session';
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALREADY_CONFIRMED = 'Este e-mail já foi confirmado. Entre com seu e-mail e senha.';

function alreadyConfirmed(): AuthError {
  return new AuthError(ALREADY_CONFIRMED, 'ALREADY_CONFIRMED');
}

/** Same rules as the Cognito pool: at least 8 characters, no space at the edges. */
function passwordProblem(password: string): string | null {
  if (!password.trim()) return 'Informe a senha.';
  if (password !== password.trim()) return 'A senha não pode começar nem terminar com espaço.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  return null;
}

function isRole(value: unknown): value is Role {
  return value === 'examiner' || value === 'guardian';
}

/**
 * The simulated user of an e-mail and profile: `MOCK_MASTER_EMAIL` with the examiner profile
 * is the admin master; everyone else shares the fixed id of the profile.
 */
function mockUser(email: string, role: Role): AuthUser {
  if (role === 'examiner' && normalizeEmail(email) === MOCK_MASTER_EMAIL) {
    return { id: MOCK_MASTER_ID, email, role, isMaster: true };
  }
  return { id: MOCK_USER_IDS[role], email, role, isMaster: false };
}

/** Cognito groups of the simulated token, as the pool would put them. */
function groupsOf(user: AuthUser): string[] {
  if (user.role === 'guardian') return [GUARDIAN_GROUP];
  return user.isMaster ? [EXAMINER_GROUP, MASTER_GROUP] : [EXAMINER_GROUP];
}

function readStored(storage: Storage | null): AuthUser | null {
  if (!storage) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(MOCK_SESSION_KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.email !== 'string' || !isRole(record.role)) return null;
    return mockUser(record.email, record.role);
  } catch {
    return null;
  }
}

function defaultStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage;
}

/**
 * Simulated login: any e-mail signs in with the chosen profile (`MOCK_MASTER_EMAIL` as
 * examiner is the admin master). The session (e-mail and profile only) lives in
 * `sessionStorage`, so it ends when the tab closes.
 *
 * Simulated sign-up: the code is always `MOCK_SIGN_UP_CODE` (`MOCK_EXPIRED_CODE` simulates
 * an expired one) and `MOCK_EXISTING_EMAIL` already has an account. The accounts (e-mail
 * only, never the password) live in memory.
 */
export function createMockAuth(storage: Storage | null = defaultStorage()): AuthService {
  let user = readStored(storage);
  let pending: AuthUser | null = null;
  /** E-mails of the accounts waiting for the code. */
  const unconfirmed = new Set<string>();
  const confirmed = new Set<string>([MOCK_EXISTING_EMAIL]);

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
      if (unconfirmed.has(normalizeEmail(cleanEmail))) {
        return Promise.reject(
          new AuthError('Confirme o e-mail antes de entrar.', 'USER_NOT_CONFIRMED'),
        );
      }
      const next = mockUser(cleanEmail, role);
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

    signUp(email: string, password: string) {
      const key = normalizeEmail(email);
      if (!EMAIL_PATTERN.test(key)) {
        return Promise.reject(new AuthError('Informe um e-mail válido.'));
      }
      const problem = passwordProblem(password);
      if (problem) return Promise.reject(new AuthError(problem));
      if (confirmed.has(key) || unconfirmed.has(key)) {
        return Promise.reject(new AuthError('Já existe uma conta com este e-mail.'));
      }
      unconfirmed.add(key);
      return Promise.resolve();
    },

    confirmSignUp(email: string, code: string) {
      const key = normalizeEmail(email);
      const cleanCode = code.trim();
      if (!cleanCode) return Promise.reject(new AuthError('Informe o código.'));
      // Like Cognito (NotAuthorizedException): the account no longer takes a code.
      if (confirmed.has(key)) return Promise.reject(alreadyConfirmed());
      if (cleanCode === MOCK_EXPIRED_CODE) {
        return Promise.reject(new AuthError('Código expirado. Peça um novo.'));
      }
      // Like Cognito with PreventUserExistenceErrors: an unknown e-mail reads as a bad code.
      if (cleanCode !== MOCK_SIGN_UP_CODE || !unconfirmed.has(key)) {
        return Promise.reject(new AuthError('Código incorreto.'));
      }
      unconfirmed.delete(key);
      confirmed.add(key);
      finish(mockUser(email.trim(), 'guardian'));
      return Promise.resolve<ConfirmSignUpResult>('SIGNED_IN');
    },

    resendSignUpCode(email: string) {
      if (!EMAIL_PATTERN.test(normalizeEmail(email))) {
        return Promise.reject(new AuthError('Informe um e-mail válido.'));
      }
      // Like Cognito (InvalidParameterException "User is already confirmed.").
      if (confirmed.has(normalizeEmail(email))) return Promise.reject(alreadyConfirmed());
      return Promise.resolve();
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
          'cognito:groups': groupsOf(user),
        }),
      );
    },
  };
}
