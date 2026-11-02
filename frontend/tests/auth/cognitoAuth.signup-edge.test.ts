import { beforeEach, describe, expect, it, vi } from 'vitest';

const amplify = vi.hoisted(() => ({
  configure: vi.fn(),
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signOut: vi.fn(),
  fetchAuthSession: vi.fn(),
  signUp: vi.fn(),
  confirmSignUp: vi.fn(),
  resendSignUpCode: vi.fn(),
  autoSignIn: vi.fn(),
}));

vi.mock('aws-amplify', () => ({ Amplify: { configure: amplify.configure } }));
vi.mock('aws-amplify/auth', () => ({
  signIn: amplify.signIn,
  confirmSignIn: amplify.confirmSignIn,
  signOut: amplify.signOut,
  fetchAuthSession: amplify.fetchAuthSession,
  signUp: amplify.signUp,
  confirmSignUp: amplify.confirmSignUp,
  resendSignUpCode: amplify.resendSignUpCode,
  autoSignIn: amplify.autoSignIn,
}));

import { CONFIRM_SIGN_UP_FALLBACK, createCognitoAuth } from '../../src/auth/cognitoAuth';

const config = { userPoolId: 'us-east-2_example', clientId: 'client-example' };

describe('confirmação do cadastro pelo Cognito: casos de borda', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('não mostra o texto cru do gatilho PostConfirmation quando ele falha', async () => {
    const error = new Error('PostConfirmation failed with error boom.');
    error.name = 'UserLambdaValidationException';
    amplify.confirmSignUp.mockRejectedValue(error);
    const attempt = createCognitoAuth(config).confirmSignUp('mae@example.com', '123456');
    await expect(attempt).rejects.toThrow(CONFIRM_SIGN_UP_FALLBACK);
    await expect(attempt).rejects.not.toThrow(/PostConfirmation/);
    expect(amplify.autoSignIn).not.toHaveBeenCalled();
  });
});
