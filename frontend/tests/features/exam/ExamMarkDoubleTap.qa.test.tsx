/**
 * § 6.4 exam of a student (RN006), card #49 etapa 2: cases of the double tap filter beyond
 * `ExamMarkDoubleTap.test.tsx` (qa-frontend). A touch double tap, a tap while the mark is
 * on its way or already landed, during the wait of a new try, after "Tentar de novo", the
 * "Só não marcados" filter remounting the buttons, and the move to another student (the
 * same item ids), where the window must not carry over. The clock is `Date` only.
 *
 * Helena (open event, Marrom, exam in progress): Parar and Nome do fundador não marcados,
 * Professor certo.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { DOUBLE_TAP_MS } from '../../../src/features/exam/markClickGuard';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { holdRetryWaits, retryWaits } from '../../retryWaits';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const FABIO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e06';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const FOUNDER = mockRequirementId('Marrom', 7);

let db: MockDb;
/** 503 for the next marks while > 0. */
let busy = 0;
/** Writes that reached the API, in order: `PUT Helena Parar true` or `DELETE Fábio Parar`. */
let writes: string[] = [];

function nameOf(id: unknown): string {
  return id === HELENA
    ? 'Helena'
    : id === FABIO
      ? 'Fábio'
      : id === PARAR
        ? 'Parar'
        : id === FOUNDER
          ? 'Fundador'
          : String(id);
}

function examOf(studentId: string) {
  return db.exams.find((exam) => exam.student_id === studentId)!;
}

function answerOf(requirementId: string, studentId = HELENA) {
  return db.answers.find(
    (item) => item.exam_id === examOf(studentId).id && item.requirement_id === requirementId,
  );
}

function refusal() {
  if (busy <= 0) return undefined;
  busy -= 1;
  return HttpResponse.json({ message: 'Sistema ocupado no momento.' }, { status: 503 });
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
  writes = [];
  busy = 0;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.put(ANSWER_URL, async ({ request, params }) => {
      const body = (await request.clone().json()) as { correct: boolean };
      writes.push(
        `PUT ${nameOf(params.studentId)} ${nameOf(params.requirementId)} ${String(body.correct)}`,
      );
      return refusal();
    }),
    http.delete(ANSWER_URL, ({ params }) => {
      writes.push(`DELETE ${nameOf(params.studentId)} ${nameOf(params.requirementId)}`);
      return refusal();
    }),
  );
}

async function openHelena() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

function later(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

async function settled(expected: string[]) {
  await waitFor(() => {
    expect(writes).toEqual(expected);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(writes).toEqual(expected);
}

describe('double tap filter, more cases (§ 6.4, RN006, qa-frontend #49)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn006 takes a touch double tap (pointer events of a finger) as one mark', async () => {
    const { user } = await openHelena();
    const certo = button('Certo: Parar');
    await user.pointer([
      { keys: '[TouchA]', target: certo },
      { keys: '[TouchA]', target: certo },
    ]);
    await settled(['PUT Helena Parar true']);
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    expect(answerOf(PARAR)?.correct).toBe(true);
  });

  it('rn006 ignores the second tap after the answer of the first one landed', async () => {
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(true);
    });
    later(DOUBLE_TAP_MS - 100);
    await user.click(button('Certo: Parar'));
    await settled(['PUT Helena Parar true']);
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
  });

  it('rn006 ignores a double tap during the wait of a new try and sends its first tap', async () => {
    holdRetryWaits();
    busy = 1;
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    await waitFor(() => {
      expect(retryWaits).toHaveLength(1);
    });
    later(DOUBLE_TAP_MS);
    await user.dblClick(button('Errado: Parar'));
    expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
    act(() => {
      retryWaits[0]!.release();
    });
    await settled(['PUT Helena Parar true', 'PUT Helena Parar false']);
    expect(answerOf(PARAR)?.correct).toBe(false);
    expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
  });

  it('rn006 a double tap on the pressed item right after "Tentar de novo" unmarks it once', async () => {
    busy = 3;
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    const alert = await screen.findByRole('alert');
    // The two waits of the new tries took 2 s.
    later(2000);
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }));
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    await user.dblClick(button('Certo: Parar'));
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => {
      expect(writes.at(-1)).toBe('DELETE Helena Parar');
    });
    await settled(writes.slice());
    expect(writes.filter((write) => write.startsWith('DELETE'))).toHaveLength(1);
    expect(answerOf(PARAR)).toBeUndefined();
  });

  it('rn006 keeps the window when the "Só não marcados" filter remounts the buttons', async () => {
    const { user } = await openHelena();
    const filter = screen.getByRole('switch', { name: 'Só não marcados' });
    await user.click(filter);
    await user.click(button('Certo: Parar'));
    await user.click(filter);
    later(DOUBLE_TAP_MS - 1);
    await user.click(button('Certo: Parar'));
    await settled(['PUT Helena Parar true']);
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
  });

  it('rn006 does not carry the window to the next student (the same item ids)', async () => {
    const fabioExam = {
      ...examOf(HELENA),
      id: '6f2c8d1e-4b3a-4c5d-9e6f-0201f2a3b4c9',
      student_id: FABIO,
    };
    db.exams.push(fabioExam);
    db.answers.push({
      exam_id: fabioExam.id,
      requirement_id: PARAR,
      correct: true,
      marked_by: db.answers[0]!.marked_by,
      marked_at: '2026-11-21T11:00:00+00:00',
    });
    const { user } = await openHelena();
    // Helena: Parar becomes Certo; at once to Fábio, whose Parar is already Certo.
    await user.click(button('Certo: Parar'));
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(true);
    });
    await user.click(await screen.findByRole('link', { name: 'Anterior: Fábio Lima' }));
    await screen.findByRole('heading', { level: 1, name: 'Fábio Lima' });
    await waitFor(() => {
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });
    // The same instant: a first tap on Fábio's exam, it takes his mark off.
    await user.click(button('Certo: Parar'));
    await settled(['PUT Helena Parar true', 'DELETE Fábio Parar']);
    expect(answerOf(PARAR, FABIO)).toBeUndefined();
    expect(answerOf(PARAR)?.correct).toBe(true);
  });

  it('rn006 lets Enter on another item mark it at once after a mark by keyboard', async () => {
    const { user } = await openHelena();
    button('Certo: Parar').focus();
    await user.keyboard('{Enter}');
    button('Certo: Nome do fundador do Judô').focus();
    await user.keyboard('{Enter}');
    await settled(['PUT Helena Parar true', 'PUT Helena Fundador true']);
    expect(button('Certo: Nome do fundador do Judô')).toHaveAttribute('aria-pressed', 'true');
  });
});
