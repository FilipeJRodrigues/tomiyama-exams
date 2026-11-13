import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createMockAuth } from '../../src/auth/mockAuth';
import {
  MOCK_EXPIRED_CODE,
  MOCK_RESET_CODE,
  MOCK_RESET_REQUIRED_EMAIL,
} from '../../src/auth/mockConstants';
import type { AuthService } from '../../src/auth/types';
import { expectNoEnglish } from '../noEnglish';
import { renderApp, type RenderAppResult } from '../render';
import { setViewportWidth } from '../viewport';

const EMAIL = 'mae@example.com';
const NEW_PASSWORD = 'senha-nova-1';

async function requestCode({ user }: RenderAppResult, email = EMAIL) {
  const field = await screen.findByLabelText(/^E-mail/);
  await user.clear(field);
  if (email) await user.type(field, email);
  await user.click(screen.getByRole('button', { name: 'Enviar código' }));
}

async function reachResetStep(app: RenderAppResult) {
  await requestCode(app);
  return screen.findByRole('heading', { name: 'Crie uma nova senha' });
}

interface ResetInput {
  code?: string;
  password?: string;
  confirmation?: string;
}

async function fillReset({ user }: RenderAppResult, input: ResetInput = {}) {
  const { code = MOCK_RESET_CODE, password = NEW_PASSWORD, confirmation = password } = input;
  if (code) await user.type(screen.getByLabelText(/^Código/), code);
  if (password) await user.type(screen.getByLabelText(/^Nova senha/), password);
  if (confirmation) await user.type(screen.getByLabelText(/^Confirme a nova senha/), confirmation);
  await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
}

describe('recuperação de senha (§ 2, § 6.1): link no login', () => {
  it('leva do login à etapa do e-mail, com o e-mail digitado e o foco no título', async () => {
    const { user, router } = await renderApp({ route: '/entrar' });
    await user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
    const link = screen.getByRole('link', { name: 'Esqueci minha senha' });
    expect(link).toHaveStyle({ minHeight: '44px' });
    await user.click(link);

    const heading = await screen.findByRole('heading', { name: 'Recuperar senha' });
    expect(heading).toHaveFocus();
    expect(router.state.location.pathname).toBe('/recuperar-senha');
    // LGPD: the e-mail travels in router state, never in the URL.
    expect(router.state.location.search).toBe('');
    const field = screen.getByLabelText(/^E-mail/);
    expect(field).toHaveValue(EMAIL);
    expect(field).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByRole('button', { name: 'Enviar código' })).toHaveStyle({
      minHeight: '44px',
    });
    expectNoEnglish();
  });

  it('documenta o e-mail e o código simulados na tela de entrada', async () => {
    await renderApp({ route: '/entrar' });
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(MOCK_RESET_REQUIRED_EMAIL);
    expect(note).toHaveTextContent(MOCK_RESET_CODE);
  });

  it('volta ao login', async () => {
    const { user, router } = await renderApp({ route: '/recuperar-senha' });
    await user.click(await screen.findByRole('link', { name: 'Voltar para o login' }));
    expect(router.state.location.pathname).toBe('/entrar');
  });
});

