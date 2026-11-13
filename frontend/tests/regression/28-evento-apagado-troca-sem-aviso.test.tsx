/**
 * Erro: no Dia do exame, quando o evento escolhido (`?evento=`) é apagado por outro examinador
 * enquanto está na tela, a tela troca de evento sem avisar. Percebido no 404 "Evento não
 * encontrado" do "Confirmar presença" (que relê os eventos) ou numa releitura em segundo plano
 * (volta do foco à janela), o evento sai da lista e `selectEvent` cai para o evento aberto mais
 * recente: o seletor e o `?evento` passam para ele e a lista de alunos dele aparece; o aviso do
 * 404 some junto com a lista do evento apagado e o foco, que estava no "Confirmar presença",
 * cai no `body`. Sem outro evento aberto, a tela mostra só "Nenhum evento aberto." e o
 * `?evento` do evento apagado fica na URL.
 * Esperado (decisão do usuário, opção A: a tela nunca troca de evento sozinha):
 * 1. um aviso `role="alert"` com exatamente "O evento escolhido não foi encontrado. Ele pode ter
 *    sido apagado. Escolha um evento na lista.";
 * 2. o seletor fica em "Nenhum evento escolhido" e nenhuma lista de alunos aparece, nem a de
 *    outro evento, até o examinador escolher um evento;
 * 3. o `?evento` sai da URL (replace) e não volta sozinho com outro evento;
 * 4. o foco perdido (estava na lista que sumiu) vai para o título "Dia do exame"; o foco que
 *    está num lugar que continua na tela (o seletor) não é roubado (§ 6.7);
 * 5. escolher um evento no seletor tira o aviso e mostra a lista dele;
 * 6. sem outro evento aberto, o aviso aparece no lugar do "Nenhum evento aberto." mudo.
 * Os casos "guarda" passam hoje e não podem quebrar com a correção.
 * Issue: #28
 */
import type { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryKeys } from '../../src/api/queries';
import type { ExamEvent } from '../../src/api/types';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { gate, makeEvent } from '../features/events/helpers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp, type RenderAppResult } from '../render';

/** "Exame novembro/2026" (21/11/2026), open and with exams: where the old code falls back. */
const OPEN = MOCK_EVENT_IDS.open;
const OPEN_LABEL = 'Exame novembro/2026 · 21/11/2026 · Aberto';
const CLOSED = MOCK_EVENT_IDS.closed;
/** The event another examiner deletes: open, the most recent one, no exams (RN016 allows it). */
const GONE = '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c0d';
const GONE_LABEL = 'Exame dezembro/2026 · 12/12/2026 · Aberto';
/** Another open event, older than OPEN (so never the default), only in one case of E. */
const OLDER = '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c0e';
const OLDER_LABEL = 'Exame outubro/2026 · 25/10/2026 · Aberto';

const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';
const TITLE = 'Dia do exame';
const NOT_FOUND =
  'O evento escolhido não foi encontrado. Ele pode ter sido apagado. Escolha um evento na lista.';
const NO_CHOICE = 'Nenhum evento escolhido';
const NO_OPEN_EVENT = 'Nenhum evento aberto.';
const OPEN_EXAMS_URL = `${TEST_API_URL}/events/${OPEN}/exams`;
const GONE_EXAMS_URL = `${TEST_API_URL}/events/${GONE}/exams`;

let db: MockDb;

function picker(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Evento' });
}

/** Text of the option the event picker shows. */
function pickerText(): string {
  return picker().selectedOptions[0]?.textContent ?? '';
}

/** Text of each `role="alert"` on the screen, spaces normalized. */
function alertTexts(): string[] {
  return screen
    .queryAllByRole('alert')
    .map((alert) => alert.textContent.replace(/\s+/g, ' ').trim());
}

