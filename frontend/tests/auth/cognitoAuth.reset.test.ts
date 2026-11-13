import { beforeEach, describe, expect, it, vi } from 'vitest';

const amplify = vi.hoisted(() => ({
  configure: vi.fn(),
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signOut: vi.fn(),
  fetchAuthSession: vi.fn(),
  resetPassword: vi.fn(),
  confirmResetPassword: vi.fn(),
}));

vi.mock('aws-amplify', () => ({ Amplify: { configure: amplify.configure } }));
vi.mock('aws-amplify/auth', () => ({
  signIn: amplify.signIn,
  confirmSignIn: amplify.confirmSignIn,
  signOut: amplify.signOut,
  fetchAuthSession: amplify.fetchAuthSession,
  resetPassword: amplify.resetPassword,
  confirmResetPassword: amplify.confirmResetPassword,
}));

import {
  CONFIRM_RESET_FALLBACK,
  RESET_PASSWORD_FALLBACK,
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
const NOT_ALLOWED =
  'Não é possível redefinir a senha desta conta. Se você recebeu uma senha temporária, entre com ela; se não, fale com a academia.';

describe('recuperação de senha pelo Cognito: envio do código', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('pede o código com o e-mail normalizado', async () => {
    amplify.resetPassword.mockResolvedValue({
      isPasswordReset: false,
      nextStep: { resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE' },
    });
    await createCognitoAuth(config).resetPassword(' Mae@Example.com ');
    expect(amplify.resetPassword).toHaveBeenCalledWith({ username: 'mae@example.com' });
  });

  it('responde como sucesso para um e-mail sem conta (UserNotFoundException)', async () => {
    amplify.resetPassword.mockRejectedValue(namedError('UserNotFoundException'));
    await expect(
      createCognitoAuth(config).resetPassword('ninguem@example.com'),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['LimitExceededException', TOO_MANY],
    ['TooManyRequestsException', TOO_MANY],
    ['TooManyFailedAttemptsException', TOO_MANY],
    ['CodeDeliveryFailureException', 'Não foi possível enviar o código por e-mail. Tente de novo.'],
    ['NotAuthorizedException', NOT_ALLOWED],
    ['EmptyResetPasswordUsername', 'Informe o e-mail.'],
    ['NetworkError', NETWORK],
    ['AlgoNovoException', RESET_PASSWORD_FALLBACK],
  ])('traduz %s no envio do código', async (name, message) => {
    amplify.resetPassword.mockRejectedValue(namedError(name));
    const attempt = createCognitoAuth(config).resetPassword('mae@example.com');
    await expect(attempt).rejects.toBeInstanceOf(AuthError);
    await expect(attempt).rejects.toThrow(message);
  });

  it('marca a conta sem e-mail confirmado (InvalidParameterException)', async () => {
    amplify.resetPassword.mockRejectedValue(namedError('InvalidParameterException'));
    const attempt = createCognitoAuth(config).resetPassword('mae@example.com');
    await expect(attempt).rejects.toMatchObject({
      code: 'USER_NOT_CONFIRMED',
      message:
        'Este e-mail ainda não foi confirmado. Confirme o e-mail antes de redefinir a senha.',
    });
  });
});

describe('recuperação de senha pelo Cognito: código e nova senha', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('confirma com o e-mail normalizado e o código sem espaços nas pontas', async () => {
    amplify.confirmResetPassword.mockResolvedValue(undefined);
    await createCognitoAuth(config).confirmResetPassword(
      ' Mae@Example.com',
      ' 123456 ',
      'senha-nova-1',
    );
    expect(amplify.confirmResetPassword).toHaveBeenCalledWith({
      username: 'mae@example.com',
      confirmationCode: '123456',
      newPassword: 'senha-nova-1',
    });
  });

  it.each([
    ['CodeMismatchException', 'Código incorreto.'],
    // Never says the account does not exist.
    ['UserNotFoundException', 'Código incorreto.'],
    ['ExpiredCodeException', 'Código expirado. Peça um novo.'],
    ['InvalidPasswordException', 'A senha não atende aos requisitos: pelo menos 8 caracteres.'],
    ['LimitExceededException', TOO_MANY],
    ['TooManyFailedAttemptsException', TOO_MANY],
    ['NotAuthorizedException', NOT_ALLOWED],
    ['InvalidParameterException', CONFIRM_RESET_FALLBACK],
    ['EmptyConfirmResetPasswordConfirmationCode', 'Informe o código.'],
    ['EmptyConfirmResetPasswordNewPassword', 'Informe a nova senha.'],
    ['NetworkError', NETWORK],
    ['AlgoNovoException', CONFIRM_RESET_FALLBACK],
  ])('traduz %s na troca da senha', async (name, message) => {
    amplify.confirmResetPassword.mockRejectedValue(namedError(name));
    const attempt = createCognitoAuth(config).confirmResetPassword(
      'mae@example.com',
      '123456',
      'senha-nova-1',
    );
    await expect(attempt).rejects.toBeInstanceOf(AuthError);
    await expect(attempt).rejects.toThrow(message);
  });
});

describe('login Cognito com senha redefinida pela academia', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('marca o passo RESET_PASSWORD do Amplify v6', async () => {
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'RESET_PASSWORD' },
    });
    await expect(
      createCognitoAuth(config).signIn({ email: 'mae@example.com', password: 'senha-teste' }),
    ).rejects.toMatchObject({
      code: 'PASSWORD_RESET_REQUIRED',
      message: 'É preciso redefinir a senha antes de entrar.',
    });
  });

  it('marca a PasswordResetRequiredException lançada', async () => {
    amplify.signIn.mockRejectedValue(namedError('PasswordResetRequiredException'));
    await expect(
      createCognitoAuth(config).signIn({ email: 'mae@example.com', password: 'senha-teste' }),
    ).rejects.toMatchObject({ code: 'PASSWORD_RESET_REQUIRED' });
  });
});
