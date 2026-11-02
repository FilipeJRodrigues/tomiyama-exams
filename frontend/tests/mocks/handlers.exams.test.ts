/**
 * The simulated `GET /events`, `GET /events/{id}/exams` and `POST /events/{id}/exams`
 * follow the backend (`handlers/events.py`, `handlers/exams.py`, `domain/exams.py`): same
 * order, status codes and pt-BR messages (RN005, RN016).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiClient, type ApiClient } from '../../src/api/client';
import { confirmAttendance, listEventExams, listEvents } from '../../src/api/queries';
import { createMockAuth } from '../../src/auth/mockAuth';
import type { Role } from '../../src/auth/types';
import { createMockDb, MOCK_EVENT_IDS, mockBelts, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const BRUNO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e02';
const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const { open: OPEN, closed: CLOSED } = MOCK_EVENT_IDS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let db: MockDb;

async function apiAs(role: Role | null): Promise<ApiClient> {
  const auth = createMockAuth(null);
  if (role) await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

/** Raw POST, for bodies the typed helper never sends. */
function postRaw(api: ApiClient, eventId: string, body: unknown) {
  return api.post(`/events/${eventId}/exams`, body);
}

type Call = (api: ApiClient) => Promise<unknown>;

const EXAMINER_ROUTES: [string, Call][] = [
  ['GET /events', (api) => listEvents(api)],
  ['GET /events/{id}/exams', (api) => listEventExams(api, OPEN)],
  ['POST /events/{id}/exams', (api) => confirmAttendance(api, OPEN, ANA)],
];

