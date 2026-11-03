/**
 * Erro: na tela "Requisitos" (§ 6.5, RN017), depois de criar ou excluir um item, a lista da
 * faixa é corrigida na hora no cache e logo em seguida recarregada com `GET /requirements`.
 * No backend real esse GET lê o índice `by_belt` (GSI), que não tem leitura consistente: logo
 * após a gravação ele ainda pode devolver a lista antiga (backend/README.md, "o `total` vem de
 * um GSI"; `repository/requirements.py`, `list_by_belt`). A recarga imediata troca a lista
 * corrigida pela antiga: o item recém-criado some da tela (ao lado do aviso "Requisito
 * criado.") e o item excluído reaparece (e um novo "Excluir" nele dá 404).
 * Esperado: uma leitura atrasada do índice, logo depois de gravar, não desfaz o que a própria
 * API acabou de confirmar (201/204): o item criado continua na lista e o excluído não volta.
 * Issue: #25
 */
import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Requirement } from '../../src/api/types';
import { AppProviders } from '../../src/app/AppProviders';
import { createQueryClient } from '../../src/app/queryClient';
import { createRoutes } from '../../src/app/routes';
import { createMockAuth } from '../../src/auth/mockAuth';
import { createMockDb, mockBelts, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

const REQUIREMENTS_URL = `${TEST_API_URL}/requirements`;
const BRANCA_CINZA = mockBelts.find((belt) => belt.name === 'Branca/Cinza')!.id;

let db: MockDb;
/** The items the GSI still shows: the belt as it was before the write. */
let indexSnapshot: Requirement[] | null;
let staleReads: number;

/** `GET /requirements?belt_id=…` read from a GSI that has not caught up with the write yet. */
function lagIndexAfterWrites() {
  server.use(
    http.get(REQUIREMENTS_URL, ({ request }) => {
      if (indexSnapshot === null) return undefined;
      const params = new URL(request.url).searchParams;
      const belt = params.get('belt_id');
      const kind = params.get('kind');
      staleReads += 1;
      const items = indexSnapshot
        .filter((item) => item.belt_id === belt && (kind === null || item.kind === kind))
        .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
      return HttpResponse.json(items);
    }),
  );
}

async function openScreen() {
  const auth = createMockAuth(window.sessionStorage);
  await auth.signIn({ email: 'examiner@example.com', password: 'senha-teste', role: 'examiner' });
  const queryClient: QueryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  const router = createMemoryRouter(createRoutes({ useMocks: true }), {
    initialEntries: ['/requisitos'],
  });
  const user = userEvent.setup({ delay: null });
  render(
    <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await screen.findByRole('table', { name: 'Requisitos' });
  return { user, queryClient };
}

function descriptions(): string[] {
  const table = screen.getByRole('table', { name: 'Requisitos' });
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map((row) => row.querySelectorAll('th, td')[3]?.textContent.trim() ?? '');
}

/** Every request of the screen answered and applied (also a reload right after the write). */
async function settled(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
    expect(queryClient.isMutating()).toBe(0);
  });
}

describe('lista de requisitos logo após gravar, com o índice by_belt atrasado (§ 6.5, RN017)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    indexSnapshot = null;
    staleReads = 0;
    lagIndexAfterWrites();
  });

  it('rn017 o item criado continua na lista depois da recarga', async () => {
    const { user, queryClient } = await openScreen();
    indexSnapshot = db.requirements.map((item) => ({ ...item }));

    await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Teórico');
    await user.type(within(dialog).getByLabelText(/^Categoria/), 'Vocabulário');
    await user.type(within(dialog).getByLabelText(/^Descrição/), 'Começar');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Requisito criado.');
    // The API confirmed it (201) and kept it.
    expect(db.requirements.some((item) => item.description === 'Começar')).toBe(true);
    await settled(queryClient);

    const cached = queryClient.getQueryData<Requirement[]>([
      'requirements',
      { belt_id: BRANCA_CINZA, kind: undefined },
    ]);
    expect(cached?.map((item) => item.description)).toContain('Começar');
    expect(descriptions()).toContain('Começar');
    expect(screen.getByText(/^7 itens/)).toBeInTheDocument();
  });

  it('rn017 o item excluído não volta para a lista depois da recarga', async () => {
    const { user, queryClient } = await openScreen();
    indexSnapshot = db.requirements.map((item) => ({ ...item }));

    await user.click(screen.getByRole('button', { name: 'Excluir Osoto gari' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir requisito' });
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Requisito excluído.');
    expect(db.requirements.some((item) => item.description === 'Osoto gari')).toBe(false);
    await settled(queryClient);

    expect(descriptions()).not.toContain('Osoto gari');
    expect(screen.getByText(/^5 itens/)).toBeInTheDocument();
  });
});
