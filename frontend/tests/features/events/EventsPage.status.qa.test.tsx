/**
 * Events screen (§ 6.5, § 6.7, RN016), "Encerrar" / "Reabrir" beyond
 * `EventsPage.status.test.tsx`: layout change with the dialog open, a second dialog opened
 * while the first fades out, the edit form after the change, keyboard, long accented names on
 * the phone, 401 and network failure on the `PUT`, and the guardian (QA of card #136).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { holdExitTransitions } from '../../exitTransitions';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { mediaMatches, setViewportWidth } from '../../viewport';
import {
  EVENTS_URL,
  ROUTE,
  dialogGone,
  openEdit,
  openEvents,
  recordRequests,
  statusSelect,
  tableRows,
  writes,
} from './helpers';

const OPEN_NAME = 'Exame novembro/2026';
const CLOSED_NAME = 'Exame março/2026';

let db: MockDb;

function stored(id: string) {
  const event = db.events.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`sem o evento ${id}`);
  return event;
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

describe('QA #136: Encerrar / Reabrir, casos além da suíte', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  });

  it('a troca de layout com o diálogo aberto devolve o foco ao "Reabrir" do cartão', async () => {
    stubMatchMedia();
    const { user } = await openEvents();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    resizeTo(390);
    await screen.findByRole('list', { name: 'Eventos' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    const card = within(screen.getByRole('list', { name: 'Eventos' })).getAllByRole(
      'listitem',
    )[0] as HTMLElement;
    expect(within(card).getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` })).toHaveFocus();
  });

  it('cancelar A e abrir B durante o fechamento: o diálogo e o PUT são de B', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    const exit = holdExitTransitions();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: `Reabrir evento ${CLOSED_NAME}` }));
    exit.release();
    const reopen = await screen.findByRole('dialog', { name: 'Reabrir evento' });
    expect(reopen).toHaveTextContent(`Reabrir o evento “${CLOSED_NAME}” (01/03/2026)?`);
    await user.click(within(reopen).getByRole('button', { name: 'Reabrir' }));
    await dialogGone();
    expect(writes(requests)).toEqual([
      {
        method: 'PUT',
        url: `${EVENTS_URL}/${MOCK_EVENT_IDS.closed}`,
        body: { name: CLOSED_NAME, status: 'OPEN' },
      },
    ]);
    expect(stored(MOCK_EVENT_IDS.open).status).toBe('OPEN');
    expect(screen.getByRole('button', { name: `Encerrar evento ${CLOSED_NAME}` })).toHaveFocus();
  });

  it('encerrar A e abrir B enquanto A some: B ainda pode ser reaberto (a trava é liberada)', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    const exit = holdExitTransitions();
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: `Reabrir evento ${CLOSED_NAME}` }));
    exit.release();
    const reopen = await screen.findByRole('dialog', { name: 'Reabrir evento' });
    await user.click(within(reopen).getByRole('button', { name: 'Reabrir' }));
    await dialogGone();
    expect(writes(requests).map((request) => request.body)).toEqual([
      { name: OPEN_NAME, status: 'CLOSED' },
      { name: CLOSED_NAME, status: 'OPEN' },
    ]);
    expect(tableRows().map((cells) => cells[2])).toEqual(['Encerrado', 'Aberto']);
  });

  it('depois de encerrar, "Editar" abre com a situação Encerrado', async () => {
    const { user } = await openEvents();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    const edit = await openEdit(user, OPEN_NAME);
    expect(statusSelect(edit).value).toBe('CLOSED');
  });

  it('teclado: Tab do "Cancelar" vai ao "Encerrar" e Enter envia', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    });
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Encerrar' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(writes(requests)).toHaveLength(1);
    expect(screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` })).toHaveFocus();
  });

  it('nome longo com acentos no celular (360 px): texto e rótulos completos', async () => {
    const name = 'Exame de graduação de Judô — turma infantil da manhã, Araraquara (São João)';
    db.events = db.events.map((event) =>
      event.id === MOCK_EVENT_IDS.open ? { ...event, name } : event,
    );
    setViewportWidth(360);
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    await screen.findByRole('list', { name: 'Eventos' });
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${name}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    expect(dialog).toHaveTextContent(`Encerrar o evento “${name}” (21/11/2026)?`);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    expect(stored(MOCK_EVENT_IDS.open)).toMatchObject({ name, status: 'CLOSED' });
    expect(screen.getByRole('button', { name: `Reabrir evento ${name}` })).toHaveFocus();
  });

  it('401 no PUT encerra a sessão e volta ao login, sem diálogo preso', async () => {
    server.use(
      http.put(`${EVENTS_URL}/:id`, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );
    const { user } = await openEvents();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await waitFor(() => {
      expect(screen.queryByRole('table', { name: 'Eventos' })).not.toBeInTheDocument();
    });
    await dialogGone();
    expect(stored(MOCK_EVENT_IDS.open).status).toBe('OPEN');
  });

  it('queda de rede no PUT: mensagem de conexão no diálogo, que continua aberto', async () => {
    server.use(http.put(`${EVENTS_URL}/:id`, () => HttpResponse.error()));
    const { user } = await openEvents();
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível encerrar');
    expect(alert).toHaveTextContent('Não foi possível falar com o servidor');
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
  });

  it('responsável não vê "Encerrar" nem "Reabrir"', async () => {
    await openEvents('guardian');
    await waitFor(() => {
      expect(screen.queryByRole('table', { name: 'Eventos' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^(Encerrar|Reabrir) evento/ })).toBeNull();
  });
});
