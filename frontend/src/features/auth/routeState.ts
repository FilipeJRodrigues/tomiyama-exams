import type { LoginRedirectState } from '../../app/guards';

/**
 * Router state of the login and sign-up screens. The e-mail travels in router state
 * (memory), never in the URL.
 */
export interface LoginPageState extends LoginRedirectState {
  /** Set after the e-mail was confirmed but the automatic sign-in did not happen. */
  confirmedEmail?: string;
}

export interface SignUpPageState {
  /** Opens the sign-up at the code step, for an account waiting for confirmation. */
  confirmEmail?: string;
}

function stringField(state: unknown, key: string): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const value = (state as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function confirmedEmailOf(state: unknown): string | null {
  return stringField(state, 'confirmedEmail' satisfies keyof LoginPageState);
}

export function confirmEmailOf(state: unknown): string | null {
  return stringField(state, 'confirmEmail' satisfies keyof SignUpPageState);
}
