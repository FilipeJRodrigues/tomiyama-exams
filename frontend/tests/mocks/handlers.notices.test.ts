/**
 * The simulated `GET /students/{id}/exam-notices` follows `backend/README.md` ("Avisos de exame
 * ao responsável (RN019)", `domain/notices.py`): guardians only, before any read; 404 for a
 * missing student or someone else's; one notice per open event where it holds, nearest date
 * first. The mock uses the student's fixed eligibility where the API evaluates it on the date
 * of each event.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createApiClient, type ApiClient } from '../../src/api/client';
import { listStudentExamNotices } from '../../src/api/queries';
import type { Exam, ExamEvent } from '../../src/api/types';
import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_MASTER_EMAIL, MOCK_USER_IDS } from '../../src/auth/mockConstants';
import type { Role } from '../../src/auth/types';
import { MOCK_EVENT_IDS, createMockDb, mockBelts, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

/** Guardian's student, eligible for the belt Cinza/Azul. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
/** Guardian's student, blocked. */
const BRUNO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e02';
/** Examiner's student, eligible. */
const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';
/** Guardian's student with a decided exam at the closed event, blocked. */
const GABRIEL = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07';
const { open: OPEN, closed: CLOSED } = MOCK_EVENT_IDS;

function beltId(name: string): string {
  return mockBelts.find((belt) => belt.name === name)!.id;
}

let db: MockDb;

