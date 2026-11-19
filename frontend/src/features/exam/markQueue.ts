/**
 * § 6.4 exam of a student (RN006), card #185: a marked item goes to the end of the queue, so
 * the top of each tab always shows an item still open while there is one.
 *
 * - Inside each category the open items come first and the marked ones after, both in sheet
 *   order. A category with every item marked goes to the end of the tab, after the ones with
 *   some item open; the categories keep the sheet order among themselves. The order depends
 *   on the data only (`queueOrder`): the same after a reload, or when another examiner marks.
 * - The counts ("x/N" of each category, "marcados/total" of the tabs) do not change.
 * - When the order moves on the screen (`useMarkQueue`): a marked item shows its mark in place
 *   for `MOVE_DELAY_MS`, then slides for `SLIDE_MS` (no slide with reduced motion).
 *
 * Pure functions here; the timing, the focus and the slide live in `useMarkQueue` and
 * `QueueMotion`.
 */
import type { ExamSheetItem } from '../../api/types';
import { MARK_LABELS, REQUIREMENT_KINDS, markState, type CategoryGroup } from './examModel';

/** How long a marked item shows its mark in place before it slides to the end. */
export const MOVE_DELAY_MS = 1000;

/** How long the slide lasts (none with `prefers-reduced-motion`). */
export const SLIDE_MS = 250;

/** Whether an item counts as open for the queue (by default: it has no mark). */
export type IsOpen = (item: ExamSheetItem) => boolean;

/** The default `IsOpen`: the item has no mark. */
export const hasNoMark: IsOpen = (item) => item.answer === null;

/**
 * Ids of every item in queue order, kind by kind: in each category the open items, then the
 * marked ones (both in sheet order); the categories with some item open first, then the
 * complete ones (both in sheet order, a category where its first item is).
 */
export function queueOrder(items: readonly ExamSheetItem[], isOpen: IsOpen = hasNoMark): string[] {
  const ids: string[] = [];
  for (const kind of REQUIREMENT_KINDS) {
    const categories = new Map<string, ExamSheetItem[]>();
    for (const item of items) {
      if (item.kind !== kind) continue;
      const category = categories.get(item.category);
      if (category) category.push(item);
      else categories.set(item.category, [item]);
    }
    const withOpen: string[] = [];
    const complete: string[] = [];
    for (const all of categories.values()) {
      const open = all.filter(isOpen);
      const marked = all.filter((item) => !isOpen(item));
      (open.length > 0 ? withOpen : complete).push(...[...open, ...marked].map((item) => item.id));
    }
    ids.push(...withOpen, ...complete);
  }
  return ids;
}

/** The items sorted by `order` (ids); items it does not list go at the end, in sheet order. */
export function inQueueOrder(
  items: readonly ExamSheetItem[],
  order: readonly string[],
): ExamSheetItem[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, rank: rank.get(item.id) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Place of each item shown in a tab: index of its category and its index in the tab. */
function placesOf(groups: readonly CategoryGroup[]): Map<string, string> {
  const places = new Map<string, string>();
  let index = 0;
  for (const [category, group] of groups.entries()) {
    for (const item of group.items) {
      places.set(item.id, `${category}:${index}`);
      index += 1;
    }
  }
  return places;
}

/**
 * Items shown in both lists whose place changed: their index in the tab, or the place of
 * their category (every item of a category that moved is somewhere else on the screen).
 */
export function movedItems(
  before: readonly CategoryGroup[],
  after: readonly CategoryGroup[],
): Set<string> {
  const was = placesOf(before);
  const moved = new Set<string>();
  for (const [id, place] of placesOf(after)) {
    const previous = was.get(id);
    if (previous !== undefined && previous !== place) moved.add(id);
  }
  return moved;
}

/** The first item shown without a mark, or null when every item shown is marked. */
export function firstOpenItem(groups: readonly CategoryGroup[]): string | null {
  for (const group of groups) {
    const open = group.items.find((item) => item.answer === null);
    if (open) return open.id;
  }
  return null;
}

function itemPhrase(item: ExamSheetItem): string {
  const state = markState(item);
  return state === 'unmarked'
    ? `${item.description} desmarcado, movido para os itens em aberto de ${item.category}`
    : `${item.description} marcado como ${MARK_LABELS[state].toLowerCase()}, movido para o fim de ${item.category}`;
}

/**
 * What the live region says when the order moved (§ 6.7): each of `ids` that changed place,
 * with its mark and where it went, in the order of the screen; and the category it left
 * complete, when it went to the end of the tab. Empty when none of `ids` moved.
 */
export function moveAnnouncement(
  before: readonly CategoryGroup[],
  after: readonly CategoryGroup[],
  ids: ReadonlySet<string>,
): string {
  const moved = movedItems(before, after);
  const placeBefore = new Map(before.map((group, index) => [group.category, index]));
  const phrases: string[] = [];
  for (const [index, group] of after.entries()) {
    const own = group.items.filter((item) => ids.has(item.id) && moved.has(item.id));
    if (own.length === 0) continue;
    phrases.push(...own.map(itemPhrase));
    const wentToEnd = placeBefore.get(group.category) !== index;
    if (group.marked === group.total && wentToEnd) {
      phrases.push(`Categoria ${group.category} completa, movida para o fim da aba`);
    }
  }
  return phrases.length === 0 ? '' : `${phrases.join('. ')}.`;
}
