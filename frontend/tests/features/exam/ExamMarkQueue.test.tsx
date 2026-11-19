/**
 * § 6.4 exam of a student (RN006, § 6.7), card #185: a marked item goes to the end of its
 * category, so the top of the tab always shows an item still open while there is one.
 *
 * - Inside each category the open items come first and the marked ones after, both in sheet
 *   order; a category with every item marked goes to the end of the tab. "x/N" and the
 *   "marcados/total" of the tabs do not change.
 * - A marked item shows its mark in place for `MOVE_DELAY_MS`, then slides to the end. Any
 *   mark during the wait starts it again, so the list never moves while the examiner marks.
 * - After the move, a tap on an item that changed place is ignored during the slide and for
 *   `DOUBLE_TAP_MS` after it: the second tap of a double tap never lands on another item.
 * - The keyboard focus goes to the first open item; the focus is never left on the page.
 *
 * Helena (open event, Marrom, exam in progress): Teórico — Vocabulário: Professor certo,
 * Parar não marcado; Histórico: Nome do fundador do Judô não marcado. Prático — Fundamentos:
 * both marked; Naguewaza: Deashi barai and Osoto gari não marcados.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { DOUBLE_TAP_MS } from '../../../src/features/exam/markClickGuard';
import { MOVE_DELAY_MS, SLIDE_MS } from '../../../src/features/exam/markQueue';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setReducedMotion } from '../../viewport';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const FOUNDER = mockRequirementId('Marrom', 7);
const DEASHI = mockRequirementId('Marrom', 3);
const FOUNDER_NAME = 'Nome do fundador do Judô';

const NAMES: Record<string, string> = {
  [PARAR]: 'Parar',
  [FOUNDER]: 'Fundador',
  [DEASHI]: 'Deashi',
  [mockRequirementId('Marrom', 1)]: 'Saudação em pé',
  [mockRequirementId('Marrom', 4)]: 'Osoto',
};

let db: MockDb;
/** Writes that reached the API, in order: `PUT Parar true` or `DELETE Parar`. */
let writes: string[] = [];

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

/** Items of the tab on the screen, top to bottom, by description. */
function itemOrder(): string[] {
  return screen
    .getAllByRole('group', { name: /^Marcação: / })
    .map((group) => group.getAttribute('aria-label')!.replace('Marcação: ', ''));
}

/** Categories of the tab on the screen, top to bottom, with their "x/N". */
function categoryOrder(): string[] {
  return screen
    .getAllByRole('region', { name: /\d+\/\d+$/ })
    .map((region) => within(region).getByRole('heading').textContent);
}

/** From here on the clock (`setTimeout` and `Date`) moves only when the test says so. */
function stopTheClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });
}

