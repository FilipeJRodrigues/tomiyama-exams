/**
 * Erro: quando a API responde 401 (token expirado ou revogado), a sessão é encerrada e a
 * tela volta ao login, mas o cache do TanStack Query continua com a lista de alunos do
 * usuário anterior (nome e data de nascimento de crianças). Só o botão "Sair" limpa o
 * cache; o caminho do 401 (`ApiProvider` → `signOut`) não. O próximo usuário que entrar
 * no mesmo navegador vê os dados antigos enquanto a nova consulta não volta.
 * Esperado: qualquer fim de sessão (Sair ou 401) descarta os dados em cache (§ 8, LGPD;
 * critério 5 do PR da base: "um 401 encerra a sessão").
 * Issue: -
 */
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { queryKeys, useStudents } from '../../src/api/queries';
import { AppProviders } from '../../src/app/AppProviders';
import { createQueryClient } from '../../src/app/queryClient';
import { createRoutes } from '../../src/app/routes';
import { createMockAuth } from '../../src/auth/mockAuth';
import { installMockApi, server, TEST_API_URL } from '../msw-server';

/** Stands in for the future students screen: reads `GET /students` through the cache. */
function StudentsProbe() {
  const query = useStudents();
  return <p>{query.data ? `alunos: ${String(query.data.length)}` : 'sem dados'}</p>;
}

describe('fim de sessão por 401', () => {
  it('descarta os alunos em cache do usuário anterior', async () => {
    installMockApi();
    const auth = createMockAuth(window.sessionStorage);
    await auth.signIn({ email: 'mae@example.com', password: 'senha-teste', role: 'guardian' });
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

    // The token expires: the next request gets the API Gateway 401.
    server.use(
      http.get(`${TEST_API_URL}/students`, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );
    await queryClient.refetchQueries();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
    expect(queryClient.getQueryData(queryKeys.students())).toBeUndefined();
  });
});
