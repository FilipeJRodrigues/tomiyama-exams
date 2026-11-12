/**
 * Events screen (§ 6.5), "Encerrar" / "Reabrir" on each row: a confirmation, then
 * `PUT /events/{id}` with the name of the event and the other status (the same body as the
 * edit form; the date never changes). Closing blocks attendance and marking (RN016) and the
 * sensei still decides the exams in progress (RN008a); the API messages stay in the dialog,
 * one request per click, and the focus goes back to the row (§ 6.7).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { holdExitTransitions } from '../../exitTransitions';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import {
  EVENTS_URL,
  ROUTE,
  dialogGone,
  gate,
  openEvents,
  recordRequests,
  rowNames,
  tableRows,
  writes,
} from './helpers';

const OPEN_NAME = 'Exame novembro/2026';
const CLOSED_NAME = 'Exame março/2026';

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

async function openClose(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: `Encerrar evento ${name}` }));
  return screen.findByRole('dialog', { name: 'Encerrar evento' });
}

async function openReopen(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: `Reabrir evento ${name}` }));
  return screen.findByRole('dialog', { name: 'Reabrir evento' });
}

describe('events screen, "Encerrar" / "Reabrir" (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn016 each row offers the action of its status: "Encerrar" when open, "Reabrir" when closed', async () => {
    await openEvents();
    expect(screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` })).toHaveTextContent(
      'Encerrar',
    );
    expect(
      screen.queryByRole('button', { name: `Reabrir evento ${OPEN_NAME}` }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Reabrir evento ${CLOSED_NAME}` })).toHaveTextContent(
      'Reabrir',
    );
    expect(
      screen.queryByRole('button', { name: `Encerrar evento ${CLOSED_NAME}` }),
    ).not.toBeInTheDocument();
    expect(tableRows().map((cells) => cells[3])).toEqual([
      'EditarEncerrarExcluir',
      'EditarReabrirExcluir',
    ]);
  });

  it('rn016 rn008a closes an open event: confirmation, PUT with the name and CLOSED, row and button change, focus back', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    const dialog = await openClose(user, OPEN_NAME);

    expect(dialog).toHaveTextContent(CLOSE_TEXT);
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();

    expect(writes(requests)).toEqual([
      {
        method: 'PUT',
        url: `${EVENTS_URL}/${MOCK_EVENT_IDS.open}`,
        body: { name: OPEN_NAME, status: 'CLOSED' },
      },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Evento encerrado.');
    expect(tableRows()[0]).toEqual([OPEN_NAME, '21/11/2026', 'Encerrado', 'EditarReabrirExcluir']);
    expect(screen.getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` })).toHaveFocus();
    expect(stored(MOCK_EVENT_IDS.open)).toMatchObject({
      name: OPEN_NAME,
      status: 'CLOSED',
      exam_date: '2026-11-21',
    });
  });

  it('rn016 reopens a closed event: PUT with the name and OPEN, row and button change', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    const dialog = await openReopen(user, CLOSED_NAME);

    expect(dialog).toHaveTextContent(REOPEN_TEXT);
    await user.click(within(dialog).getByRole('button', { name: 'Reabrir' }));
    await dialogGone();

    expect(writes(requests)).toEqual([
      {
        method: 'PUT',
        url: `${EVENTS_URL}/${MOCK_EVENT_IDS.closed}`,
        body: { name: CLOSED_NAME, status: 'OPEN' },
      },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Evento reaberto.');
    expect(tableRows()[1]).toEqual([CLOSED_NAME, '01/03/2026', 'Aberto', 'EditarEncerrarExcluir']);
    expect(screen.getByRole('button', { name: `Encerrar evento ${CLOSED_NAME}` })).toHaveFocus();
    expect(stored(MOCK_EVENT_IDS.closed)).toMatchObject({
      status: 'OPEN',
      exam_date: '2026-03-01',
    });
  });

  it('"Cancelar", "Fechar" and Esc send nothing and give the focus back to the button', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    const trigger = screen.getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` });

    let dialog = await openClose(user, OPEN_NAME);
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await dialogGone();
    expect(trigger).toHaveFocus();

    dialog = await openClose(user, OPEN_NAME);
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    await dialogGone();
    expect(trigger).toHaveFocus();

    await openClose(user, OPEN_NAME);
    await user.keyboard('{Escape}');
    await dialogGone();
    expect(trigger).toHaveFocus();

    expect(writes(requests)).toHaveLength(0);
    expect(stored(MOCK_EVENT_IDS.open).status).toBe('OPEN');
    expect(tableRows()[0]?.[2]).toBe('Aberto');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('an API error stays in the dialog with its message; a new try may go and works', async () => {
    const message = 'Sistema ocupado no momento. Tente de novo em instantes.';
    let fail = true;
    server.use(
      http.put(`${EVENTS_URL}/:id`, () => {
        if (!fail) return undefined;
        return HttpResponse.json({ message }, { status: 503 });
      }),
    );
    const { user } = await openEvents();
    const dialog = await openClose(user, OPEN_NAME);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível encerrar');
    expect(alert).toHaveTextContent(message);
    expect(screen.getByRole('dialog', { name: 'Encerrar evento' })).toBeInTheDocument();
    expect(tableRows()[0]?.[2]).toBe('Aberto');

    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    expect(tableRows()[0]?.[2]).toBe('Encerrado');
    expect(stored(MOCK_EVENT_IDS.open).status).toBe('CLOSED');
  });

  it('a reopening refused says "Não foi possível reabrir" with the API message', async () => {
    const message = 'Nome: campo obrigatório';
    server.use(
      http.put(`${EVENTS_URL}/:id`, () => HttpResponse.json({ message }, { status: 400 })),
    );
    const { user } = await openEvents();
    const dialog = await openReopen(user, CLOSED_NAME);
    await user.click(within(dialog).getByRole('button', { name: 'Reabrir' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível reabrir');
    expect(alert).toHaveTextContent(message);
  });

  it('rn016 a 403 says "Sem permissão" with the API message', async () => {
    const message = 'Somente examinadores';
    server.use(
      http.put(`${EVENTS_URL}/:id`, () => HttpResponse.json({ message }, { status: 403 })),
    );
    const { user } = await openEvents();
    const dialog = await openClose(user, OPEN_NAME);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent(message);
  });

  it('an event deleted meanwhile: the 404 is shown, the row leaves and the focus goes to the title', async () => {
    const { user } = await openEvents();
    const dialog = await openClose(user, OPEN_NAME);
    db.events = db.events.filter((event) => event.id !== MOCK_EVENT_IDS.open);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Evento não encontrado');

    await user.keyboard('{Escape}');
    await dialogGone();
    await waitFor(() => {
      expect(rowNames()).toEqual([CLOSED_NAME]);
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Eventos' })).toHaveFocus();
  });

  it('a new confirmation starts without the error of the previous one', async () => {
    server.use(
      http.put(`${EVENTS_URL}/:id`, () =>
        HttpResponse.json({ message: 'Falhou' }, { status: 400 }),
      ),
    );
    const { user } = await openEvents();
    let dialog = await openClose(user, OPEN_NAME);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await within(dialog).findByRole('alert');
    await user.keyboard('{Escape}');
    await dialogGone();

    dialog = await openReopen(user, CLOSED_NAME);
    expect(dialog).toHaveTextContent(REOPEN_TEXT);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a double click on "Encerrar" sends one PUT; Esc and "Cancelar" wait for the answer', async () => {
    const held = gate();
    let puts = 0;
    server.use(
      http.put(`${EVENTS_URL}/:id`, async () => {
        puts += 1;
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openEvents();
    const dialog = await openClose(user, OPEN_NAME);
    const confirm = within(dialog).getByRole('button', { name: 'Encerrar' });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    await waitFor(() => {
      expect(confirm).toHaveAttribute('data-loading', 'true');
    });
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Fechar' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'Encerrar evento' })).toBeInTheDocument();

    held.release();
    await dialogGone();
    expect(puts).toBe(1);
    expect(tableRows()[0]?.[2]).toBe('Encerrado');
  });

  it('Enter or a click on "Encerrar" while the dialog fades out sends no second PUT (#88)', async () => {
    const held = gate();
    let puts = 0;
    server.use(
      http.put(`${EVENTS_URL}/:id`, async () => {
        puts += 1;
        if (puts === 1) await held.wait;
        return undefined;
      }),
    );
    const { user } = await openEvents();
    const dialog = await openClose(user, OPEN_NAME);
    const confirm = within(dialog).getByRole('button', { name: 'Encerrar' });
    await user.click(confirm);
    await waitFor(() => {
      expect(puts).toBe(1);
    });

    // The answer comes with the closing held: the dialog is still on the screen, fading out.
    const exit = holdExitTransitions();
    held.release();
    expect(await screen.findByRole('status')).toHaveTextContent('Evento encerrado.');
    expect(screen.getByRole('dialog', { name: 'Encerrar evento' })).toBeInTheDocument();
    expect(confirm).not.toHaveAttribute('data-loading');
    await user.click(confirm);
    confirm.focus();
    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(puts).toBe(1);

    // The lock is free again once the dialog is gone: reopening works.
    const reopen = await openReopen(user, OPEN_NAME);
    await user.click(within(reopen).getByRole('button', { name: 'Reabrir' }));
    await dialogGone();
    expect(puts).toBe(2);
    expect(stored(MOCK_EVENT_IDS.open).status).toBe('OPEN');
  });
});

describe('events screen, "Encerrar" / "Reabrir" on the phone (§ 6.5, § 6.7)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    setViewportWidth(390);
  });

  it('every card has the three buttons, 44 px tall, wrapping when the card is narrow', async () => {
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const list = await screen.findByRole('list', { name: 'Eventos' });
    const [open, closed] = within(list).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    const buttons = [
      within(open).getByRole('button', { name: `Editar evento ${OPEN_NAME}` }),
      within(open).getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }),
      within(open).getByRole('button', { name: `Excluir evento ${OPEN_NAME}` }),
      within(closed).getByRole('button', { name: `Reabrir evento ${CLOSED_NAME}` }),
    ];
    for (const button of buttons) expect(button).toHaveStyle({ minHeight: '44px' });
    // Mantine's `Group` sets its wrap through a CSS variable.
    expect(buttons[0]?.parentElement?.style.getPropertyValue('--group-wrap')).toBe('wrap');
  });

  it('rn016 closes from the card: full screen dialog, card shows "Encerrado", focus on its "Reabrir"', async () => {
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const list = await screen.findByRole('list', { name: 'Eventos' });
    const open = within(list).getAllByRole('listitem')[0] as HTMLElement;
    await user.click(within(open).getByRole('button', { name: `Encerrar evento ${OPEN_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    expect(dialog).toHaveTextContent(CLOSE_TEXT);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();

    const card = within(screen.getByRole('list', { name: 'Eventos' })).getAllByRole(
      'listitem',
    )[0] as HTMLElement;
    expect(card).toHaveTextContent('SituaçãoEncerrado');
    expect(within(card).getByRole('button', { name: `Reabrir evento ${OPEN_NAME}` })).toHaveFocus();
    expect(stored(MOCK_EVENT_IDS.open).status).toBe('CLOSED');
  });
});

describe('events screen "Encerrar" and the exam day (§ 6.3)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn016 after closing the only open event with "Encerrar", the exam day has no open event', async () => {
    const { user } = await renderApp({ route: '/dia-do-exame', signedInAs: 'examiner' });
    await screen.findByRole('combobox', { name: 'Evento' });
    await user.click(screen.getByRole('link', { name: 'Eventos' }));
    await screen.findByRole('table', { name: 'Eventos' });

    const dialog = await openClose(user, OPEN_NAME);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();

    await user.click(screen.getByRole('link', { name: 'Dia do exame' }));
    expect(await screen.findByText('Nenhum evento aberto.')).toBeInTheDocument();
  });
});
