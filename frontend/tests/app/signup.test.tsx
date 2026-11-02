import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createMockAuth } from '../../src/auth/mockAuth';
import {
  MOCK_EXISTING_EMAIL,
  MOCK_EXPIRED_CODE,
  MOCK_SIGN_UP_CODE,
} from '../../src/auth/mockConstants';
import type { AuthService, ConfirmSignUpResult } from '../../src/auth/types';
import { renderApp, type RenderAppResult } from '../render';
import { setViewportWidth } from '../viewport';

const EMAIL = 'mae@example.com';
const PASSWORD = 'senha-forte-1';

interface AccountInput {
  email?: string;
  password?: string;
  confirmation?: string;
}

async function fillAccount({ user }: RenderAppResult, input: AccountInput = {}) {
  const { email = EMAIL, password = PASSWORD, confirmation = password } = input;
  const emailField = await screen.findByLabelText(/^E-mail/);
  await user.clear(emailField);
  if (email) await user.type(emailField, email);
  await user.clear(screen.getByLabelText(/^Senha/));
  if (password) await user.type(screen.getByLabelText(/^Senha/), password);
  await user.clear(screen.getByLabelText(/^Confirme a senha/));
  if (confirmation) await user.type(screen.getByLabelText(/^Confirme a senha/), confirmation);
  await user.click(screen.getByRole('button', { name: 'Criar conta' }));
}

async function reachConfirmStep(app: RenderAppResult) {
  await fillAccount(app);
  return screen.findByRole('heading', { name: 'Confirme seu e-mail' });
}

describe('cadastro de responsável (§ 6.1): passo do e-mail e senha', () => {
  it.each([
    [{ email: '' }, 'Informe o e-mail.'],
    [{ email: 'mae.example.com' }, 'Informe um e-mail válido.'],
    [{ password: '', confirmation: '' }, 'Informe a senha.'],
    [{ password: '        ' }, 'Informe a senha.'],
    [{ password: 'curta12' }, 'A senha precisa ter pelo menos 8 caracteres.'],
    [{ password: ' senha-forte' }, 'A senha não pode começar nem terminar com espaço.'],
    [{ confirmation: 'outra-senha-1' }, 'As senhas não conferem.'],
  ])('valida %o no cliente', async (input, message) => {
    const auth = createMockAuth(null);
    const signUp = vi.spyOn(auth, 'signUp');
    const app = await renderApp({ route: '/cadastro', auth });
    await fillAccount(app, input);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.closest('form')).toHaveAttribute('aria-describedby', alert.id);
    expect(screen.getByRole('heading', { name: 'Cadastre-se' })).toBeInTheDocument();
    expect(signUp).not.toHaveBeenCalled();
  });

  it('cria a conta e vai para o código, com o foco no título', async () => {
    const app = await renderApp({ route: '/cadastro' });
    const heading = await reachConfirmStep(app);

    expect(heading).toHaveFocus();
    expect(screen.getByText(`Enviamos um código para ${EMAIL}.`)).toBeInTheDocument();
    const code = screen.getByLabelText(/^Código/);
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(app.router.state.location.pathname).toBe('/cadastro');
    // LGPD: the e-mail never goes to the URL.
    expect(app.router.state.location.search).toBe('');
  });

  it('mostra o erro de conta existente', async () => {
    const app = await renderApp({ route: '/cadastro' });
    await fillAccount(app, { email: MOCK_EXISTING_EMAIL });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Já existe uma conta com este e-mail.',
    );
    expect(screen.getByRole('heading', { name: 'Cadastre-se' })).toBeInTheDocument();
  });

  it('cria a conta uma vez só com cliques repetidos e Enter durante o envio', async () => {
    const base = createMockAuth(null);
    let finish: () => void = () => undefined;
    const signUp = vi.fn<AuthService['signUp']>(
      (email, password) =>
        new Promise<void>((resolve, reject) => {
          finish = () => {
            base.signUp(email, password).then(resolve, reject);
          };
        }),
    );
    const app = await renderApp({ route: '/cadastro', auth: { ...base, signUp } });
    await fillAccount(app);
    const button = screen.getByRole('button', { name: 'Criar conta' });
    await app.user.click(button);
    await app.user.type(screen.getByLabelText(/^Confirme a senha/), '{Enter}');

    expect(signUp).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    finish();
    expect(await screen.findByRole('heading', { name: 'Confirme seu e-mail' })).toBeInTheDocument();
  });

  it('mostra a dica do modo simulado', async () => {
    await renderApp({ route: '/cadastro' });
    expect(await screen.findByRole('note')).toHaveTextContent(MOCK_EXISTING_EMAIL);
  });
});

