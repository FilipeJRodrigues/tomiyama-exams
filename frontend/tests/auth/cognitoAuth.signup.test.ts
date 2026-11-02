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

import {
  CONFIRM_SIGN_UP_FALLBACK,
  RESEND_CODE_FALLBACK,
  SIGN_UP_FALLBACK,
  createCognitoAuth,
} from '../../src/auth/cognitoAuth';
import { AuthError } from '../../src/auth/types';

function namedError(name: string): Error {
  const error = new Error(`raw ${name}`);
  error.name = name;
  return error;
}

const config = { userPoolId: 'us-east-2_example', clientId: 'client-example' };
const TOO_MANY = 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
const NETWORK = 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.';

describe('cadastro pelo Cognito', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('cria a conta com o e-mail como atributo e o login automático ligado', async () => {
    amplify.signUp.mockResolvedValue({
      isSignUpComplete: false,
      nextStep: { signUpStep: 'CONFIRM_SIGN_UP' },
    });
    await createCognitoAuth(config).signUp(' mae@example.com ', 'senha-forte-1');
    expect(amplify.signUp).toHaveBeenCalledWith({
      username: 'mae@example.com',
      password: 'senha-forte-1',
      options: { userAttributes: { email: 'mae@example.com' }, autoSignIn: true },
    });
  });

  it.each([
    ['UsernameExistsException', 'Já existe uma conta com este e-mail.'],
    ['InvalidPasswordException', 'A senha não atende aos requisitos: pelo menos 8 caracteres.'],
    ['InvalidParameterException', 'Informe um e-mail válido.'],
    ['LimitExceededException', TOO_MANY],
    ['TooManyRequestsException', TOO_MANY],
    ['NetworkError', NETWORK],
    ['AlgoNovoException', SIGN_UP_FALLBACK],
  ])('traduz %s no cadastro', async (name, message) => {
    amplify.signUp.mockRejectedValue(namedError(name));
    const attempt = createCognitoAuth(config).signUp('mae@example.com', 'senha-forte-1');
    await expect(attempt).rejects.toBeInstanceOf(AuthError);
    await expect(attempt).rejects.toThrow(message);
  });

  it.each([
    ['CodeMismatchException', 'Código incorreto.'],
    ['ExpiredCodeException', 'Código expirado. Peça um novo.'],
    ['LimitExceededException', TOO_MANY],
    ['TooManyFailedAttemptsException', TOO_MANY],
    ['NetworkError', NETWORK],
    ['AlgoNovoException', CONFIRM_SIGN_UP_FALLBACK],
  ])('traduz %s na confirmação', async (name, message) => {
    amplify.confirmSignUp.mockRejectedValue(namedError(name));
    await expect(
      createCognitoAuth(config).confirmSignUp('mae@example.com', '123456'),
    ).rejects.toThrow(message);
    expect(amplify.autoSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ['LimitExceededException', TOO_MANY],
    ['CodeDeliveryFailureException', 'Não foi possível enviar o código por e-mail. Tente de novo.'],
    ['NetworkError', NETWORK],
    ['AlgoNovoException', RESEND_CODE_FALLBACK],
  ])('traduz %s no reenvio do código', async (name, message) => {
    amplify.resendSignUpCode.mockRejectedValue(namedError(name));
    await expect(createCognitoAuth(config).resendSignUpCode('mae@example.com')).rejects.toThrow(
      message,
    );
  });

  it('reenvia o código para o e-mail sem espaços', async () => {
    amplify.resendSignUpCode.mockResolvedValue({});
    await createCognitoAuth(config).resendSignUpCode(' mae@example.com ');
    expect(amplify.resendSignUpCode).toHaveBeenCalledWith({ username: 'mae@example.com' });
  });

  it('confirma o código e entra automaticamente', async () => {
    amplify.confirmSignUp.mockResolvedValue({
      isSignUpComplete: true,
      nextStep: { signUpStep: 'COMPLETE_AUTO_SIGN_IN' },
    });
    amplify.autoSignIn.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    await expect(
      createCognitoAuth(config).confirmSignUp(' mae@example.com ', ' 123456 '),
    ).resolves.toBe('SIGNED_IN');
    expect(amplify.confirmSignUp).toHaveBeenCalledWith({
      username: 'mae@example.com',
      confirmationCode: '123456',
    });
    expect(amplify.autoSignIn).toHaveBeenCalledTimes(1);
  });

  it('pede o login quando o login automático falha', async () => {
    amplify.confirmSignUp.mockResolvedValue({
      isSignUpComplete: true,
      nextStep: { signUpStep: 'COMPLETE_AUTO_SIGN_IN' },
    });
    amplify.autoSignIn.mockRejectedValue(namedError('AutoSignInException'));
    await expect(
      createCognitoAuth(config).confirmSignUp('mae@example.com', '123456'),
    ).resolves.toBe('SIGN_IN_REQUIRED');
  });

  it('pede o login quando o login automático pede outro passo', async () => {
    amplify.confirmSignUp.mockResolvedValue({
      isSignUpComplete: true,
      nextStep: { signUpStep: 'COMPLETE_AUTO_SIGN_IN' },
    });
    amplify.autoSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' },
    });
    await expect(
      createCognitoAuth(config).confirmSignUp('mae@example.com', '123456'),
    ).resolves.toBe('SIGN_IN_REQUIRED');
  });

  it('pede o login quando o cadastro não começou nesta página (veio do login)', async () => {
    amplify.confirmSignUp.mockResolvedValue({
      isSignUpComplete: true,
      nextStep: { signUpStep: 'DONE' },
    });
    await expect(
      createCognitoAuth(config).confirmSignUp('mae@example.com', '123456'),
    ).resolves.toBe('SIGN_IN_REQUIRED');
    expect(amplify.autoSignIn).not.toHaveBeenCalled();
  });

  it('marca o login de conta sem e-mail confirmado, para a tela oferecer a confirmação', async () => {
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_UP' },
    });
    await expect(
      createCognitoAuth(config).signIn({ email: 'mae@example.com', password: 'senha-forte-1' }),
    ).rejects.toMatchObject({
      message: 'Confirme o e-mail antes de entrar.',
      code: 'USER_NOT_CONFIRMED',
    });

    amplify.signIn.mockRejectedValue(namedError('UserNotConfirmedException'));
    await expect(
      createCognitoAuth(config).signIn({ email: 'mae@example.com', password: 'senha-forte-1' }),
    ).rejects.toMatchObject({ code: 'USER_NOT_CONFIRMED' });
  });
});