/** `ms` go by: timers due run, and the answers of the API come back meanwhile. */
async function passes(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A finger tap: the button takes the focus, as in Chrome, and the click has `detail` 1. */
function tap(name: string) {
  const target = button(name);
  act(() => {
    target.focus();
  });
  fireEvent.click(target, { detail: 1 });
}

/** Space or Enter on a focused button: a click with `detail` 0. */
function press(name: string) {
  const target = button(name);
  act(() => {
    target.focus();
  });
  fireEvent.click(target, { detail: 0 });
}

function pressed(name: string) {
  return button(name).getAttribute('aria-pressed') === 'true';
}

const THEORY_AT_START = ['Parar', 'Professor', FOUNDER_NAME];
const THEORY_AFTER_PARAR = [FOUNDER_NAME, 'Professor', 'Parar'];

describe('marked items go to the end of the queue (§ 6.4, RN006, #185)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, 'animate');
  });

  describe('order', () => {
    it('rn006 opens with the open items first and the complete categories last', async () => {
      const { user } = await openHelena();
      expect(categoryOrder()).toEqual(['Vocabulário 1/2', 'Histórico 0/1']);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      expect(screen.getByRole('tab', { name: /^Teórico 1\/3$/ })).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: /^Prático 2\/4$/ }));
      expect(categoryOrder()).toEqual(['Naguewaza 0/2', 'Fundamentos 2/2']);
      expect(itemOrder()).toEqual([
        'Deashi barai',
        'Osoto gari',
        'Demonstrar saudação em pé',
        'Demonstrar saudação ajoelhado',
      ]);
    });

    it('rn006 takes the order from the data when the exam reloads (another examiner)', async () => {
      await openHelena();
      db.answers.push({
        exam_id: helenaExam().id,
        requirement_id: PARAR,
        correct: true,
        marked_by: 'mock-examiner-2',
        marked_at: '2026-11-21T13:40:00+00:00',
      });
      await act(async () => {
        window.dispatchEvent(new Event('visibilitychange'));
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      expect(categoryOrder()).toEqual(['Histórico 0/1', 'Vocabulário 2/2']);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
    });

    it('rn010 keeps the sheet order of a read-only exam', async () => {
      db.events = db.events.map((event) =>
        event.id === OPEN ? { ...event, status: 'CLOSED' } : event,
      );
      await openHelena();
      const vocabulary = screen.getByRole('region', { name: /^Vocabulário/ });
      expect(
        within(vocabulary)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        'ProfessorResposta esperada: SenseiCerto',
        'PararResposta esperada: MateNão marcado',
      ]);
    });
  });

  describe('when the item moves', () => {
    it('rn006 shows the mark for about a second, then moves the item to the end', async () => {
      await openHelena();
      stopTheClock();
      tap('Certo: Parar');

      await passes(MOVE_DELAY_MS - 1);
      expect(pressed('Certo: Parar')).toBe(true);
      expect(answerOf(PARAR)?.correct).toBe(true);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      // The counts move at once, as before.
      expect(screen.getByRole('tab', { name: /^Teórico 2\/3$/ })).toBeInTheDocument();
      expect(categoryOrder()).toEqual(['Vocabulário 2/2', 'Histórico 0/1']);

      await passes(1);
      expect(categoryOrder()).toEqual(['Histórico 0/1', 'Vocabulário 2/2']);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(pressed('Certo: Parar')).toBe(true);
      expect(screen.getByRole('tab', { name: /^Teórico 2\/3$/ })).toBeInTheDocument();
    });

    it('rn006 a change of mind on the same item during the wait counts and starts it again', async () => {
      await openHelena();
      stopTheClock();
      tap('Certo: Parar');
      await passes(600);
      tap('Errado: Parar');
      expect(pressed('Errado: Parar')).toBe(true);

      await passes(MOVE_DELAY_MS - 1);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      await passes(1);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(pressed('Errado: Parar')).toBe(true);
      expect(writes).toEqual(['PUT Parar true', 'PUT Parar false']);
    });

    it('rn006 keeps the list still while other items are marked, then moves them together', async () => {
      await openHelena();
      stopTheClock();
      tap('Certo: Parar');
      await passes(500);
      tap(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(true);

      await passes(MOVE_DELAY_MS - 1);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      await passes(1);
      expect(categoryOrder()).toEqual(['Vocabulário 2/2', 'Histórico 1/1']);
      expect(itemOrder()).toEqual(['Professor', 'Parar', FOUNDER_NAME]);
      expect(writes).toEqual(['PUT Parar true', 'PUT Fundador true']);
    });

    it('rn006 a reload in the middle of the wait does not move the list', async () => {
      await openHelena();
      stopTheClock();
      tap('Certo: Parar');
      await passes(100);
      // Another examiner marks the founder; the window gets the focus back.
      db.answers.push({
        exam_id: helenaExam().id,
        requirement_id: FOUNDER,
        correct: true,
        marked_by: 'mock-examiner-2',
        marked_at: '2026-11-21T13:40:00+00:00',
      });
      act(() => {
        window.dispatchEvent(new Event('visibilitychange'));
      });
      await passes(300);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(true);
      expect(itemOrder()).toEqual(THEORY_AT_START);

      await passes(MOVE_DELAY_MS - 400);
      expect(categoryOrder()).toEqual(['Vocabulário 2/2', 'Histórico 1/1']);
      expect(itemOrder()).toEqual(['Professor', 'Parar', FOUNDER_NAME]);
    });
  });

  describe('taps right after the move', () => {
    it('rn006 ignores a tap on the item that moved up into the place, until the window ends', async () => {
      await openHelena();
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS);
      expect(itemOrder()[0]).toBe(FOUNDER_NAME);

      tap(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(false);
      await passes(SLIDE_MS + DOUBLE_TAP_MS - 1);
      tap(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(false);

      await passes(1);
      tap(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(true);
      await passes(100);
      expect(writes).toEqual(['PUT Parar true', 'PUT Fundador true']);
    });

    it('rn006 ignores a tap on the item that moved down too, and takes one on an item that stayed', async () => {
      const { user } = await openHelena();
      await user.click(screen.getByRole('tab', { name: /^Prático/ }));
      stopTheClock();
      tap('Certo: Deashi barai');
      await passes(MOVE_DELAY_MS);
      expect(itemOrder().slice(0, 2)).toEqual(['Osoto gari', 'Deashi barai']);

      tap('Certo: Osoto gari');
      tap('Errado: Deashi barai');
      expect(pressed('Certo: Osoto gari')).toBe(false);
      expect(pressed('Certo: Deashi barai')).toBe(true);
      // Fundamentos did not move: the tap counts.
      tap('Errado: Demonstrar saudação em pé');
      expect(pressed('Errado: Demonstrar saudação em pé')).toBe(true);
      await passes(100);
      expect(writes).toEqual(['PUT Deashi true', 'PUT Saudação em pé false']);
    });
  });

  describe('"Só não marcados"', () => {
    it('rn006 moves the marked item to the end of its category and keeps it until the tab changes', async () => {
      const { user } = await openHelena();
      await user.click(screen.getByRole('tab', { name: /^Prático/ }));
      await user.click(screen.getByRole('switch', { name: 'Só não marcados' }));
      expect(itemOrder()).toEqual(['Deashi barai', 'Osoto gari']);
      stopTheClock();
      tap('Certo: Deashi barai');
      await passes(MOVE_DELAY_MS);
      expect(itemOrder()).toEqual(['Osoto gari', 'Deashi barai']);
      expect(categoryOrder()).toEqual(['Naguewaza 1/2']);

      // Still there to be corrected.
      await passes(SLIDE_MS + DOUBLE_TAP_MS);
      tap('Errado: Deashi barai');
      expect(pressed('Errado: Deashi barai')).toBe(true);
      await passes(MOVE_DELAY_MS);
      expect(itemOrder()).toEqual(['Osoto gari', 'Deashi barai']);

      vi.useRealTimers();
      await user.click(screen.getByRole('tab', { name: /^Teórico/ }));
      await user.click(screen.getByRole('tab', { name: /^Prático/ }));
      expect(itemOrder()).toEqual(['Osoto gari']);
    });

    it('rn006 sends a category left with no open item to the end of the tab, still shown', async () => {
      const { user } = await openHelena();
      await user.click(screen.getByRole('switch', { name: 'Só não marcados' }));
      expect(itemOrder()).toEqual(['Parar', FOUNDER_NAME]);
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS);
      expect(categoryOrder()).toEqual(['Histórico 0/1', 'Vocabulário 2/2']);
      expect(itemOrder()).toEqual([FOUNDER_NAME, 'Parar']);

      vi.useRealTimers();
      await user.click(screen.getByRole('switch', { name: 'Só não marcados' }));
      await user.click(screen.getByRole('switch', { name: 'Só não marcados' }));
      expect(itemOrder()).toEqual([FOUNDER_NAME]);
    });
  });

  describe('focus and screen reader (§ 6.7)', () => {
    it('rn006 the keyboard focus goes to the first open item, and stays when none is left', async () => {
      await openHelena();
      stopTheClock();
      press('Certo: Parar');
      await passes(MOVE_DELAY_MS - 1);
      expect(button('Certo: Parar')).toHaveFocus();
      await passes(1);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(button(`Certo: ${FOUNDER_NAME}`)).toHaveFocus();

      // A key press on the item that moved up counts at once.
      fireEvent.click(button(`Certo: ${FOUNDER_NAME}`), { detail: 0 });
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(true);
      await passes(MOVE_DELAY_MS);
      expect(itemOrder()).toEqual(['Professor', 'Parar', FOUNDER_NAME]);
      // No open item left in the tab: the focus stays on the button of the moved item.
      expect(button(`Certo: ${FOUNDER_NAME}`)).toHaveFocus();
      expect(document.activeElement).not.toBe(document.body);
    });

    it('rn006 the focus of a tap stays on the moved button, never on the page', async () => {
      await openHelena();
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(button('Certo: Parar')).toHaveFocus();
    });

    it('announces the move once, politely, without the percentages', async () => {
      await openHelena();
      const live = screen.getByTestId('queue-live');
      expect(live).toHaveAttribute('aria-live', 'polite');
      expect(live).toBeEmptyDOMElement();
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS - 1);
      expect(live).toBeEmptyDOMElement();
      await passes(1);
      expect(live).toHaveTextContent(
        'Parar marcado como certo, movido para o fim de Vocabulário. ' +
          'Categoria Vocabulário completa, movida para o fim da aba.',
      );
      expect(live).not.toHaveTextContent('%');
    });
  });

  describe('refused marks', () => {
    it('rn006 a refused mark puts the item back in place, and it does not move', async () => {
      server.use(
        http.put(ANSWER_URL, () =>
          HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
        ),
      );
      await openHelena();
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS * 2);
      expect(screen.getByRole('alert')).toHaveTextContent('Esta área é dos examinadores');
      expect(pressed('Certo: Parar')).toBe(false);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      expect(button('Certo: Parar')).toHaveFocus();
    });

    it('rn006 a mark that may have been saved stays in place while its notice is open', async () => {
      // The API saves it, but the answer never comes back (network), three times.
      server.use(
        http.put(ANSWER_URL, ({ params }) => {
          if (answerOf(String(params.requirementId)) === undefined) {
            db.answers.push({
              exam_id: helenaExam().id,
              requirement_id: String(params.requirementId),
              correct: true,
              marked_by: 'mock-examiner',
              marked_at: '2026-11-21T13:40:00+00:00',
            });
          }
          return HttpResponse.error();
        }),
      );
      const { user } = await openHelena();
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS * 2);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível confirmar a marcação de "Parar"');
      // The reload shows it saved; it stays where the examiner left it.
      expect(pressed('Certo: Parar')).toBe(true);
      expect(itemOrder()).toEqual(THEORY_AT_START);

      vi.useRealTimers();
      act(() => {
        within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
      });
      await user.keyboard('{Enter}');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(button('Certo: Parar')).toHaveFocus();
    });
  });

  describe('motion', () => {
    /** Each item and category a row of 80 px, in the order of the page. */
    function layOutRows() {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const rows = Array.from(document.querySelectorAll('[data-category], [data-item]'));
        const top = Math.max(rows.indexOf(this), 0) * 80;
        return DOMRect.fromRect({ x: 0, y: top, width: 600, height: 72 });
      });
    }

    function stubAnimate() {
      const animate = vi.fn<(this: Element, ...args: Parameters<Element['animate']>) => unknown>(
        () => ({ cancel: () => undefined }),
      );
      Object.defineProperty(Element.prototype, 'animate', {
        configurable: true,
        writable: true,
        value: animate,
      });
      return animate;
    }

    it('slides the items that change place', async () => {
      const animate = stubAnimate();
      await openHelena();
      layOutRows();
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS - 1);
      expect(animate).not.toHaveBeenCalled();
      await passes(1);

      const parar = button('Certo: Parar').closest('li');
      const slid = animate.mock.contexts;
      expect(slid).toContain(parar);
      const call = animate.mock.calls[slid.indexOf(parar!)]!;
      expect(JSON.stringify(call[0])).toContain('translateY');
      expect(call[1]).toMatchObject({ duration: SLIDE_MS });
    });

    it('swaps without sliding with reduced motion, after the same wait and a shorter window', async () => {
      setReducedMotion(true);
      const animate = stubAnimate();
      await openHelena();
      layOutRows();
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS - 1);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      await passes(1);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(animate).not.toHaveBeenCalled();

      await passes(DOUBLE_TAP_MS - 1);
      tap(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(false);
      await passes(1);
      tap(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(true);
    });
  });
});
