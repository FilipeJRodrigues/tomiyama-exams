/**
 * Simulated `GET/POST/PUT/DELETE /events` follow `handlers/events.py` and `domain/events.py`
 * (RN016): examiners only, the API order, `status` `OPEN` by default, the same messages in
 * the same order, the date that never changes and the 409 of an event with exams.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError, createApiClient, type ApiClient } from '../../src/api/client';
import { createEvent, deleteEvent, listEvents, updateEvent } from '../../src/api/queries';
import type { ExamEvent } from '../../src/api/types';
import { createMockAuth } from '../../src/auth/mockAuth';
import type { Role } from '../../src/auth/types';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

let db: MockDb;

async function apiAs(role: Role | null) {
  const auth = createMockAuth(null);
  if (role) await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('a requisição deveria falhar');
}

/** Sends a body the typed helpers would not build (wrong types, missing fields). */
function rawPost(api: ApiClient, body: unknown) {
  return api.post<ExamEvent>('/events', body);
}

function rawPut(api: ApiClient, id: string, body: unknown) {
  return api.put<ExamEvent>(`/events/${id}`, body);
}

function stored(id: string): ExamEvent | undefined {
  return db.events.find((event) => event.id === id);
}

describe('simulated events API (RN016)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn016 only examiners list, create, edit and delete', async () => {
    const guardian = await apiAs('guardian');
    const calls = [
      listEvents(guardian),
      createEvent(guardian, { name: 'X', exam_date: '2027-01-01' }),
      updateEvent(guardian, MOCK_EVENT_IDS.open, { name: 'X', status: 'OPEN' }),
      deleteEvent(guardian, MOCK_EVENT_IDS.open),
    ];
    for (const call of calls) {
      const error = await failure(call);
      expect(error.status).toBe(403);
      expect(error.message).toBe('Esta área é dos examinadores');
    }
    expect((await failure(listEvents(await apiAs(null)))).status).toBe(401);
  });

  it('rn016 creates with OPEN by default, trimmed name and timestamps to the second', async () => {
    const api = await apiAs('examiner');
    const created = await createEvent(api, {
      name: '  Exame junho/2027 ',
      exam_date: '2027-06-12',
    });
    expect(created).toMatchObject({
      name: 'Exame junho/2027',
      exam_date: '2027-06-12',
      status: 'OPEN',
    });
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(stored(created.id)).toEqual(created);
    const closed = await createEvent(api, {
      name: 'Exame antigo',
      exam_date: '2025-01-10',
      status: 'CLOSED',
    });
    expect(closed.status).toBe('CLOSED');
  });

  it('lists from the most recent exam date; a tie goes to the newest created', async () => {
    db.events.push(
      { ...db.events[0]!, id: 'z-mesmo-dia-antes', created_at: '2026-01-01T00:00:00+00:00' },
      { ...db.events[0]!, id: 'a-mesmo-dia-depois', created_at: '2026-12-01T00:00:00+00:00' },
    );
    const list = await listEvents(await apiAs('examiner'));
    expect(list.map((event) => event.id)).toEqual([
      'a-mesmo-dia-depois',
      MOCK_EVENT_IDS.open,
      'z-mesmo-dia-antes',
      MOCK_EVENT_IDS.closed,
    ]);
  });

  it('validates the POST in the order of the backend: name, date, status', async () => {
    const api = await apiAs('examiner');
    const cases: [unknown, string][] = [
      [{}, 'Campo obrigatório: Nome'],
      [{ name: '   ', exam_date: 'x', status: 'x' }, 'Campo obrigatório: Nome'],
      [{ name: 5 }, 'Nome: valor inválido'],
      [{ name: 'x'.repeat(81) }, 'Nome: máximo de 80 caracteres'],
      [{ name: 'Exame' }, 'Campo obrigatório: Data do exame'],
      [{ name: 'Exame', exam_date: '' }, 'Campo obrigatório: Data do exame'],
      [{ name: 'Exame', exam_date: '20/03/2027' }, 'Data do exame: data inválida (use AAAA-MM-DD)'],
      [{ name: 'Exame', exam_date: '2027-02-30' }, 'Data do exame: data inválida (use AAAA-MM-DD)'],
      [{ name: 'Exame', exam_date: '2027-03-20', status: 'open' }, 'Situação: valor inválido'],
      [{ name: 'Exame', exam_date: '2027-03-20', status: '' }, 'Situação: valor inválido'],
      [[], 'Corpo da requisição inválido: envie um objeto JSON'],
    ];
    for (const [body, message] of cases) {
      const error = await failure(rawPost(api, body));
      expect([error.status, error.message]).toEqual([400, message]);
    }
    // 80 code points (an emoji is two UTF-16 units) is accepted, like the API.
    const name = '🥋'.repeat(80);
    expect((await rawPost(api, { name, exam_date: '2027-03-20', status: null })).status).toBe(
      'OPEN',
    );
    expect(db.events).toHaveLength(3);
  });

  it('rn016 edits name and status, reopens, keeps the date and refuses another one', async () => {
    const api = await apiAs('examiner');
    const closed = MOCK_EVENT_IDS.closed;
    const reopened = await updateEvent(api, closed, { name: ' Exame de março ', status: 'OPEN' });
    expect(reopened).toMatchObject({
      name: 'Exame de março',
      status: 'OPEN',
      exam_date: '2026-03-01',
    });
    expect(reopened.created_at).toBe('2026-02-10T12:00:00+00:00');

    // Without status the event keeps the one it has; the same date may be resent.
    const same = await rawPut(api, closed, { name: 'Exame de março', exam_date: '2026-03-01' });
    expect(same.status).toBe('OPEN');

    const changed = await failure(
      rawPut(api, closed, { name: 'Exame de março', exam_date: '2026-03-02' }),
    );
    expect([changed.status, changed.message]).toEqual([
      400,
      'A data do evento não pode ser alterada',
    ]);
    const invalid = await failure(rawPut(api, closed, { name: 'Exame', exam_date: 'março' }));
    expect(invalid.message).toBe('Data do exame: data inválida (use AAAA-MM-DD)');
    // The name comes before the status and the date.
    const order = await failure(rawPut(api, closed, { status: 'x', exam_date: '2000-01-01' }));
    expect(order.message).toBe('Campo obrigatório: Nome');
    const status = await failure(rawPut(api, closed, { name: 'Exame', status: 'x' }));
    expect(status.message).toBe('Situação: valor inválido');
    expect(stored(closed)?.exam_date).toBe('2026-03-01');
  });

  it('404 for an event that does not exist, before the body is checked', async () => {
    const api = await apiAs('examiner');
    const put = await failure(rawPut(api, 'nao-existe', {}));
    expect([put.status, put.message]).toEqual([404, 'Evento não encontrado']);
    const remove = await failure(deleteEvent(api, 'nao-existe'));
    expect([remove.status, remove.message]).toEqual([404, 'Evento não encontrado']);
  });

  it('rn016 an event with exams is not deleted; one without is', async () => {
    const api = await apiAs('examiner');
    const error = await failure(deleteEvent(api, MOCK_EVENT_IDS.closed));
    expect([error.status, error.message]).toEqual([409, 'Evento possui exames registrados']);
    expect(stored(MOCK_EVENT_IDS.closed)).toBeDefined();

    await deleteEvent(api, MOCK_EVENT_IDS.open);
    expect(stored(MOCK_EVENT_IDS.open)).toBeUndefined();
  });
});
