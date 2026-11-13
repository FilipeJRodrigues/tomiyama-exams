import { Amplify } from 'aws-amplify';
import {
  autoSignIn,
  confirmSignIn,
  confirmResetPassword,
  confirmSignUp,
  fetchAuthSession,
  resendSignUpCode,
  resetPassword,
  signIn,
  signOut,
  signUp,
} from 'aws-amplify/auth';

import type { CognitoConfig } from '../app/config';
import { normalizeEmail } from './email';
import {
  AuthError,
  isMasterFromGroups,
  roleFromGroups,
  type AuthService,
  type AuthUser,
  type SignInStep,
} from './types';

const TOO_MANY = 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
const NETWORK = 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.';
const INVALID_PASSWORD = 'A senha não atende aos requisitos: pelo menos 8 caracteres.';
const NOT_CONFIRMED = 'Confirme o e-mail antes de entrar.';
const ALREADY_CONFIRMED = 'Este e-mail já foi confirmado. Entre com seu e-mail e senha.';
const PASSWORD_RESET_REQUIRED = 'É preciso redefinir a senha antes de entrar.';
const RESET_NOT_CONFIRMED =
  'Este e-mail ainda não foi confirmado. Confirme o e-mail antes de redefinir a senha.';
const CODE_MISMATCH = 'Código incorreto.';

/** pt-BR messages for the Cognito errors the login can hit (by `error.name`). */
const COGNITO_MESSAGES: Record<string, string> = {
  NotAuthorizedException: 'E-mail ou senha incorretos.',
  UserNotFoundException: 'E-mail ou senha incorretos.',
  UserNotConfirmedException: NOT_CONFIRMED,
  PasswordResetRequiredException: PASSWORD_RESET_REQUIRED,
  InvalidPasswordException: INVALID_PASSWORD,
  LimitExceededException: TOO_MANY,
  TooManyRequestsException: TOO_MANY,
  TooManyFailedAttemptsException: TOO_MANY,
  EmptySignInUsername: 'Informe o e-mail.',
  EmptySignInPassword: 'Informe a senha.',
  EmptyConfirmSignInChallengeResponse: 'Informe a nova senha.',
  NetworkError: NETWORK,
};

/** pt-BR messages for the Cognito errors of the sign-up and its e-mail code. */
const SIGN_UP_MESSAGES: Record<string, string> = {
  UsernameExistsException: 'Já existe uma conta com este e-mail.',
  InvalidPasswordException: INVALID_PASSWORD,
  // Cognito answers this for a malformed e-mail (the screen already blocks a password
  // with spaces at the edges, the other case of this error).
  InvalidParameterException: 'Informe um e-mail válido.',
  CodeMismatchException: CODE_MISMATCH,
  ExpiredCodeException: 'Código expirado. Peça um novo.',
  CodeDeliveryFailureException: 'Não foi possível enviar o código por e-mail. Tente de novo.',
  LimitExceededException: TOO_MANY,
  TooManyRequestsException: TOO_MANY,
  TooManyFailedAttemptsException: TOO_MANY,
  EmptySignUpUsername: 'Informe o e-mail.',
  EmptySignUpPassword: 'Informe a senha.',
  EmptyConfirmSignUpUsername: 'Informe o e-mail.',
  EmptyConfirmSignUpCode: 'Informe o código.',
  EmptyResendSignUpCodeUsername: 'Informe o e-mail.',
  NetworkError: NETWORK,
};

/**
 * pt-BR messages for the Cognito errors of the password recovery. `UserNotFoundException`
 * never reaches the screen as such: step 1 treats it as success and step 2 as a wrong code,
 * so nobody learns whether an account exists (the pool also has PreventUserExistenceErrors).
 */
