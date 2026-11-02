/**
 * Erro: no passo "Confirme seu e-mail", "Reenviar código" para uma conta que já foi
 * confirmada (em outra aba, ou quando a resposta do primeiro "Confirmar" se perdeu ou o
 * gatilho PostConfirmation falhou depois de confirmar) mostra "Informe um e-mail válido.".
 * O Cognito responde `InvalidParameterException` ("User is already confirmed.") ao
 * `ResendConfirmationCode`, e `SIGN_UP_MESSAGES` traduz esse erro, em qualquer operação,
 * como e-mail malformado, mas o e-mail mostrado na tela é válido.
 * Esperado: no reenvio, a mensagem diz que o e-mail já foi confirmado e manda entrar com
 * e-mail e senha, como já acontece no "Confirmar" (`NotAuthorizedException`) (§ 6.1; § 2).
 * Issue: -
 */
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

import { createCognitoAuth } from '../../src/auth/cognitoAuth';

const config = { userPoolId: 'us-east-2_example', clientId: 'client-example' };

describe('reenvio do código para conta já confirmada (§ 6.1)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('não diz que o e-mail é inválido; diz que já foi confirmado', async () => {
    const error = new Error('User is already confirmed.');
    error.name = 'InvalidParameterException';
    amplify.resendSignUpCode.mockRejectedValue(error);

    const attempt = createCognitoAuth(config).resendSignUpCode('mae@example.com');
    await expect(attempt).rejects.not.toThrow('Informe um e-mail válido.');
    await expect(attempt).rejects.toThrow(
      'Este e-mail já foi confirmado. Entre com seu e-mail e senha.',
    );
  });
});
