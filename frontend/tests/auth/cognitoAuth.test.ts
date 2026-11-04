import { beforeEach, describe, expect, it, vi } from 'vitest';

const amplify = vi.hoisted(() => ({
  configure: vi.fn(),
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signOut: vi.fn(),
  fetchAuthSession: vi.fn(),
}));

vi.mock('aws-amplify', () => ({ Amplify: { configure: amplify.configure } }));
vi.mock('aws-amplify/auth', () => ({
  signIn: amplify.signIn,
  confirmSignIn: amplify.confirmSignIn,
  signOut: amplify.signOut,
  fetchAuthSession: amplify.fetchAuthSession,
}));

import { cognitoErrorMessage, createCognitoAuth } from '../../src/auth/cognitoAuth';

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

const config = { userPoolId: 'us-east-2_example', clientId: 'client-example' };

describe('createCognitoAuth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('configures Amplify with the pool and client ids', () => {
    createCognitoAuth(config);
    expect(amplify.configure).toHaveBeenCalledWith({
      Auth: {
        Cognito: {
          userPoolId: 'us-east-2_example',
          userPoolClientId: 'client-example',
          loginWith: { email: true },
        },
      },
    });
  });

  it('maps the first-login challenge to the new password step', async () => {
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });
    amplify.confirmSignIn.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    const auth = createCognitoAuth(config);

    await expect(auth.signIn({ email: ' prof@example.com ', password: 'Temp-123' })).resolves.toBe(
      'NEW_PASSWORD_REQUIRED',
    );
    expect(amplify.signIn).toHaveBeenCalledWith({
      username: 'prof@example.com',
      password: 'Temp-123',
    });
    await expect(auth.confirmNewPassword('Nova-senha-1')).resolves.toBe('DONE');
    expect(amplify.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: 'Nova-senha-1' });
  });

  it('refuses other challenges with a pt-BR message', async () => {
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' },
    });
    await expect(
      createCognitoAuth(config).signIn({ email: 'a@example.com', password: 'x' }),
    ).rejects.toThrow('Este tipo de login ainda não é aceito pelo sistema.');
  });

  it('translates a wrong password', async () => {
    amplify.signIn.mockRejectedValue(namedError('NotAuthorizedException'));
    await expect(
      createCognitoAuth(config).signIn({ email: 'a@example.com', password: 'x' }),
    ).rejects.toThrow('E-mail ou senha incorretos.');
  });

  it('ends a stale session and signs in again', async () => {
    amplify.signIn
      .mockRejectedValueOnce(namedError('UserAlreadyAuthenticatedException'))
      .mockResolvedValueOnce({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    await expect(
      createCognitoAuth(config).signIn({ email: 'a@example.com', password: 'x' }),
    ).resolves.toBe('DONE');
    expect(amplify.signOut).toHaveBeenCalledTimes(1);
  });

  it('reads the user and the profile from the ID token', async () => {
    amplify.fetchAuthSession.mockResolvedValue({
      tokens: {
        idToken: {
          payload: { sub: 'sub-1', email: 'prof@example.com', 'cognito:groups': ['admin'] },
          toString: () => 'id-token',
        },
      },
    });
    const auth = createCognitoAuth(config);
    await expect(auth.getCurrentUser()).resolves.toEqual({
      id: 'sub-1',
      email: 'prof@example.com',
      role: 'examiner',
      isMaster: false,
    });
    await expect(auth.getIdToken()).resolves.toBe('id-token');
  });

  it('has no user without tokens', async () => {
    amplify.fetchAuthSession.mockResolvedValue({ tokens: undefined });
    const auth = createCognitoAuth(config);
    await expect(auth.getCurrentUser()).resolves.toBeNull();
    await expect(auth.getIdToken()).resolves.toBeNull();
  });
});

describe('cognitoErrorMessage', () => {
  it('has a generic pt-BR fallback', () => {
    expect(cognitoErrorMessage(namedError('SomethingNew'))).toBe(
      'Não foi possível entrar. Tente de novo.',
    );
    expect(cognitoErrorMessage(namedError('UserNotConfirmedException'))).toBe(
      'Confirme o e-mail antes de entrar.',
    );
  });
});
