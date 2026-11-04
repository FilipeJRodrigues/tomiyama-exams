/**
 * § 6.4 (RN006), card #49: a mark refused for a passing reason (503, 409 "Outra marcação…",
 * 429, 504, network) is sent again by itself up to twice, after 0,5 s and 1,5 s, with the
 * newest click on the item; after three refusals the item goes back as the API has it and
 * the notice offers "Tentar de novo". A final refusal (decided exam, closed event…) is not
 * sent again.
 *
 * The waits never take real time: `tests/retryWaits.ts` ends them at once, or holds them
 * until the test releases them (`holdRetryWaits`).
 *
 * Helena (open event, Marrom belt, exam in progress): Teórico 1/3 marked (Professor certo;
 * Parar and Nome do fundador não marcados), 33,3%.
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
import { holdRetryWaits, retryWaits } from '../../retryWaits';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const FABIO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e06';
const SHEET_URL = `${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`;
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const TRY_AGAIN = 'Outra marcação está em andamento. Tente de novo.';

/** How the API answers the next mark; `undefined` (nothing left) lets it through. */
type Outcome = 'busy' | 'conflict' | 'throttled' | 'timeout' | 'network' | Refusal;
type Refusal = 'decided' | 'closed' | 'forbidden';

const REFUSALS: Record<Exclude<Outcome, 'network'>, [number, string]> = {
  busy: [503, BUSY],
  conflict: [409, TRY_AGAIN],
  throttled: [429, 'Too Many Requests'],
  timeout: [504, 'Endpoint request timed out'],
  decided: [409, 'Exame já decidido'],
  closed: [400, 'Evento encerrado'],
  forbidden: [403, 'Esta área é dos examinadores'],
};

let db: MockDb;
let outcomes: Outcome[] = [];
let sheetReads = 0;
/** Marks that reached the API, in order: `PUT <student> <item> true|false` or `DELETE …`. */
let writes: string[] = [];

function examOf(studentId: string) {
  return db.exams.find((exam) => exam.student_id === studentId)!;
}

function answerOf(requirementId: string, studentId = HELENA) {
  return db.answers.find(
    (item) => item.exam_id === examOf(studentId).id && item.requirement_id === requirementId,
  );
}

function nameOf(id: unknown): string {
  return id === HELENA ? 'Helena' : id === FABIO ? 'Fábio' : id === PARAR ? 'Parar' : String(id);
}

