/**
 * § 6.4 exam of a student (RN006, § 6.7), card #185: when the queue order (`markQueue.ts`)
 * moves on the screen.
 *
 * - The order on the screen waits while the examiner marks: each mark (and "Tentar de novo")
 *   starts a wait of `MOVE_DELAY_MS` again, and the order also waits while a mark is on its way
 *   (the item slides only once the API took it). Then every item that changed place slides at
 *   once. So the list never moves under a finger marking items in a row, and an item never
 *   slides to the end to come back when its mark is refused.
 * - While a refusal notice is open, the whole order stays still: no item and no category
 *   changes place, even when a reload shows a mark saved after all (network, 504). The
 *   examiner deals with the error with nothing moving on the screen. The changes waiting take
 *   place when the notice closes ("Fechar", or "Tentar de novo" once the mark is saved), with
 *   the same slide, tap guard, focus and announcement.
 * - Without a wait, the order follows the data at once (a reload brings another examiner's
 *   marks). A reload during a wait changes the marks shown, never the order.
 * - After the order moves, a pointer tap on the Certo/Errado of an item that changed place is
 *   ignored during the slide and `DOUBLE_TAP_MS` after it (`settling`): the second tap of a
 *   double tap, or a tap already on its way, never lands on an item it was not aimed at.
 * - The live region speaks only of the items this examiner marked whose mark stayed (the item
 *   shows the mark last wanted): a refused mark, back to the API state, is not "desmarcado".
 * - A read-only exam keeps the sheet order (§ 6.4: nothing to mark, nothing moves).
 *
 * The slide and the focus are done by `QueueMotion` with `move`; the live region text is
 * `announcement`.
 */
import { useReducedMotion } from '@mantine/hooks';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ExamSheetItem, RequirementKind } from '../../api/types';
import { groupByCategory, itemsOfKind, markState, type MarkState } from './examModel';
import { DOUBLE_TAP_MS } from './markClickGuard';
import {
  MOVE_DELAY_MS,
  SLIDE_MS,
  firstOpenItem,
  inQueueOrder,
  moveAnnouncement,
  movedItems,
  queueOrder,
  sameOrder,
} from './markQueue';
import type { MarkFailure } from './useExamMarking';

/** A change of the order on the screen. */
export interface QueueMove {
  /** A new one for each change. */
  id: number;
  /** Items of the tab that changed place. */
  moved: ReadonlySet<string>;
  /** Of those, the ones last marked with the keyboard: their focus goes to `firstOpen`. */
  keyboard: ReadonlySet<string>;
  /** First item of the tab still without a mark, after the change. */
  firstOpen: string | null;
  /** Slide the items (not with reduced motion). */
  slide: boolean;
}

/** What the polite live region says; a new `id` is read out again, even with the same text. */
export interface QueueAnnouncement {
  id: number;
  text: string;
}

/** The last mark this examiner wanted for an item, and whether it came from the keyboard. */
interface OwnMark {
  state: MarkState;
  byKeyboard: boolean;
}

interface QueueView {
  /** Ids of every item in the order on the screen. */
  order: readonly string[];
  /** Items marked since the order last moved. */
  marks: ReadonlyMap<string, OwnMark>;
  move: QueueMove | null;
  announcement: QueueAnnouncement | null;
}

export interface MarkQueueOptions {
  /** Items as shown (with the marks on their way), in sheet order. */
  items: readonly ExamSheetItem[];
  /** The exam takes marks; when read-only, the sheet order. */
  active: boolean;
  /** No mark on its way. */
  settled: boolean;
  /** The refusal notice on the screen: while there is one, the order stays still. */
  failure: MarkFailure | null;
  /** The tab, the filter and the items kept under it: which items are on the screen. */
  kind: RequirementKind;
  onlyUnmarked: boolean;
  keep: ReadonlySet<string>;
}

export interface MarkQueue {
  /** Items in the order on the screen. */
  items: readonly ExamSheetItem[];
  move: QueueMove | null;
  announcement: QueueAnnouncement | null;
  /**
   * A mark of this examiner (or "Tentar de novo"), with the state it asks for: the order waits
   * `MOVE_DELAY_MS` again. `byKeyboard`: Space or Enter, not a pointer.
   */
  marked: (itemId: string, state: MarkState, byKeyboard: boolean) => void;
  /** A pointer tap on this item's Certo/Errado is ignored: it, or what is around it, moved. */
  settling: (itemId: string) => boolean;
}

