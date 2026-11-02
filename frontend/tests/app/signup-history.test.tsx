import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_SIGN_UP_CODE } from '../../src/auth/mockConstants';
import { AuthError, type AuthService } from '../../src/auth/types';
import { renderApp, type RenderAppResult } from '../render';

const EMAIL = 'mae@example.com';
const PASSWORD = 'senha-forte-1';
const ALREADY_CONFIRMED = 'Este e-mail já foi confirmado. Entre com seu e-mail e senha.';
const alreadyConfirmed = () =>
  Promise.reject(new AuthError(ALREADY_CONFIRMED, 'ALREADY_CONFIRMED'));

async function reachConfirmStep({ user }: RenderAppResult) {
  await user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
  await user.type(screen.getByLabelText(/^Senha/), PASSWORD);
  await user.type(screen.getByLabelText(/^Confirme a senha/), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Criar conta' }));
  await screen.findByRole('heading', { name: 'Confirme seu e-mail' });
}

describe('cadastro (§ 6.1): histórico e teclado no passo do código', () => {
  it('voltar e avançar a partir do login mantém o passo do código; depois de entrar, voltar não reabre o login', async () => {
    const auth = createMockAuth(null);
    await auth.signUp(EMAIL, PASSWORD);
    const app = await renderApp({ route: '/entrar', auth });
    await app.user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
    await app.user.type(screen.getByLabelText(/^Senha/), PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Entrar' }));
    const alert = await screen.findByRole('alert');
    await app.user.click(within(alert).getByRole('link', { name: 'Confirmar e-mail' }));
    await screen.findByRole('heading', { name: 'Confirme seu e-mail' });

    await act(() => app.router.navigate(-1));
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    await act(() => app.router.navigate(1));
    expect(await screen.findByRole('heading', { name: 'Confirme seu e-mail' })).toBeInTheDocument();
    expect(screen.getByText(`Enviamos um código para ${EMAIL}.`)).toBeInTheDocument();

    await app.user.type(screen.getByLabelText(/^Código/), MOCK_SIGN_UP_CODE);
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
    await act(() => app.router.navigate(-1));
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
  });

  it('o link "Entrar" do alerta entra na ordem do Tab, antes do código', async () => {
    const app = await renderApp({
      route: '/cadastro',
      auth: { ...createMockAuth(null), resendSignUpCode: alreadyConfirmed } satisfies AuthService,
    });
    await reachConfirmStep(app);
    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    await screen.findByRole('alert');
    (document.activeElement as HTMLElement | null)?.blur();

    await app.user.tab();
    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveFocus();
    await app.user.tab();
    expect(screen.getByLabelText(/^Código/)).toHaveFocus();
    await app.user.tab();
    expect(screen.getByRole('button', { name: 'Confirmar' })).toHaveFocus();
    await app.user.tab();
    expect(screen.getByRole('button', { name: 'Reenviar código' })).toHaveFocus();
    await app.user.tab();
    expect(screen.getByRole('button', { name: 'Trocar e-mail' })).toHaveFocus();
  });

  it('"já confirmado" tira o aviso de reenvio, e um erro seguinte tira o link "Entrar"', async () => {
    const app = await renderApp({
      route: '/cadastro',
      auth: { ...createMockAuth(null), confirmSignUp: alreadyConfirmed } satisfies AuthService,
    });
    await reachConfirmStep(app);
    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    await screen.findByText('Novo código enviado');
    await app.user.type(screen.getByLabelText(/^Código/), MOCK_SIGN_UP_CODE);
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(ALREADY_CONFIRMED);
    expect(screen.queryByText('Novo código enviado')).not.toBeInTheDocument();

    await app.user.clear(screen.getByLabelText(/^Código/));
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Informe o código de 6 dígitos.');
    expect(within(alert).queryByRole('link')).not.toBeInTheDocument();
  });
});
