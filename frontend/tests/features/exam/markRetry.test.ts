/**
 * § 6.4 (RN006): the real wait before a refused mark is sent again. The rest of the suite
 * uses the stand-in of `tests/retryWaits.ts` (see `tests/setup.ts`); here the module itself is
 * checked, with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MarkRetry = typeof import('../../../src/features/exam/markRetry');

const { MARK_RETRY_DELAYS_MS, waitForRetry } = await vi.importActual<MarkRetry>(
  '../../../src/features/exam/markRetry',
);

describe('waitForRetry (rn006 nova tentativa automática)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn006 tries twice more, waiting 0,5 s and then 1,5 s', () => {
    expect(MARK_RETRY_DELAYS_MS).toEqual([500, 1500]);
  });

  it('rn006 ends after the given time', async () => {
    const ended = vi.fn();
    void waitForRetry(500, new AbortController().signal).then(ended);

    await vi.advanceTimersByTimeAsync(499);
    expect(ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ended).toHaveBeenCalledWith(true);
  });

  it('rn006 ends at once with false when the screen leaves, and the timer goes away', async () => {
    const controller = new AbortController();
    const wait = waitForRetry(1500, controller.signal);
    controller.abort();

    await expect(wait).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rn006 does not wait when the screen already left', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitForRetry(500, controller.signal)).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
