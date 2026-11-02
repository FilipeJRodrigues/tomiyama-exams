/**
 * Erro: no Amplify v6, `signIn` não lança `UserNotConfirmedException` nem
 * `PasswordResetRequiredException`: ele devolve `nextStep.signInStep` igual a
 * `CONFIRM_SIGN_UP` ou `RESET_PASSWORD` (`getSignInResultFromError` em
 * `@aws-amplify/auth`). `mapSignInStep` trata esses passos como desconhecidos e mostra
 * "Este tipo de login ainda não é aceito pelo sistema."; as mensagens de
 * `COGNITO_MESSAGES` para esses casos nunca aparecem.
 * Esperado: conta sem e-mail confirmado → "Confirme o e-mail antes de entrar.";
 * senha redefinida pelo examinador → "É preciso redefinir a senha antes de entrar."
 * (§ 6.1, login; § 2, contas).
 * Issue: -
 */
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

import { createCognitoAuth } from '../../src/auth/cognitoAuth';

const config = { userPoolId: 'us-east-2_example', clientId: 'client-example' };

describe('login Cognito com passos que o Amplify v6 devolve em vez de lançar', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('explica que falta confirmar o e-mail (CONFIRM_SIGN_UP)', async () => {
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_UP' },
    });
    await expect(
      createCognitoAuth(config).signIn({ email: 'mae@example.com', password: 'senha-teste' }),
    ).rejects.toThrow('Confirme o e-mail antes de entrar.');
  });

  it('explica que a senha precisa ser redefinida (RESET_PASSWORD)', async () => {
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'RESET_PASSWORD' },
    });
    await expect(
      createCognitoAuth(config).signIn({ email: 'prof@example.com', password: 'senha-teste' }),
    ).rejects.toThrow('É preciso redefinir a senha antes de entrar.');
  });
});
