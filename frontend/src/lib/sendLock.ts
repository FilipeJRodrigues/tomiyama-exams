import { useState } from 'react';

/**
 * Synchronous lock of the requests a dialog sends to the API (§ 6.5, § 6.6): one at a time,
 * and none while the dialog closes after one that worked.
 *
 * - `take()` before sending: false while the lock is held, and then nothing is sent. Not
 *   `isPending`, which only arrives on the next render (a double click, Enter twice).
 * - A request that failed gives it back (`release()` in `onError`): the dialog stays open with
 *   the API message and a new try may go.
 * - One that worked keeps it (`keepUntilClosed()` in `onSuccess`). Its dialog is still on the
 *   screen while it fades out (about 200 ms), with the focus on a field or on the button and
 *   the button enabled again; an Enter or a click there must not send the request again (#88:
 *   two `POST`, or a `DELETE` that would come back 404). The dialog gives it back when it
 *   finishes closing (`closed()` in `onExitTransitionEnd`). `closed()` only frees a lock kept
 *   this way: a dialog closed without sending ("Cancelar") leaves alone a lock some other
 *   request of the screen took meanwhile.
 * - Opening the dialog again gives it back too (`release()`): the opening cancels the closing,
 *   and with it the call to `onExitTransitionEnd`.
 *
 * While held, the dialog does not close either (`Esc`, "Cancelar"): it is sending, or already
 * closing.
 */
export interface SendLock {
  /** A request is on its way, or one worked and its dialog is still closing. */
  held: () => boolean;
  /** Takes the lock for a request: false (send nothing) when it is already held. */
  take: () => boolean;
  /** Frees the lock: the request failed or needs no closing, or the dialog opened again. */
  release: () => void;
  /** The request worked and its dialog is closing: the lock stays held until `closed()`. */
  keepUntilClosed: () => void;
  /** The dialog finished closing: frees the lock if `keepUntilClosed()` kept it. */
  closed: () => void;
}

type Phase = 'free' | 'sending' | 'closing';

export function createSendLock(): SendLock {
  let phase: Phase = 'free';
  return {
    held: () => phase !== 'free',
    take: () => {
      if (phase !== 'free') return false;
      phase = 'sending';
      return true;
    },
    release: () => {
      phase = 'free';
    },
    keepUntilClosed: () => {
      phase = 'closing';
    },
    closed: () => {
      if (phase === 'closing') phase = 'free';
    },
  };
}

/** One `SendLock` for the life of the component. */
export function useSendLock(): SendLock {
  const [lock] = useState(createSendLock);
  return lock;
}
