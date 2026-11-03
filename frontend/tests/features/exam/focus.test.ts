import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { focusIfLost, focusIsLost } from '../../../src/features/exam/focus';

function button(label: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = label;
  document.body.append(element);
  return element;
}

function heading(): HTMLHeadingElement {
  const element = document.createElement('h1');
  element.tabIndex = -1;
  element.textContent = 'Helena Prado';
  document.body.append(element);
  return element;
}

describe('focusIfLost: the focus only moves when it is lost (§ 6.7)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('moves the focus when it is on the body', () => {
    const title = heading();
    expect(document.activeElement).toBe(document.body);
    expect(focusIfLost(title)).toBe(true);
    expect(title).toHaveFocus();
  });

  it('moves the focus when the focused element left the document', () => {
    const gone = button('Aprovar');
    const title = heading();
    gone.focus();
    gone.remove();
    expect(focusIsLost()).toBe(true);
    expect(focusIfLost(title)).toBe(true);
    expect(title).toHaveFocus();
  });

  it('keeps a focus the user put on a valid element', () => {
    const link = button('Dia do exame');
    const title = heading();
    link.focus();
    expect(focusIfLost(title)).toBe(false);
    expect(link).toHaveFocus();
  });

  it('moves the focus out of an element the caller says is going away', () => {
    const notice = document.createElement('div');
    const close = document.createElement('button');
    close.textContent = 'Fechar aviso';
    notice.append(close);
    document.body.append(notice);
    const title = heading();
    close.focus();
    expect(focusIfLost(title, { leaving: [notice] })).toBe(true);
    expect(title).toHaveFocus();
  });

  it('keeps the focus when it is outside the elements going away', () => {
    const notice = document.createElement('div');
    document.body.append(notice);
    const link = button('Dia do exame');
    const title = heading();
    link.focus();
    expect(focusIfLost(title, { leaving: [notice, null] })).toBe(false);
    expect(link).toHaveFocus();
  });

  it('does nothing when there is no target on the screen', () => {
    const detached = document.createElement('h1');
    expect(focusIfLost(null)).toBe(false);
    expect(focusIfLost(undefined)).toBe(false);
    expect(focusIfLost([null, detached])).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('takes the first target still on the screen', () => {
    const detached = button('Aprovar');
    detached.remove();
    const title = heading();
    expect(focusIfLost([detached, null, title])).toBe(true);
    expect(title).toHaveFocus();
  });

  it('does not scroll to a target already in the viewport, and scrolls to one outside', () => {
    const title = heading();
    const focus = vi.spyOn(title, 'focus');
    focusIfLost(title);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });

    title.blur();
    vi.spyOn(title, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: -400, width: 100, height: 40 }),
    );
    focusIfLost(title);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });
  });

  it('counts a target under the fixed header or the bottom bar as out of view', () => {
    const title = heading();
    const focus = vi.spyOn(title, 'focus');
    // What `useScrollPadding` sets on the exam screen.
    const root = document.documentElement.style;
    root.scrollPaddingTop = '70px';
    root.scrollPaddingBottom = '120px';
    onTestFinished(() => {
      root.scrollPaddingTop = '';
      root.scrollPaddingBottom = '';
    });
    const rect = vi.spyOn(title, 'getBoundingClientRect');

    rect.mockReturnValue(DOMRect.fromRect({ x: 0, y: 20, width: 100, height: 40 }));
    focusIfLost(title);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });

    title.blur();
    rect.mockReturnValue(
      DOMRect.fromRect({ x: 0, y: window.innerHeight - 100, width: 100, height: 40 }),
    );
    focusIfLost(title);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });

    title.blur();
    rect.mockReturnValue(DOMRect.fromRect({ x: 0, y: 200, width: 100, height: 40 }));
    focusIfLost(title);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });
});
