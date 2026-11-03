/**
 * Erro: na tela "Requisitos" (§ 6.5, RN017), se um `GET /requirements?belt_id=…` da lista já
 * estava a caminho quando a gravação foi confirmada (a janela voltou a ter foco com o diálogo
 * aberto, `refetchOnWindowFocus`; ou a recarga depois de um 409 seguida de um novo "Salvar"),
 * a resposta desse GET, lida antes da gravação, chega depois do patch do cache e o desfaz: o
 * item recém-criado some da lista ao lado do aviso "Requisito criado." e o excluído volta.
 * O patch de `patchRequirementLists` não cancela a recarga em voo (`cancelQueries`).
 * Esperado: uma resposta pedida antes da gravação não sobrescreve o que a API acabou de
 * confirmar (201/204): o item criado fica na lista e o excluído não volta.
 * Issue: #25
 */
import { QueryClient, focusManager } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
/** Lets the held GET answer (with the list as it was when it was asked). */
let release: (() => void) | null;
let holdNext: boolean;

/** Holds the next `GET /requirements?belt_id=…` until `release()`; it answers the old list. */
function holdNextListRead() {
  server.use(
    http.get(REQUIREMENTS_URL, async ({ request }) => {
      if (!holdNext) return undefined;
      holdNext = false;
      const params = new URL(request.url).searchParams;
      const belt = params.get('belt_id');
      const snapshot = db.requirements
        .filter((item) => item.belt_id === belt)
        .map((item) => ({ ...item }))
        .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return HttpResponse.json<Requirement[]>(snapshot);
    }),
  );
}

async function openScreen() {
  const auth = createMockAuth(window.sessionStorage);
  await auth.signIn({ email: 'examiner@example.com', password: 'senha-teste', role: 'examiner' });
  const queryClient: QueryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: true } });
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

/** The window gets the focus back: the open list reloads, and that GET is held. */
async function reloadOnFocusHeld() {
  holdNext = true;
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await waitFor(() => {
    expect(release).not.toBeNull();
  });
}

/** The held GET answers, and every request of the screen is answered and applied. */
async function answerHeldRead(queryClient: QueryClient) {
  release?.();
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
    expect(queryClient.isMutating()).toBe(0);
  });
}

describe('lista de requisitos com uma recarga em voo durante a gravação (§ 6.5, RN017)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    release = null;
    holdNext = false;
    holdNextListRead();
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  it('rn017 o item criado continua na lista quando a recarga antiga chega depois', async () => {
    const { user, queryClient } = await openScreen();

    await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Teórico');
    await user.type(within(dialog).getByLabelText(/^Categoria/), 'Vocabulário');
    await user.type(within(dialog).getByLabelText(/^Descrição/), 'Começar');
    await reloadOnFocusHeld();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Requisito criado.');
    expect(db.requirements.some((item) => item.description === 'Começar')).toBe(true);
    expect(descriptions()).toContain('Começar');

    await answerHeldRead(queryClient);

    const cached = queryClient.getQueryData<Requirement[]>([
      'requirements',
      { belt_id: BRANCA_CINZA, kind: undefined },
    ]);
    expect(cached?.map((item) => item.description)).toContain('Começar');
    expect(descriptions()).toContain('Começar');
    expect(screen.getByText(/^7 itens/)).toBeInTheDocument();
  });

  it('rn017 o item excluído não volta quando a recarga antiga chega depois', async () => {
    const { user, queryClient } = await openScreen();

    await user.click(screen.getByRole('button', { name: 'Excluir Osoto gari' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir requisito' });
    await reloadOnFocusHeld();
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Requisito excluído.');
    expect(
      db.requirements.some(
        (item) => item.belt_id === BRANCA_CINZA && item.description === 'Osoto gari',
      ),
    ).toBe(false);
    expect(descriptions()).not.toContain('Osoto gari');

    await answerHeldRead(queryClient);

    expect(descriptions()).not.toContain('Osoto gari');
    expect(screen.getByText(/^5 itens/)).toBeInTheDocument();
  });
});
