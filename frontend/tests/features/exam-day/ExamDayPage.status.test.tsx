/**
 * Exam day (§ 6.3), "Encerrar evento" / "Reabrir evento" beside the event picker: the same
 * confirmation as the events screen (§ 6.5), then `PUT /events/{id}` with the name and the other
 * status. Closing takes the attendance actions away and shows the "Evento encerrado" note
 * (RN016); reopening gives them back. The event stays selected (picker and `?evento=`), the API
 * messages stay in the dialog and the focus goes back to the button (§ 6.7).
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import { EVENTS_URL, dialogGone, gate, makeEvent, recordRequests, writes } from '../events/helpers';

const OPEN = MOCK_EVENT_IDS.open;
const CLOSED = MOCK_EVENT_IDS.closed;
const OPEN_NAME = 'Exame novembro/2026';
const CLOSED_NAME = 'Exame março/2026';
const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';
const TITLE = 'Dia do exame';

const CLOSE_TEXT =
  'Encerrar o evento “Exame novembro/2026” (21/11/2026)? A presença e a marcação dos itens ficam bloqueadas, mas o sensei ainda pode decidir os exames em andamento. O evento pode ser reaberto depois.';
const REOPEN_TEXT =
  'Reabrir o evento “Exame março/2026” (01/03/2026)? A presença e a marcação dos itens voltam a ser permitidas.';

let db: MockDb;

function stored(id: string) {
  const event = db.events.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`sem o evento ${id}`);
  return event;
}

function picker(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Evento' });
}

function confirmButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /^Confirmar presença/ });
}

function statusButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /^(Encerrar|Reabrir) evento/ });
}

async function openClose(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
  return screen.findByRole('dialog', { name: 'Encerrar evento' });
}

async function openReopen(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: `Reabrir evento ${CLOSED_NAME}` }));
  return screen.findByRole('dialog', { name: 'Reabrir evento' });
}

async function openExamDay(route = ROUTE) {
  const result = await renderApp({ route, signedInAs: 'examiner' });
  await screen.findByRole('table', { name: LIST });
  return result;
}

describe('exam day, "Encerrar evento" / "Reabrir evento" (§ 6.3, § 6.5)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn016 offers "Encerrar evento" for the open event and "Reabrir evento" for the closed one', async () => {
    const { user } = await openExamDay();
    const close = screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` });
    expect(close).toHaveTextContent(/^Encerrar evento$/);
    expect(statusButtons()).toEqual([close]);

    await user.selectOptions(picker(), CLOSED);
    const reopen = await screen.findByRole('button', { name: `Reabrir evento ${CLOSED_NAME}` });
    expect(reopen).toHaveTextContent(/^Reabrir evento$/);
    expect(statusButtons()).toEqual([reopen]);
  });

  it('rn016 closes the selected event: PUT with the name and CLOSED, note on, attendance off, same event, focus back', async () => {
    // A second open event: closing the selected one must not move the screen to it.
    db.events.push(
      makeEvent('5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c09', {
        name: 'Exame outubro/2026',
        exam_date: '2026-10-25',
      }),
    );
    const { user, router } = await openExamDay();
    expect(picker()).toHaveValue(OPEN);
    expect(confirmButtons().length).toBeGreaterThan(0);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    const requests = recordRequests();

    const dialog = await openClose(user);
    expect(dialog).toHaveTextContent(CLOSE_TEXT);
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();

    expect(writes(requests)).toEqual([
      { method: 'PUT', url: `${EVENTS_URL}/${OPEN}`, body: { name: OPEN_NAME, status: 'CLOSED' } },
    ]);
    expect(stored(OPEN)).toMatchObject({ status: 'CLOSED', exam_date: '2026-11-21' });
    expect(screen.getByRole('status')).toHaveTextContent('Evento encerrado.');
    expect(await screen.findByRole('note')).toHaveTextContent('Evento encerrado');
    expect(confirmButtons()).toHaveLength(0);
    // Who attended still opens the exam (RN008a).
    expect(screen.getByRole('link', { name: 'Abrir exame de Helena Prado' })).toBeInTheDocument();

    expect(picker()).toHaveValue(OPEN);
    expect(router.state.location.search).toBe(`?evento=${OPEN}`);
    const reopen = screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` });
    expect(reopen).toHaveTextContent(/^Reabrir evento$/);
    expect(reopen).toHaveFocus();
  });

  it('rn016 reopens the selected closed event: PUT with OPEN, note off, attendance back, focus back', async () => {
    const { user, router } = await openExamDay(`${ROUTE}?evento=${CLOSED}`);
    expect(screen.getByRole('note')).toHaveTextContent('Evento encerrado');
    expect(confirmButtons()).toHaveLength(0);
    const requests = recordRequests();

    const dialog = await openReopen(user);
    expect(dialog).toHaveTextContent(REOPEN_TEXT);
    await user.click(within(dialog).getByRole('button', { name: 'Reabrir' }));
    await dialogGone();

    expect(writes(requests)).toEqual([
      {
        method: 'PUT',
        url: `${EVENTS_URL}/${CLOSED}`,
        body: { name: CLOSED_NAME, status: 'OPEN' },
      },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Evento reaberto.');
    await waitFor(() => {
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });
    expect(confirmButtons().length).toBeGreaterThan(0);
    expect(picker()).toHaveValue(CLOSED);
    expect(router.state.location.search).toBe(`?evento=${CLOSED}`);
    expect(screen.getByRole('button', { name: `Encerrar evento ${CLOSED_NAME}` })).toHaveFocus();
  });

  it('"Cancelar", "Fechar" and Esc send nothing and give the focus back to the button', async () => {
    const { user } = await openExamDay();
    const requests = recordRequests();
    const trigger = screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` });

    let dialog = await openClose(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await dialogGone();
    expect(trigger).toHaveFocus();

    dialog = await openClose(user);
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    await dialogGone();
    expect(trigger).toHaveFocus();

    await openClose(user);
    await user.keyboard('{Escape}');
    await dialogGone();
    expect(trigger).toHaveFocus();

    expect(writes(requests)).toHaveLength(0);
    expect(stored(OPEN).status).toBe('OPEN');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(confirmButtons().length).toBeGreaterThan(0);
  });

  it('works from the keyboard: Enter opens, Tab reaches "Encerrar", Enter closes the event', async () => {
    const { user } = await openExamDay();
    const trigger = screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` });
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Encerrar' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` })).toHaveFocus();
    expect(stored(OPEN).status).toBe('CLOSED');
  });

  it('an API error stays in the dialog; the screen does not change and a new try works', async () => {
    const message = 'Sistema ocupado no momento. Tente de novo em instantes.';
    let fail = true;
    server.use(
      http.put(`${EVENTS_URL}/:id`, () => {
        if (!fail) return undefined;
        return HttpResponse.json({ message }, { status: 503 });
      }),
    );
    const { user } = await openExamDay();
    const dialog = await openClose(user);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível encerrar');
    expect(alert).toHaveTextContent(message);
    expect(screen.getByRole('dialog', { name: 'Encerrar evento' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(stored(OPEN).status).toBe('OPEN');

    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    expect(screen.getByRole('status')).toHaveTextContent('Evento encerrado.');
    expect(await screen.findByRole('note')).toHaveTextContent('Evento encerrado');
  });

  it('a double click on "Encerrar" sends one PUT', async () => {
    const held = gate();
    let puts = 0;
    server.use(
      http.put(`${EVENTS_URL}/:id`, async () => {
        puts += 1;
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openExamDay();
    const dialog = await openClose(user);
    const confirm = within(dialog).getByRole('button', { name: 'Encerrar' });
    await user.dblClick(confirm);
    await waitFor(() => {
      expect(confirm).toHaveAttribute('data-loading', 'true');
    });
    held.release();
    await dialogGone();
    expect(puts).toBe(1);
  });

  it('an event deleted meanwhile: the 404 is shown and, once closed, the focus goes to the title', async () => {
    const { user } = await openExamDay();
    const dialog = await openClose(user);
    db.events = db.events.filter((event) => event.id !== OPEN);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Evento não encontrado');

    await user.keyboard('{Escape}');
    await dialogGone();
    expect(await screen.findByText('Nenhum evento aberto.')).toBeInTheDocument();
    expect(statusButtons()).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 1, name: TITLE })).toHaveFocus();
  });

  it('an event deleted meanwhile with another open event: the screen moves to it, the focus goes to the title', async () => {
    const otherId = '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c09';
    db.events.push(makeEvent(otherId, { name: 'Exame outubro/2026', exam_date: '2026-10-25' }));
    const { user, router } = await openExamDay();
    const dialog = await openClose(user);
    db.events = db.events.filter((event) => event.id !== OPEN);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Evento não encontrado');

    await user.keyboard('{Escape}');
    await dialogGone();
    // The button of another event is not the one the user pressed: the focus does not go there.
    expect(
      await screen.findByRole('button', { name: 'Encerrar evento Exame outubro/2026' }),
    ).not.toHaveFocus();
    expect(picker()).toHaveValue(otherId);
    await waitFor(() => {
      expect(router.state.location.search).toBe(`?evento=${otherId}`);
    });
    expect(screen.getByRole('heading', { level: 1, name: TITLE })).toHaveFocus();
  });

  it('the notice closes with "Fechar aviso" (focus to the title) and leaves with another event', async () => {
    const { user } = await openExamDay();
    let dialog = await openClose(user);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    const notice = screen.getByRole('status');
    await user.click(within(notice).getByRole('button', { name: 'Fechar aviso' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: TITLE })).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` }));
    dialog = await screen.findByRole('dialog', { name: 'Reabrir evento' });
    await user.click(within(dialog).getByRole('button', { name: 'Reabrir' }));
    await dialogGone();
    expect(screen.getByRole('status')).toHaveTextContent('Evento reaberto.');

    await user.selectOptions(picker(), CLOSED);
    await screen.findByRole('button', { name: `Reabrir evento ${CLOSED_NAME}` });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('has no button while the events load, on their error, with no event and with no open event', async () => {
    const held = gate();
    server.use(
      http.get(
        EVENTS_URL,
        async () => {
          await held.wait;
          return undefined;
        },
        { once: true },
      ),
    );
    const first = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    expect(await screen.findByText('Carregando eventos…')).toBeInTheDocument();
    expect(statusButtons()).toHaveLength(0);
    held.release();
    await screen.findByRole('table', { name: LIST });
    first.unmount();

    server.use(
      http.get(EVENTS_URL, () => HttpResponse.json({ message: 'Erro interno.' }, { status: 500 }), {
        once: true,
      }),
    );
    const second = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    expect(await screen.findByText('Não foi possível carregar os eventos')).toBeInTheDocument();
    expect(statusButtons()).toHaveLength(0);
    second.unmount();

    db.events = [];
    const third = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    expect(await screen.findByText('Nenhum evento cadastrado.')).toBeInTheDocument();
    expect(statusButtons()).toHaveLength(0);
    third.unmount();

    db = createMockDb({ includeShowcase: true });
    db.events = db.events.filter((event) => event.status === 'CLOSED');
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    expect(await screen.findByText('Nenhum evento aberto.')).toBeInTheDocument();
    expect(picker()).toBeInTheDocument();
    expect(statusButtons()).toHaveLength(0);
  });
});

describe('exam day, "Encerrar evento" on the phone (§ 6.3, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    setViewportWidth(360);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn016 at 360 px: 44 px button that wraps under the picker, full screen dialog, cards follow the change', async () => {
    const { user, router } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const list = await screen.findByRole('list', { name: LIST });
    expect(within(list).getAllByRole('button', { name: /^Confirmar presença/ }).length).toBe(2);

    const trigger = screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` });
    expect(trigger).toHaveStyle({ minHeight: '44px' });
    // Picker and button share a line only when both fit; Mantine's `Group` wraps by default.
    const row = trigger.parentElement!;
    expect(row).toContainElement(picker());
    expect(row.style.getPropertyValue('--group-wrap')).toBe('wrap');

    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    expect(dialog).toHaveAttribute('data-full-screen', 'true');
    expect(dialog).toHaveTextContent(CLOSE_TEXT);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();

    expect(screen.getByRole('status')).toHaveTextContent('Evento encerrado.');
    expect(await screen.findByRole('note')).toHaveTextContent('Evento encerrado');
    expect(
      within(screen.getByRole('list', { name: LIST })).queryAllByRole('button', {
        name: /^Confirmar presença/,
      }),
    ).toHaveLength(0);
    expect(router.state.location.search).toBe(`?evento=${OPEN}`);
    const reopen = screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` });
    expect(reopen).toHaveFocus();
    expect(reopen).toHaveStyle({ minHeight: '44px' });
  });
});
