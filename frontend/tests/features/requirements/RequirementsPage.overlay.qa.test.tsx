/**
 * Tela "Requisitos" (§ 6.5, RN017, #25) com o GSI `by_belt` atrasado de verdade: depois de uma
 * gravação, toda leitura de `GET /requirements?belt_id` (a recarga em voo, a recarga pedida
 * pela gravação e as recargas por foco) ainda devolve a lista de antes. Só a sobreposição das
 * gravações recentes (`recentRequirementWrites`) mantém na tela o que a API confirmou.
 * As regressões `25-recarga-em-voo-*` e `25-recarga-apos-404-*` passam mesmo sem a sobreposição
 * (o mock delas devolve dados novos na recarga); estes casos cobrem a sobreposição em si.
 *
 * Sem corrida de tempo: as leituras seguradas só respondem quando o teste manda, o relógio da
 * janela de 30 s é controlado (`vi.setSystemTime`, só `Date`) e toda espera é por estado.
 */
import { QueryClient, focusManager } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RECENT_WRITE_WINDOW_MS } from '../../../src/api/recentRequirementWrites';
import type { Requirement } from '../../../src/api/types';
import { AppProviders } from '../../../src/app/AppProviders';
import { createQueryClient } from '../../../src/app/queryClient';
import { createRoutes } from '../../../src/app/routes';
import { createMockAuth } from '../../../src/auth/mockAuth';
import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { REQUIREMENTS_URL, beltFilter, beltId, replaceText, rowDescriptions } from './helpers';

const BRANCA_CINZA = beltId('Branca/Cinza');
const CINZA = beltId('Cinza');
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

let db: MockDb;
/** What the GSI still answers (the requirements before the writes); `null` = up to date. */
let gsi: Requirement[] | null;
/** Belts whose next list read is held until `release()`. */
let holdBelts: Set<string>;
let release: (() => void) | null;
/** Belts whose next list read fails with 500 (once each). */
let failBelts: Set<string>;
/** List reads that reached the mock. */
let reads: number;

function snapshot(): Requirement[] {
  return db.requirements.map((item) => ({ ...item }));
}

function lagGsi() {
  gsi = snapshot();
}

function listFrom(source: readonly Requirement[], belt: string, kind: string | null) {
  return source
    .filter((item) => item.belt_id === belt && (kind === null || item.kind === kind))
    .map((item) => ({ ...item }))
    .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
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
  return { user, queryClient, router };
}

/** Every dialog is gone (the filters are reachable again). */
async function noDialog() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

/**
 * No request in flight, and the screen rendered what reached the cache: TanStack notifies the
 * observers in a `setTimeout(0)` queued when the last request ended, so one more turn of the
 * timer queue (FIFO, no real delay) lets that render happen first.
 */
async function settled(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
    expect(queryClient.isMutating()).toBe(0);
  });
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
}

/**
 * The window gets the focus back: the open list reloads (from the late GSI, if lagging).
 * TanStack starts that reload after an `await`, so the read is awaited before the settle.
 */
async function refocus(queryClient: QueryClient) {
  const before = reads;
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await waitFor(() => {
    expect(reads).toBeGreaterThan(before);
  });
  await settled(queryClient);
}

/** Same, but the reload is held on its way until `release()`. */
async function refocusHeld() {
  holdBelts.add(BRANCA_CINZA);
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await waitFor(() => {
    expect(release).not.toBeNull();
  });
}

function count(description: string): number {
  return rowDescriptions().filter((text) => text === description).length;
}

async function fillNew(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  values: { kind: 'Prático' | 'Teórico'; category: string; description: string },
) {
  await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), values.kind);
  await replaceText(user, within(dialog).getByLabelText(/^Categoria/), values.category);
  await replaceText(user, within(dialog).getByLabelText(/^Descrição/), values.description);
}

async function editDescription(
  user: ReturnType<typeof userEvent.setup>,
  current: string,
  next: string,
) {
  await user.click(screen.getByRole('button', { name: `Editar ${current}` }));
  const dialog = await screen.findByRole('dialog', { name: 'Editar requisito' });
  await replaceText(user, within(dialog).getByLabelText(/^Descrição/), next);
  await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Editar requisito' })).not.toBeInTheDocument();
  });
}