const RESET_MESSAGES: Record<string, string> = {
  CodeMismatchException: CODE_MISMATCH,
  UserNotFoundException: CODE_MISMATCH,
  ExpiredCodeException: 'Código expirado. Peça um novo.',
  InvalidPasswordException: INVALID_PASSWORD,
  CodeDeliveryFailureException: 'Não foi possível enviar o código por e-mail. Tente de novo.',
  // "User password cannot be reset in the current state" (temporary password not yet
  // changed) or "User is disabled".
  NotAuthorizedException:
    'Não é possível redefinir a senha desta conta. Se você recebeu uma senha temporária, entre com ela; se não, fale com a academia.',
  LimitExceededException: TOO_MANY,
  TooManyRequestsException: TOO_MANY,
  TooManyFailedAttemptsException: TOO_MANY,
  EmptyResetPasswordUsername: 'Informe o e-mail.',
  EmptyConfirmResetPasswordUsername: 'Informe o e-mail.',
  EmptyConfirmResetPasswordConfirmationCode: 'Informe o código.',
  EmptyConfirmResetPasswordNewPassword: 'Informe a nova senha.',
  NetworkError: NETWORK,
};

export const SIGN_UP_FALLBACK = 'Não foi possível criar a conta. Tente de novo.';
export const CONFIRM_SIGN_UP_FALLBACK = 'Não foi possível confirmar o e-mail. Tente de novo.';
export const RESEND_CODE_FALLBACK = 'Não foi possível reenviar o código. Tente de novo.';
export const RESET_PASSWORD_FALLBACK = 'Não foi possível enviar o código. Tente de novo.';
export const CONFIRM_RESET_FALLBACK = 'Não foi possível redefinir a senha. Tente de novo.';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

export function cognitoErrorMessage(error: unknown): string {
  return COGNITO_MESSAGES[errorName(error)] ?? 'Não foi possível entrar. Tente de novo.';
}

/** Message for a sign-up, confirmation or resend failure; `fallback` for the unknown ones. */
export function signUpErrorMessage(error: unknown, fallback: string): string {
  return SIGN_UP_MESSAGES[errorName(error)] ?? fallback;
}

function notConfirmed(): AuthError {
  return new AuthError(NOT_CONFIRMED, 'USER_NOT_CONFIRMED');
}

function passwordResetRequired(): AuthError {
  return new AuthError(PASSWORD_RESET_REQUIRED, 'PASSWORD_RESET_REQUIRED');
}

function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  if (errorName(error) === 'UserNotConfirmedException') return notConfirmed();
  if (errorName(error) === 'PasswordResetRequiredException') return passwordResetRequired();
  return new AuthError(cognitoErrorMessage(error));
}

/** Message for a failure of the password recovery; `fallback` for the unknown ones. */
export function resetErrorMessage(error: unknown, fallback: string): string {
  return RESET_MESSAGES[errorName(error)] ?? fallback;
}

function toResetError(error: unknown, fallback: string): AuthError {
  if (error instanceof AuthError) return error;
  // On `ForgotPassword`: the account has no verified e-mail, i.e. the sign-up code was never
  // entered. The sign-up already tells an existing e-mail apart, so this reveals nothing new.
  if (errorName(error) === 'InvalidParameterException') {
    return new AuthError(RESET_NOT_CONFIRMED, 'USER_NOT_CONFIRMED');
  }
  return new AuthError(resetErrorMessage(error, fallback));
}

function toSignUpError(error: unknown, fallback: string): AuthError {
  return error instanceof AuthError ? error : new AuthError(signUpErrorMessage(error, fallback));
}

/**
 * Cognito error that means "this account is already confirmed" in each operation:
 * `NotAuthorizedException` on `ConfirmSignUp` and `InvalidParameterException` ("User is
 * already confirmed.") on `ResendConfirmationCode`.
 */
function toCodeStepError(
  error: unknown,
  alreadyConfirmedName: string,
  fallback: string,
): AuthError {
  if (errorName(error) === alreadyConfirmedName) {
    return new AuthError(ALREADY_CONFIRMED, 'ALREADY_CONFIRMED');
  }
  return toSignUpError(error, fallback);
}

