/**
 * The simulated `GET /students/{id}/exams` follows `backend/README.md` ("Histórico de exames
 * do aluno (RN018)", `domain/history.py`): examiners only, before any read; 404 for a missing
 * student; every exam with the current names, most recent first; and it is built from the
 * stored exams, so an attendance or a decision of the simulated API shows in it at once.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createApiClient, type ApiClient } from '../../src/api/client';
import { confirmAttendance, decideExam, listStudentExams } from '../../src/api/queries';
import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import type { Role } from '../../src/auth/types';
import { MOCK_EVENT_IDS, createMockDb, mockBelts, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const GABRIEL = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07';
const { open: OPEN, closed: CLOSED } = MOCK_EVENT_IDS;

function beltId(name: string): string {
  return mockBelts.find((belt) => belt.name === name)!.id;
}

let db: MockDb;

async function apiAs(role: Role | null): Promise<ApiClient> {
  const auth = createMockAuth(null);
  if (role) await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

describe('simulated student exam history (RN018)', () => {
  beforeEach(() => {
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn018 is for examiners only, also for the owner of the student (403), and needs a session', async () => {
    await expect(listStudentExams(await apiAs('guardian'), GABRIEL)).rejects.toMatchObject({
      status: 403,
      message: 'Esta área é dos examinadores',
    });
    // Before any read: a guardian does not learn whether the student exists.
    await expect(listStudentExams(await apiAs('guardian'), 'nao-existe')).rejects.toMatchObject({
      status: 403,
    });
    await expect(listStudentExams(await apiAs(null), GABRIEL)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('answers 404 for a student that does not exist', async () => {
    await expect(listStudentExams(await apiAs('examiner'), 'nao-existe')).rejects.toMatchObject({
      status: 404,
      message: 'Aluno não encontrado',
    });
  });

  it('answers [] for a student without exams', async () => {
    expect(await listStudentExams(await apiAs('examiner'), ANA)).toEqual([]);
  });

  it('sends the exam with the names of its event and belts, and the source', async () => {
    expect(await listStudentExams(await apiAs('examiner'), ELIDA)).toEqual([
      {
        event_id: CLOSED,
        event_name: 'Exame março/2026',
        exam_date: '2026-03-01',
        target_belt_id: beltId('Roxa'),
        target_belt_name: 'Roxa',
        kind: 'STRIPE',
        status: 'APPROVED',
        decided_by_id: MOCK_USER_IDS.examiner,
        decided_at: '2026-03-01T15:00:00+00:00',
        notes: null,
        created_at: '2026-03-01T13:00:00+00:00',
        source: {
          belt_id: beltId('Verde'),
          belt_name: 'Verde',
          belt_since: '2024-05-20',
          stripes: 0,
        },
      },
    ]);
    const [gabriel] = await listStudentExams(await apiAs('examiner'), GABRIEL);
    expect(gabriel?.notes).toBe('Bom equilíbrio nas quedas');
  });

  it('rn018 shows a confirmed attendance at once, then its decision', async () => {
    const api = await apiAs('examiner');
    await confirmAttendance(api, OPEN, CARLA);
    const [present] = await listStudentExams(api, CARLA);
    expect(present).toMatchObject({
      event_id: OPEN,
      target_belt_name: 'Verde',
      kind: 'STRIPE',
      status: 'IN_PROGRESS',
      decided_by_id: null,
      decided_at: null,
      notes: null,
      source: { belt_id: beltId('Laranja'), belt_name: 'Laranja', stripes: 0 },
    });

    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    await decideExam(api, OPEN, CARLA, { result: 'FAILED', notes: 'Treinar as quedas' });
    const [decided] = await listStudentExams(api, CARLA);
    expect(decided).toMatchObject({
      status: 'FAILED',
      decided_by_id: MOCK_USER_IDS.examiner,
      notes: 'Treinar as quedas',
    });
    expect(decided?.decided_at).toEqual(expect.any(String));
  });

  it('orders by event date, then the newest attendance, then event id; no event goes last', async () => {
    const base = db.exams.find((exam) => exam.student_id === ELIDA)!;
    db.events.push(
      { ...db.events[1]!, id: 'antigo', name: 'Exame 2025', exam_date: '2025-03-01' },
      { ...db.events[1]!, id: 'mesmo-dia', name: 'Exame extra', exam_date: '2026-03-01' },
    );
    db.exams.push(
      { ...base, id: 'x1', event_id: 'antigo' },
      {
        ...base,
        id: 'x2',
        event_id: OPEN,
        status: 'IN_PROGRESS',
        created_at: '2026-11-02T12:00:00+00:00',
      },
      // Same date as the closed event, newer attendance: comes before it.
      { ...base, id: 'x3', event_id: 'mesmo-dia', created_at: '2026-03-01T14:00:00+00:00' },
      { ...base, id: 'x4', event_id: 'apagado' },
    );
    const history = await listStudentExams(await apiAs('examiner'), ELIDA);
    expect(history.map((item) => [item.event_id, item.event_name, item.exam_date])).toEqual([
      [OPEN, 'Exame novembro/2026', '2026-11-21'],
      ['mesmo-dia', 'Exame extra', '2026-03-01'],
      [CLOSED, 'Exame março/2026', '2026-03-01'],
      ['antigo', 'Exame 2025', '2025-03-01'],
      ['apagado', null, null],
    ]);
  });

  it('sends the current belt names, and null for a belt that is gone', async () => {
    db.belts = db.belts
      .map((belt) => (belt.name === 'Roxa' ? { ...belt, name: 'Roxa (nova)' } : belt))
      .filter((belt) => belt.name !== 'Verde');
    const [item] = await listStudentExams(await apiAs('examiner'), ELIDA);
    expect(item?.target_belt_name).toBe('Roxa (nova)');
    expect(item?.source?.belt_name).toBeNull();
  });
});
