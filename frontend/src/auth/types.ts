/** Profiles: examiner = Cognito group `admin`; guardian = group `responsavel`. */
export type Role = 'examiner' | 'guardian';

export const EXAMINER_GROUP = 'admin';
export const GUARDIAN_GROUP = 'responsavel';

export interface AuthUser {
  /** Cognito `sub`; owner id of the students the user registers. */
  id: string;
  email: string;
  role: Role;
}

/** What the login screen does next. */
export type SignInStep = 'DONE' | 'NEW_PASSWORD_REQUIRED';

/**
 * Outcome of the e-mail confirmation: signed in automatically, or the account is
 * confirmed but the user still has to sign in (the automatic sign-in was not possible).
 */
export type ConfirmSignUpResult = 'SIGNED_IN' | 'SIGN_IN_REQUIRED';

export interface SignInInput {
  email: string;
  password: string;
  /** Simulated profile; only used when `supportsRoleChoice` is true. */
  role?: Role;
}

/**
 * Authentication used by the screens. Two implementations: Cognito (Amplify Auth)
 * and the simulated one used with `VITE_USE_MOCKS=true`.
 */
export interface AuthService {
  /** True for the simulated login, which lets the user pick the profile. */
  readonly supportsRoleChoice: boolean;
  getCurrentUser(): Promise<AuthUser | null>;
  signIn(input: SignInInput): Promise<SignInStep>;
  /** Second step of the first login: replace the temporary password. */
  confirmNewPassword(newPassword: string): Promise<SignInStep>;
  signOut(): Promise<void>;
  /** Open sign-up (creates a guardian); a 6-digit code goes to the e-mail. */
  signUp(email: string, password: string): Promise<void>;
  /** Confirm the e-mail with the code and sign in automatically when possible. */
  confirmSignUp(email: string, code: string): Promise<ConfirmSignUpResult>;
  resendSignUpCode(email: string): Promise<void>;
  /** ID token for the `Authorization` header; null when signed out. */
  getIdToken(): Promise<string | null>;
}

/** Failures the screens react to beyond showing the message. */
export type AuthErrorCode = 'USER_NOT_CONFIRMED' | 'ALREADY_CONFIRMED';

/** Authentication failure with a pt-BR message safe to show. */
export class AuthError extends Error {
  override name = 'AuthError';
  readonly code: AuthErrorCode | null;

  constructor(message: string, code: AuthErrorCode | null = null) {
    super(message);
    this.code = code;
  }
}

export const ROLE_LABELS: Record<Role, string> = {
  examiner: 'Examinador',
  guardian: 'Responsável',
};

export function roleFromGroups(groups: readonly string[]): Role {
  return groups.includes(EXAMINER_GROUP) ? 'examiner' : 'guardian';
}