function answer(outcome: Outcome | undefined) {
  if (outcome === undefined) return undefined;
  if (outcome === 'network') return HttpResponse.error();
  const [status, message] = REFUSALS[outcome];
  return HttpResponse.json({ message }, { status });
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
  outcomes = [];
  sheetReads = 0;
  writes = [];
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.get(SHEET_URL, () => {
      sheetReads += 1;
      return undefined;
    }),
    http.put(ANSWER_URL, async ({ request, params }) => {
      const body = (await request.clone().json()) as { correct: boolean };
      writes.push(
        `PUT ${nameOf(params.studentId)} ${nameOf(params.requirementId)} ${String(body.correct)}`,
      );
      return answer(outcomes.shift());
    }),
    http.delete(ANSWER_URL, ({ params }) => {
      writes.push(`DELETE ${nameOf(params.studentId)} ${nameOf(params.requirementId)}`);
      return answer(outcomes.shift());
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

function theoryScore() {
  return screen.getByTestId('exam-scores').querySelector<HTMLElement>('[data-score="THEORY"]')!;
}

function waitDurations() {
  return retryWaits.map((wait) => wait.ms);
}

/** The wait of index `index` was asked for (the mark was refused and will be sent again). */
async function waitAskedFor(index: number) {
  await waitFor(() => {
    expect(retryWaits).toHaveLength(index + 1);
  });
  return retryWaits[index]!;
}

/** Let what is on its way run for a moment (to check that nothing else happens). */
async function settleAWhile() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/** Parar ends saved as Certo, with the summary of the API: Teórico 2/3, 66,7%. */
async function expectPararSavedAsCorrect() {
  await waitFor(() => {
    expect(answerOf(PARAR)?.correct).toBe(true);
  });
  await waitFor(() => {
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
  });
  expect(screen.getByRole('tab', { name: /^Teórico 2\/3$/ })).toBeInTheDocument();
  expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
  expect(within(theoryScore()).getByText('marcados 2 de 3')).toBeInTheDocument();
}

describe('new tries of a refused mark (§ 6.4, RN006)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('a passing refusal', () => {
    it('rn006 keeps the mark during the wait and saves it on the new try (503)', async () => {
      const waits = holdRetryWaits();
      outcomes = ['busy'];
      const { user } = await openHelena();
      const reads = sheetReads;
      await user.click(button('Certo: Parar'));

      const wait = await waitAskedFor(0);
      expect(wait.ms).toBe(500);
      expect(writes).toEqual(['PUT Helena Parar true']);
      // Still on its way: the mark, the tab and the summary show it, with no notice.
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('tab', { name: /^Teórico 2\/3$/ })).toBeInTheDocument();
      expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      // The reload on window focus waits for the new try.
      await act(async () => {
        window.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      await settleAWhile();
      expect(sheetReads).toBe(reads);

      act(() => {
        wait.release();
      });
      await expectPararSavedAsCorrect();
      expect(writes).toEqual(['PUT Helena Parar true', 'PUT Helena Parar true']);
      expect(waits).toHaveLength(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      // Then the exam reloads, as after any mark that held the reload back.
      await waitFor(() => {
        expect(sheetReads).toBe(reads + 1);
      });
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });

    it.each([
      ['409 "Outra marcação está em andamento"', 'conflict'],
      ['a network failure', 'network'],
      ['429', 'throttled'],
      ['504', 'timeout'],
    ] as const)('rn006 saves the mark on the new try after %s', async (_label, outcome) => {
      outcomes = [outcome];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));

      await expectPararSavedAsCorrect();
      expect(writes).toEqual(['PUT Helena Parar true', 'PUT Helena Parar true']);
      expect(waitDurations()).toEqual([500]);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('rn006 saves on the third try, after waiting 0,5 s and 1,5 s', async () => {
      outcomes = ['busy', 'conflict'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));

      await expectPararSavedAsCorrect();
      expect(writes).toHaveLength(3);
      expect(waitDurations()).toEqual([500, 1500]);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('rn006 sends the click made during the wait, one request at a time', async () => {
      holdRetryWaits();
      outcomes = ['busy'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const wait = await waitAskedFor(0);

      await user.click(button('Errado: Parar'));
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
      await settleAWhile();
      expect(writes).toEqual(['PUT Helena Parar true']);

      act(() => {
        wait.release();
      });
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(false);
      });
      expect(writes).toEqual(['PUT Helena Parar true', 'PUT Helena Parar false']);
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /^Teórico 2\/3$/ })).toBeInTheDocument();
      });
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(within(theoryScore()).getByText('33,3%')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('rn006 sends the item back to the saved state when clicked back during the wait', async () => {
      // After a 504 or a network failure the first send may have been saved: what the
      // screen has from the API is not sure, so the newest click is sent all the same.
      holdRetryWaits();
      outcomes = ['timeout'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const wait = await waitAskedFor(0);
      await user.click(button('Certo: Parar'));
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');

      act(() => {
        wait.release();
      });
      await waitFor(() => {
        expect(writes).toEqual(['PUT Helena Parar true', 'DELETE Helena Parar']);
      });
      await settleAWhile();
      expect(answerOf(PARAR)).toBeUndefined();
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('tab', { name: /^Teórico 1\/3$/ })).toBeInTheDocument();
      expect(within(theoryScore()).getByText('33,3%')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('three refusals', () => {
    it('rn006 puts the item back and offers "Tentar de novo", which saves it', async () => {
      outcomes = ['busy', 'busy', 'network'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível salvar a marcação de "Parar"');
      expect(alert).toHaveTextContent(
        'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.',
      );
      expect(writes).toHaveLength(3);
      expect(waitDurations()).toEqual([500, 1500]);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('tab', { name: /^Teórico 1\/3$/ })).toBeInTheDocument();
      expect(within(theoryScore()).getByText('33,3%')).toBeInTheDocument();
      expect(within(alert).getByRole('button', { name: 'Fechar aviso' })).toBeInTheDocument();

      // By keyboard: the button names the item.
      const retry = within(alert).getByRole('button', { name: 'Tentar de novo: Parar' });
      expect(retry).toHaveTextContent('Tentar de novo');
      retry.focus();
      await user.keyboard('{Enter}');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      // The button left with the notice: the focus goes to the item, not to the page.
      expect(button('Certo: Parar')).toHaveFocus();
      await expectPararSavedAsCorrect();
      expect(writes).toEqual([
        'PUT Helena Parar true',
        'PUT Helena Parar true',
        'PUT Helena Parar true',
        'PUT Helena Parar true',
      ]);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('rn006 "Tentar de novo" sends the last mark wanted, with its own new tries', async () => {
      const waits = holdRetryWaits();
      outcomes = ['busy', 'busy', 'busy', 'busy'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const first = await waitAskedFor(0);
      // Changed during the first wait: Errado is what the examiner wants in the end.
      await user.click(button('Errado: Parar'));
      act(() => {
        first.release();
      });
      const second = await waitAskedFor(1);
      act(() => {
        second.release();
      });

      const alert = await screen.findByRole('alert');
      expect(writes).toEqual([
        'PUT Helena Parar true',
        'PUT Helena Parar false',
        'PUT Helena Parar false',
      ]);
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'false');

      await user.click(within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      // Refused once more: the new tries start over at 0,5 s.
      const third = await waitAskedFor(2);
      expect(third.ms).toBe(500);
      act(() => {
        third.release();
      });

      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(false);
      });
      expect(waits.map((wait) => wait.ms)).toEqual([500, 1500, 500]);
      expect(writes.slice(3)).toEqual(['PUT Helena Parar false', 'PUT Helena Parar false']);
      await waitFor(() => {
        expect(within(theoryScore()).getByText('marcados 2 de 3')).toBeInTheDocument();
      });
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('rn006 a new click on the item takes "Tentar de novo" away and is what is saved', async () => {
      outcomes = ['busy', 'busy', 'busy'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const alert = await screen.findByRole('alert');
      expect(
        within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }),
      ).toBeInTheDocument();

      await user.click(button('Errado: Parar'));
      expect(
        screen.queryByRole('button', { name: 'Tentar de novo: Parar' }),
      ).not.toBeInTheDocument();

      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(false);
      });
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
      expect(writes).toEqual([
        'PUT Helena Parar true',
        'PUT Helena Parar true',
        'PUT Helena Parar true',
        'PUT Helena Parar false',
      ]);
    });
  });

  describe('reload after the last try', () => {
    const TIMEOUT = 'Endpoint request timed out';

    it('rn006 reloads the exam once, as a refused try may have been saved (3 × 504)', async () => {
      const saved = db.answers.find((item) => item.exam_id === examOf(HELENA).id)!;
      let landed = false;
      // The first try reaches the table, but its answer is lost to the gateway timeout.
      server.use(
        http.put(ANSWER_URL, ({ params }) => {
          if (params.requirementId !== PARAR) return undefined;
          if (!landed) {
            landed = true;
            db.answers.push({ ...saved, requirement_id: PARAR, correct: true });
          }
          return HttpResponse.json({ message: TIMEOUT }, { status: 504 });
        }),
      );
      const { user } = await openHelena();
      const reads = sheetReads;
      await user.click(button('Certo: Parar'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível salvar a marcação de "Parar"');
      await waitFor(() => {
        expect(sheetReads).toBe(reads + 1);
      });
      // The reload brings what the API has: Parar saved, with its summary.
      await waitFor(() => {
        expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      });
      expect(screen.getByRole('tab', { name: /^Teórico 2\/3$/ })).toBeInTheDocument();
      expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
      // The notice and its "Tentar de novo" stay after the reload.
      expect(
        within(screen.getByRole('alert')).getByRole('button', { name: 'Tentar de novo: Parar' }),
      ).toBeInTheDocument();
      await settleAWhile();
      expect(sheetReads).toBe(reads + 1);
    });

    it('rn006 reloads only once no other mark of the exam is on its way', async () => {
      holdRetryWaits();
      let openGate: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      server.use(
        http.put(ANSWER_URL, async ({ params }) => {
          if (params.requirementId === PARAR) {
            return HttpResponse.json({ message: TIMEOUT }, { status: 504 });
          }
          // Nome do fundador waits until the test lets it through to the mock API.
          await gate;
          return undefined;
        }),
      );
      const { user } = await openHelena();
      const reads = sheetReads;
      await user.click(button('Certo: Parar'));
      const first = await waitAskedFor(0);
      await user.click(button('Errado: Nome do fundador do Judô'));

      act(() => {
        first.release();
      });
      const second = await waitAskedFor(1);
      act(() => {
        second.release();
      });
      const alert = await screen.findByRole('alert');
      expect(
        within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }),
      ).toBeInTheDocument();
      await settleAWhile();
      // Nome do fundador is still on its way: no reload yet.
      expect(sheetReads).toBe(reads);

      act(() => {
        openGate!();
      });
      await waitFor(() => {
        expect(sheetReads).toBe(reads + 1);
      });
      await waitFor(() => {
        expect(button('Errado: Nome do fundador do Judô')).toHaveAttribute('aria-pressed', 'true');
      });
      expect(
        within(screen.getByRole('alert')).getByRole('button', { name: 'Tentar de novo: Parar' }),
      ).toBeInTheDocument();
      await settleAWhile();
      expect(sheetReads).toBe(reads + 1);
    });

    it.each([
      [['network', 'busy', 'busy'], 1],
      [['timeout', 'conflict', 'conflict'], 1],
      [['busy', 'throttled', 'busy'], 1],
      // A transaction conflict was cancelled whole: nothing of it reached the table.
      [['conflict', 'conflict', 'conflict'], 0],
    ] as const)('rn006 after %j reloads the exam %i time(s)', async (refusals, reloads) => {
      outcomes = [...refusals];
      const { user } = await openHelena();
      const reads = sheetReads;
      await user.click(button('Certo: Parar'));
      await screen.findByRole('alert');
      await waitFor(() => {
        expect(sheetReads).toBe(reads + reloads);
      });
      await settleAWhile();
      expect(sheetReads).toBe(reads + reloads);
      expect(screen.getByRole('button', { name: 'Tentar de novo: Parar' })).toBeInTheDocument();
    });
  });

  describe('a final refusal', () => {
    it.each([
      ['decided', 'Exame já decidido'],
      ['closed', 'Evento encerrado'],
      ['forbidden', 'Esta área é dos examinadores'],
    ] as const)(
      'rn006 does not send %s again nor offer "Tentar de novo"',
      async (outcome, message) => {
        outcomes = [outcome];
        const { user } = await openHelena();
        await user.click(button('Certo: Parar'));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(message);
        await settleAWhile();
        expect(writes).toEqual(['PUT Helena Parar true']);
        expect(retryWaits).toHaveLength(0);
        expect(screen.queryByRole('button', { name: /^Tentar de novo/ })).not.toBeInTheDocument();
        expect(
          within(screen.getByRole('alert')).getByRole('button', { name: 'Fechar aviso' }),
        ).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /^Teórico 1\/3$/ })).toBeInTheDocument();
      },
    );
  });

  describe('leaving during the wait', () => {
    it('rn006 sends nothing more once the screen left', async () => {
      holdRetryWaits();
      outcomes = ['busy'];
      const { user, unmount } = await openHelena();
      await user.click(button('Certo: Parar'));
      const wait = await waitAskedFor(0);
      const errors = vi.spyOn(console, 'error');

      unmount();
      expect(wait.aborted).toBe(true);
      wait.release();
      await settleAWhile();

      expect(writes).toEqual(['PUT Helena Parar true']);
      expect(retryWaits).toHaveLength(1);
      expect(answerOf(PARAR)).toBeUndefined();
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });

    it('rn006 keeps trying the exam of the mark after moving to another student', async () => {
      db.exams.push({
        ...examOf(HELENA),
        id: '6f2c8d1e-4b3a-4c5d-9e6f-0201f2a3b4c9',
        student_id: FABIO,
      });
      holdRetryWaits();
      outcomes = ['busy'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const wait = await waitAskedFor(0);

      await user.click(await screen.findByRole('link', { name: 'Anterior: Fábio Lima' }));
      await screen.findByRole('heading', { level: 1, name: 'Fábio Lima' });
      await screen.findByRole('button', { name: 'Certo: Parar' });
      expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);

      act(() => {
        wait.release();
      });
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(true);
      });
      expect(writes).toEqual(['PUT Helena Parar true', 'PUT Helena Parar true']);
      expect(answerOf(PARAR, FABIO)).toBeUndefined();
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
