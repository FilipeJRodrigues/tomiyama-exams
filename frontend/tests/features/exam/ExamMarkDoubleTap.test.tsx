/**
 * § 6.4 exam of a student (RN006): a double tap on the phone or the Enter key held down on
 * Certo/Errado counts as one click, so a mark never undoes itself by accident (#49). The
 * clock is `Date` only (`vi.setSystemTime`), never a real wait.
 *
 * Helena (open event, exam in progress): Parar and Nome do fundador do Judô não marcados,
 * Professor certo.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PROFESSOR = mockRequirementId('Marrom', 5);
const PARAR = mockRequirementId('Marrom', 6);
const FOUNDER = mockRequirementId('Marrom', 7);

const NAMES: Record<string, string> = {
  [PROFESSOR]: 'Professor',
  [PARAR]: 'Parar',
  [FOUNDER]: 'Fundador',
};

let db: MockDb;
/** Writes that reached the API, in order: `PUT Parar true` or `DELETE Parar`. */
let writes: string[] = [];

function answerOf(requirementId: string) {
  const exam = db.exams.find((item) => item.student_id === HELENA)!;
  return db.answers.find(
    (item) => item.exam_id === exam.id && item.requirement_id === requirementId,
  );
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
  writes = [];
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.put(ANSWER_URL, async ({ request, params }) => {
      const body = (await request.clone().json()) as { correct: boolean };
      writes.push(`PUT ${NAMES[String(params.requirementId)]} ${String(body.correct)}`);
      return undefined;
    }),
    http.delete(ANSWER_URL, ({ params }) => {
      writes.push(`DELETE ${NAMES[String(params.requirementId)]}`);
      return undefined;
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

/** Every mark landed and nothing else is sent. */
async function settled(expected: string[]) {
  await waitFor(() => {
    expect(writes).toEqual(expected);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(writes).toEqual(expected);
}

/**
 * A user whose keys held down keep repeating for longer than the double tap window: the
 * clock moves `DOUBLE_TAP_MS` between each repeated `keydown`, as a key held for seconds.
 */
function userHoldingKeys() {
  return userEvent.setup({
    advanceTimers: () => {
      later(DOUBLE_TAP_MS);
    },
  });
}

describe('double tap and held key on Certo/Errado (§ 6.4, RN006)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('taps', () => {
    it('rn006 takes a double tap on the same button as one mark', async () => {
      const { user } = await openHelena();
      await user.dblClick(button('Certo: Parar'));
      await settled(['PUT Parar true']);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(answerOf(PARAR)?.correct).toBe(true);
    });

    it('rn006 ignores the second tap until the window ends', async () => {
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      later(DOUBLE_TAP_MS - 1);
      await user.click(button('Certo: Parar'));
      await settled(['PUT Parar true']);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });

    it('rn006 takes the mark off with a second tap after the window', async () => {
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      later(DOUBLE_TAP_MS);
      await user.click(button('Certo: Parar'));
      await settled(['PUT Parar true', 'DELETE Parar']);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
      expect(answerOf(PARAR)).toBeUndefined();
    });

    it('rn006 takes a double tap on the pressed button as one unmark', async () => {
      const { user } = await openHelena();
      await user.dblClick(button('Certo: Professor'));
      await settled(['DELETE Professor']);
      expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'false');
      expect(answerOf(PROFESSOR)).toBeUndefined();
    });

    it('rn006 takes Certo and then Errado at once as a change of mind', async () => {
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await user.click(button('Errado: Parar'));
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(false);
      });
      expect(writes.at(-1)).toBe('PUT Parar false');
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
    });

    it('rn006 takes Certo, Errado and Certo again at once: the last one wins', async () => {
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await user.click(button('Errado: Parar'));
      await user.click(button('Certo: Parar'));
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(true);
      });
      expect(writes.at(-1)).toBe('PUT Parar true');
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });

    it('rn006 leaves the other items alone', async () => {
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await user.click(button('Certo: Nome do fundador do Judô'));
      await user.click(button('Certo: Professor'));
      await waitFor(() => {
        expect(answerOf(PROFESSOR)).toBeUndefined();
      });
      await waitFor(() => {
        expect(answerOf(FOUNDER)?.correct).toBe(true);
      });
      expect(answerOf(PARAR)?.correct).toBe(true);
      expect([...writes].sort()).toEqual([
        'DELETE Professor',
        'PUT Fundador true',
        'PUT Parar true',
      ]);
    });

    it('rn006 takes a new tap at once after a refusal put the item back', async () => {
      let refuse = true;
      server.use(
        http.put(ANSWER_URL, () =>
          refuse
            ? HttpResponse.json({ message: 'Requisição inválida' }, { status: 400 })
            : undefined,
        ),
      );
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await screen.findByRole('alert');
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');

      // Same button, same instant (the clock did not move): the item changed meanwhile.
      refuse = false;
      await user.click(button('Certo: Parar'));
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(true);
      });
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });

    it('rn006 keeps the window when the buttons remount (tab change)', async () => {
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await user.click(screen.getByRole('tab', { name: /^Prático/ }));
      await user.click(screen.getByRole('tab', { name: /^Teórico/ }));
      await user.click(button('Certo: Parar'));
      await settled(['PUT Parar true']);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('keyboard', () => {
    it('rn006 marks once while Enter is held down', async () => {
      await openHelena();
      const user = userHoldingKeys();
      button('Certo: Parar').focus();
      await user.keyboard('{Enter>6/}');
      await settled(['PUT Parar true']);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Certo: Parar')).toHaveFocus();
    });

    it('rn006 drops only the repeated Enter, not the first one', async () => {
      await openHelena();
      const certo = button('Certo: Parar');
      expect(fireEvent.keyDown(certo, { key: 'Enter', repeat: true })).toBe(false);
      expect(fireEvent.keyDown(certo, { key: 'Enter' })).toBe(true);
      expect(fireEvent.keyDown(certo, { key: ' ', repeat: true })).toBe(true);
    });

    it('rn006 takes the mark off with Enter pressed again after the window', async () => {
      const { user } = await openHelena();
      button('Certo: Parar').focus();
      await user.keyboard('{Enter}');
      later(DOUBLE_TAP_MS);
      await user.keyboard('{Enter}');
      await settled(['PUT Parar true', 'DELETE Parar']);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
      expect(answerOf(PARAR)).toBeUndefined();
    });

    it('rn006 marks once while Space is held down (it clicks when released)', async () => {
      await openHelena();
      const user = userHoldingKeys();
      button('Certo: Parar').focus();
      await user.keyboard('[Space>6/]');
      await settled(['PUT Parar true']);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });
  });
});
