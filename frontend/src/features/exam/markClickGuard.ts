/**
 * § 6.4 marking (RN006): Certo/Errado must not undo themselves by accident.
 *
 * - A double tap on the phone hits the same button twice: the second tap would take off the
 *   mark the first one just made. A click on the same button of the same item less than
 *   `DOUBLE_TAP_MS` after the last accepted click on that item is ignored, while the item
 *   still shows what that click made of it.
 * - The window is about the same button only: Certo and then Errado on the same item is a
 *   change of mind and always counts, and so does Certo again after it (the last accepted
 *   click on the item is Errado by then). Other items are never affected.
 * - When the item changed meanwhile by other means (a refused mark put it back, a reload
 *   brought another examiner's mark), the click is a new intent and counts: the examiner who
 *   sees the refusal and taps Certo again at once is not ignored.
 * - An ignored click does not move the window: it counts from the last accepted click.
 * - The Enter key held down repeats `keydown`, and each one clicks a focused button. Those
 *   repeats are dropped in `MarkButtons` (`preventMarkKeyRepeat`); the Space key clicks only
 *   when released, so holding it clicks once.
 * - A tap that takes the refusal notice away ("Fechar aviso", "Tentar de novo") would move
 *   the list up under the finger, and the second tap of a double tap land on a Certo/Errado
 *   never aimed at: the exam screen keeps the space of the notice for `DOUBLE_TAP_MS`
 *   (`ExamPage.tsx`), so that tap lands on the empty space.
 * - The time of a click is the `timeStamp` of its event: in the browser it counts from the
 *   page load and never goes back when the system clock is set, unlike `Date.now()`. In the
 *   tests (jsdom) it is `Date.now()` of the moment the event was made, so `vi.setSystemTime`
 *   still drives it. Without it (a call made by code), the guard asks its own clock.
 *
 * The last accepted click of each item lives in a ref of the exam screen (`ExamContent`),
 * not of the buttons: the buttons remount when the tab or the "Só não marcados" filter
 * changes, and the screen remounts only for another exam (the same item ids come back for
 * the next student of the same belt, and must start clean).
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';

import type { MarkState } from './examModel';

/** A second click on the same button sooner than this is taken as a double tap. */
export const DOUBLE_TAP_MS = 500;

export type MarkChoice = 'correct' | 'wrong';

/** The last click on an item that counted. */
export interface AcceptedMarkClick {
  choice: MarkChoice;
  /** What the click made of the item. */
  made: MarkState;
  /** Time of the click, in ms (`timeStamp` of its event). */
  at: number;
}

/** A click on one of the buttons of an item. */
export interface MarkClick {
  choice: MarkChoice;
  /** What the item shows when clicked. */
  current: MarkState;
  /** Time of the click, in ms (`timeStamp` of its event). */
  at: number;
}

/**
 * Whether `click` repeats the last accepted click on the same item: same button, the item
 * still as that click left it, and sooner than `DOUBLE_TAP_MS`. A clock that went back
 * (`at` before the accepted one) never blocks a click.
 */
export function isDoubleTap(last: AcceptedMarkClick | undefined, click: MarkClick): boolean {
  if (last === undefined || last.choice !== click.choice || last.made !== click.current) {
    return false;
  }
  const elapsed = click.at - last.at;
  return elapsed >= 0 && elapsed < DOUBLE_TAP_MS;
}

/**
 * `true` when the click counts (and is remembered with what it makes of the item, `next`),
 * `false` for a double tap. `at` is the `timeStamp` of the click event.
 */
export type AcceptMarkClick = (
  itemId: string,
  choice: MarkChoice,
  current: MarkState,
  next: MarkState,
  at?: number,
) => boolean;

/** Same origin as `Event.timeStamp` in the browser, and monotonic. */
const pageNow = () => performance.now();

/**
 * The click filter of one exam screen; `now` is the clock of a click that comes without its
 * time (`at`), for tests.
 */
export function useMarkClickGuard(now: () => number = pageNow): AcceptMarkClick {
  const accepted = useRef(new Map<string, AcceptedMarkClick>());
  return useCallback(
    (itemId, choice, current, next, clickedAt) => {
      const at = clickedAt ?? now();
      if (isDoubleTap(accepted.current.get(itemId), { choice, current, at })) return false;
      accepted.current.set(itemId, { choice, made: next, at });
      return true;
    },
    [now],
  );
}

/** Enter held down on a Certo/Errado button: only the first press clicks. */
export function preventMarkKeyRepeat(event: KeyboardEvent<HTMLElement>) {
  if (event.key === 'Enter' && event.repeat) event.preventDefault();
}
