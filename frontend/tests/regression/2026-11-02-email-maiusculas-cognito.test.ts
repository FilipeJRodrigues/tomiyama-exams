/**
 * Erro: o serviço Cognito manda o e-mail como foi digitado (só sem espaços nas pontas):
 * "Mae@Example.com" vira o `username` e o atributo `email` com maiúsculas. O pool do
 * `infra/template.yaml` não define `UsernameConfiguration.CaseSensitive: false`, então o
 * Cognito compara o e-mail diferenciando maiúsculas: quem se cadastra como
 * "Mae@Example.com" não entra digitando "mae@example.com", e um segundo cadastro com
 * "mae@example.com" cria outro responsável. O login simulado (`mockAuth`) já normaliza
 * para minúsculas, por isso a suíte da tela não pega o erro.
 * Esperado: cadastro, confirmação, reenvio e login mandam o e-mail sem espaços e em
 * minúsculas, igual ao simulado (§ 6.1; § 2: conta por e-mail).
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
const TYPED = '  Mae@Example.COM ';
const EXPECTED = 'mae@example.com';

describe('e-mail com maiúsculas no Cognito (§ 6.1)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('cadastro', async () => {
    amplify.signUp.mockResolvedValue({
      isSignUpComplete: false,
      nextStep: { signUpStep: 'CONFIRM_SIGN_UP' },
    });
    await createCognitoAuth(config).signUp(TYPED, 'senha-forte-1');
    expect(amplify.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        username: EXPECTED,
        options: expect.objectContaining({ userAttributes: { email: EXPECTED } }) as unknown,
      }),
    );
  });

  it('confirmação', async () => {
    amplify.confirmSignUp.mockResolvedValue({
      isSignUpComplete: true,
      nextStep: { signUpStep: 'DONE' },
    });
    await createCognitoAuth(config).confirmSignUp(TYPED, '123456');
    expect(amplify.confirmSignUp).toHaveBeenCalledWith(
      expect.objectContaining({ username: EXPECTED }),
    );
  });

  it('reenvio do código', async () => {
    amplify.resendSignUpCode.mockResolvedValue({});
    await createCognitoAuth(config).resendSignUpCode(TYPED);
    expect(amplify.resendSignUpCode).toHaveBeenCalledWith({ username: EXPECTED });
  });

  it('login', async () => {
    amplify.signIn.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    await createCognitoAuth(config).signIn({ email: TYPED, password: 'senha-forte-1' });
    expect(amplify.signIn).toHaveBeenCalledWith(expect.objectContaining({ username: EXPECTED }));
  });
});
