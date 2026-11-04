/**
 * § 6.4 (RN006): the waits before a mark refused for a passing reason
 * (`isTransientMarkError`) is sent again. Two more tries, the second one waiting longer, so
 * a busy server gets some room; after them the examiner is told and can try again.
 */

/** Wait before each new try, in order: 0,5 s before the second send, 1,5 s before the third. */
export const MARK_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

/**
 * Resolves `true` after `ms`, or `false` at once when `signal` aborts (the screen left), so
 * nothing is sent afterwards.
 */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
