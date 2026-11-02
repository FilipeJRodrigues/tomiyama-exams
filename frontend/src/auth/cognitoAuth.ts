import { Amplify } from 'aws-amplify';
import { confirmSignIn, fetchAuthSession, signIn, signOut } from 'aws-amplify/auth';

import type { CognitoConfig } from '../app/config';
import {
  AuthError,
  roleFromGroups,
  type AuthService,
  type AuthUser,
  type SignInStep,
} from './types';

const TOO_MANY = 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';

/** pt-BR messages for the Cognito errors the login can hit (by `error.name`). */
const COGNITO_MESSAGES: Record<string, string> = {
  NotAuthorizedException: 'E-mail ou senha incorretos.',
  UserNotFoundException: 'E-mail ou senha incorretos.',
  UserNotConfirmedException: 'Confirme o e-mail antes de entrar.',
  PasswordResetRequiredException: 'É preciso redefinir a senha antes de entrar.',
  InvalidPasswordException: 'A senha não atende aos requisitos: pelo menos 8 caracteres.',
  LimitExceededException: TOO_MANY,
  TooManyRequestsException: TOO_MANY,
  TooManyFailedAttemptsException: TOO_MANY,
  EmptySignInUsername: 'Informe o e-mail.',
  EmptySignInPassword: 'Informe a senha.',
  EmptyConfirmSignInChallengeResponse: 'Informe a nova senha.',
  NetworkError: 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.',
};

/** Sign-in steps the app does not handle but can explain (by `nextStep.signInStep`). */
const SIGN_IN_STEP_MESSAGES: Record<string, string | undefined> = {
  CONFIRM_SIGN_UP: COGNITO_MESSAGES.UserNotConfirmedException,
  RESET_PASSWORD: COGNITO_MESSAGES.PasswordResetRequiredException,
};

export function cognitoErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return COGNITO_MESSAGES[name] ?? 'Não foi possível entrar. Tente de novo.';
}

function toAuthError(error: unknown): AuthError {
  return error instanceof AuthError ? error : new AuthError(cognitoErrorMessage(error));
}

export function mapSignInStep(step: string): SignInStep {
  if (step === 'DONE') return 'DONE';
  if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return 'NEW_PASSWORD_REQUIRED';
  // Amplify v6 returns these steps instead of throwing the matching Cognito exceptions.
  const message = SIGN_IN_STEP_MESSAGES[step];
  if (message) throw new AuthError(message);
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
      return {
        id: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : '',
        role: roleFromGroups(stringList(payload['cognito:groups'])),
      };
    } catch {
      return null;
    }
  }

  async function attemptSignIn(email: string, password: string): Promise<SignInStep> {
    const result = await signIn({ username: email.trim(), password });
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
