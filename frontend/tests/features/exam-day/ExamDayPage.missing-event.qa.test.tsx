/**
 * QA #28: Dia do exame quando o evento escolhido não está na lista (§ 6.3, § 6.7, RN005, RN016),
 * casos além da suíte e das regressões `tests/regression/28-*`: a releitura dos eventos que
 * falha depois do 404, confirmações em andamento quando o evento some, a resposta 201 atrasada,
 * o diálogo "Encerrar evento" aberto, avisos de sucesso que sobrariam na tela, voltar/avançar do
 * navegador, StrictMode, o evento que reaparece numa releitura e o teclado.
 */
import type { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProviders } from '../../../src/app/AppProviders';
import { createQueryClient } from '../../../src/app/queryClient';
import { createRoutes } from '../../../src/app/routes';
import { createMockAuth } from '../../../src/auth/mockAuth';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp, type RenderAppResult } from '../../render';
import { EVENTS_URL, dialogGone, gate, makeEvent } from '../events/helpers';

const OPEN = MOCK_EVENT_IDS.open;
const CLOSED = MOCK_EVENT_IDS.closed;
/** Aberto, o mais recente (o padrão) e sem exames: pode ser apagado (RN016). */
const GONE = '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c0d';
const GONE_NAME = 'Exame dezembro/2026';
const GONE_LABEL = 'Exame dezembro/2026 · 12/12/2026 · Aberto';
const MISSING = '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c99';

const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';
const TITLE = 'Dia do exame';
const NOT_FOUND =
  'O evento escolhido não foi encontrado. Ele pode ter sido apagado. Escolha um evento na lista.';
const NO_CHOICE = 'Nenhum evento escolhido';
const GONE_EXAMS_URL = `${TEST_API_URL}/events/${GONE}/exams`;

let db: MockDb;

function picker(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Evento' });
}

function pickerText(): string {
  return picker().selectedOptions[0]?.textContent ?? '';
}

function alertTexts(): string[] {
  return screen
    .queryAllByRole('alert')
    .map((alert) => alert.textContent.replace(/\s+/g, ' ').trim());
}

function studentLists(): HTMLElement[] {
  return [
    ...screen.queryAllByRole('table', { name: LIST }),
    ...screen.queryAllByRole('list', { name: LIST }),
  ];
}

function title(): HTMLElement {
  return screen.getByRole('heading', { level: 1, name: TITLE });
}

function deleteEvent(id: string) {
  db.events = db.events.filter((event) => event.id !== id);
}

async function windowRegainsFocus() {
  await act(async () => {
    window.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
}

/** Deixa toda leitura em andamento terminar e o React desenhar o que voltou. */
async function settle(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
    expect(queryClient.isMutating()).toBe(0);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * O evento vem na URL, como depois de uma escolha no seletor ou de recarregar a página: a tela já
 * abre com ele, sem depender do instante em que o `?evento` do evento padrão chega à tela.
 */
async function openOnGone(route = `${ROUTE}?evento=${GONE}`): Promise<RenderAppResult> {
  const rendered = await renderApp({ route, signedInAs: 'examiner' });
  await screen.findByRole('table', { name: LIST });
  expect(pickerText()).toBe(GONE_LABEL);
  await waitFor(() => {
    expect(rendered.router.state.location.search).toBe(`?evento=${GONE}`);
  });
  return rendered;
}

function confirmButton(name: string): HTMLElement {
  return screen.getByRole('button', { name: `Confirmar presença de ${name}` });
}

async function expectOnlyTheNotice() {
  await waitFor(() => {
    expect(alertTexts()).toEqual([NOT_FOUND]);
  });
  expect(pickerText()).toBe(NO_CHOICE);
  expect(studentLists()).toEqual([]);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^(Encerrar|Reabrir) evento/ })).toBeNull();
}

