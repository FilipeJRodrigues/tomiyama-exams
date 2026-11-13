import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { AppProviders } from '../../src/app/AppProviders';
import { createQueryClient } from '../../src/app/queryClient';
import { createRoutes } from '../../src/app/routes';
import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_RESET_CODE } from '../../src/auth/mockConstants';
import type { AuthService } from '../../src/auth/types';
import { TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const NEW_PASSWORD = 'senha-nova-1';

function gated() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

async function settle() {
  await new Promise((done) => setTimeout(done, 50));
}

function renderStrict(auth: AuthService, route = '/recuperar-senha') {
  const queryClient = createQueryClient();
  const router = createMemoryRouter(createRoutes({ useMocks: true }), { initialEntries: [route] });
  const user = userEvent.setup({ delay: null });
  render(
    <StrictMode>
      <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );
  return { router, user };
}

describe('recuperação de senha: corridas da resposta atrasada (qa-frontend, #146)', () => {
  it('StrictMode: caminho normal avança, reenvia com aviso e volta ao login', async () => {
    const { router, user } = renderStrict(createMockAuth(null));
    await user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
    await user.click(screen.getByRole('button', { name: 'Enviar código' }));
    expect(await screen.findByRole('heading', { name: 'Crie uma nova senha' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Novo código enviado');
    await user.type(screen.getByLabelText(/^Código/), MOCK_RESET_CODE);
    await user.type(screen.getByLabelText(/^Nova senha/), NEW_PASSWORD);
    await user.type(screen.getByLabelText(/^Confirme a nova senha/), NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/entrar');
    expect(screen.getByLabelText(/^E-mail/)).toHaveValue('mae@example.com');
  });

  it('StrictMode: resposta atrasada depois de sair não navega', async () => {
    const base = createMockAuth(null);
    const gate = gated();
    const resetPassword = vi.fn<AuthService['resetPassword']>(async (email) => {
      await gate.promise;
      return base.resetPassword(email);
    });
    const { router, user } = renderStrict({ ...base, resetPassword });
    await user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
    await user.click(screen.getByRole('button', { name: 'Enviar código' }));
    await user.click(screen.getByRole('link', { name: 'Voltar para o login' }));
    await screen.findByRole('heading', { name: 'Entrar' });
    gate.release();
    await settle();
    expect(router.state.location.pathname).toBe('/entrar');
  });

  it('sair e voltar à etapa do e-mail antes da resposta antiga: a antiga não toma a tela nova', async () => {
    const base = createMockAuth(null);
    const gate = gated();
    let calls = 0;
    const resetPassword = vi.fn<AuthService['resetPassword']>(async (email) => {
      calls += 1;
      if (calls === 1) await gate.promise;
      return base.resetPassword(email);
    });
    const app = await renderApp({ route: '/entrar', auth: { ...base, resetPassword } });
    await app.user.click(await screen.findByRole('link', { name: 'Esqueci minha senha' }));
    await app.user.type(await screen.findByLabelText(/^E-mail/), 'antigo@example.com');
    await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
    await app.user.click(screen.getByRole('link', { name: 'Voltar para o login' }));
    await app.user.click(await screen.findByRole('link', { name: 'Esqueci minha senha' }));
    const email = await screen.findByLabelText(/^E-mail/);
    await app.user.clear(email);
    await app.user.type(email, 'novo@example.com');
    await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
    await screen.findByRole('heading', { name: 'Crie uma nova senha' });
    expect(screen.getByText(/novo@example\.com/)).toBeInTheDocument();
    gate.release();
    await settle();
    expect(screen.getByRole('heading', { name: 'Crie uma nova senha' })).toBeInTheDocument();
    expect(screen.queryByText(/antigo@example\.com/)).not.toBeInTheDocument();
  });

  it('sair e voltar à etapa do e-mail: o erro antigo não aparece no formulário novo', async () => {
    const base = createMockAuth(null);
    const gate = gated();
    let calls = 0;
    const resetPassword = vi.fn<AuthService['resetPassword']>(async (email) => {
      calls += 1;
      if (calls === 1) {
        await gate.promise;
        throw new Error('rede');
      }
      return base.resetPassword(email);
    });
    const app = await renderApp({ route: '/entrar', auth: { ...base, resetPassword } });
    await app.user.click(await screen.findByRole('link', { name: 'Esqueci minha senha' }));
    await app.user.type(await screen.findByLabelText(/^E-mail/), 'antigo@example.com');
    await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
    await app.user.click(screen.getByRole('link', { name: 'Voltar para o login' }));
    await app.user.click(await screen.findByRole('link', { name: 'Esqueci minha senha' }));
    await screen.findByRole('heading', { name: 'Recuperar senha' });
    gate.release();
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar código' })).toBeEnabled();
  });

  it('reenvio atrasado, sair e voltar à etapa 2: o aviso antigo não aparece', async () => {
    const base = createMockAuth(null);
    const gate = gated();
    let calls = 0;
    const resetPassword = vi.fn<AuthService['resetPassword']>(async (email) => {
      calls += 1;
      if (calls > 1) await gate.promise;
      return base.resetPassword(email);
    });
    const app = await renderApp({ route: '/entrar', auth: { ...base, resetPassword } });
    await app.user.click(await screen.findByRole('link', { name: 'Esqueci minha senha' }));
    await app.user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
    await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
    await screen.findByRole('heading', { name: 'Crie uma nova senha' });
    await app.user.click(screen.getByRole('button', { name: 'Reenviar código' }));
    await app.user.click(screen.getByRole('link', { name: 'Voltar para o login' }));
    await screen.findByRole('heading', { name: 'Entrar' });
    await app.router.navigate(-1);
    await screen.findByRole('heading', { name: 'Crie uma nova senha' });
    gate.release();
    await settle();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reenviar código' })).toBeEnabled();
  });

  it('troca de senha atrasada depois de sair: não navega', async () => {
    const base = createMockAuth(null);
    const gate = gated();
    const confirmResetPassword = vi.fn<AuthService['confirmResetPassword']>(async (e, c, p) => {
      await gate.promise;
      return base.confirmResetPassword(e, c, p);
    });
    const app = await renderApp({ route: '/entrar', auth: { ...base, confirmResetPassword } });
    await app.user.click(await screen.findByRole('link', { name: 'Esqueci minha senha' }));
    await app.user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
    await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
    await screen.findByRole('heading', { name: 'Crie uma nova senha' });
    await app.user.type(screen.getByLabelText(/^Código/), MOCK_RESET_CODE);
    await app.user.type(screen.getByLabelText(/^Nova senha/), NEW_PASSWORD);
    await app.user.type(screen.getByLabelText(/^Confirme a nova senha/), NEW_PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Salvar nova senha' }));
    await app.user.click(screen.getByRole('link', { name: 'Voltar para o login' }));
    await screen.findByRole('heading', { name: 'Entrar' });
    const key = app.router.state.location.key;
    gate.release();
    await settle();
    expect(app.router.state.location.key).toBe(key);
  });
});