describe('simulated exam day API', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has an open and a closed event, most recent first', async () => {
    const events = await listEvents(await apiAs('examiner'));
    expect(events.map((event) => [event.id, event.status, event.exam_date])).toEqual([
      [OPEN, 'OPEN', '2026-11-21'],
      [CLOSED, 'CLOSED', '2026-03-01'],
    ]);
  });

  it('orders by exam date, then by the newest created', async () => {
    db.events.push(
      { ...db.events[1]!, id: 'antigo', exam_date: '2025-01-01' },
      { ...db.events[0]!, id: 'mesmo-dia', created_at: '2026-10-30T12:00:00+00:00' },
    );
    const events = await listEvents(await apiAs('examiner'));
    expect(events.map((event) => event.id)).toEqual(['mesmo-dia', OPEN, CLOSED, 'antigo']);
  });

  it.each(EXAMINER_ROUTES)(
    '%s is for examiners only (403) and needs a session (401)',
    async (_route, call) => {
      await expect(call(await apiAs('guardian'))).rejects.toMatchObject({
        status: 403,
        message: 'Esta área é dos examinadores',
      });
      await expect(call(await apiAs(null))).rejects.toMatchObject({ status: 401 });
    },
  );

  it('lists the exams of the event with the student name', async () => {
    const exams = await listEventExams(await apiAs('examiner'), CLOSED);
    expect(exams).toHaveLength(1);
    expect(exams[0]).toMatchObject({
      event_id: CLOSED,
      student_id: ELIDA,
      student_name: 'Élida Ramos',
      kind: 'STRIPE',
      status: 'APPROVED',
    });
    expect(exams[0]!.id).toMatch(UUID);
    expect(await listEventExams(await apiAs('examiner'), OPEN)).toEqual([]);
  });

  it('lists the exams by student name, without accents or case', async () => {
    const api = await apiAs('examiner');
    await confirmAttendance(api, OPEN, CARLA);
    await confirmAttendance(api, OPEN, ANA);
    db.students.find((item) => item.student.id === CARLA)!.student.full_name = 'álvaro';
    const exams = await listEventExams(api, OPEN);
    expect(exams.map((exam) => exam.student_name)).toEqual(['álvaro', 'Ana Souza']);
  });

  it('answers 404 for a missing event', async () => {
    const api = await apiAs('examiner');
    await expect(listEventExams(api, 'nao-existe')).rejects.toMatchObject({
      status: 404,
      message: 'Evento não encontrado',
    });
    await expect(confirmAttendance(api, 'nao-existe', ANA)).rejects.toMatchObject({
      status: 404,
      message: 'Evento não encontrado',
    });
  });

  it('rn005 confirms an eligible student: 201 with the exam in progress', async () => {
    const exam = await confirmAttendance(await apiAs('examiner'), OPEN, ANA);
    expect(exam).toMatchObject({
      event_id: OPEN,
      student_id: ANA,
      student_name: 'Ana Souza',
      kind: 'BELT',
      target_belt_id: mockBelts.find((belt) => belt.name === 'Cinza/Azul')!.id,
      status: 'IN_PROGRESS',
      decided_by_id: null,
      decided_at: null,
      notes: null,
      created_by: 'mock-examiner',
    });
    expect(exam.id).toMatch(UUID);
    expect(db.students.find((item) => item.student.id === ANA)!.examCount).toBe(1);
    const exams = await listEventExams(await apiAs('examiner'), OPEN);
    expect(exams.map((item) => item.student_id)).toEqual([ANA]);
  });

  it('rn005 refuses a repeated confirmation with 409', async () => {
    const api = await apiAs('examiner');
    await confirmAttendance(api, OPEN, ANA);
    await expect(confirmAttendance(api, OPEN, ANA)).rejects.toMatchObject({
      status: 409,
      message: 'Presença já confirmada neste evento',
    });
  });

  it('rn016 refuses a closed event', async () => {
    await expect(confirmAttendance(await apiAs('examiner'), CLOSED, ANA)).rejects.toMatchObject({
      status: 400,
      message: 'Evento encerrado',
    });
  });

  it('answers the repeat before the closed event, like the backend', async () => {
    await expect(confirmAttendance(await apiAs('examiner'), CLOSED, ELIDA)).rejects.toMatchObject({
      status: 409,
      message: 'Presença já confirmada neste evento',
    });
  });

  it('rn005 refuses an inactive student', async () => {
    await expect(confirmAttendance(await apiAs('examiner'), OPEN, ELIDA)).rejects.toMatchObject({
      status: 400,
      message: 'Aluno inativo não pode fazer exame',
    });
  });

  it('rn005 refuses an ineligible student with the reasons, joined by "; "', async () => {
    const api = await apiAs('examiner');
    await expect(confirmAttendance(api, OPEN, BRUNO)).rejects.toMatchObject({
      status: 400,
      message: 'Idade mínima para a faixa Azul/Amarela: 8 anos',
    });
    db.students
      .find((item) => item.student.id === BRUNO)!
      .eligibility.reasons.push('Carência mínima de 6 meses na faixa atual (faltam 2)');
    await expect(confirmAttendance(api, OPEN, BRUNO)).rejects.toMatchObject({
      status: 400,
      message:
        'Idade mínima para a faixa Azul/Amarela: 8 anos; Carência mínima de 6 meses na faixa atual (faltam 2)',
    });
    expect(db.exams.filter((exam) => exam.event_id === OPEN)).toEqual([]);
  });

  it('answers 404 for a missing student', async () => {
    await expect(
      confirmAttendance(await apiAs('examiner'), OPEN, 'nao-existe'),
    ).rejects.toMatchObject({ status: 404, message: 'Aluno não encontrado' });
  });

  it.each([
    [{}, 'Campo obrigatório: Aluno'],
    [{ student_id: '   ' }, 'Campo obrigatório: Aluno'],
    [{ student_id: 42 }, 'Aluno: valor inválido'],
    [{ student_id: 'x'.repeat(65) }, 'Aluno: máximo de 64 caracteres'],
    [[ANA], 'Corpo da requisição inválido: envie um objeto JSON'],
  ])('validates the body %j like the backend', async (body, message) => {
    await expect(postRaw(await apiAs('examiner'), OPEN, body)).rejects.toMatchObject({
      status: 400,
      message,
    });
  });

  it('gives each database its own copy', () => {
    db.exams.push({ ...db.exams[0]!, id: 'outro' });
    db.events.pop();
    const fresh = createMockDb();
    expect(fresh.exams).toHaveLength(1);
    expect(fresh.events).toHaveLength(2);
  });

  it('adds the showcase exams: Helena present at the open event', () => {
    const showcase = createMockDb({ includeShowcase: true });
    expect(
      showcase.exams.filter((exam) => exam.event_id === OPEN).map((exam) => exam.status),
    ).toEqual(['IN_PROGRESS']);
    expect(showcase.exams).toHaveLength(3);
  });
});