export function mapSignInStep(step: string): SignInStep {
  if (step === 'DONE') return 'DONE';
  if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return 'NEW_PASSWORD_REQUIRED';
  if (step === 'CONFIRM_SIGN_UP') throw notConfirmed();
  // Amplify v6 returns this step instead of throwing `PasswordResetRequiredException`
  // (password reset in the Cognito console); the login goes to the recovery code step.
  if (step === 'RESET_PASSWORD') throw passwordResetRequired();
  throw new AuthError('Este tipo de login ainda não é aceito pelo sistema.');
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Login through Amplify Auth (Cognito user pool). The region comes from the pool id. */
export function createCognitoAuth(config: CognitoConfig): AuthService {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.clientId,
        loginWith: { email: true },
      },
    },
  });

  async function currentUser(): Promise<AuthUser | null> {
    try {
      const session = await fetchAuthSession();
      const payload = session.tokens?.idToken?.payload;
      if (!payload || typeof payload.sub !== 'string') return null;
      const groups = stringList(payload['cognito:groups']);
      return {
        id: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : '',
        role: roleFromGroups(groups),
        isMaster: isMasterFromGroups(groups),
      };
    } catch {
      return null;
    }
  }

  async function attemptSignIn(email: string, password: string): Promise<SignInStep> {
    const result = await signIn({ username: normalizeEmail(email), password });
    return mapSignInStep(result.nextStep.signInStep);
  }

  return {
    supportsRoleChoice: false,

    getCurrentUser: currentUser,

    async signIn({ email, password }) {
      try {
        return await attemptSignIn(email, password);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'UserAlreadyAuthenticatedException') {
          throw toAuthError(error);
        }
      }
      // A stale session blocks a new sign-in: end it and try once more.
      try {
        await signOut();
        return await attemptSignIn(email, password);
      } catch (error) {
        throw toAuthError(error);
      }
    },

    async confirmNewPassword(newPassword) {
      try {
        const result = await confirmSignIn({ challengeResponse: newPassword });
        return mapSignInStep(result.nextStep.signInStep);
      } catch (error) {
        throw toAuthError(error);
      }
    },

    async signOut() {
      await signOut();
    },

    async signUp(email, password) {
      try {
        const username = normalizeEmail(email);
        // Amplify keeps the password in memory for `autoSignIn`; nothing goes to storage.
        await signUp({
          username,
          password,
          options: { userAttributes: { email: username }, autoSignIn: true },
        });
      } catch (error) {
        throw toSignUpError(error, SIGN_UP_FALLBACK);
      }
    },

    async confirmSignUp(email, code) {
      let signUpStep: string;
      try {
        const result = await confirmSignUp({
          username: normalizeEmail(email),
          confirmationCode: code.trim(),
        });
        signUpStep = result.nextStep.signUpStep;
      } catch (error) {
        throw toCodeStepError(error, 'NotAuthorizedException', CONFIRM_SIGN_UP_FALLBACK);
      }
      // No automatic sign-in when the sign-up did not start in this page (e.g. the user
      // came from the login): the account is confirmed and the login asks for the password.
      if (signUpStep !== 'COMPLETE_AUTO_SIGN_IN') return 'SIGN_IN_REQUIRED';
      try {
        const result = await autoSignIn();
        return result.nextStep.signInStep === 'DONE' ? 'SIGNED_IN' : 'SIGN_IN_REQUIRED';
      } catch {
        // The account is confirmed anyway; the login screen takes over.
        return 'SIGN_IN_REQUIRED';
      }
    },

    async resendSignUpCode(email) {
      try {
        await resendSignUpCode({ username: normalizeEmail(email) });
      } catch (error) {
        throw toCodeStepError(error, 'InvalidParameterException', RESEND_CODE_FALLBACK);
      }
    },

    async resetPassword(email) {
      try {
        await resetPassword({ username: normalizeEmail(email) });
      } catch (error) {
        // Same answer as a known e-mail (the pool's PreventUserExistenceErrors already does
        // this; kept here in case the setting changes).
        if (errorName(error) === 'UserNotFoundException') return;
        throw toResetError(error, RESET_PASSWORD_FALLBACK);
      }
    },

    async confirmResetPassword(email, code, newPassword) {
      try {
        await confirmResetPassword({
          username: normalizeEmail(email),
          confirmationCode: code.trim(),
          newPassword,
        });
      } catch (error) {
        // Not the "e-mail not confirmed" reading: step 2 sends only a code and a password.
        if (errorName(error) === 'InvalidParameterException') {
          throw new AuthError(CONFIRM_RESET_FALLBACK);
        }
        throw toResetError(error, CONFIRM_RESET_FALLBACK);
      }
    },

    async getIdToken() {
      try {
        const session = await fetchAuthSession();
        return session.tokens?.idToken?.toString() ?? null;
      } catch {
        return null;
      }
    },
  };
}