/** Lists of students on the screen: the table (notebook) or the cards (phone). */
function studentLists(): HTMLElement[] {
  return [
    ...screen.queryAllByRole('table', { name: LIST }),
    ...screen.queryAllByRole('list', { name: LIST }),
  ];
}

/** Where the focus is, in a short form for the failure message (`body` when lost). */
function focusedElement(): string {
  const active = document.activeElement;
  if (active === null || active === document.body) return 'body';
  const name = active.getAttribute('aria-label') ?? active.textContent.trim();
  return `${active.tagName.toLowerCase()} "${name}"`;
}

function rowOf(table: HTMLElement, name: string): HTMLElement {
  return within(table).getByRole('rowheader', { name }).closest('tr')!;
}

/** Counts the GETs to `url`; the simulated API still answers them. */
function countGets(url: string) {
  const calls = { count: 0 };
  server.use(
    http.get(url, () => {
      calls.count += 1;
      return undefined;
    }),
  );
  return calls;
}

/** Another examiner deletes the event (it has no exams, RN016): it leaves the API. */
function deleteEvent(id: string) {
  db.events = db.events.filter((event) => event.id !== id);
}

/** The other open event gets closed, so none is left open once GONE is deleted. */
function closeOpenEvent() {
  db.events = db.events.map((event) =>
    event.id === OPEN ? { ...event, status: 'CLOSED' as const } : event,
  );
}

/** The exam day on `route`, with the list of GONE on the screen. */
async function openOnGone(route: string): Promise<RenderAppResult> {
  const rendered = await renderApp({ route, signedInAs: 'examiner' });
  await screen.findByRole('table', { name: LIST });
  expect(pickerText()).toBe(GONE_LABEL);
  await waitFor(() => {
    expect(rendered.router.state.location.search).toBe(`?evento=${GONE}`);
  });
  return rendered;
}

function anaConfirmButton(): HTMLElement {
  return within(rowOf(screen.getByRole('table', { name: LIST }), 'Ana Souza')).getByRole('button', {
    name: 'Confirmar presença de Ana Souza',
  });
}

/** GONE is deleted, then "Confirmar presença" of Ana: the API answers 404 "Evento não encontrado". */
async function confirmAnaAfterDeletion(user: UserEvent) {
  deleteEvent(GONE);
  await user.click(anaConfirmButton());
}

