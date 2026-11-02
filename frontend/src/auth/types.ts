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
  /** ID token for the `Authorization` header; null when signed out. */
  getIdToken(): Promise<string | null>;
}

/** Authentication failure with a pt-BR message safe to show. */
export class AuthError extends Error {
  override name = 'AuthError';
}

export const ROLE_LABELS: Record<Role, string> = {
  examiner: 'Examinador',
  guardian: 'Responsável',
};

export function roleFromGroups(groups: readonly string[]): Role {
  return groups.includes(EXAMINER_GROUP) ? 'examiner' : 'guardian';
}
