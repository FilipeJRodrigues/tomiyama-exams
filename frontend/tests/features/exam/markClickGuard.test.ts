/** § 6.4 (RN006): the double tap filter of Certo/Errado (#49). */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DOUBLE_TAP_MS,
  isDoubleTap,
  useMarkClickGuard,
  type AcceptedMarkClick,
} from '../../../src/features/exam/markClickGuard';

const T0 = 1_000_000;
const CERTO_MADE: AcceptedMarkClick = { choice: 'correct', made: 'correct', at: T0 };

describe('isDoubleTap', () => {
  it('rn006 is a double tap on the same button within the window', () => {
    expect(isDoubleTap(CERTO_MADE, { choice: 'correct', current: 'correct', at: T0 })).toBe(true);
    expect(
      isDoubleTap(CERTO_MADE, {
        choice: 'correct',
        current: 'correct',
        at: T0 + DOUBLE_TAP_MS - 1,
      }),
    ).toBe(true);
  });

  it('rn006 is not one from the end of the window on', () => {
    expect(
      isDoubleTap(CERTO_MADE, { choice: 'correct', current: 'correct', at: T0 + DOUBLE_TAP_MS }),
    ).toBe(false);
  });

  it('rn006 is not one on the other button', () => {
    expect(isDoubleTap(CERTO_MADE, { choice: 'wrong', current: 'correct', at: T0 })).toBe(false);
  });

  it('rn006 is not one when the item changed meanwhile', () => {
    expect(isDoubleTap(CERTO_MADE, { choice: 'correct', current: 'unmarked', at: T0 })).toBe(false);
  });

  it('is not one without an accepted click or with a clock that went back', () => {
    expect(isDoubleTap(undefined, { choice: 'correct', current: 'unmarked', at: T0 })).toBe(false);
    expect(isDoubleTap(CERTO_MADE, { choice: 'correct', current: 'correct', at: T0 - 1 })).toBe(
      false,
    );
  });
});

describe('useMarkClickGuard', () => {
  function guardAt(times: number[]) {
    const clock = [...times];
    const { result } = renderHook(() => useMarkClickGuard(() => clock.shift() ?? 0));
    return result.current;
  }

  it('rn006 counts the window from the last accepted click, not from an ignored one', () => {
    const accept = guardAt([T0, T0 + 300, T0 + 600]);
    expect(accept('parar', 'correct', 'unmarked', 'correct')).toBe(true);
    expect(accept('parar', 'correct', 'correct', 'unmarked')).toBe(false);
    expect(accept('parar', 'correct', 'correct', 'unmarked')).toBe(true);
  });

  it('rn006 takes the time of the click event over its clock (#49)', () => {
    // The clock stands still; the click events say how far apart they are.
    const { result } = renderHook(() => useMarkClickGuard(() => T0));
    const accept = result.current;
    expect(accept('parar', 'correct', 'unmarked', 'correct', 10)).toBe(true);
    expect(accept('parar', 'correct', 'correct', 'unmarked', 10 + DOUBLE_TAP_MS - 1)).toBe(false);
    expect(accept('parar', 'correct', 'correct', 'unmarked', 10 + DOUBLE_TAP_MS)).toBe(true);
  });

  it('rn006 keeps each item apart', () => {
    const accept = guardAt([T0, T0, T0]);
    expect(accept('parar', 'correct', 'unmarked', 'correct')).toBe(true);
    expect(accept('fundador', 'correct', 'unmarked', 'correct')).toBe(true);
    expect(accept('parar', 'correct', 'correct', 'unmarked')).toBe(false);
  });
});

describe('useMarkClickGuard default clock (#49)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rn006 asks performance.now(), not Date.now(), for a click without its time', () => {
    const times = [T0, T0 + 100];
    vi.spyOn(performance, 'now').mockImplementation(() => times.shift() ?? 0);
    const date = vi.spyOn(Date, 'now');
    const { result } = renderHook(() => useMarkClickGuard());
    expect(result.current('parar', 'correct', 'unmarked', 'correct')).toBe(true);
    expect(result.current('parar', 'correct', 'correct', 'unmarked')).toBe(false);
    expect(date).not.toHaveBeenCalled();
  });
});