describe('QA #28: Dia do exame, evento escolhido fora da lista, casos além da suíte', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    db.events.push(makeEvent(GONE, { name: GONE_NAME, exam_date: '2026-12-12' }));
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn005 a releitura dos eventos falha (500) depois do 404: a lista e o aviso do 404 ficam; a releitura seguinte traz o aviso do evento', async () => {
    let failing = true;
    server.use(
      http.get(EVENTS_URL, () =>
        failing ? HttpResponse.json({ message: 'Erro interno' }, { status: 500 }) : undefined,
      ),
    );
    // A primeira carga precisa funcionar.
    failing = false;
    const { user, queryClient, router } = await openOnGone();
    failing = true;
    deleteEvent(GONE);
    await user.click(confirmButton('Ana Souza'));

    await waitFor(() => {
      expect(alertTexts().join(' ')).toContain('Evento não encontrado');
    });
    await settle(queryClient);
    // Nada mudou de evento e o erro do 404 continua dito ao examinador.
    expect(alertTexts().join(' ')).toContain('Não foi possível confirmar a presença de Ana Souza');
    expect(alertTexts()).not.toContain(NOT_FOUND);
    expect(pickerText()).toBe(GONE_LABEL);
    expect(screen.getByRole('table', { name: LIST })).toBeInTheDocument();
    expect(router.state.location.search).toBe(`?evento=${GONE}`);

    failing = false;
    await windowRegainsFocus();
    await expectOnlyTheNotice();
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
  });

  it('rn005 duas confirmações em andamento quando o evento some: dois 404, um só aviso, nenhuma lista e o foco no título', async () => {
    const held = gate();
    let posts = 0;
    server.use(
      http.post(GONE_EXAMS_URL, async () => {
        posts += 1;
        await held.wait;
        return undefined;
      }),
    );
    const { user, queryClient, router } = await openOnGone();
    const [first, second] = screen.getAllByRole('button', { name: /^Confirmar presença de / });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    deleteEvent(GONE);
    await user.click(first!);
    await user.click(second!);
    await waitFor(() => {
      expect(posts).toBe(2);
    });

    held.release();
    await expectOnlyTheNotice();
    await settle(queryClient);
    await expectOnlyTheNotice();
    expect(router.state.location.search).toBe('');
    await waitFor(() => {
      expect(title()).toHaveFocus();
    });
    expect(posts).toBe(2);
  });

  it('rn005 um 201 atrasado depois do aviso não traz a lista nem o aviso de presença; o evento que reaparece não é escolhido sozinho', async () => {
    const held = gate();
    let hidden = false;
    server.use(
      http.post(GONE_EXAMS_URL, async () => {
        await held.wait;
        return undefined;
      }),
      // Uma releitura que não traz o evento, embora a confirmação ainda vá ser aceita.
      http.get(EVENTS_URL, () =>
        hidden ? HttpResponse.json(db.events.filter((event) => event.id !== GONE)) : undefined,
      ),
    );
    const { user, queryClient, router } = await openOnGone();
    await user.click(confirmButton('Ana Souza'));
    hidden = true;
    await windowRegainsFocus();
    await waitFor(() => {
      expect(alertTexts()).toEqual([NOT_FOUND]);
    });

    held.release();
    await settle(queryClient);
    await expectOnlyTheNotice();
    expect(screen.queryByText(/Presença de .* confirmada/)).not.toBeInTheDocument();
    expect(router.state.location.search).toBe('');

    // O evento volta numa releitura: aparece no seletor, mas ninguém o escolheu.
    hidden = false;
    await windowRegainsFocus();
    await waitFor(() => {
      expect(within(picker()).getByRole('option', { name: GONE_LABEL })).toBeInTheDocument();
    });
    await settle(queryClient);
    await expectOnlyTheNotice();
    expect(router.state.location.search).toBe('');

    // Escolhido pelo examinador, a presença que o 201 criou está lá.
    await user.selectOptions(picker(), GONE);
    const table = await screen.findByRole('table', { name: LIST });
    expect(
      await within(table).findByRole('link', { name: 'Abrir exame de Ana Souza' }),
    ).toBeInTheDocument();
    expect(alertTexts()).toEqual([]);
    expect(router.state.location.search).toBe(`?evento=${GONE}`);
  });

  it('"Encerrar evento" aberto quando o evento some numa releitura: o diálogo fica; ao cancelar, o aviso e o foco no título', async () => {
    const { user, queryClient, router } = await openOnGone();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${GONE_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    deleteEvent(GONE);
    await windowRegainsFocus();
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    await settle(queryClient);
    // O foco não sai do diálogo, que continua a pedir a confirmação.
    expect(dialog).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await dialogGone();
    await expectOnlyTheNotice();
    await waitFor(() => {
      expect(title()).toHaveFocus();
    });
  });

  it('rn016 o aviso de "evento encerrado com sucesso" não sobra quando o evento some, nem volta ao escolher outro', async () => {
    const { user, queryClient } = await openOnGone();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${GONE_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    expect(await screen.findByRole('status')).toBeInTheDocument();

    // Minutos depois: a gravação desta sessão já não é posta por cima das leituras de
    // `GET /events` (`recentEventWrites`), e a releitura sem o evento vale.
    vi.setSystemTime(new Date(2026, 10, 2, 12, 30));
    deleteEvent(GONE);
    await windowRegainsFocus();
    await expectOnlyTheNotice();
    await settle(queryClient);

    await user.selectOptions(picker(), OPEN);
    await screen.findByRole('table', { name: LIST });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(alertTexts()).toEqual([]);
  });

  it('rn005 o aviso "Presença confirmada" não sobra quando o evento some; o foco que estava no "Abrir exame" vai ao título', async () => {
    const { user, queryClient } = await openOnGone();
    await user.click(confirmButton('Ana Souza'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Presença de Ana Souza confirmada.',
    );
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Abrir exame de Ana Souza' })).toHaveFocus();
    });

    deleteEvent(GONE);
    await windowRegainsFocus();
    await expectOnlyTheNotice();
    await settle(queryClient);
    await waitFor(() => {
      expect(title()).toHaveFocus();
    });
  });

  it('voltar e avançar do navegador depois do aviso: seletor, lista e URL sempre do mesmo evento, sem aviso sobrando', async () => {
    const { user, queryClient, router } = await renderApp({
      route: `${ROUTE}?evento=${MISSING}`,
      signedInAs: 'examiner',
    });
    await expectOnlyTheNotice();
    await user.selectOptions(picker(), CLOSED);
    await screen.findByRole('table', { name: LIST });
    expect(router.state.location.search).toBe(`?evento=${CLOSED}`);

    // Voltar: a entrada sem `?evento`, de onde o id inexistente saiu. Como numa tela aberta
    // de novo, vale o padrão, e o que a URL diz é o que a tela mostra.
    await act(async () => {
      await router.navigate(-1);
    });
    await screen.findByRole('table', { name: LIST });
    await settle(queryClient);
    expect(alertTexts()).toEqual([]);
    expect(picker()).toHaveValue(GONE);
    expect(router.state.location.search).toBe(`?evento=${GONE}`);

    await act(async () => {
      await router.navigate(1);
    });
    await waitFor(() => {
      expect(picker()).toHaveValue(CLOSED);
    });
    expect(router.state.location.search).toBe(`?evento=${CLOSED}`);
    expect(alertTexts()).toEqual([]);
    expect(await screen.findByRole('note')).toHaveTextContent('Evento encerrado');
  });

  it('StrictMode: o link inexistente dá um só aviso, a URL fica limpa e a escolha no seletor funciona', async () => {
    const auth = createMockAuth(window.sessionStorage);
    await auth.signIn({ email: 'examiner@example.com', password: 'senha-teste', role: 'examiner' });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: true } });
    const router = createMemoryRouter(createRoutes({ useMocks: true }), {
      initialEntries: [`${ROUTE}?evento=${MISSING}`],
    });
    const user = userEvent.setup({ delay: null });
    render(
      <StrictMode>
        <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
          <RouterProvider router={router} />
        </AppProviders>
      </StrictMode>,
    );

    await expectOnlyTheNotice();
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    await settle(queryClient);
    await expectOnlyTheNotice();
    expect(router.state.location.search).toBe('');
    expect(title()).not.toHaveFocus();

    await user.selectOptions(picker(), GONE);
    await screen.findByRole('table', { name: LIST });
    expect(alertTexts()).toEqual([]);
    expect(router.state.location.search).toBe(`?evento=${GONE}`);

    // E o evento apagado enquanto está na tela: o aviso, e o foco perdido vai ao título.
    deleteEvent(GONE);
    await user.click(confirmButton('Ana Souza'));
    await expectOnlyTheNotice();
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    await waitFor(() => {
      expect(title()).toHaveFocus();
    });
  });

  it('teclado (§ 6.7): do título, Tab chega ao seletor; "Nenhum evento escolhido" não pode ser escolhido e some depois da escolha', async () => {
    const { user, queryClient } = await openOnGone();
    deleteEvent(GONE);
    await user.click(confirmButton('Ana Souza'));
    await expectOnlyTheNotice();
    await settle(queryClient);
    await waitFor(() => {
      expect(title()).toHaveFocus();
    });

    await user.tab();
    expect(picker()).toHaveFocus();
    const placeholder = within(picker()).getByRole<HTMLOptionElement>('option', {
      name: NO_CHOICE,
    });
    expect(placeholder.disabled).toBe(true);
    expect(within(picker()).getAllByRole('option')).toHaveLength(db.events.length + 1);

    await user.selectOptions(picker(), OPEN);
    await screen.findByRole('table', { name: LIST });
    expect(within(picker()).queryByRole('option', { name: NO_CHOICE })).toBeNull();
    expect(picker()).toHaveFocus();
  });

  it('todos os eventos apagados com a lista na tela: "Nenhum evento cadastrado.", sem lista, URL limpa e o foco no título', async () => {
    const { user, queryClient, router } = await openOnGone();
    const search = screen.getByRole('searchbox', { name: 'Buscar por nome' });
    await user.click(search);
    db.events = [];
    await windowRegainsFocus();

    expect(await screen.findByText('Nenhum evento cadastrado.')).toBeInTheDocument();
    await settle(queryClient);
    expect(studentLists()).toEqual([]);
    expect(screen.queryByRole('combobox', { name: 'Evento' })).toBeNull();
    expect(router.state.location.search).toBe('');
    await waitFor(() => {
      expect(title()).toHaveFocus();
    });
  });

  it.each([
    ['vazio', '?evento='],
    ['ausente', ''],
  ])(
    '?evento %s conta como sem escolha: o evento aberto mais recente, sem aviso',
    async (_, search) => {
      const { router } = await renderApp({ route: `${ROUTE}${search}`, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      expect(pickerText()).toBe(GONE_LABEL);
      expect(alertTexts()).toEqual([]);
      await waitFor(() => {
        expect(router.state.location.search).toBe(`?evento=${GONE}`);
      });
    },
  );

  it('lgpd: o aviso não põe dado de aluno nem o id do evento apagado na URL, no armazenamento ou no console', async () => {
    const logs = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const { user, queryClient, router } = await openOnGone();
    deleteEvent(GONE);
    await user.click(confirmButton('Ana Souza'));
    await expectOnlyTheNotice();
    await settle(queryClient);

    const { pathname, search, hash } = router.state.location;
    expect(`${pathname}${search}${hash}`).toBe(ROUTE);
    const stored = [window.localStorage, window.sessionStorage]
      .flatMap((storage) => Object.keys(storage).map((key) => storage.getItem(key) ?? ''))
      .join(' ');
    expect(stored).not.toContain('Ana Souza');
    expect(stored).not.toContain(GONE);
    const printed = logs.flatMap((log) => log.mock.calls.flat().map(String)).join(' ');
    expect(printed).not.toContain('Ana Souza');
    logs.forEach((log) => {
      log.mockRestore();
    });
  });
});