async function deleteRow(user: ReturnType<typeof userEvent.setup>, description: string) {
  await user.click(screen.getByRole('button', { name: `Excluir ${description}` }));
  const dialog = await screen.findByRole('dialog', { name: 'Excluir requisito' });
  await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
  return dialog;
}

describe('Requisitos com o GSI atrasado: sobreposição das gravações recentes (§ 6.5, RN017)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    gsi = null;
    holdBelts = new Set();
    failBelts = new Set();
    release = null;
    reads = 0;
    server.use(
      http.get(REQUIREMENTS_URL, async ({ request }) => {
        const params = new URL(request.url).searchParams;
        const belt = params.get('belt_id');
        if (belt === null) return undefined;
        reads += 1;
        if (failBelts.delete(belt)) {
          return HttpResponse.json({ message: 'Erro interno' }, { status: 500 });
        }
        const held = holdBelts.delete(belt);
        if (gsi === null && !held) return undefined;
        // A held read answers what the index had when it was asked.
        const answer = listFrom(gsi ?? db.requirements, belt, params.get('kind'));
        if (held) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return HttpResponse.json<Requirement[]>(answer);
      }),
    );
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('rn017 recarga em voo + GSI atrasado: o item criado fica, também nas recargas seguintes', async () => {
    const { user, queryClient } = await openScreen();
    lagGsi();

    await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
    await fillNew(user, dialog, {
      kind: 'Teórico',
      category: 'Vocabulário',
      description: 'Começar',
    });
    await refocusHeld();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito criado.');

    release?.();
    await settled(queryClient);
    expect(count('Começar')).toBe(1);
    expect(screen.getByText(/^7 itens/)).toBeInTheDocument();

    await refocus(queryClient);
    expect(count('Começar')).toBe(1);
    expect(screen.getByText(/^7 itens/)).toBeInTheDocument();
  });

  it('rn017 recarga em voo + GSI atrasado: o item excluído não volta', async () => {
    const { user, queryClient } = await openScreen();
    lagGsi();

    await user.click(screen.getByRole('button', { name: 'Excluir Osoto gari' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir requisito' });
    await refocusHeld();
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito excluído.');

    release?.();
    await settled(queryClient);
    await refocus(queryClient);
    expect(rowDescriptions()).not.toContain('Osoto gari');
    expect(screen.getByText(/^5 itens/)).toBeInTheDocument();
  });

  it('rn017 404 "Requisito não encontrado" + GSI que ainda traz o item: ele sai e não volta', async () => {
    const { user, queryClient } = await openScreen();
    // The GSI still shows "Osoto gari", already deleted by another examiner.
    lagGsi();
    db.requirements = db.requirements.filter(
      (item) => !(item.belt_id === BRANCA_CINZA && item.description === 'Osoto gari'),
    );

    // A reload is on its way (focus) when the 404 arrives; another deletion is confirmed
    // before it answers.
    await refocusHeld();
    const dialog = await deleteRow(user, 'Osoto gari');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Requisito não encontrado');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Excluir requisito' })).not.toBeInTheDocument();
    });
    await deleteRow(user, 'Deashi barai');
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito excluído.');

    release?.();
    await settled(queryClient);
    await refocus(queryClient);
    expect(rowDescriptions()).not.toContain('Osoto gari');
    expect(rowDescriptions()).not.toContain('Deashi barai');
    expect(screen.getByText(/^4 itens/)).toBeInTheDocument();
  });

  it('rn017 404 "Requisito não encontrado" ao editar também tira o item, com o GSI atrasado', async () => {
    const { user, queryClient } = await openScreen();
    lagGsi();
    db.requirements = db.requirements.filter(
      (item) => !(item.belt_id === BRANCA_CINZA && item.description === 'Osoto gari'),
    );

    await user.click(screen.getByRole('button', { name: 'Editar Osoto gari' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar requisito' });
    await replaceText(user, within(dialog).getByLabelText(/^Descrição/), 'Osoto gari (direita)');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Requisito não encontrado');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await settled(queryClient);
    await refocus(queryClient);

    expect(rowDescriptions()).not.toContain('Osoto gari');
    expect(screen.getByText(/^5 itens/)).toBeInTheDocument();
  });

  it('rn017 outro 404 (não "Requisito não encontrado") não tira o item da lista', async () => {
    const { user, queryClient } = await openScreen();
    server.use(
      http.put(`${REQUIREMENTS_URL}/:id`, () =>
        HttpResponse.json({ message: 'Faixa não encontrada' }, { status: 404 }),
      ),
      http.delete(`${REQUIREMENTS_URL}/:id`, () =>
        HttpResponse.json({ message: 'Faixa não encontrada' }, { status: 404 }),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Editar Osoto gari' }));
    const editDialog = await screen.findByRole('dialog', { name: 'Editar requisito' });
    await replaceText(user, within(editDialog).getByLabelText(/^Descrição/), 'Outro nome');
    await user.click(within(editDialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(editDialog).findByRole('alert')).toHaveTextContent('Faixa não encontrada');
    await user.click(within(editDialog).getByRole('button', { name: 'Cancelar' }));

    const deleteDialog = await deleteRow(user, 'Osoto gari');
    expect(await within(deleteDialog).findByRole('alert')).toHaveTextContent(
      'Faixa não encontrada',
    );
    await user.click(within(deleteDialog).getByRole('button', { name: 'Cancelar' }));
    await settled(queryClient);
    await refocus(queryClient);

    expect(count('Osoto gari')).toBe(1);
    expect(rowDescriptions()).not.toContain('Outro nome');
    expect(screen.getByText(/^6 itens/)).toBeInTheDocument();
  });

  it('rn017 passada a janela de 30 s, a lista volta a mostrar o que a API devolve', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const { user, queryClient } = await openScreen();

    await editDescription(user, 'Osoto gari', 'Osoto gari (direita)');
    await settled(queryClient);
    expect(count('Osoto gari (direita)')).toBe(1);

    // Another examiner renames it right after; the GSI is up to date.
    const osoto = db.requirements.find((item) => item.description === 'Osoto gari (direita)')!;
    osoto.description = 'Osoto gari (esquerda)';

    vi.setSystemTime(T0 + RECENT_WRITE_WINDOW_MS);
    await refocus(queryClient);
    expect(count('Osoto gari (esquerda)')).toBe(1);
    expect(rowDescriptions()).not.toContain('Osoto gari (direita)');
    expect(screen.getByText(/^6 itens/)).toBeInTheDocument();
  });

  it('rn017 duas edições seguidas do mesmo item com o GSI atrasado: vale a mais nova', async () => {
    const { user, queryClient } = await openScreen();
    lagGsi();

    await editDescription(user, 'Osoto gari', 'Osoto gari A');
    await editDescription(user, 'Osoto gari A', 'Osoto gari B');
    await settled(queryClient);
    await refocus(queryClient);

    expect(count('Osoto gari B')).toBe(1);
    expect(rowDescriptions()).not.toContain('Osoto gari A');
    expect(rowDescriptions()).not.toContain('Osoto gari');
    expect(screen.getByText(/^6 itens/)).toBeInTheDocument();
  });

  it('rn017 edição que troca a faixa com o GSI atrasado: sai da faixa antiga e aparece na nova', async () => {
    const { user, queryClient } = await openScreen();
    lagGsi();

    await user.click(screen.getByRole('button', { name: 'Editar Osoto gari' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar requisito' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Faixa/ }), 'Cinza');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Requisito salvo na faixa Cinza (Prático), fora do filtro atual.',
    );
    await settled(queryClient);
    await refocus(queryClient);
    expect(rowDescriptions()).not.toContain('Osoto gari');
    expect(screen.getByText(/^5 itens/)).toBeInTheDocument();
    await noDialog();

    // Cinza was never loaded: its first read comes from the late GSI, without the item.
    await user.selectOptions(beltFilter(), 'Cinza');
    await settled(queryClient);
    expect(await screen.findByRole('table', { name: 'Requisitos' })).toBeInTheDocument();
    expect(rowDescriptions()).toEqual(['Osoto gari']);
  });

  it('rn017 exclusão seguida de recriação com o GSI atrasado: o item aparece uma vez', async () => {
    const { user, queryClient } = await openScreen();
    lagGsi();

    await deleteRow(user, 'Osoto gari');
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito excluído.');
    await settled(queryClient);

    await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
    await fillNew(user, dialog, {
      kind: 'Prático',
      category: 'Naguewaza',
      description: 'Osoto gari',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito criado.');
    await settled(queryClient);
    await refocus(queryClient);

    expect(count('Osoto gari')).toBe(1);
    expect(screen.getByText(/^6 itens/)).toBeInTheDocument();
    // It is the new item (at the end of the sheet), not the deleted one.
    expect(rowDescriptions().at(-1)).toBe('Osoto gari');
  });

  it('rn017 lista de outra faixa em primeira carga, deixada de lado: ao voltar, carrega com o item', async () => {
    const { user, queryClient } = await openScreen();

    // Cinza starts loading (held) and the examiner goes back to Branca/Cinza.
    holdBelts.add(CINZA);
    await user.selectOptions(beltFilter(), 'Cinza');
    expect(await screen.findByText('Carregando requisitos…')).toBeInTheDocument();
    await waitFor(() => {
      expect(release).not.toBeNull();
    });
    await user.selectOptions(beltFilter(), 'Branca/Cinza');
    await screen.findByRole('table', { name: 'Requisitos' });

    // An item is created in Cinza while that first read is still on its way.
    await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Faixa/ }), 'Cinza');
    await fillNew(user, dialog, {
      kind: 'Prático',
      category: 'Naguewaza',
      description: 'Harai goshi',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/^Requisito criado na faixa Cinza/);

    // The old read answers (empty) after the write; the GSI is still behind.
    gsi = snapshot().filter((item) => item.description !== 'Harai goshi');
    release?.();
    await noDialog();
    await user.selectOptions(beltFilter(), 'Cinza');
    await settled(queryClient);
    expect(screen.queryByText('Carregando requisitos…')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(rowDescriptions()).toEqual(['Harai goshi']);
  });

  it('rn017 lista em nova tentativa depois de erro quando a gravação é confirmada: carrega, sem ficar presa', async () => {
    const { user, queryClient } = await openScreen();
    // One retry, right away (the default waits 1 s): the first read fails, the retry is held.
    queryClient.setDefaultOptions({
      queries: { retry: 1, retryDelay: 0, refetchOnWindowFocus: true },
    });
    failBelts.add(CINZA);
    holdBelts.add(CINZA);
    await user.selectOptions(beltFilter(), 'Cinza');
    await waitFor(() => {
      expect(release).not.toBeNull();
    });
    expect(failBelts.has(CINZA)).toBe(false);
    expect(screen.getByText('Carregando requisitos…')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
    await fillNew(user, dialog, {
      kind: 'Prático',
      category: 'Naguewaza',
      description: 'Harai goshi',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito criado.');

    await waitFor(() => {
      expect(rowDescriptions()).toEqual(['Harai goshi']);
    });
    release?.();
    await settled(queryClient);
    expect(screen.queryByText('Não foi possível carregar os requisitos')).not.toBeInTheDocument();
    expect(rowDescriptions()).toEqual(['Harai goshi']);
  });

  it('rn017 Sair e entrar com outro examinador: a gravação do anterior não se sobrepõe à API', async () => {
    const { user, router } = await openScreen();

    await editDescription(user, 'Osoto gari', 'Osoto gari (direita)');
    expect(count('Osoto gari (direita)')).toBe(1);
    // Right after, another examiner renames it back on the server.
    const osoto = db.requirements.find((item) => item.description === 'Osoto gari (direita)')!;
    osoto.description = 'Osoto gari';

    await user.click(screen.getByRole('button', { name: 'Sair' }));
    const email = await screen.findByLabelText(/^E-mail/);
    await replaceText(user, email, 'outro.examinador@example.com');
    await replaceText(user, screen.getByLabelText(/^Senha/), 'senha-teste');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Entrar' })).not.toBeInTheDocument();
    });
    await router.navigate('/requisitos');
    await screen.findByRole('table', { name: 'Requisitos' });

    expect(count('Osoto gari')).toBe(1);
    expect(rowDescriptions()).not.toContain('Osoto gari (direita)');
  });
});
