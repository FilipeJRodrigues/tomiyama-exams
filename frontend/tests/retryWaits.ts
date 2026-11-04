/**
 * Test stand-in for `waitForRetry` (`src/features/exam/markRetry.ts`), put in place for the
 * whole suite by `tests/setup.ts`: no test waits the real 0,5 s and 1,5 s before a mark is
 * sent again, and none depends on how fast the machine is.
 *
 * - By default each wait ends at once (a refused mark is tried three times in a row).
 * - `holdRetryWaits()` keeps every wait until the test releases it, to check the screen
 *   during the wait or to act in it (a new click, leaving the screen).
 * - `retryWaits` lists the waits asked for, in order, with their duration.
 */

export interface RetryWait {
  ms: number;
  /** Ends the wait as the timer would (the mark is sent again). */
  release: () => void;
  /** The screen left and the wait was cancelled. */
  aborted: boolean;
}

export const retryWaits: RetryWait[] = [];

let hold = false;

/** From now on, every wait stays until released (or cancelled by the screen). */
export function holdRetryWaits(): RetryWait[] {
  hold = true;
  return retryWaits;
}

/** Back to waits that end at once, with an empty list (after each test). */
export function resetRetryWaits(): void {
  hold = false;
  retryWaits.length = 0;
}

/** Same contract as `waitForRetry`: `true` when the wait ends, `false` when cancelled. */
export function controlledWaitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const wait: RetryWait = {
      ms,
      aborted: false,
      release: () => {
        resolve(!signal.aborted);
      },
    };
    retryWaits.push(wait);
    if (signal.aborted) {
      wait.aborted = true;
      resolve(false);
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        wait.aborted = true;
        resolve(false);
      },
      { once: true },
    );
    if (!hold) wait.release();
  });
}
