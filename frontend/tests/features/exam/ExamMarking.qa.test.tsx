/**
 * § 6.4 marking, cases added by qa-frontend (card #24): two items on their way when the exam
 * gets decided (RN010), a refused unmark (RN006) and leaving for the next student while a
 * mark is on its way. Helpers copied from `ExamMarking.test.tsx`.
 *
 * Helena (open event, Marrom belt, exam in progress): Teórico 1/3 marked (Professor certo;
 * Parar and Nome do fundador não marcados), 33,3%; Prático 2/4, 25%.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PROFESSOR = mockRequirementId('Marrom', 5);
const PARAR = mockRequirementId('Marrom', 6);
const FOUNDER = mockRequirementId('Marrom', 7);

let db: MockDb;

function helenaExam() {
  return db.exams.find((exam) => exam.student_id === HELENA)!;
}

function answerOf(requirementId: string) {
  return db.answers.find(
    (item) => item.exam_id === helenaExam().id && item.requirement_id === requirementId,
  );
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
}

interface HeldWrite {
  requirementId: string;
  release: () => void;
}

/** Hold every mark (PUT and DELETE) until released, one by one, in any order. */
function holdWrites(): HeldWrite[] {
  const held: HeldWrite[] = [];
  const hold = ({ params }: { params: Record<string, unknown> }) =>
    new Promise<undefined>((resolve) => {
      held.push({
        requirementId: String(params.requirementId),
        release: () => {
          resolve(undefined);
        },
      });
    });
  server.use(http.put(ANSWER_URL, hold), http.delete(ANSWER_URL, hold));
  return held;
}

async function release(write: HeldWrite | undefined) {
  if (!write) throw new Error('Nenhuma marcação retida');
  await act(async () => {
    write.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function openHelena() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

function scores() {
  return screen.getByTestId('exam-scores');
}

function theoryScore() {
  return scores().querySelector<HTMLElement>('[data-score="THEORY"]')!;
}

const FABIO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e06';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

function decideHelena(status: 'APPROVED' | 'FAILED') {
  Object.assign(helenaExam(), {
    status,
    decided_by_id: 'mock-examiner',
    decided_at: '2026-11-21T12:00:00+00:00',
  });
}

describe('marking the exam items, more cases (§ 6.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn010 keeps the saved item and turns read-only when another one is refused as decided', async () => {
    const held = holdWrites();
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    await user.click(button('Errado: Nome do fundador do Judô'));
    await release(held[0]);

    decideHelena('FAILED');
    server.use(
      http.put(ANSWER_URL, () =>
        HttpResponse.json({ message: 'Exame já decidido' }, { status: 409 }),
      ),
    );
    await release(held[1]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Exame já decidido');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^(Certo|Errado):/ })).not.toBeInTheDocument();
    });
    const parar = screen.getByText('Parar').closest('li')!;
    expect(within(parar).getByText('Certo')).toBeInTheDocument();
    const founder = screen.getByText('Nome do fundador do Judô').closest('li')!;
    expect(within(founder).getByText('Não marcado')).toBeInTheDocument();
    expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    expect(answerOf(FOUNDER)).toBeUndefined();
  });

  it('rn006 keeps the mark and the summary when taking it off is refused', async () => {
    // Hold the refusal so the optimistic state is checked before it comes back (card #57:
    // answered at once, the 503 could undo it before the check).
    let refuse!: () => void;
    const refused = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    server.use(
      http.delete(ANSWER_URL, async () => {
        await refused;
        return HttpResponse.json({ message: BUSY }, { status: 503 });
      }),
    );
    const { user } = await openHelena();
    await user.click(button('Certo: Professor'));
    expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('tab', { name: /^Teórico 0\/3$/ })).toBeInTheDocument();
    expect(within(theoryScore()).getByText('0%')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(answerOf(PROFESSOR)?.correct).toBe(true);

    await act(async () => {
      refuse();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(BUSY);
    expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('tab', { name: /^Teórico 1\/3$/ })).toBeInTheDocument();
    expect(within(theoryScore()).getByText('33,3%')).toBeInTheDocument();
    expect(answerOf(PROFESSOR)?.correct).toBe(true);
  });

  it('rn006 saves marks on their way after moving to the previous student, and shows them back', async () => {
    db.exams.push({
      ...helenaExam(),
      id: '6f2c8d1e-4b3a-4c5d-9e6f-0201f2a3b4c9',
      student_id: FABIO,
    });
    const held = holdWrites();
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    await user.click(button('Errado: Nome do fundador do Judô'));

    await user.click(await screen.findByRole('link', { name: 'Anterior: Fábio Lima' }));
    await screen.findByRole('heading', { level: 1, name: 'Fábio Lima' });
    await screen.findByRole('button', { name: 'Certo: Parar' });
    // Nothing of Helena's marks shows on Fábio's exam.
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);

    await release(held[0]);
    await release(held[1]);
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(true);
      expect(answerOf(FOUNDER)?.correct).toBe(false);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(await screen.findByRole('link', { name: 'Próximo: Helena Prado' }));
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    expect(await screen.findByRole('button', { name: 'Certo: Parar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(button('Errado: Nome do fundador do Judô')).toHaveAttribute('aria-pressed', 'true');
    expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
  });
});