describe('cadastro de responsável (§ 6.1): passo do código', () => {
  it('confirma o código, entra como responsável e vai para a tela inicial', async () => {
    const app = await renderApp({ route: '/cadastro' });
    await reachConfirmStep(app);
    expect(screen.getByRole('note')).toHaveTextContent(MOCK_SIGN_UP_CODE);

    await app.user.type(screen.getByLabelText(/^Código/), MOCK_SIGN_UP_CODE);
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
    expect(app.router.state.location.pathname).toBe('/alunos');
    const menu = screen.getByRole('navigation', { name: 'Menu principal' });
    expect(menu).toHaveTextContent('Responsável');
    expect(within(menu).queryByRole('link', { name: 'Faixas' })).not.toBeInTheDocument();
  });

  it.each([
    ['999999', 'Código incorreto.'],
    [MOCK_EXPIRED_CODE, 'Código expirado. Peça um novo.'],
    ['12a45', 'Informe o código de 6 dígitos.'],
  ])('mostra o erro do código %s', async (code, message) => {
    const app = await renderApp({ route: '/cadastro' });
    await reachConfirmStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), code);
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.closest('form')).toHaveAttribute('aria-describedby', alert.id);
    expect(screen.getByRole('heading', { name: 'Confirme seu e-mail' })).toBeInTheDocument();
  });

  it('reenvia o código com aviso e uma vez só com clique duplo', async () => {
    const base = createMockAuth(null);
    let finish: () => void = () => undefined;
    const finishGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const resendSignUpCode = vi.fn<AuthService['resendSignUpCode']>(() => finishGate);
    const app = await renderApp({ route: '/cadastro', auth: { ...base, resendSignUpCode } });
    await reachConfirmStep(app);

    const resend = screen.getByRole('button', { name: 'Reenviar código' });
    await app.user.dblClick(resend);
    await app.user.click(resend);
    expect(resendSignUpCode).toHaveBeenCalledTimes(1);
    expect(resendSignUpCode).toHaveBeenCalledWith(EMAIL);
    expect(resend).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeDisabled();

    finish();
    expect(await screen.findByRole('status')).toHaveTextContent(
      `Enviamos um novo código para ${EMAIL}.`,
    );
    expect(resend).toBeEnabled();
  });

  it('mostra o erro do reenvio', async () => {
    const base = createMockAuth(null);
    const auth: AuthService = {
      ...base,
      resendSignUpCode: () => Promise.reject(new Error('falha de rede')),
    };
    const app = await renderApp({ route: '/cadastro', auth });
    await reachConfirmStep(app);
    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível reenviar o código. Tente de novo.',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('leva ao login com aviso quando o login automático não acontece', async () => {
    const base = createMockAuth(null);
    const confirmSignUp = vi.fn<AuthService['confirmSignUp']>(() =>
      Promise.resolve<ConfirmSignUpResult>('SIGN_IN_REQUIRED'),
    );
    const app = await renderApp({ route: '/cadastro', auth: { ...base, confirmSignUp } });
    await reachConfirmStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), ` ${MOCK_SIGN_UP_CODE} `);
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(confirmSignUp).toHaveBeenCalledWith(EMAIL, MOCK_SIGN_UP_CODE);
    expect(app.router.state.location.pathname).toBe('/entrar');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Conta confirmada. Entre com seu e-mail e senha.',
    );
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue(EMAIL);
  });

  it('volta para trocar o e-mail, com o e-mail preenchido', async () => {
    const app = await renderApp({ route: '/cadastro' });
    await reachConfirmStep(app);
    await app.user.click(screen.getByRole('button', { name: 'Trocar e-mail' }));

    expect(screen.getByRole('heading', { name: 'Cadastre-se' })).toHaveFocus();
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue(EMAIL);
    expect(screen.getByLabelText(/^Senha/)).toHaveValue('');
  });

  it('alcança todos os controles pelo Tab, na ordem da tela', async () => {
    const app = await renderApp({ route: '/cadastro' });
    await reachConfirmStep(app);

    await app.user.tab();
    expect(screen.getByLabelText(/^Código/)).toHaveFocus();
    await app.user.tab();
    expect(screen.getByRole('button', { name: 'Confirmar' })).toHaveFocus();
    await app.user.tab();
    expect(screen.getByRole('button', { name: 'Reenviar código' })).toHaveFocus();
    await app.user.tab();
    expect(screen.getByRole('button', { name: 'Trocar e-mail' })).toHaveFocus();
  });

  it.each([390, 768, 1280])('mantém todas as ações em %i px', async (width) => {
    setViewportWidth(width);
    const app = await renderApp({ route: '/cadastro' });
    expect(await screen.findByRole('button', { name: 'Criar conta' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Entrar' })).toBeVisible();
    await reachConfirmStep(app);
    for (const name of ['Confirmar', 'Reenviar código', 'Trocar e-mail']) {
      expect(screen.getByRole('button', { name })).toBeVisible();
    }
  });

  it('manda quem já entrou para a tela inicial', async () => {
    const { router } = await renderApp({ route: '/cadastro', signedInAs: 'guardian' });
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/alunos');
  });
});

describe('login de conta sem e-mail confirmado (§ 6.1)', () => {
  it('oferece a confirmação com o e-mail preenchido e entra depois do código', async () => {
    const auth = createMockAuth(window.sessionStorage);
    await auth.signUp(EMAIL, PASSWORD);
    const app = await renderApp({ route: '/entrar', auth });

    await app.user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
    await app.user.type(screen.getByLabelText(/^Senha/), PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Entrar' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Confirme o e-mail antes de entrar.');

    await app.user.click(within(alert).getByRole('link', { name: 'Confirmar e-mail' }));
    expect(await screen.findByRole('heading', { name: 'Confirme seu e-mail' })).toHaveFocus();
    expect(app.router.state.location.pathname).toBe('/cadastro');
    expect(app.router.state.location.search).toBe('');
    expect(screen.getByText(`Enviamos um código para ${EMAIL}.`)).toBeInTheDocument();

    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Enviamos um novo código');

    await app.user.type(screen.getByLabelText(/^Código/), MOCK_SIGN_UP_CODE);
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
  });

  it('não oferece a confirmação para outros erros', async () => {
    const base = createMockAuth(null);
    const auth: AuthService = {
      ...base,
      signIn: () => Promise.reject(new Error('falha de rede')),
    };
    const app = await renderApp({ route: '/entrar', auth });
    await app.user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
    await app.user.type(screen.getByLabelText(/^Senha/), PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Confirmar e-mail' })).not.toBeInTheDocument();
  });
});