const NO_MARKS: ReadonlyMap<string, OwnMark> = new Map();

/** The items of the tab on the screen, in `order`. */
function shownGroups(
  items: readonly ExamSheetItem[],
  order: readonly string[],
  kind: RequirementKind,
  onlyUnmarked: boolean,
  keep: ReadonlySet<string>,
) {
  return groupByCategory(itemsOfKind(inQueueOrder(items, order), kind), onlyUnmarked, keep);
}

/** The marks of `marks` the items show (the API kept them), among the items in `ids`. */
function marksThatStayed(
  items: readonly ExamSheetItem[],
  marks: ReadonlyMap<string, OwnMark>,
  ids: ReadonlySet<string>,
): Map<string, OwnMark> {
  const stayed = new Map<string, OwnMark>();
  for (const item of items) {
    const mark = marks.get(item.id);
    if (mark !== undefined && ids.has(item.id) && markState(item) === mark.state) {
      stayed.set(item.id, mark);
    }
  }
  return stayed;
}

export function useMarkQueue({
  items,
  active,
  settled,
  failure,
  kind,
  onlyUnmarked,
  keep,
}: MarkQueueOptions): MarkQueue {
  const slide = !useReducedMotion();

  const [view, setView] = useState<QueueView>(() => ({
    order: queueOrder(items),
    marks: NO_MARKS,
    move: null,
    announcement: null,
  }));

  // The wait after a mark: `key` starts it again, `running` ends when it runs out.
  const [wait, setWait] = useState({ key: 0, running: false });
  useEffect(() => {
    if (!wait.running) return;
    const timer = window.setTimeout(() => {
      setWait((current) => (current.key === wait.key ? { ...current, running: false } : current));
    }, MOVE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [wait.key, wait.running]);
  const held = wait.running || !settled || failure !== null;

  let current = view;
  if (active && !held) {
    const target = queueOrder(items);
    if (!sameOrder(view.order, target)) {
      // The order moves: worked out while rendering, so the screen never shows it half done.
      const before = shownGroups(items, view.order, kind, onlyUnmarked, keep);
      const after = shownGroups(items, target, kind, onlyUnmarked, keep);
      const moved = movedItems(before, after);
      const own = marksThatStayed(items, view.marks, moved);
      const text = moveAnnouncement(before, after, new Set(own.keys()));
      current = {
        order: target,
        marks: NO_MARKS,
        move:
          moved.size === 0
            ? view.move
            : {
                id: (view.move?.id ?? 0) + 1,
                moved,
                keyboard: new Set([...own].filter(([, mark]) => mark.byKeyboard).map(([id]) => id)),
                firstOpen: firstOpenItem(after),
                slide,
              },
        announcement:
          text === '' ? view.announcement : { id: (view.announcement?.id ?? 0) + 1, text },
      };
      setView(current);
    } else if (view.marks.size > 0) {
      // Nothing moved (an item already at its place, the last one of its category): the wait
      // is over and its marks are forgotten.
      current = { ...view, marks: NO_MARKS };
      setView(current);
    }
  }

  // Taps on the items that changed place are ignored during the slide and the double tap
  // window after it. A ref: read by the click handlers only.
  const settlingIds = useRef<ReadonlySet<string>>(new Set());
  const { move } = current;
  useLayoutEffect(() => {
    if (move === null) return;
    settlingIds.current = new Set([...settlingIds.current, ...move.moved]);
    const timer = window.setTimeout(
      () => {
        settlingIds.current = new Set();
      },
      (move.slide ? SLIDE_MS : 0) + DOUBLE_TAP_MS,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [move]);

  const marked = (itemId: string, state: MarkState, byKeyboard: boolean) => {
    setView((now) => ({ ...now, marks: new Map(now.marks).set(itemId, { state, byKeyboard }) }));
    setWait((now) => ({ key: now.key + 1, running: true }));
  };

  const settling = useCallback((itemId: string) => settlingIds.current.has(itemId), []);

  return {
    items: active ? inQueueOrder(items, current.order) : items,
    move,
    announcement: current.announcement,
    marked,
    settling,
  };
}