/** GONE is deleted, then the window gets the focus back: the events are read again. */
async function windowRegainsFocusAfterDeletion() {
  deleteEvent(GONE);
  await act(async () => {
    window.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
}

/** Waits for the re-read of the events that no longer brings `id` to be over. */
async function eventsReread(queryClient: QueryClient, id: string) {
  await waitFor(() => {
    const state = queryClient.getQueryState<ExamEvent[]>(queryKeys.events);
    expect(state?.data?.map((event) => event.id)).not.toContain(id);
    expect(state?.fetchStatus).toBe('idle');
  });
}

/**
 * Waits until the screen reacted to that re-read, whatever the code does: the notice, the mute
 * "Nenhum evento aberto." or the list of another event.
 */
async function screenReacted(id: string) {
  await waitFor(() => {
    const reacted =
      alertTexts().includes(NOT_FOUND) ||
      screen.queryByText(NO_OPEN_EVENT) !== null ||
      (picker().value !== id && studentLists().length > 0);
    expect(reacted, 'a tela ainda não reagiu à releitura sem o evento').toBe(true);
  });
}

/** Lets every read on its way end and React draw what came back. */
async function settle(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The re-read without GONE happened and the screen is done with it. */
async function goneSettled(queryClient: QueryClient) {
  await eventsReread(queryClient, GONE);
  await screenReacted(GONE);
  await settle(queryClient);
}

async function expectFocusOnTitle() {
  await waitFor(() => {
    expect(focusedElement()).toBe(`h1 "${TITLE}"`);
  });
  expect(screen.getByRole('heading', { level: 1, name: TITLE })).toHaveFocus();
}

describe('Dia do exame: o evento escolhido é apagado enquanto está na tela (§ 6.3, § 6.7, #28)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    db.events.push(makeEvent(GONE, { name: 'Exame dezembro/2026', exam_date: '2026-12-12' }));
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('A. 404 do "Confirmar presença", com outro evento aberto', () => {
    it('1. mostra o aviso de evento não encontrado, e só ele', async () => {
      const { user, queryClient } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);

      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });
    });

    it('2. o seletor fica em "Nenhum evento escolhido" e não aparece a lista do outro evento aberto', async () => {
      const openExams = countGets(OPEN_EXAMS_URL);
      const { user, queryClient } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);

      await waitFor(() => {
        expect(pickerText()).toBe(NO_CHOICE);
      });
      expect(picker()).toHaveValue('');
      expect(studentLists()).toEqual([]);
      expect(screen.queryByText('Carregando alunos…')).not.toBeInTheDocument();
      expect(
        openExams.count,
        'a lista do outro evento aberto foi carregada (GET dos exames dele)',
      ).toBe(0);
    });

    it('3. o ?evento sai da URL, com replace, e não volta com o outro evento', async () => {
      const { user, queryClient, router } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      expect(router.state.historyAction).toBe('POP');
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);

      await waitFor(() => {
        expect(router.state.location.search).toBe('');
      });
      expect(router.state.location.pathname).toBe(ROUTE);
      expect(router.state.historyAction).toBe('REPLACE');
      await settle(queryClient);
      expect(router.state.location.search).toBe('');
    });

    it('4. o foco, perdido com a lista que sumiu, vai para o título "Dia do exame"', async () => {
      const { user, queryClient } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);

      await expectFocusOnTitle();
    });

    it('4. guarda: o foco que o examinador levou ao seletor durante a confirmação não é roubado', async () => {
      const held = gate();
      server.use(
        http.post(GONE_EXAMS_URL, async () => {
          await held.wait;
          return undefined;
        }),
      );
      const { user, queryClient } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await waitFor(() => {
        expect(anaConfirmButton()).toHaveAttribute('data-loading', 'true');
      });
      await user.click(picker());
      expect(picker()).toHaveFocus();

      held.release();
      await goneSettled(queryClient);
      expect(picker()).toHaveFocus();
    });
  });

  describe('B. 404 do "Confirmar presença", sem outro evento aberto', () => {
    beforeEach(() => {
      closeOpenEvent();
    });

    it('1. mostra o aviso de evento não encontrado, e só ele', async () => {
      const { user, queryClient } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);

      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });
    });

    it('3. o ?evento do evento apagado sai da URL, com replace', async () => {
      const { user, queryClient, router } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);

      await waitFor(() => {
        expect(router.state.location.search).toBe('');
      });
      expect(router.state.historyAction).toBe('REPLACE');
    });

    it('6. o aviso fica no lugar do "Nenhum evento aberto." mudo', async () => {
      const { user, queryClient } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);

      expect(screen.queryByText(NO_OPEN_EVENT)).not.toBeInTheDocument();
      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });
      expect(pickerText()).toBe(NO_CHOICE);
      expect(studentLists()).toEqual([]);
    });

    it('4. o foco, perdido com a lista que sumiu, vai para o título "Dia do exame"', async () => {
      const { user, queryClient } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);

      await expectFocusOnTitle();
    });
  });

  describe('C. releitura em segundo plano (volta do foco à janela), sem clique', () => {
    it('1. mostra o aviso de evento não encontrado', async () => {
      const { queryClient } = await openOnGone(ROUTE);
      await windowRegainsFocusAfterDeletion();
      await goneSettled(queryClient);

      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });
    });

    it('2. o seletor fica em "Nenhum evento escolhido" e não aparece a lista do outro evento aberto', async () => {
      const openExams = countGets(OPEN_EXAMS_URL);
      const { queryClient } = await openOnGone(ROUTE);
      await windowRegainsFocusAfterDeletion();
      await goneSettled(queryClient);

      await waitFor(() => {
        expect(pickerText()).toBe(NO_CHOICE);
      });
      expect(studentLists()).toEqual([]);
      expect(screen.queryByText('Carregando alunos…')).not.toBeInTheDocument();
      expect(
        openExams.count,
        'a lista do outro evento aberto foi carregada (GET dos exames dele)',
      ).toBe(0);
    });

    it('3. o ?evento sai da URL e não volta com o outro evento', async () => {
      const { queryClient, router } = await openOnGone(ROUTE);
      await windowRegainsFocusAfterDeletion();
      await goneSettled(queryClient);

      await waitFor(() => {
        expect(router.state.location.search).toBe('');
      });
      expect(router.state.historyAction).toBe('REPLACE');
      await settle(queryClient);
      expect(router.state.location.search).toBe('');
    });

    it('4. o foco que estava na busca da lista que sumiu vai para o título "Dia do exame"', async () => {
      const { user, queryClient } = await openOnGone(ROUTE);
      const search = screen.getByRole('searchbox', { name: 'Buscar por nome' });
      await user.click(search);
      expect(search).toHaveFocus();

      await windowRegainsFocusAfterDeletion();
      await goneSettled(queryClient);

      await expectFocusOnTitle();
    });

    it('4. guarda: o foco no seletor, que continua na tela, não é roubado', async () => {
      const { user, queryClient } = await openOnGone(ROUTE);
      await user.click(picker());
      expect(picker()).toHaveFocus();

      await windowRegainsFocusAfterDeletion();
      await goneSettled(queryClient);
      expect(picker()).toHaveFocus();
    });

    it('guarda: apagar outro evento, que não é o escolhido, não muda nada nem avisa', async () => {
      const { queryClient, router } = await openOnGone(ROUTE);
      db.events = db.events.filter((event) => event.id !== CLOSED);
      await act(async () => {
        window.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      await eventsReread(queryClient, CLOSED);
      await settle(queryClient);

      expect(alertTexts()).toEqual([]);
      expect(pickerText()).toBe(GONE_LABEL);
      expect(router.state.location.search).toBe(`?evento=${GONE}`);
      expect(screen.getByRole('table', { name: LIST })).toBeInTheDocument();
    });
  });

  describe('E. depois de A, escolher um evento no seletor', () => {
    it('5. o aviso some e a lista do evento escolhido aparece', async () => {
      const { user, queryClient, router } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);
      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });

      await user.selectOptions(picker(), OPEN);
      const table = await screen.findByRole('table', { name: LIST });
      expect(alertTexts()).toEqual([]);
      expect(pickerText()).toBe(OPEN_LABEL);
      expect(router.state.location.search).toBe(`?evento=${OPEN}`);
      expect(
        within(rowOf(table, 'Helena Prado')).getByRole('link', {
          name: 'Abrir exame de Helena Prado',
        }),
      ).toBeInTheDocument();
    });

    it('5. vale também para um evento aberto que não é o padrão: a tela fica nele', async () => {
      // Older than OPEN: the default (most recent open) is still OPEN, not the chosen one.
      db.events.push(makeEvent(OLDER, { name: 'Exame outubro/2026', exam_date: '2026-10-25' }));
      const { user, queryClient, router } = await openOnGone(`${ROUTE}?evento=${GONE}`);
      await confirmAnaAfterDeletion(user);
      await goneSettled(queryClient);
      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });

      await user.selectOptions(picker(), OLDER);
      await screen.findByRole('table', { name: LIST });
      await settle(queryClient);
      expect(alertTexts()).toEqual([]);
      expect(pickerText()).toBe(OLDER_LABEL);
      expect(router.state.location.search).toBe(`?evento=${OLDER}`);
    });
  });
});
