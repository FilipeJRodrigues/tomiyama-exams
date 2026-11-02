/**
 * Erro: depois de "Criar conta", o passo "Confirme seu e-mail" só existe no estado do
 * componente (`useState` de `SignUpPage`); o estado do router continua vazio. Ao recarregar
 * a página (ou voltar a ela pelo histórico), a tela volta para "Cadastre-se" com o
 * formulário vazio. No Cognito, um novo "Criar conta" com o mesmo e-mail dá "Já existe uma
 * conta com este e-mail." (a conta existe, sem confirmação), e a tela não oferece o passo
 * do código: o responsável só chega nele pelo login, digitando a senha.
 * Esperado: recarregar no passo do código mantém o passo do código com o mesmo e-mail,
 * guardado no estado do router como no link "Confirmar e-mail" do login (sem ir para a
 * URL) (§ 6.1; § 2).
 * Issue: -
 */
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AppProviders } from '../../src/app/AppProviders';
import { createQueryClient } from '../../src/app/queryClient';
import { createRoutes } from '../../src/app/routes';
import { createMockAuth } from '../../src/auth/mockAuth';
import { TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const EMAIL = 'mae@example.com';
const PASSWORD = 'senha-forte-1';

describe('cadastro: recarregar no passo do código (§ 6.1)', () => {
  it('continua em "Confirme seu e-mail" com o mesmo e-mail, sem o e-mail na URL', async () => {
    // Same service before and after the reload: the account stays in the pool, unconfirmed.
    const auth = createMockAuth(null);
    const app = await renderApp({ route: '/cadastro', auth });
    await app.user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
    await app.user.type(screen.getByLabelText(/^Senha/), PASSWORD);
    await app.user.type(screen.getByLabelText(/^Confirme a senha/), PASSWORD);
    await app.user.click(screen.getByRole('button', { name: 'Criar conta' }));
    await screen.findByRole('heading', { name: 'Confirme seu e-mail' });

    // A reload keeps the current history entry (path and state), like `history.state`.
    const location = app.router.state.location;
    expect(location.search).toBe('');
    app.unmount();
    const router = createMemoryRouter(createRoutes({ useMocks: true }), {
      initialEntries: [location],
    });
    render(
      <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={createQueryClient()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    expect(await screen.findByRole('heading', { name: 'Confirme seu e-mail' })).toBeInTheDocument();
    expect(screen.getByText(`Enviamos um código para ${EMAIL}.`)).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
  });
});
