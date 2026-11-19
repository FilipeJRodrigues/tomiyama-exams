import { Component, createRef, type ReactNode } from 'react';

import { focusInView, focusIsLost } from './focus';
import { SLIDE_MS } from './markQueue';
import type { QueueMove } from './useMarkQueue';

interface QueueMotionProps {
  /** The last change of the order (`useMarkQueue`); a new one slides and places the focus. */
  move: QueueMove | null;
  children: ReactNode;
}

/** Where the list was on the screen, and the focus, right before the order changed. */
interface Before {
  categories: Map<string, number>;
  items: Map<string, number>;
  focused: Element | null;
}

const CATEGORY = '[data-category]';
const ITEM = '[data-item]';

function tops(root: HTMLElement, selector: string, key: 'category' | 'item'): Map<string, number> {
  const found = new Map<string, number>();
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    const id = element.dataset[key];
    if (id !== undefined) found.set(id, element.getBoundingClientRect().top);
  }
  return found;
}

/** Starts at `shift` px from its place and slides to it. */
function slideFrom(element: HTMLElement, shift: number) {
  if (Math.abs(shift) < 1 || typeof element.animate !== 'function') return;
  element.animate([{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }], {
    duration: SLIDE_MS,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
  });
}

/**
 * FLIP: each category and item starts where it was and slides to its new place. A category
 * slides as a whole and its items slide inside it, so an item's own shift leaves out the
 * one of its category. Slides still running are dropped first: the places measured before
 * already include them.
 */
function slide(root: HTMLElement, before: Before) {
  const categories = Array.from(root.querySelectorAll<HTMLElement>(CATEGORY));
  const items = Array.from(root.querySelectorAll<HTMLElement>(ITEM));
  for (const element of [...categories, ...items]) {
    if (typeof element.getAnimations !== 'function') continue;
    for (const animation of element.getAnimations()) animation.cancel();
  }
  const categoryShift = new Map<string, number>();
  for (const [category, top] of tops(root, CATEGORY, 'category')) {
    const was = before.categories.get(category);
    if (was !== undefined) categoryShift.set(category, was - top);
  }
  const itemShift = new Map<HTMLElement, number>();
  for (const item of items) {
    const was = item.dataset.item === undefined ? undefined : before.items.get(item.dataset.item);
    if (was === undefined) continue;
    const category = item.closest<HTMLElement>(CATEGORY)?.dataset.category;
    const outer = category === undefined ? 0 : (categoryShift.get(category) ?? 0);
    itemShift.set(item, was - item.getBoundingClientRect().top - outer);
  }
  for (const category of categories) {
    const key = category.dataset.category;
    if (key !== undefined) slideFrom(category, categoryShift.get(key) ?? 0);
  }
  for (const [item, shift] of itemShift) slideFrom(item, shift);
}

/** The first Certo/Errado of an item on the screen. */
function firstButtonOf(root: HTMLElement, itemId: string): HTMLElement | null {
  const item = Array.from(root.querySelectorAll<HTMLElement>(ITEM)).find(
    (element) => element.dataset.item === itemId,
  );
  return item?.querySelector<HTMLElement>('button[data-choice]') ?? null;
}

/**
 * § 6.7, after the order changed. The focus on an item marked with the keyboard that moved
 * goes to the first open item, on its first button (the examiner goes on down the queue);
 * with none left, it stays where it was. Any other focus the change took away (the browser
 * drops the focus of an element moved in the page) goes back to the same element, without
 * scrolling. Never left on the page body.
 */
function placeFocus(root: HTMLElement, move: QueueMove, focused: Element | null) {
  if (!(focused instanceof HTMLElement) || !root.contains(focused)) return;
  const itemId = focused.closest<HTMLElement>(ITEM)?.dataset.item;
  if (itemId !== undefined && move.keyboard.has(itemId) && move.firstOpen !== null) {
    const next = firstButtonOf(root, move.firstOpen);
    if (next !== null) {
      focusInView(next);
      return;
    }
  }
  if (focusIsLost() && focused.isConnected) focused.focus({ preventScroll: true });
}

/**
 * The items of the exam screen, sliding to their new places when the queue order changes
 * (§ 6.4, card #185). The places are measured right before React changes the page
 * (`getSnapshotBeforeUpdate`, which only a class component has), so the slide starts exactly
 * where each item was.
 */
export class QueueMotion extends Component<QueueMotionProps> {
  private readonly root = createRef<HTMLDivElement>();

  override getSnapshotBeforeUpdate(previous: QueueMotionProps): Before | null {
    const root = this.root.current;
    if (root === null || this.props.move === null || this.props.move === previous.move) {
      return null;
    }
    return {
      categories: this.props.move.slide
        ? tops(root, CATEGORY, 'category')
        : new Map<string, number>(),
      items: this.props.move.slide ? tops(root, ITEM, 'item') : new Map<string, number>(),
      focused: document.activeElement,
    };
  }

  override componentDidUpdate(_previous: QueueMotionProps, _state: unknown, before: Before | null) {
    const root = this.root.current;
    const move = this.props.move;
    if (before === null || root === null || move === null) return;
    if (move.slide) slide(root, before);
    placeFocus(root, move, before.focused);
  }

  override render() {
    return <div ref={this.root}>{this.props.children}</div>;
  }
}
