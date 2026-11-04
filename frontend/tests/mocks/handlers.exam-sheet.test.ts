/**
 * The simulated `GET /events/{id}/exams/{student_id}` and `GET /examiners` follow
 * `backend/README.md` (§ "Exame do aluno e marcação"): same shape, RN007 summary, 404
 * messages and examiner-only access.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError, createApiClient, type ApiClient } from '../../src/api/client';
import { getExamSheet, listExaminers } from '../../src/api/queries';
import { createMockAuth } from '../../src/auth/mockAuth';
import type { Role } from '../../src/auth/types';
import { MOCK_EVENT_IDS, createMockDb, mockRequirementId, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

const { open: OPEN, closed: CLOSED } = MOCK_EVENT_IDS;
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const GABRIEL = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07';
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

let db: MockDb;

async function apiAs(role: Role | null): Promise<ApiClient> {
  const auth = createMockAuth(null);
  if (role) await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

async function failure(call: Promise<unknown>): Promise<[number, string]> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiError) return [error.status, error.message];
  }
  throw new Error('a chamada deveria falhar');
}

describe('simulated exam sheet API', () => {
  beforeEach(() => {
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn007 sends the exam in progress with its items, marks and summary', async () => {
    const sheet = await getExamSheet(await apiAs('examiner'), OPEN, HELENA);
    expect(sheet.exam).toMatchObject({
      student_id: HELENA,
      student_name: 'Helena Prado',
      kind: 'BELT',
      status: 'IN_PROGRESS',
      source_stripes: 4,
    });
    expect(sheet.event).toMatchObject({ id: OPEN, status: 'OPEN', exam_date: '2026-11-21' });
    expect(sheet.student).toEqual({
      id: HELENA,
      full_name: 'Helena Prado',
      birth_date: '2011-06-18',
    });
    expect(sheet.target_belt?.name).toBe('Marrom');
    expect(sheet.items.map((item) => item.sort_order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(sheet.items[0]?.answer).toMatchObject({
      requirement_id: mockRequirementId('Marrom', 1),
      correct: true,
    });
    expect(sheet.items[2]?.answer).toBeNull();
    expect(sheet.summary).toEqual({
      THEORY: { kind: 'THEORY', total: 3, marked: 1, correct: 1, percent: 33.3 },
      PRACTICE: { kind: 'PRACTICE', total: 4, marked: 2, correct: 1, percent: 25 },
    });
  });

  it('rn007 answers percent null for a belt without items of a kind', async () => {
    const sheet = await getExamSheet(await apiAs('examiner'), CLOSED, GABRIEL);
    expect(sheet.exam.status).toBe('APPROVED');
    expect(sheet.summary.PRACTICE).toEqual({
      kind: 'PRACTICE',
      total: 0,
      marked: 0,
      correct: 0,
      percent: null,
    });
    expect(sheet.summary.THEORY.percent).toBe(50);
  });

  it('sends a decided exam of a closed event, with who decided', async () => {
    const sheet = await getExamSheet(await apiAs('examiner'), CLOSED, ELIDA);
    expect(sheet.event.status).toBe('CLOSED');
    expect(sheet.exam).toMatchObject({ kind: 'STRIPE', status: 'APPROVED' });
    expect(sheet.exam.decided_by_id).toBe(db.examiners[0]?.id);
  });

  it('rn018 sends student null when the student no longer exists', async () => {
    db.students = db.students.filter((item) => item.student.id !== HELENA);
    const sheet = await getExamSheet(await apiAs('examiner'), OPEN, HELENA);
    expect(sheet.student).toBeNull();
    expect(sheet.exam.student_name).toBeNull();
  });

  it('answers 404 for a missing event or exam', async () => {
    const api = await apiAs('examiner');
    expect(await failure(getExamSheet(api, 'sem-evento', HELENA))).toEqual([
      404,
      'Evento não encontrado',
    ]);
    expect(await failure(getExamSheet(api, OPEN, ANA))).toEqual([404, 'Exame não encontrado']);
  });

  it('keeps guardians and signed-out users out', async () => {
    expect(await failure(getExamSheet(await apiAs('guardian'), OPEN, HELENA))).toEqual([
      403,
      'Esta área é dos examinadores',
    ]);
    expect((await failure(getExamSheet(await apiAs(null), OPEN, HELENA)))[0]).toBe(401);
    expect(await failure(listExaminers(await apiAs('guardian')))).toEqual([
      403,
      'Esta área é dos examinadores',
    ]);
  });

  it('lists the active examiners', async () => {
    const examiners = await listExaminers(await apiAs('examiner'));
    expect(examiners.map((examiner) => examiner.name)).toEqual([
      'Sensei Simulado',
      null,
      'Master Simulado',
    ]);
  });
});
