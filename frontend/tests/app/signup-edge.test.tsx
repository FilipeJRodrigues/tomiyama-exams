import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_SIGN_UP_CODE } from '../../src/auth/mockConstants';
import type { AuthService, ConfirmSignUpResult } from '../../src/auth/types';
import { renderApp, type RenderAppResult } from '../render';

const EMAIL = 'mae@example.com';
const PASSWORD = 'senha-forte-1';

async function reachConfirmStep({ user }: RenderAppResult) {
  await user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
  await user.type(screen.getByLabelText(/^Senha/), PASSWORD);
  await user.type(screen.getByLabelText(/^Confirme a senha/), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Criar conta' }));
  await screen.findByRole('heading', { name: 'Confirme seu e-mail' });
}

describe('cadastro de responsável (§ 6.1): casos de borda', () => {
  it('não deixa "Confirmar" e "Reenviar código" correrem juntos', async () => {
    const base = createMockAuth(null);
    let finishResend: () => void = () => undefined;
    let finishConfirm: (result: ConfirmSignUpResult) => void = () => undefined;
    const resendSignUpCode = vi.fn<AuthService['resendSignUpCode']>(
      () =>
        new Promise<void>((resolve) => {
          finishResend = resolve;
        }),
    );
    const confirmSignUp = vi.fn<AuthService['confirmSignUp']>(
      () =>
        new Promise<ConfirmSignUpResult>((resolve) => {
          finishConfirm = resolve;
        }),
    );
    const app = await renderApp({
      route: '/cadastro',
      auth: { ...base, resendSignUpCode, confirmSignUp },
    });
    await reachConfirmStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), MOCK_SIGN_UP_CODE);

    // Enter in the code field while the resend runs.
    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    await app.user.type(screen.getByLabelText(/^Código/), '{Enter}');
    expect(confirmSignUp).not.toHaveBeenCalled();
    finishResend();
    await screen.findByRole('status');

    // Resend and Enter while the confirmation runs.
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));
    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    await app.user.type(screen.getByLabelText(/^Código/), '{Enter}');
    expect(resendSignUpCode).toHaveBeenCalledTimes(1);
    expect(confirmSignUp).toHaveBeenCalledTimes(1);
    finishConfirm('SIGN_IN_REQUIRED');
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
  });

  it('aceita o código com espaço no meio', async () => {
    const app = await renderApp({ route: '/cadastro', auth: createMockAuth(null) });
    await reachConfirmStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), '123 456');
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
  });

  it('oferece a confirmação no login com o e-mail em maiúsculas e espaços', async () => {
    const auth = createMockAuth(null);
    await auth.signUp(EMAIL, PASSWORD);
    const app = await renderApp({ route: '/entrar', auth });
    await app.user.type(await screen.findByLabelText(/^E-mail/), '  Mae@Example.com ');
    await app.user.type(screen.getByLabelText(/^Senha/), PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Entrar' }));
    const alert = await screen.findByRole('alert');
    await app.user.click(within(alert).getByRole('link', { name: 'Confirmar e-mail' }));
    expect(await screen.findByText('Enviamos um código para Mae@Example.com.')).toBeInTheDocument();
  });

  it('LGPD: a senha não vai para o storage nem para o console', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const app = await renderApp({ route: '/cadastro' });
    await reachConfirmStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), MOCK_SIGN_UP_CODE);
    await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));
    await screen.findByRole('heading', { name: 'Alunos', level: 1 });

    const stored = [window.sessionStorage, window.localStorage]
      .flatMap((storage) => Object.keys(storage).map((key) => storage.getItem(key) ?? ''))
      .join('\n');
    expect(stored).not.toContain(PASSWORD);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(PASSWORD);
      spy.mockRestore();
    }
  });
});
