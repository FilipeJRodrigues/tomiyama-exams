/**
 * Events screen (§ 6.5), the writes: create (`POST /events`, status Aberto by default), edit
 * (`PUT /events/{id}`: name and status, reopening a closed event; the date is read only) and
 * delete with confirmation (`DELETE /events/{id}`, 409 for an event with exams, RN016), with
 * the API messages, one request per click, `Esc` and the focus back on the row (§ 6.7).
 *
 * The state while a request is on its way is checked with the response held (`gate`), never
 * with a delay.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import {
  EVENTS_URL,
  dialogGone,
  field,
  gate,
  makeEvent,
  openDelete,
  openEdit,
  openEvents,
  openNew,
  recordRequests,
  replaceText,
  rowNames,
  statusSelect,
  tableRows,
  writes,
} from './helpers';

const STATUS_HELP =
  'Encerrado bloqueia a confirmação de presença e a marcação dos itens; o sensei ainda decide os exames em andamento.';

let db: MockDb;

function stored(id: string) {
  const event = db.events.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`sem o evento ${id}`);
  return event;
}

function notice() {
  return screen.getByRole('status');
}

describe('events screen, create (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn016 creates an open event by default: POST, notice, row in order, focus on its row', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    const dialog = await openNew(user);

    expect(field(dialog, /^Nome/)).toHaveFocus();
    expect(statusSelect(dialog)).toHaveValue('OPEN');
    expect(statusSelect(dialog)).toHaveDisplayValue('Aberto');
    expect(within(dialog).getByText(STATUS_HELP)).toBeInTheDocument();

    await replaceText(user, field(dialog, /^Nome/), '  Exame junho/2026  ');
    await user.type(field(dialog, /^Data do exame/), '2026-06-20');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    expect(writes(requests)).toEqual([
      {
        method: 'POST',
        url: EVENTS_URL,
        body: { name: 'Exame junho/2026', exam_date: '2026-06-20', status: 'OPEN' },
      },
    ]);
    expect(notice()).toHaveTextContent('Evento criado.');
    expect(rowNames()).toEqual(['Exame novembro/2026', 'Exame junho/2026', 'Exame março/2026']);
    expect(tableRows()[1]).toEqual(['Exame junho/2026', '20/06/2026', 'Aberto', 'EditarExcluir']);
    expect(screen.getByRole('button', { name: 'Editar evento Exame junho/2026' })).toHaveFocus();
    expect(db.events.find((event) => event.name === 'Exame junho/2026')?.status).toBe('OPEN');
  });

  it('may create a closed event', async () => {
    const { user } = await openEvents();
    const dialog = await openNew(user);
    await replaceText(user, field(dialog, /^Nome/), 'Exame antigo');
    await user.type(field(dialog, /^Data do exame/), '2025-05-10');
    await user.selectOptions(statusSelect(dialog), 'Encerrado');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(tableRows().at(-1)).toEqual([
      'Exame antigo',
      '10/05/2025',
      'Encerrado',
      'EditarExcluir',
    ]);
  });

  it('checks the fields before sending and focuses the first invalid one', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    const dialog = await openNew(user);
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(within(dialog).getByText('Informe o nome.')).toBeInTheDocument();
    expect(within(dialog).getByText('Informe a data do exame.')).toBeInTheDocument();
    expect(field(dialog, /^Nome/)).toHaveFocus();

    await replaceText(user, field(dialog, /^Nome/), 'x'.repeat(81));
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(within(dialog).getByText('Use no máximo 80 caracteres.')).toBeInTheDocument();
    expect(writes(requests)).toHaveLength(0);
  });

  it('shows the 400 of the API with its message and keeps what was typed', async () => {
    const message = 'Data do exame: data inválida (use AAAA-MM-DD)';
    server.use(http.post(EVENTS_URL, () => HttpResponse.json({ message }, { status: 400 })));
    const { user } = await openEvents();
    const dialog = await openNew(user);
    await replaceText(user, field(dialog, /^Nome/), 'Exame julho/2026');
    await user.type(field(dialog, /^Data do exame/), '2026-07-04');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível salvar');
    expect(alert).toHaveTextContent(message);
    expect(field(dialog, /^Nome/)).toHaveValue('Exame julho/2026');
    expect(rowNames()).not.toContain('Exame julho/2026');
  });

  it('a 403 on the save says "Sem permissão" with the API message', async () => {
    server.use(
      http.post(EVENTS_URL, () =>
        HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
      ),
    );
    const { user } = await openEvents();
    const dialog = await openNew(user);
    await replaceText(user, field(dialog, /^Nome/), 'Exame julho/2026');
    await user.type(field(dialog, /^Data do exame/), '2026-07-04');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos examinadores');
  });

  it('a double click on "Salvar" sends one POST; Esc, "Fechar" and "Cancelar" wait for the answer', async () => {
    const held = gate();
    let posts = 0;
    server.use(
      http.post(EVENTS_URL, async () => {
        posts += 1;
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openEvents();
    const dialog = await openNew(user);
    await replaceText(user, field(dialog, /^Nome/), 'Exame julho/2026');
    await user.type(field(dialog, /^Data do exame/), '2026-07-04');
    const save = within(dialog).getByRole('button', { name: 'Salvar' });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    await waitFor(() => {
      expect(save).toHaveAttribute('data-loading', 'true');
    });
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Fechar' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'Novo evento' })).toBeInTheDocument();

    held.release();
    await dialogGone();
    expect(posts).toBe(1);
    expect(db.events.filter((event) => event.name === 'Exame julho/2026')).toHaveLength(1);
  });

  it('closes with Esc, saves nothing and a new opening starts blank', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    let dialog = await openNew(user);
    await replaceText(user, field(dialog, /^Nome/), 'Rascunho');
    await user.keyboard('{Escape}');
    await dialogGone();
    expect(screen.getByRole('button', { name: 'Novo evento' })).toHaveFocus();

    dialog = await openNew(user);
    expect(field(dialog, /^Nome/)).toHaveValue('');
    expect(writes(requests)).toHaveLength(0);
  });
});

describe('events screen, edit (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn016 edits the name and closes the event: PUT with name and status, row changes, focus back', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    const dialog = await openEdit(user, 'Exame novembro/2026');

    expect(field(dialog, /^Nome/)).toHaveValue('Exame novembro/2026');
    expect(statusSelect(dialog)).toHaveDisplayValue('Aberto');
    await replaceText(user, field(dialog, /^Nome/), 'Exame de novembro');
    await user.selectOptions(statusSelect(dialog), 'Encerrado');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    expect(writes(requests)).toEqual([
      {
        method: 'PUT',
        url: `${EVENTS_URL}/${MOCK_EVENT_IDS.open}`,
        body: { name: 'Exame de novembro', status: 'CLOSED' },
      },
    ]);
    expect(notice()).toHaveTextContent('Evento salvo.');
    expect(tableRows()[0]).toEqual([
      'Exame de novembro',
      '21/11/2026',
      'Encerrado',
      'EditarExcluir',
    ]);
    expect(screen.getByRole('button', { name: 'Editar evento Exame de novembro' })).toHaveFocus();
    expect(stored(MOCK_EVENT_IDS.open)).toMatchObject({
      name: 'Exame de novembro',
      status: 'CLOSED',
      exam_date: '2026-11-21',
    });
  });

  it('rn016 reopens a closed event', async () => {
    const { user } = await openEvents();
    const dialog = await openEdit(user, 'Exame março/2026');
    expect(statusSelect(dialog)).toHaveDisplayValue('Encerrado');
    await user.selectOptions(statusSelect(dialog), 'Aberto');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    expect(tableRows()[1]).toEqual(['Exame março/2026', '01/03/2026', 'Aberto', 'EditarExcluir']);
    expect(stored(MOCK_EVENT_IDS.closed).status).toBe('OPEN');
  });

  it('rn016 the date is read only on an edit and is not sent', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    const dialog = await openEdit(user, 'Exame março/2026');

    const date = field(dialog, /^Data do exame/);
    expect(date).toHaveAttribute('readonly');
    expect(date).toHaveValue('01/03/2026');
    expect(date).not.toHaveAttribute('type', 'date');
    expect(within(dialog).getByText('Não muda depois da criação.')).toBeInTheDocument();
    expect(within(dialog).getByText(STATUS_HELP)).toBeInTheDocument();

    await user.type(date, '2027');
    expect(date).toHaveValue('01/03/2026');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(writes(requests).map((request) => request.body)).toEqual([
      { name: 'Exame março/2026', status: 'CLOSED' },
    ]);
    expect(stored(MOCK_EVENT_IDS.closed).exam_date).toBe('2026-03-01');
  });

  it('shows the 400 of the API on an edit with its message', async () => {
    const message = 'A data do evento não pode ser alterada';
    server.use(
      http.put(`${EVENTS_URL}/:id`, () => HttpResponse.json({ message }, { status: 400 })),
    );
    const { user } = await openEvents();
    const dialog = await openEdit(user, 'Exame março/2026');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível salvar');
    expect(alert).toHaveTextContent(message);
  });

  it('an event deleted meanwhile: the 404 is shown and the row leaves the list', async () => {
    const { user } = await openEvents();
    const dialog = await openEdit(user, 'Exame novembro/2026');
    db.events = db.events.filter((event) => event.id !== MOCK_EVENT_IDS.open);
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Evento não encontrado');
    await user.keyboard('{Escape}');
    await dialogGone();
    await waitFor(() => {
      expect(rowNames()).toEqual(['Exame março/2026']);
    });
  });

  it('a double Enter in the edit sends one PUT', async () => {
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
    const dialog = await openEdit(user, 'Exame março/2026');
    const form = within(dialog).getByRole('form', { name: 'Editar evento' });
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toHaveAttribute(
        'data-loading',
        'true',
      );
    });
    held.release();
    await dialogGone();
    expect(puts).toBe(1);
  });

  it('on the phone the focus goes back to the card after the save', async () => {
    setViewportWidth(390);
    const { user } = await renderApp({ route: '/eventos', signedInAs: 'examiner' });
    await screen.findByRole('list', { name: 'Eventos' });
    const dialog = await openEdit(user, 'Exame março/2026');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar evento Exame março/2026' })).toHaveFocus();
    });
  });
});

describe('events screen, delete (§ 6.5)', () => {
  const FREE_ID = 'evento-sem-exames';

  beforeEach(() => {
    db = createMockDb();
    db.events.push(
      makeEvent(FREE_ID, {
        name: 'Exame cancelado',
        exam_date: '2026-08-15',
        created_at: '2026-07-01T12:00:00+00:00',
      }),
    );
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('asks first; "Cancelar" deletes nothing and gives the focus back', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    const dialog = await openDelete(user, 'Exame cancelado');
    expect(dialog).toHaveTextContent(
      'Excluir o evento “Exame cancelado” (15/08/2026)? Esta ação não pode ser desfeita.',
    );
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await dialogGone();
    expect(writes(requests)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Excluir evento Exame cancelado' })).toHaveFocus();
  });

  it('Esc closes the confirmation without deleting', async () => {
    const { user } = await openEvents();
    await openDelete(user, 'Exame cancelado');
    await user.keyboard('{Escape}');
    await dialogGone();
    expect(rowNames()).toContain('Exame cancelado');
  });

  it('deletes after the confirmation: DELETE, row gone, notice, focus on the title', async () => {
    const { user } = await openEvents();
    const requests = recordRequests();
    const dialog = await openDelete(user, 'Exame cancelado');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await dialogGone();

    expect(writes(requests)).toEqual([
      { method: 'DELETE', url: `${EVENTS_URL}/${FREE_ID}`, body: null },
    ]);
    expect(rowNames()).toEqual(['Exame novembro/2026', 'Exame março/2026']);
    expect(notice()).toHaveTextContent('Evento excluído.');
    expect(screen.getByRole('heading', { level: 1, name: 'Eventos' })).toHaveFocus();
    expect(db.events.some((event) => event.id === FREE_ID)).toBe(false);
  });

  it('rn016 an event with exams is not deleted: the 409 stays in the dialog', async () => {
    const { user } = await openEvents();
    const dialog = await openDelete(user, 'Exame março/2026');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível excluir');
    expect(alert).toHaveTextContent('Evento possui exames registrados');
    expect(screen.getByRole('dialog', { name: 'Excluir evento' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await dialogGone();
    expect(rowNames()).toContain('Exame março/2026');
    expect(stored(MOCK_EVENT_IDS.closed)).toBeDefined();
  });

  it('a new confirmation starts without the error of the previous one', async () => {
    const { user } = await openEvents();
    let dialog = await openDelete(user, 'Exame março/2026');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await within(dialog).findByRole('alert');
    await user.keyboard('{Escape}');
    await dialogGone();

    dialog = await openDelete(user, 'Exame cancelado');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a double click on "Excluir" sends one DELETE; Esc waits for the answer', async () => {
    const held = gate();
    let deletes = 0;
    server.use(
      http.delete(`${EVENTS_URL}/:id`, async () => {
        deletes += 1;
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openEvents();
    const dialog = await openDelete(user, 'Exame cancelado');
    const confirm = within(dialog).getByRole('button', { name: 'Excluir' });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    await waitFor(() => {
      expect(confirm).toHaveAttribute('data-loading', 'true');
    });
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'Excluir evento' })).toBeInTheDocument();

    held.release();
    await dialogGone();
    expect(deletes).toBe(1);
    expect(rowNames()).not.toContain('Exame cancelado');
  });
});

describe('events screen and the exam day (§ 6.3)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn016 after closing the only open event, the exam day has no open event', async () => {
    const { user } = await renderAppAtExamDayFirst();
    const dialog = await openEdit(user, 'Exame novembro/2026');
    await user.selectOptions(statusSelect(dialog), 'Encerrado');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    await user.click(screen.getByRole('link', { name: 'Dia do exame' }));
    expect(await screen.findByText('Nenhum evento aberto.')).toBeInTheDocument();
  });
});

/** Visits the exam day first (its event list gets cached), then the events screen. */
async function renderAppAtExamDayFirst() {
  const result = await renderApp({ route: '/dia-do-exame', signedInAs: 'examiner' });
  await screen.findByRole('combobox', { name: 'Evento' });
  await result.user.click(screen.getByRole('link', { name: 'Eventos' }));
  await screen.findByRole('table', { name: 'Eventos' });
  return result;
}
