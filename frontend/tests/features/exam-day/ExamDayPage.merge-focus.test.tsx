import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb, MOCK_EVENT_IDS, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const OPEN = MOCK_EVENT_IDS.open;
const CLOSED = MOCK_EVENT_IDS.closed;
const OPEN_EXAMS_URL = `${TEST_API_URL}/events/${OPEN}/exams`;
const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';

let db: MockDb;

function rowOf(table: HTMLElement, name: string): HTMLElement {
  return within(table).getByRole('rowheader', { name }).closest('tr')!;
}

function filterRadio(name: RegExp) {
  return within(screen.getByRole('radiogroup', { name: 'Filtrar alunos' })).getByRole('radio', {
    name,
  });
}

function holdPosts() {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let count = 0;
  server.use(
    http.post(OPEN_EXAMS_URL, async () => {
      count += 1;
      await gate;
      return undefined;
    }),
  );
  return {
    held: () => count,
    release: () => {
      open();
    },
  };
}

/** Every GET of the open event's exams after the first POST answers stale (empty). */
function staleAfterPost() {
  let posted = false;
  server.use(
    http.post(OPEN_EXAMS_URL, () => {
      posted = true;
      return undefined;
    }),
    http.get(OPEN_EXAMS_URL, () => (posted ? HttpResponse.json([]) : undefined)),
  );
}

async function settle(ms = 80) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('exam day: focus and confirmed exams across reloads (§ 6.3, RN005, RN016)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('focus goes to the second link after two confirmations in a row', async () => {
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
    );
    const ana = await within(rowOf(table, 'Ana Souza')).findByRole('link', { name: /Abrir/ });
    await waitFor(() => expect(ana).toHaveFocus());
    await user.click(
      within(rowOf(table, 'Carla Mendes')).getByRole('button', { name: /Confirmar presença/ }),
    );
    const carla = await within(rowOf(table, 'Carla Mendes')).findByRole('link', {
      name: /Abrir/,
    });
    await waitFor(() => expect(carla).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Presença de Carla Mendes confirmada.');
    expect(filterRadio(/^Presentes \(3\)$/)).toBeInTheDocument();
    // Search then clear: neither link steals the focus.
    const search = screen.getByRole('searchbox', { name: 'Buscar por nome' });
    await user.click(search);
    await user.type(search, 'zz{Backspace}{Backspace}ca');
    expect(search).toHaveFocus();
    expect(search).toHaveValue('ca');
  });

  it('does not steal the focus when the row is hidden by the search at the 201', async () => {
    const { release, held } = holdPosts();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
    );
    await waitFor(() => {
      expect(held()).toBe(1);
    });
    const search = screen.getByRole('searchbox', { name: 'Buscar por nome' });
    await user.click(search);
    await user.type(search, 'carla');
    release();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Presença de Ana Souza confirmada.'),
    );
    await settle();
    await user.clear(search);
    await settle();
    expect(search).toHaveFocus();
    expect(
      within(rowOf(screen.getByRole('table', { name: LIST }), 'Ana Souza')).getByRole('link', {
        name: /Abrir exame/,
      }),
    ).not.toHaveFocus();
  });

  it('keeps the merged exam after switching event and back', async () => {
    staleAfterPost();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
    );
    await within(rowOf(table, 'Ana Souza')).findByRole('link', { name: /Abrir exame/ });
    await settle();

    const picker = screen.getByRole('combobox', { name: 'Evento' });
    await user.selectOptions(picker, CLOSED);
    await screen.findByRole('note');
    await waitFor(() => {
      expect(
        within(screen.getByRole('table', { name: LIST })).queryByRole('link', {
          name: 'Abrir exame de Ana Souza',
        }),
      ).toBeNull();
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Evento' }), OPEN);
    await waitFor(() => {
      expect(screen.queryByRole('note')).toBeNull();
    });
    const back = await screen.findByRole('table', { name: LIST });
    await settle();
    expect(
      within(rowOf(back, 'Ana Souza')).getByRole('link', { name: 'Abrir exame de Ana Souza' }),
    ).toBeInTheDocument();
    expect(filterRadio(/^Presentes \(1\)$/)).toBeInTheDocument();
    // No focus steal on the way back.
    expect(within(rowOf(back, 'Ana Souza')).getByRole('link')).not.toHaveFocus();
  });

  it('keeps the merged exam with only "Abrir exame" once the event is closed', async () => {
    staleAfterPost();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
    );
    await within(rowOf(table, 'Ana Souza')).findByRole('link', { name: /Abrir exame/ });
    db.events = db.events.map((event) =>
      event.id === OPEN ? { ...event, status: 'CLOSED' } : event,
    );
    // Another confirm hits the closed event (400) and reloads the events.
    await user.click(
      within(rowOf(table, 'Carla Mendes')).getByRole('button', { name: /Confirmar presença/ }),
    );
    await screen.findByRole('note');
    await settle();
    const closedTable = screen.getByRole('table', { name: LIST });
    expect(within(closedTable).queryAllByRole('button')).toHaveLength(0);
    expect(
      within(rowOf(closedTable, 'Ana Souza')).getByRole('link', {
        name: 'Abrir exame de Ana Souza',
      }),
    ).toBeInTheDocument();
    expect(rowOf(closedTable, 'Ana Souza')).toHaveTextContent('Presente · Em andamento');
    expect(filterRadio(/^Presentes \(1\)$/)).toBeInTheDocument();
  });

  it('counts the merged exams in the filters, with the search applied', async () => {
    staleAfterPost();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
    );
    await within(rowOf(table, 'Ana Souza')).findByRole('link', { name: /Abrir exame/ });
    await settle();
    // Stale reload: Helena (already present) also disappears from the GET; only Ana stays.
    expect(filterRadio(/^Presentes \(1\)$/)).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Buscar por nome' }), 'souza');
    expect(filterRadio(/^Todos \(2\)$/)).toBeInTheDocument();
    expect(filterRadio(/^Presentes \(1\)$/)).toBeInTheDocument();
    await user.click(filterRadio(/^Presentes/));
    expect(
      within(screen.getByRole('table', { name: LIST }))
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Ana Souza']);
  });

  it('moves the focus to "Abrir exame" in a card at 390 px, once', async () => {
    setViewportWidth(390);
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const list = await screen.findByRole('list', { name: LIST });
    const card = () =>
      within(screen.getByRole('list', { name: LIST }))
        .getAllByRole('listitem')
        .find((item) => item.textContent.includes('Carla Mendes'))!;
    await user.click(within(card()).getByRole('button', { name: /Confirmar presença/ }));
    const link = await within(card()).findByRole('link', { name: 'Abrir exame de Carla Mendes' });
    await waitFor(() => expect(link).toHaveFocus());
    expect(list).toBeInTheDocument();
    const filters = screen.getByRole('radiogroup', { name: 'Filtrar alunos' });
    await user.click(within(filters).getByRole('radio', { name: /^Bloqueados/ }));
    const present = within(filters).getByRole('radio', { name: /^Presentes/ });
    await user.click(present);
    expect(present).toHaveFocus();
  });
});
