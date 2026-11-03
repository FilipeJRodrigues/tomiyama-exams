/**
 * The simulated `GET /settings` and `POST /events/{id}/exams/{student_id}/decision` follow
 * `backend/README.md` (§ "Configurações da academia" and § "Decisão do sensei"): the sensei
 * view, the checks in the order of the table and the effect of the approval (RN009).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError, createApiClient, type ApiClient } from '../../src/api/client';
import { decideExam, getSettings } from '../../src/api/queries';
import type { DecisionInput } from '../../src/api/types';
import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { createMockAuth } from '../../src/auth/mockAuth';
import type { Role } from '../../src/auth/types';
import { MOCK_EVENT_IDS, createMockDb, mockBelts, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

const { open: OPEN, closed: CLOSED } = MOCK_EVENT_IDS;
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const MARROM = mockBelts.find((belt) => belt.name === 'Marrom')!;
const APPROVE: DecisionInput = { result: 'APPROVED', notes: null };

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

function helena() {
  return db.students.find((item) => item.student.id === HELENA)!.student;
}

describe('simulated settings and decision API', () => {
  beforeEach(() => {
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  describe('GET /settings', () => {
    it('sends the sensei with his account, active while an examiner', async () => {
      const settings = await getSettings(await apiAs('examiner'));
      expect(settings.sensei_user_id).toBe('mock-examiner-2');
      expect(settings.sensei).toEqual({
        id: 'mock-examiner-2',
        email: 'examinadora@example.com',
        name: null,
        active: true,
      });
    });

    it('sends an inactive sensei without e-mail and name, and null without a sensei', async () => {
      db.settings.sensei_user_id = 'conta-removida';
      expect((await getSettings(await apiAs('examiner'))).sensei).toEqual({
        id: 'conta-removida',
        email: null,
        name: null,
        active: false,
      });
      db.settings.sensei_user_id = null;
      expect((await getSettings(await apiAs('examiner'))).sensei).toBeNull();
    });

    it('is for examiners only', async () => {
      expect(await failure(getSettings(await apiAs('guardian')))).toEqual([
        403,
        'Esta área é dos examinadores',
      ]);
    });
  });

  describe('POST …/decision', () => {
    beforeEach(() => {
      db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    });

    it('rn009 approves a belt exam: target belt, event date, no stripes', async () => {
      const outcome = await decideExam(await apiAs('examiner'), OPEN, HELENA, {
        result: 'APPROVED',
        notes: '  Ótimo ukemi ',
      });
      expect(outcome.exam).toMatchObject({
        status: 'APPROVED',
        decided_by_id: MOCK_USER_IDS.examiner,
        notes: 'Ótimo ukemi',
        student_name: 'Helena Prado',
      });
      expect(outcome.student).toMatchObject({
        current_belt_id: MARROM.id,
        current_belt_since: '2026-11-21',
        stripes: 0,
      });
    });

    it('rn009 fails without changing the student', async () => {
      const outcome = await decideExam(await apiAs('examiner'), OPEN, HELENA, {
        result: 'FAILED',
        notes: '   ',
      });
      expect(outcome.exam).toMatchObject({ status: 'FAILED', notes: null });
      expect(outcome.student).toBeNull();
      expect(helena().stripes).toBe(4);
    });

    it('rn008 refuses without a sensei (409) and to whoever is not the sensei (403)', async () => {
      const api = await apiAs('examiner');
      db.settings.sensei_user_id = null;
      expect(await failure(decideExam(api, OPEN, HELENA, APPROVE))).toEqual([
        409,
        'Defina o sensei nas configurações da academia',
      ]);
      db.settings.sensei_user_id = 'mock-examiner-2';
      expect(await failure(decideExam(api, OPEN, HELENA, APPROVE))).toEqual([
        403,
        'Somente o sensei pode decidir o exame',
      ]);
    });

    it('rn010 refuses a decided exam', async () => {
      expect(await failure(decideExam(await apiAs('examiner'), CLOSED, ELIDA, APPROVE))).toEqual([
        409,
        'Exame já decidido',
      ]);
    });

    it('rn008 refuses a graduation changed since the attendance', async () => {
      helena().stripes = 3;
      expect(await failure(decideExam(await apiAs('examiner'), OPEN, HELENA, APPROVE))).toEqual([
        409,
        'A graduação do aluno mudou desde a presença. Confira antes de decidir.',
      ]);
    });

    it('validates the result and the note', async () => {
      const api = await apiAs('examiner');
      const bad = { result: 'TALVEZ', notes: null } as unknown as DecisionInput;
      expect(await failure(decideExam(api, OPEN, HELENA, bad))).toEqual([
        400,
        'Resultado inválido: envie result como APPROVED (aprovado) ou FAILED (reprovado)',
      ]);
      expect(
        await failure(decideExam(api, OPEN, HELENA, { ...APPROVE, notes: 'x'.repeat(501) })),
      ).toEqual([400, 'Observação: máximo de 500 caracteres']);
    });
  });
});
