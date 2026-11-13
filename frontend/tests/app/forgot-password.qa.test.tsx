import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_EXPIRED_CODE, MOCK_RESET_CODE } from '../../src/auth/mockConstants';
import type { AuthService } from '../../src/auth/types';
import { renderApp, type RenderAppResult } from '../render';

const EMAIL = 'joão.mãe@example.com';
const NEW_PASSWORD = 'senha-nova-1';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function reachResetStep({ user }: RenderAppResult, email = 'mae@example.com') {
  await user.type(await screen.findByLabelText(/^E-mail/), email);
  await user.click(screen.getByRole('button', { name: 'Enviar código' }));
  return screen.findByRole('heading', { name: 'Crie uma nova senha' });
}

describe('recuperação de senha: bordas (qa-frontend, #146)', () => {
  it('logado, /recuperar-senha leva para dentro do app sem mostrar o formulário', async () => {
    const { router } = await renderApp({ route: '/recuperar-senha', signedInAs: 'guardian' });
    await waitFor(() => {
      expect(router.state.location.pathname).not.toBe('/recuperar-senha');
    });
    expect(screen.queryByRole('button', { name: 'Enviar código' })).not.toBeInTheDocument();
  });

  it('sem estado (recarga, link direto) abre a etapa do e-mail vazia', async () => {
    await renderApp({ route: '/recuperar-senha' });
    expect(await screen.findByRole('heading', { name: 'Recuperar senha' })).toHaveFocus();
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue('');
  });

  it('aceita o código colado com espaço e recusa 7 dígitos no campo do código', async () => {
    const base = createMockAuth(null);
    const confirmResetPassword = vi.fn<AuthService['confirmResetPassword']>(
      (email, code, password) => base.confirmResetPassword(email, code, password),
    );
    const app = await renderApp({
      route: '/recuperar-senha',
      auth: { ...base, confirmResetPassword },
    });
    await reachResetStep(app);
    const code = screen.getByLabelText(/^Código/);
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByLabelText(/^Nova senha/)).toHaveAttribute('autocomplete', 'new-password');
    await app.user.type(code, '1234567');
    await app.user.type(screen.getByLabelText(/^Nova senha/), NEW_PASSWORD);
    await app.user.type(screen.getByLabelText(/^Confirme a nova senha/), NEW_PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe o código de 6 dígitos.');
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(confirmResetPassword).not.toHaveBeenCalled();

    await app.user.clear(code);
    await app.user.type(code, '123 456');
    await app.user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(confirmResetPassword).toHaveBeenCalledWith(
      'mae@example.com',
      MOCK_RESET_CODE,
      NEW_PASSWORD,
    );
  });

  it('código expirado mostra a mensagem em pt-BR e o reenvio funciona depois', async () => {
    const app = await renderApp({ route: '/recuperar-senha' });
    await reachResetStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), MOCK_EXPIRED_CODE);
    await app.user.type(screen.getByLabelText(/^Nova senha/), NEW_PASSWORD);
    await app.user.type(screen.getByLabelText(/^Confirme a nova senha/), NEW_PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Código expirado. Peça um novo.');
    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Novo código enviado');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('senhas diferentes apontam o campo da confirmação', async () => {
    const app = await renderApp({ route: '/recuperar-senha' });
    await reachResetStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), MOCK_RESET_CODE);
    await app.user.type(screen.getByLabelText(/^Nova senha/), NEW_PASSWORD);
    await app.user.type(screen.getByLabelText(/^Confirme a nova senha/), 'outra-senha-1');
    await app.user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('As senhas não conferem.');
    expect(screen.getByLabelText(/^Confirme a nova senha/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('Enter no código durante o reenvio não dispara a troca de senha', async () => {
    const base = createMockAuth(null);
    const gate = deferred();
    let calls = 0;
    const resetPassword = vi.fn<AuthService['resetPassword']>(async (email) => {
      calls += 1;
      if (calls > 1) await gate.promise;
      return base.resetPassword(email);
    });
    const confirmResetPassword = vi.fn<AuthService['confirmResetPassword']>(
      (email, code, password) => base.confirmResetPassword(email, code, password),
    );
    const app = await renderApp({
      route: '/recuperar-senha',
      auth: { ...base, resetPassword, confirmResetPassword },
    });
    await reachResetStep(app);
    await app.user.type(screen.getByLabelText(/^Código/), MOCK_RESET_CODE);
    await app.user.type(screen.getByLabelText(/^Nova senha/), NEW_PASSWORD);
    await app.user.type(screen.getByLabelText(/^Confirme a nova senha/), NEW_PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    expect(screen.getByRole('button', { name: 'Trocar e-mail' })).toBeDisabled();
    await app.user.type(screen.getByLabelText(/^Confirme a nova senha/), '{Enter}');
    expect(confirmResetPassword).not.toHaveBeenCalled();
    gate.resolve();
    expect(await screen.findByRole('status')).toHaveTextContent('Novo código enviado');
  });

  it('nada do e-mail ou do código vai para o storage nem para a URL', async () => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    const app = await renderApp({ route: '/entrar' });
    await app.user.click(await screen.findByRole('link', { name: 'Esqueci minha senha' }));
    await reachResetStep(app, EMAIL);
    expect(screen.getByText(new RegExp(EMAIL.replace('.', '\\.')))).toBeInTheDocument();
    await app.user.type(screen.getByLabelText(/^Código/), MOCK_RESET_CODE);
    await app.user.type(screen.getByLabelText(/^Nova senha/), NEW_PASSWORD);
    await app.user.type(screen.getByLabelText(/^Confirme a nova senha/), NEW_PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    await screen.findByRole('heading', { name: 'Entrar' });
    expect(app.router.state.location.search).toBe('');
    const dump = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, i) => {
        const key = storage.key(i) ?? '';
        return `${key}=${storage.getItem(key) ?? ''}`;
      }).join(';');
    const stored = dump(window.sessionStorage) + dump(window.localStorage);
    expect(stored).not.toContain('example.com');
    expect(stored).not.toContain(MOCK_RESET_CODE);
    expect(stored).not.toContain(NEW_PASSWORD);
  });
});
