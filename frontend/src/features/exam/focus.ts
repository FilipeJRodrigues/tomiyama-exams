/**
 * The one rule for moving the focus on the exam screen (§ 6.7): the focus only moves when it
 * is lost. Wherever the user put it (the trail, a tab, another button), it stays.
 *
 * The focus is lost when `document.activeElement` is null or the body, when it is an element
 * no longer in the document, or when it is inside an element the caller says is going away
 * (the decision dialog closing, the notice whose close button was just pressed).
 */

import { useEffect } from 'react';

type Candidate = Element | null | undefined;

export interface FocusIfLostOptions {
  /** Elements about to leave the screen: a focus inside one of them counts as lost. */
  leaving?: readonly Candidate[];
  /** Default: scroll only when the target is not fully in the viewport. */
  preventScroll?: boolean;
}

/** Whether the focus is lost: on the page, on a removed element or inside a leaving one. */
export function focusIsLost(leaving: readonly Candidate[] = []): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || !active.isConnected) return true;
  return leaving.some((element) => element instanceof Element && element.contains(active));
}

function canTakeFocus(element: Candidate): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && element !== document.body;
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Whether the element is fully in view, out of the scroll padding of the page: the exam
 * screen sets it to the fixed header at the top and the fixed summary bar at the bottom
 * (`useScrollPadding`), so a target under one of them counts as hidden and is scrolled to,
 * and the browser scrolls it clear of them.
 */
function inViewport(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const root = document.documentElement;
  const height = window.innerHeight || root.clientHeight;
  const style = window.getComputedStyle(root);
  const top = pixels(style.scrollPaddingTop);
  const bottom = height - pixels(style.scrollPaddingBottom);
  return rect.top >= top && rect.bottom <= bottom;
}

/**
 * Moves the focus to the first target still on the screen, only when the focus is lost (see
 * `focusIsLost`). Returns whether it moved.
 */
export function focusIfLost(
  targets: Candidate | readonly Candidate[],
  options: FocusIfLostOptions = {},
): boolean {
  if (!focusIsLost(options.leaving)) return false;
  const list: readonly Candidate[] = Array.isArray(targets) ? targets : [targets as Candidate];
  const target = list.find(canTakeFocus);
  if (target === undefined) return false;
  target.focus({ preventScroll: options.preventScroll ?? inViewport(target) });
  return document.activeElement === target;
}

/**
 * Clear of the fixed header when the focus scrolls a target into view (§ 6.7). For
 * `useScrollPadding('top', ...)` on the screens under the app header.
 */
export const HEADER_SCROLL_PADDING =
  'calc(var(--app-shell-header-offset, 60px) + var(--mantine-spacing-xs))';

type ScrollPaddingEdge = 'scrollPaddingTop' | 'scrollPaddingBottom';

/**
 * Keeps one edge of the page's scroll padding (a CSS length) while the caller is on the
 * screen: what is fixed over the page (the header, the phone summary bar) is left out both
 * by the browser when the focus scrolls a target into view and by `focusIfLost`.
 */
export function useScrollPadding(edge: 'top' | 'bottom', value: string | null): void {
  useEffect(() => {
    if (value === null) return;
    const property: ScrollPaddingEdge = edge === 'top' ? 'scrollPaddingTop' : 'scrollPaddingBottom';
    const style = document.documentElement.style;
    style[property] = value;
    return () => {
      style[property] = '';
    };
  }, [edge, value]);
}
