import type { FetchStatus } from '@tanstack/react-query';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { focusIfLost } from '../exam/focus';

/** A read of the screen, as `useQuery` returns it: only whether it is on its way matters. */
export interface ScreenRead {
  fetchStatus: FetchStatus;
}

/** Handed to `LoadError`: its "Tentar de novo" and the press of it. */
export interface RetryFocus {
  /** The "Tentar de novo" on the screen, of whichever `LoadError` of the screen shows it. */
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** "Tentar de novo" was pressed: call it before the reads start again. */
  pressed: () => void;
}

/**
 * The focus after "Tentar de novo" of a screen's load error (§ 6.7). Pressing it disables the
 * button while the read goes again (the browser drops the focus on the page body), and a read
 * with no data yet takes the error off the screen until it ends: the button goes away with the
 * focus. Once none of `reads` is on its way, the focus goes to the "Tentar de novo" on the
 * screen (the read failed again, or another read of the screen is still in error), else to
 * `destination` (the data came: the title of the screen, or the place the error took).
 *
 * The one rule of `focusIfLost`: the focus only moves when it is lost, so a focus the user put
 * elsewhere while the screen reloaded stays there. And only after a reload asked by the button:
 * the first load and the reloads in the background (window focus) never move it.
 *
 * Call it in the component that stays on the screen while the error comes and goes (the error
 * itself is unmounted while a read with no data goes again), with the reads whose load error
 * the screen shows, and hand the result to each of its `LoadError`.
 */
export function useRetryFocus(
  reads: readonly ScreenRead[],
  destination: RefObject<HTMLElement | null>,
): RetryFocus {
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** A press waiting for the end of the reads. */
  const asked = useRef(false);
  // A render right after the press, so the end of the reads is seen even if they end before
  // the screen renders them on their way.
  const [, setPresses] = useState(0);
  const loading = reads.some((read) => read.fetchStatus !== 'idle');

  // After every render: the reads end on any of them (the press already started them, so a
  // render after it with no read on its way is the end). Once per press.
  useEffect(() => {
    if (!asked.current || loading) return;
    asked.current = false;
    focusIfLost([buttonRef.current, destination.current]);
  });

  return {
    buttonRef,
    pressed: () => {
      asked.current = true;
      setPresses((count) => count + 1);
    },
  };
}
