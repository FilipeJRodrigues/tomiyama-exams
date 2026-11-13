import { screen } from '@testing-library/react';
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

import { createCognitoAuth } from '../../src/auth/cognitoAuth';
import { expectNoEnglish } from '../noEnglish';
import { renderApp, type RenderAppResult } from '../render';

const config = { userPoolId: 'us-east-2_example', clientId: 'client-example' };
const EMAIL = 'mae@example.com';
const TOO_MANY = 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
const NETWORK = 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.';

/** A Cognito error as Amplify throws it: English message, the type in `name`. */
function cognitoError(name: string, message = 'Something went wrong, please try again.'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function renderWithCognito(route = '/recuperar-senha') {
  return renderApp({ route, auth: createCognitoAuth(config) });
}

async function requestCode({ user }: RenderAppResult) {
  await user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
  await user.click(screen.getByRole('button', { name: 'Enviar código' }));
}

async function fillReset({ user }: RenderAppResult) {
  await user.type(screen.getByLabelText(/^Código/), '123456');
  await user.type(screen.getByLabelText(/^Nova senha/), 'senha-nova-1');
  await user.type(screen.getByLabelText(/^Confirme a nova senha/), 'senha-nova-1');
  await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
}

describe('recuperação de senha com o Cognito: etapa do e-mail', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    amplify.fetchAuthSession.mockResolvedValue({});
    amplify.resetPassword.mockResolvedValue({
      isPasswordReset: false,
      nextStep: { resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE' },
    });
  });

  it('e-mail sem conta (UserNotFoundException) tem a mesma resposta neutra', async () => {
    amplify.resetPassword.mockRejectedValue(
      cognitoError('UserNotFoundException', 'Username/client id combination not found.'),
    );
    const app = await renderWithCognito();
    await requestCode(app);

    expect(await screen.findByRole('heading', { name: 'Crie uma nova senha' })).toHaveFocus();
    expect(
      screen.getByText(`Se o e-mail estiver cadastrado, enviamos um código para ${EMAIL}.`),
    ).toBeInTheDocument();
    expect(amplify.resetPassword).toHaveBeenCalledWith({ username: EMAIL });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expectNoEnglish();
  });

  it.each([
    ['LimitExceededException', TOO_MANY],
    ['TooManyRequestsException', TOO_MANY],
    ['NetworkError', NETWORK],
    ['AlgoNovoException', 'Não foi possível enviar o código. Tente de novo.'],
  ])('mostra %s em pt-BR e fica na etapa do e-mail', async (name, message) => {
    amplify.resetPassword.mockRejectedValue(cognitoError(name));
    const app = await renderWithCognito();
    await requestCode(app);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('heading', { name: 'Recuperar senha' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^E-mail/)).not.toHaveAttribute('aria-invalid');
    expectNoEnglish();
  });

  it('conta sem e-mail confirmado oferece a confirmação do cadastro', async () => {
    amplify.resetPassword.mockRejectedValue(
      cognitoError(
        'InvalidParameterException',
        'Cannot reset password for the user as there is no registered/verified email or phone_number',
      ),
    );
    const app = await renderWithCognito();
    await requestCode(app);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Este e-mail ainda não foi confirmado. Confirme o e-mail antes de redefinir a senha.',
    );
    expectNoEnglish();
    await app.user.click(screen.getByRole('link', { name: 'Confirmar e-mail' }));
    expect(await screen.findByRole('heading', { name: 'Confirme seu e-mail' })).toBeInTheDocument();
    expect(app.router.state.location.pathname).toBe('/cadastro');
  });

  it('conta com senha temporária (NotAuthorizedException) explica o que fazer', async () => {
    amplify.resetPassword.mockRejectedValue(
      cognitoError('NotAuthorizedException', 'User password cannot be reset in the current state.'),
    );
    const app = await renderWithCognito();
    await requestCode(app);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Se você recebeu uma senha temporária, entre com ela',
    );
    expectNoEnglish();
  });
});

describe('recuperação de senha com o Cognito: etapa do código', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    amplify.fetchAuthSession.mockResolvedValue({});
    amplify.resetPassword.mockResolvedValue({
      isPasswordReset: false,
      nextStep: { resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE' },
    });
  });

  it.each([
    ['CodeMismatchException', 'Código incorreto.'],
    ['ExpiredCodeException', 'Código expirado. Peça um novo.'],
    ['InvalidPasswordException', 'A senha não atende aos requisitos: pelo menos 8 caracteres.'],
    ['TooManyFailedAttemptsException', TOO_MANY],
    ['NetworkError', NETWORK],
  ])('mostra %s em pt-BR e fica na etapa', async (name, message) => {
    amplify.confirmResetPassword.mockRejectedValue(cognitoError(name));
    const app = await renderWithCognito();
    await requestCode(app);
    await screen.findByRole('heading', { name: 'Crie uma nova senha' });
    await fillReset(app);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('heading', { name: 'Crie uma nova senha' })).toBeInTheDocument();
    expectNoEnglish();
  });

  it('troca a senha e volta ao login com o e-mail', async () => {
    amplify.confirmResetPassword.mockResolvedValue(undefined);
    const app = await renderWithCognito();
    await requestCode(app);
    await screen.findByRole('heading', { name: 'Crie uma nova senha' });
    await fillReset(app);

    expect(await screen.findByRole('heading', { name: 'Entrar' })).toHaveFocus();
    expect(amplify.confirmResetPassword).toHaveBeenCalledWith({
      username: EMAIL,
      confirmationCode: '123456',
      newPassword: 'senha-nova-1',
    });
    expect(screen.getByRole('status')).toHaveTextContent('Senha alterada.');
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue(EMAIL);
    expectNoEnglish();
  });
});

describe('login com o Cognito: senha redefinida pela academia', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    amplify.fetchAuthSession.mockResolvedValue({});
  });

  it('o passo RESET_PASSWORD leva à etapa do código sem pedir um código novo', async () => {
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'RESET_PASSWORD' },
    });
    const app = await renderWithCognito('/entrar');
    await app.user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
    await app.user.type(screen.getByLabelText(/^Senha/), 'senha-antiga');
    await app.user.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('heading', { name: 'Crie uma nova senha' })).toHaveFocus();
    expect(screen.getByText(/quando a senha foi redefinida/)).toHaveTextContent(EMAIL);
    // The console reset already e-mailed a code; a new one only on "Reenviar código".
    expect(amplify.resetPassword).not.toHaveBeenCalled();
    expectNoEnglish();
  });
});
