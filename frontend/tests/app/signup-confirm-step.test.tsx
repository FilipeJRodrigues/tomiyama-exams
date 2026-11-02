import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_SIGN_UP_CODE } from '../../src/auth/mockConstants';
import { AuthError, type AuthService, type ConfirmSignUpResult } from '../../src/auth/types';
import { renderApp, type RenderAppResult } from '../render';

const EMAIL = 'mae@example.com';
const PASSWORD = 'senha-forte-1';
const ALREADY_CONFIRMED = 'Este e-mail já foi confirmado. Entre com seu e-mail e senha.';

function alreadyConfirmed(): Promise<never> {
  return Promise.reject(new AuthError(ALREADY_CONFIRMED, 'ALREADY_CONFIRMED'));
}

async function reachConfirmStep({ user }: RenderAppResult) {
  await user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
  await user.type(screen.getByLabelText(/^Senha/), PASSWORD);
  await user.type(screen.getByLabelText(/^Confirme a senha/), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Criar conta' }));
  await screen.findByRole('heading', { name: 'Confirme seu e-mail' });
}

describe('cadastro (§ 6.1): conta que já foi confirmada', () => {
  it.each<[string, Partial<AuthService>, string]>([
    ['na confirmação', { confirmSignUp: alreadyConfirmed }, 'Confirmar'],
    ['no reenvio', { resendSignUpCode: alreadyConfirmed }, 'Reenviar código'],
  ])('oferece "Entrar" com o e-mail preenchido %s', async (_case, overrides, button) => {
    const app = await renderApp({
      route: '/cadastro',
      auth: { ...createMockAuth(null), ...overrides },
    });
    await reachConfirmStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), MOCK_SIGN_UP_CODE);
    await app.user.click(screen.getByRole('button', { name: button }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ALREADY_CONFIRMED);
    await app.user.click(within(alert).getByRole('link', { name: 'Entrar' }));

    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(app.router.state.location.pathname).toBe('/entrar');
    expect(app.router.state.location.search).toBe('');
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue(EMAIL);
  });

  it('não oferece "Entrar" no alerta para outros erros', async () => {
    const app = await renderApp({ route: '/cadastro', auth: createMockAuth(null) });
    await reachConfirmStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), '999999');
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Código incorreto.');
    expect(within(alert).queryByRole('link')).not.toBeInTheDocument();
  });

  it('o simulado responde "já confirmado" no reenvio de uma conta confirmada', async () => {
    const auth = createMockAuth(null);
    await auth.signUp(EMAIL, PASSWORD);
    await auth.confirmSignUp(EMAIL, MOCK_SIGN_UP_CODE);
    await expect(auth.resendSignUpCode(EMAIL)).rejects.toMatchObject({
      message: ALREADY_CONFIRMED,
      code: 'ALREADY_CONFIRMED',
    });
    await expect(auth.confirmSignUp(EMAIL, MOCK_SIGN_UP_CODE)).rejects.toMatchObject({
      code: 'ALREADY_CONFIRMED',
    });
  });
});

describe('cadastro (§ 6.1): "Trocar e-mail" durante um envio', () => {
  it('fica desabilitado enquanto "Confirmar" está em andamento', async () => {
    let finish: (result: ConfirmSignUpResult) => void = () => undefined;
    const finishGate = new Promise<ConfirmSignUpResult>((resolve) => {
      finish = resolve;
    });
    const confirmSignUp = vi.fn<AuthService['confirmSignUp']>(() => finishGate);
    const app = await renderApp({
      route: '/cadastro',
      auth: { ...createMockAuth(null), confirmSignUp },
    });
    await reachConfirmStep(app);
    const change = screen.getByRole('button', { name: 'Trocar e-mail' });
    expect(change).toBeEnabled();

    await app.user.type(screen.getByLabelText(/^Código/), MOCK_SIGN_UP_CODE);
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(change).toBeDisabled();
    await app.user.click(change);
    expect(screen.getByRole('heading', { name: 'Confirme seu e-mail' })).toBeInTheDocument();

    finish('SIGN_IN_REQUIRED');
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
  });

  it('fica desabilitado enquanto "Reenviar código" está em andamento', async () => {
    let finish: () => void = () => undefined;
    const finishGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const resendSignUpCode = vi.fn<AuthService['resendSignUpCode']>(() => finishGate);
    const app = await renderApp({
      route: '/cadastro',
      auth: { ...createMockAuth(null), resendSignUpCode },
    });
    await reachConfirmStep(app);
    const change = screen.getByRole('button', { name: 'Trocar e-mail' });

    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    expect(change).toBeDisabled();
    finish();
    await screen.findByRole('status');
    expect(change).toBeEnabled();
  });

  it('ao trocar o e-mail, o passo do código sai do estado do router', async () => {
    const app = await renderApp({ route: '/cadastro', auth: createMockAuth(null) });
    await reachConfirmStep(app);
    expect(app.router.state.location.state).toEqual({ confirmEmail: EMAIL });

    await app.user.click(screen.getByRole('button', { name: 'Trocar e-mail' }));
    expect(screen.getByRole('heading', { name: 'Cadastre-se' })).toBeInTheDocument();
    expect(app.router.state.location.state).toBeNull();
  });
});