describe('recuperação de senha: etapa do e-mail', () => {
  it('envia o código e mostra a resposta neutra na etapa do código', async () => {
    const app = await renderApp({ route: '/recuperar-senha' });
    const heading = await reachResetStep(app);

    expect(heading).toHaveFocus();
    expect(
      screen.getByText(`Se o e-mail estiver cadastrado, enviamos um código para ${EMAIL}.`),
    ).toBeInTheDocument();
    expect(screen.getByText(/e-mail em inglês/)).toHaveTextContent(
      'no-reply@verificationemail.com',
    );
    expect(screen.getByText(/e-mail em inglês/)).toHaveTextContent('spam');
    expect(screen.getByRole('note')).toHaveTextContent(MOCK_RESET_CODE);
    const code = screen.getByLabelText(/^Código/);
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByLabelText(/^Nova senha/)).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText(/^Confirme a nova senha/)).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    expect(app.router.state.location.search).toBe('');
    expectNoEnglish();
  });

  it.each([
    ['', 'Informe o e-mail.'],
    ['mae.example.com', 'Informe um e-mail válido.'],
  ])('valida o e-mail %j no cliente, ligado ao campo', async (email, message) => {
    const auth = createMockAuth(null);
    const resetPassword = vi.spyOn(auth, 'resetPassword');
    const app = await renderApp({ route: '/recuperar-senha', auth });
    await requestCode(app, email);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.closest('form')).toHaveAttribute('aria-describedby', alert.id);
    const field = screen.getByLabelText(/^E-mail/);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-errormessage', alert.id);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('pede o código uma vez só com cliques repetidos e Enter durante o envio', async () => {
    const base = createMockAuth(null);
    let finish: () => void = () => undefined;
    const resetPassword = vi.fn<AuthService['resetPassword']>(
      (email) =>
        new Promise<void>((resolve, reject) => {
          finish = () => {
            base.resetPassword(email).then(resolve, reject);
          };
        }),
    );
    const app = await renderApp({ route: '/recuperar-senha', auth: { ...base, resetPassword } });
    await requestCode(app);
    const button = screen.getByRole('button', { name: 'Enviar código' });
    await app.user.click(button);
    await app.user.type(screen.getByLabelText(/^E-mail/), '{Enter}');

    expect(resetPassword).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    finish();
    expect(await screen.findByRole('heading', { name: 'Crie uma nova senha' })).toBeInTheDocument();
  });

  it('funciona no celular (360 px)', async () => {
    setViewportWidth(360);
    const app = await renderApp({ route: '/recuperar-senha' });
    await reachResetStep(app);
    expect(screen.getByRole('button', { name: 'Salvar nova senha' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reenviar código' })).toBeVisible();
  });
});

describe('recuperação de senha: etapa do código e da nova senha', () => {
  it('troca a senha e volta ao login com aviso e o e-mail preenchido', async () => {
    const app = await renderApp({ route: '/recuperar-senha' });
    await reachResetStep(app);
    await fillReset(app);

    const heading = await screen.findByRole('heading', { name: 'Entrar' });
    expect(heading).toHaveFocus();
    expect(app.router.state.location.pathname).toBe('/entrar');
    expect(screen.getByRole('status')).toHaveTextContent('Senha alterada. Entre com a nova senha.');
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue(EMAIL);

    await app.user.type(screen.getByLabelText(/^Senha/), NEW_PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
  });

  it.each([
    ['999999', 'Código incorreto.'],
    [MOCK_EXPIRED_CODE, 'Código expirado. Peça um novo.'],
  ])('mostra o erro do código %s e fica na etapa', async (code, message) => {
    const app = await renderApp({ route: '/recuperar-senha' });
    await reachResetStep(app);
    await fillReset(app, { code });

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('heading', { name: 'Crie uma nova senha' })).toBeInTheDocument();
    expectNoEnglish();
  });

  it.each([
    [{ code: '12345' }, 'Informe o código de 6 dígitos.', /^Código/],
    [{ password: 'curta12' }, 'A senha precisa ter pelo menos 8 caracteres.', /^Nova senha/],
    [
      { password: ' senha-nova' },
      'A senha não pode começar nem terminar com espaço.',
      /^Nova senha/,
    ],
    [{ confirmation: 'outra-senha-1' }, 'As senhas não conferem.', /^Confirme a nova senha/],
  ])('valida %o no cliente, ligado ao campo', async (input, message, label) => {
    const auth = createMockAuth(null);
    const confirm = vi.spyOn(auth, 'confirmResetPassword');
    const app = await renderApp({ route: '/recuperar-senha', auth });
    await reachResetStep(app);
    await fillReset(app, input);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(screen.getByLabelText(label)).toHaveAttribute('aria-errormessage', alert.id);
    expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reenvia o código com aviso, uma vez só durante o envio', async () => {
    const base = createMockAuth(null);
    let finish: () => void = () => undefined;
    let calls = 0;
    // The first call (step 1) answers at once; the resend waits for `finish`.
    const resetPassword = vi.fn<AuthService['resetPassword']>((email) =>
      ++calls === 1
        ? base.resetPassword(email)
        : new Promise<void>((resolve, reject) => {
            finish = () => {
              base.resetPassword(email).then(resolve, reject);
            };
          }),
    );
    const app = await renderApp({ route: '/recuperar-senha', auth: { ...base, resetPassword } });
    await reachResetStep(app);

    const resend = screen.getByRole('button', { name: 'Reenviar código' });
    expect(resend).toHaveStyle({ minHeight: '44px' });
    expect(screen.getByRole('button', { name: 'Salvar nova senha' })).toHaveStyle({
      minHeight: '44px',
    });
    await app.user.click(resend);
    await app.user.click(resend);
    expect(resetPassword).toHaveBeenCalledTimes(2);
    expect(resend).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Salvar nova senha' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Trocar e-mail' })).toBeDisabled();

    finish();
    expect(await screen.findByRole('status')).toHaveTextContent(
      `Se o e-mail estiver cadastrado, enviamos um novo código para ${EMAIL}.`,
    );
    expect(resetPassword).toHaveBeenLastCalledWith(EMAIL);
  });

  it('troca a senha uma vez só com cliques repetidos', async () => {
    const base = createMockAuth(null);
    let finish: () => void = () => undefined;
    const confirmResetPassword = vi.fn<AuthService['confirmResetPassword']>(
      (email, code, password) =>
        new Promise<void>((resolve, reject) => {
          finish = () => {
            base.confirmResetPassword(email, code, password).then(resolve, reject);
          };
        }),
    );
    const app = await renderApp({
      route: '/recuperar-senha',
      auth: { ...base, confirmResetPassword },
    });
    await reachResetStep(app);
    await fillReset(app);
    await app.user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));

    expect(confirmResetPassword).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Reenviar código' })).toBeDisabled();
    finish();
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
  });

  it('volta à etapa do e-mail com o e-mail preenchido', async () => {
    const app = await renderApp({ route: '/recuperar-senha' });
    await reachResetStep(app);
    await app.user.click(screen.getByRole('button', { name: 'Trocar e-mail' }));

    const heading = await screen.findByRole('heading', { name: 'Recuperar senha' });
    expect(heading).toHaveFocus();
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue(EMAIL);
  });
});