async function apiAs(role: Role | null, email = 'pessoa@example.com'): Promise<ApiClient> {
  const auth = createMockAuth(null);
  if (role) await auth.signIn({ email, password: 'senha-teste', role });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

function student(id: string) {
  return db.students.find((item) => item.student.id === id)!;
}

function addEvent(id: string, name: string, examDate: string, status: ExamEvent['status']) {
  db.events.push({ ...db.events[0]!, id, name, exam_date: examDate, status });
}

function addExam(studentId: string, eventId: string, overrides: Partial<Exam> = {}) {
  db.exams.push({
    ...db.exams[0]!,
    id: `exame-${eventId}-${studentId.slice(-2)}`,
    event_id: eventId,
    student_id: studentId,
    target_belt_id: beltId('Cinza/Azul'),
    kind: 'BELT',
    status: 'IN_PROGRESS',
    decided_by_id: null,
    decided_at: null,
    notes: null,
    ...overrides,
  });
}

describe('simulated exam notices to the guardian (RN019)', () => {
  beforeEach(() => {
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn019 needs a session (401)', async () => {
    await expect(listStudentExamNotices(await apiAs(null), ANA)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rn019 is for guardians only: 403 for every examiner, also the owner, the master and the sensei', async () => {
    const refusal = { status: 403, message: 'Esta área é dos responsáveis' };
    // Carla belongs to the simulated examiner.
    await expect(listStudentExamNotices(await apiAs('examiner'), CARLA)).rejects.toMatchObject(
      refusal,
    );
    await expect(listStudentExamNotices(await apiAs('examiner'), ANA)).rejects.toMatchObject(
      refusal,
    );
    await expect(
      listStudentExamNotices(await apiAs('examiner', MOCK_MASTER_EMAIL), ANA),
    ).rejects.toMatchObject(refusal);
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    await expect(listStudentExamNotices(await apiAs('examiner'), ANA)).rejects.toMatchObject(
      refusal,
    );
    // Before any read: an examiner does not learn whether the student exists.
    await expect(
      listStudentExamNotices(await apiAs('examiner'), 'nao-existe'),
    ).rejects.toMatchObject(refusal);
  });

  it("rn013 answers the same 404 for a missing student and for someone else's", async () => {
    const notFound = { status: 404, message: 'Aluno não encontrado' };
    const api = await apiAs('guardian');
    await expect(listStudentExamNotices(api, 'nao-existe')).rejects.toMatchObject(notFound);
    await expect(listStudentExamNotices(api, CARLA)).rejects.toMatchObject(notFound);
  });

  it('rn019 sends the notice of the open event for an eligible student, with only the least of the event', async () => {
    expect(await listStudentExamNotices(await apiAs('guardian'), ANA)).toEqual([
      {
        event_id: OPEN,
        event_name: 'Exame novembro/2026',
        event_date: '2026-11-21',
        target_belt_id: beltId('Cinza/Azul'),
        target_belt_name: 'Cinza/Azul',
        kind: 'BELT',
      },
    ]);
  });

  it('rn019 answers [] for a student who is not eligible', async () => {
    const api = await apiAs('guardian');
    expect(await listStudentExamNotices(api, BRUNO)).toEqual([]);
    expect(await listStudentExamNotices(api, GABRIEL)).toEqual([]);
  });

  it('rn019 answers [] for an inactive student', async () => {
    student(ANA).student.active = false;
    expect(await listStudentExamNotices(await apiAs('guardian'), ANA)).toEqual([]);
  });

  it('rn019 has no notice of a closed event, and has it again when the event reopens', async () => {
    const api = await apiAs('guardian');
    const open = db.events.find((event) => event.id === OPEN)!;
    open.status = 'CLOSED';
    expect(await listStudentExamNotices(api, ANA)).toEqual([]);
    open.status = 'OPEN';
    expect(await listStudentExamNotices(api, ANA)).toHaveLength(1);
  });

  it('orders by the event date, nearest first, then by the event id', async () => {
    addEvent('z-marco', 'Exame março/2027', '2027-03-20', 'OPEN');
    addEvent('b-mesmo-dia', 'Exame extra B', '2026-11-21', 'OPEN');
    addEvent('0-mesmo-dia', 'Exame extra 0', '2026-11-21', 'OPEN');
    addEvent('a-outubro', 'Exame outubro/2026', '2026-10-10', 'OPEN');
    addEvent('fechado', 'Exame fechado', '2026-09-01', 'CLOSED');
    const notices = await listStudentExamNotices(await apiAs('guardian'), ANA);
    expect(notices.map((item) => [item.event_id, item.event_date])).toEqual([
      ['a-outubro', '2026-10-10'],
      ['0-mesmo-dia', '2026-11-21'],
      [OPEN, '2026-11-21'],
      ['b-mesmo-dia', '2026-11-21'],
      ['z-marco', '2027-03-20'],
    ]);
  });

  it('rn019 keeps the notice of an exam in progress in the event, with the target and kind of the exam', async () => {
    addExam(ANA, OPEN, { kind: 'STRIPE', target_belt_id: beltId('Azul') });
    expect(await listStudentExamNotices(await apiAs('guardian'), ANA)).toEqual([
      {
        event_id: OPEN,
        event_name: 'Exame novembro/2026',
        event_date: '2026-11-21',
        target_belt_id: beltId('Azul'),
        target_belt_name: 'Azul',
        kind: 'STRIPE',
      },
    ]);
  });

  it('rn019 has no notice of the other events while an exam is in progress, open or closed', async () => {
    const api = await apiAs('guardian');
    addEvent('z-marco', 'Exame março/2027', '2027-03-20', 'OPEN');
    addExam(ANA, OPEN);
    expect((await listStudentExamNotices(api, ANA)).map((item) => item.event_id)).toEqual([OPEN]);

    // In progress at a closed event: no notice anywhere.
    db.exams.pop();
    addExam(ANA, CLOSED);
    expect(await listStudentExamNotices(api, ANA)).toEqual([]);
  });

  it('rn019 drops the notice of the event once its exam is decided', async () => {
    const api = await apiAs('guardian');
    addEvent('z-marco', 'Exame março/2027', '2027-03-20', 'OPEN');
    addExam(ANA, OPEN, { status: 'FAILED', decided_by_id: MOCK_USER_IDS.examiner });
    expect((await listStudentExamNotices(api, ANA)).map((item) => item.event_id)).toEqual([
      'z-marco',
    ]);
  });

  it('sends the current belt name, and null for a belt that is gone', async () => {
    const api = await apiAs('guardian');
    addExam(ANA, OPEN, { target_belt_id: beltId('Azul') });
    db.belts = db.belts.map((belt) =>
      belt.name === 'Azul' ? { ...belt, name: 'Azul (nova)' } : belt,
    );
    expect((await listStudentExamNotices(api, ANA))[0]?.target_belt_name).toBe('Azul (nova)');
    db.belts = db.belts.filter((belt) => belt.name !== 'Azul (nova)');
    expect((await listStudentExamNotices(api, ANA))[0]?.target_belt_name).toBeNull();
  });

  it('only reads: asking for the notices changes nothing in the simulated data', async () => {
    const before = JSON.stringify(db);
    await listStudentExamNotices(await apiAs('guardian'), ANA);
    expect(JSON.stringify(db)).toBe(before);
  });
});
