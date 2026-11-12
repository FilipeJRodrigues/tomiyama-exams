/**
 * Exam day (§ 6.3, § 6.7, RN016), "Encerrar evento" / "Reabrir evento" beyond
 * `ExamDayPage.status.test.tsx`: layout change with the dialog open, a stale `GET /events`
 * after the change, a second dialog opened while the first fades out, keyboard order, long
 * accented names on the phone, attendance after reopening, 401 and network failure on the
 * `PUT`, and the guardian (QA of card #137).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { holdExitTransitions } from '../../exitTransitions';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { mediaMatches, setViewportWidth } from '../../viewport';
import { EVENTS_URL, dialogGone, recordRequests, writes } from '../events/helpers';

const OPEN = MOCK_EVENT_IDS.open;
const CLOSED = MOCK_EVENT_IDS.closed;
const OPEN_NAME = 'Exame novembro/2026';
const CLOSED_NAME = 'Exame março/2026';
const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';

let db: MockDb;

function stored(id: string) {
  const event = db.events.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`sem o evento ${id}`);
  return event;
}

function confirmButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /^Confirmar presença/ });
}

type Listener = (event: { matches: boolean; media: string }) => void;
let listeners: { query: string; listener: Listener }[] = [];
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

function stubMatchMedia() {
  listeners = [];
  window.matchMedia = ((query: string) => ({
    matches: mediaMatches(query),
    media: query,
    onchange: null,
    addListener: (listener: Listener) => {
      listeners.push({ query, listener });
    },
    removeListener: () => undefined,
    addEventListener: (_type: string, listener: Listener) => {
      listeners.push({ query, listener });
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function resizeTo(width: number) {
  setViewportWidth(width);
  act(() => {
    for (const { query, listener } of listeners) {
      listener({ matches: mediaMatches(query), media: query });
    }
  });
}

async function openExamDay(route = ROUTE) {
  const result = await renderApp({ route, signedInAs: 'examiner' });
  await screen.findByRole('table', { name: LIST });
  return result;
}

describe('QA #137: Encerrar / Reabrir no Dia do exame, casos além da suíte', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  });

  it('troca de layout com o diálogo aberto: tela cheia no celular, cartões e foco de volta ao botão', async () => {
    stubMatchMedia();
    const { user } = await openExamDay();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    resizeTo(360);
    await screen.findByRole('list', { name: LIST });
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Encerrar evento' })).toHaveAttribute(
        'data-full-screen',
        'true',
      );
    });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    const reopen = screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` });
    expect(reopen).toHaveFocus();
    expect(reopen).toHaveStyle({ minHeight: '44px' });
  });

  it('rn016 um GET /events defasado depois de encerrar não traz o evento de volta como aberto', async () => {
    const { user } = await openExamDay();
    const staleOpen = db.events.map((event) => ({ ...event }));
    // Every read from now on answers the list from before the PUT (Scan without ConsistentRead).
    server.use(http.get(EVENTS_URL, () => HttpResponse.json(staleOpen)));
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    expect(await screen.findByRole('note')).toHaveTextContent('Evento encerrado');
    // Give the invalidated reload time to land.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` })).toBeVisible();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` })).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent('Evento encerrado');
    expect(confirmButtons()).toHaveLength(0);
  });

  it('encerrar e reabrir enquanto o primeiro diálogo some: o segundo PUT vai (a trava é liberada)', async () => {
    const { user } = await openExamDay();
    const requests = recordRequests();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    const exit = holdExitTransitions();
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` }));
    exit.release();
    const reopen = await screen.findByRole('dialog', { name: 'Reabrir evento' });
    await user.click(within(reopen).getByRole('button', { name: 'Reabrir' }));
    await dialogGone();
    expect(writes(requests).map((request) => request.body)).toEqual([
      { name: OPEN_NAME, status: 'CLOSED' },
      { name: OPEN_NAME, status: 'OPEN' },
    ]);
    expect(stored(OPEN).status).toBe('OPEN');
    expect(screen.getByRole('status')).toHaveTextContent('Evento reaberto.');
    expect(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` })).toHaveFocus();
  });

  it('teclado: Tab do seletor vai ao botão, antes da lista', async () => {
    const { user } = await openExamDay();
    screen.getByRole('combobox', { name: 'Evento' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` })).toHaveFocus();
  });

  it('nome longo com acentos no celular (360 px): rótulo completo, texto visível curto', async () => {
    const name = 'Exame de graduação de Judô — turma infantil da manhã, Araraquara (São João)';
    db.events = db.events.map((event) => (event.id === OPEN ? { ...event, name } : event));
    setViewportWidth(360);
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    await screen.findByRole('list', { name: LIST });
    const trigger = screen.getByRole('button', { name: `Encerrar evento ${name}` });
    expect(trigger).toHaveTextContent(/^Encerrar evento$/);
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    expect(dialog).toHaveTextContent(`Encerrar o evento “${name}” (21/11/2026)?`);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    expect(stored(OPEN)).toMatchObject({ name, status: 'CLOSED' });
    expect(screen.getByRole('button', { name: `Reabrir evento ${name}` })).toHaveFocus();
  });

  it('rn016 reabrir devolve a presença: "Confirmar presença" volta a funcionar', async () => {
    const { user } = await openExamDay(`${ROUTE}?evento=${CLOSED}`);
    expect(confirmButtons()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: `Reabrir evento ${CLOSED_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Reabrir evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Reabrir' }));
    await dialogGone();
    await waitFor(() => {
      expect(confirmButtons().length).toBeGreaterThan(0);
    });
    const first = confirmButtons()[0] as HTMLElement;
    const studentName = (first.getAttribute('aria-label') ?? '').replace(
      'Confirmar presença de ',
      '',
    );
    await user.click(first);
    expect(await screen.findByText(`Presença de ${studentName} confirmada.`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Abrir exame de ${studentName}` })).toBeInTheDocument();
  });

  it('401 no PUT encerra a sessão e volta ao login, sem diálogo preso', async () => {
    server.use(
      http.put(`${EVENTS_URL}/:id`, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );
    const { user } = await openExamDay();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await waitFor(() => {
      expect(screen.queryByRole('table', { name: LIST })).not.toBeInTheDocument();
    });
    await dialogGone();
    expect(stored(OPEN).status).toBe('OPEN');
  });

  it('403 no PUT: "Sem permissão" com a mensagem da API, tela sem mudança', async () => {
    const message = 'Esta área é dos examinadores';
    server.use(
      http.put(`${EVENTS_URL}/:id`, () => HttpResponse.json({ message }, { status: 403 })),
    );
    const { user } = await openExamDay();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent(message);
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await dialogGone();
    expect(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` })).toHaveFocus();
    expect(confirmButtons().length).toBeGreaterThan(0);
  });

  it('queda de rede no PUT: mensagem de conexão no diálogo, que continua aberto', async () => {
    server.use(http.put(`${EVENTS_URL}/:id`, () => HttpResponse.error()));
    const { user } = await openExamDay();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível encerrar');
    expect(alert).toHaveTextContent('Não foi possível falar com o servidor');
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
  });

  it('responsável não vê "Encerrar" nem "Reabrir" no Dia do exame', async () => {
    await renderApp({ route: ROUTE, signedInAs: 'guardian' });
    await waitFor(() => {
      expect(screen.queryByText('Carregando eventos…')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('table', { name: LIST })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Encerrar|Reabrir) evento/ })).toBeNull();
  });
});
