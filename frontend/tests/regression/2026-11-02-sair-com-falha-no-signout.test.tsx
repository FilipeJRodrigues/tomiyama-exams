/**
 * Erro: quando o `signOut` do serviço de login lança exceção (no Cognito, por exemplo,
 * falha de rede ao revogar o token), o `AuthProvider.signOut` limpa o cache e encerra a
 * sessão no `finally`, mas devolve a exceção a quem chamou. Os dois chamadores descartam a
 * promessa com `void` (botão "Sair" em `AppLayout` e o 401 em `ApiProvider`), então o erro
 * vira "Unhandled Rejection" ("Uncaught (in promise)" no console do navegador) e, no
 * "Sair", o `navigate` para o login não roda (quem leva ao login é o guard).
 * Esperado: o fim de sessão termina sem rejeição não tratada, com o cache limpo e a tela de
 * login, pelos dois caminhos (§ 6.1; § 8, LGPD).
 * Issue: -
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryKeys, useStudents } from '../../src/api/queries';
import { AppProviders } from '../../src/app/AppProviders';
import { createQueryClient } from '../../src/app/queryClient';
import { createRoutes } from '../../src/app/routes';
import { createMockAuth } from '../../src/auth/mockAuth';
import type { AuthService } from '../../src/auth/types';
import { installMockApi, server, TEST_API_URL } from '../msw-server';

function StudentsProbe() {
  const query = useStudents();
  return <p>{query.data ? `alunos: ${String(query.data.length)}` : 'sem dados'}</p>;
}

/** Node's `process` (the app tsconfig has no Node types). */
interface NodeProcess {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}
const nodeProcess = (globalThis as unknown as { process: NodeProcess }).process;

const unhandled: unknown[] = [];
const collect = (reason: unknown) => {
  unhandled.push(reason);
};

/** Wait for pending promise callbacks, so a rejection has time to surface. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function renderWithFailingSignOut() {
  installMockApi();
  const base = createMockAuth(null);
  await base.signIn({ email: 'mae@example.com', password: 'senha-teste', role: 'guardian' });
  const auth: AuthService = {
    ...base,
    // The local session ends, but the call itself fails (e.g. the token revocation).
    signOut: async () => {
      await base.signOut();
      throw new Error('Network error');
    },
  };
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(createRoutes({ useMocks: true }), {
    initialEntries: ['/alunos'],
  });
  render(
    <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
      <RouterProvider router={router} />
      <StudentsProbe />
    </AppProviders>,
  );
  expect(await screen.findByText('alunos: 2')).toBeInTheDocument();
  return { queryClient, router };
}

describe('fim de sessão quando o signOut do serviço falha', () => {
  beforeEach(() => {
    unhandled.length = 0;
    nodeProcess.on('unhandledRejection', collect);
  });

  afterEach(() => {
    nodeProcess.off('unhandledRejection', collect);
  });

  it('botão Sair: sem rejeição não tratada, cache limpo, tela de login', async () => {
    const { queryClient, router } = await renderWithFailingSignOut();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
    await settle();
    expect(queryClient.getQueryData(queryKeys.students())).toBeUndefined();
    expect(unhandled).toEqual([]);
  });

  it('401 da API: sem rejeição não tratada, cache limpo, tela de login', async () => {
    const { queryClient, router } = await renderWithFailingSignOut();
    server.use(
      http.get(`${TEST_API_URL}/students`, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );
    await queryClient.refetchQueries();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
    await settle();
    expect(queryClient.getQueryData(queryKeys.students())).toBeUndefined();
    expect(unhandled).toEqual([]);
  });
});