describe('recuperação de senha: senha redefinida pela academia', () => {
  it('o login leva direto à etapa do código, com o e-mail e a orientação', async () => {
    const app = await renderApp({ route: '/entrar' });
    await app.user.type(await screen.findByLabelText(/^E-mail/), MOCK_RESET_REQUIRED_EMAIL);
    await app.user.type(screen.getByLabelText(/^Senha/), 'senha-antiga');
    await app.user.click(screen.getByRole('button', { name: 'Entrar' }));

    const heading = await screen.findByRole('heading', { name: 'Crie uma nova senha' });
    expect(heading).toHaveFocus();
    expect(app.router.state.location.pathname).toBe('/recuperar-senha');
    expect(screen.getByText('A academia redefiniu sua senha')).toBeInTheDocument();
    expect(screen.getByText(/quando a senha foi redefinida/)).toHaveTextContent(
      MOCK_RESET_REQUIRED_EMAIL,
    );
    expectNoEnglish();

    await fillReset(app);
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue(MOCK_RESET_REQUIRED_EMAIL);
    await app.user.type(screen.getByLabelText(/^Senha/), NEW_PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
  });

  it('o voltar do navegador leva de novo ao login', async () => {
    const app = await renderApp({ route: '/entrar' });
    await app.user.type(await screen.findByLabelText(/^E-mail/), MOCK_RESET_REQUIRED_EMAIL);
    await app.user.type(screen.getByLabelText(/^Senha/), 'senha-antiga');
    await app.user.click(screen.getByRole('button', { name: 'Entrar' }));
    await screen.findByRole('heading', { name: 'Crie uma nova senha' });

    await app.router.navigate(-1);
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
  });
});
