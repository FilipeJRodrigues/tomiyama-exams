import type { LoginRedirectState } from '../../app/guards';

/**
 * Router state of the login and sign-up screens. The e-mail travels in router state
 * (memory), never in the URL.
 */
export interface LoginPageState extends LoginRedirectState {
  /** Set after the e-mail was confirmed but the automatic sign-in did not happen. */
  confirmedEmail?: string;
  /** Set after the password recovery: fills the e-mail and says the password changed. */
  passwordResetEmail?: string;
}

export interface SignUpPageState {
  /** Opens the sign-up at the code step, for an account waiting for confirmation. */
  confirmEmail?: string;
}

export interface ForgotPasswordPageState {
  /** Opens the recovery at the code step (code and new password) for this e-mail. */
  resetEmail?: string;
  /** With `resetEmail`: the login found a password reset by the academy, not a request. */
  resetRequired?: boolean;
  /** Fills the e-mail of the first step (typed in the login, or back from the code step). */
  draftEmail?: string;
}

function stringField(state: unknown, key: string): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const value = (state as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function confirmedEmailOf(state: unknown): string | null {
  return stringField(state, 'confirmedEmail' satisfies keyof LoginPageState);
}

export function passwordResetEmailOf(state: unknown): string | null {
  return stringField(state, 'passwordResetEmail' satisfies keyof LoginPageState);
}

export function resetEmailOf(state: unknown): string | null {
  return stringField(state, 'resetEmail' satisfies keyof ForgotPasswordPageState);
}

export function draftEmailOf(state: unknown): string | null {
  return stringField(state, 'draftEmail' satisfies keyof ForgotPasswordPageState);
}

export function resetRequiredOf(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  const key = 'resetRequired' satisfies keyof ForgotPasswordPageState;
  return (state as Record<string, unknown>)[key] === true;
}

export function confirmEmailOf(state: unknown): string | null {
  return stringField(state, 'confirmEmail' satisfies keyof SignUpPageState);
}
