/**
 * Holds the closing of Mantine's dialogs, as in the browser while a dialog fades out
 * (about 200 ms): after `holdExitTransitions()`, a `Modal` whose `opened` turned false stays on
 * the screen, with its form and buttons, until the test calls `release()`. No real wait and
 * no dependence on how fast the machine is.
 *
 * How: the suite runs Mantine's transitions for real (no `env="test"`), and each one starts in
 * a `requestAnimationFrame`. While held, the frames asked for wait in a queue; `release()` runs
 * them and puts the real `requestAnimationFrame` back, so the dialog finishes closing (and
 * `onExitTransitionEnd` runs) as usual.
 *
 * Call it with the dialog already open: its opening also starts in a frame. The hold ends by
 * itself at the end of the test, even when the test fails before `release()`.
 */
import { act } from '@testing-library/react';
import { onTestFinished } from 'vitest';

export interface HeldTransitions {
  /** Frames waiting: one per transition (dialog, overlay) that started while held. */
  readonly pending: number;
  /** Runs the held frames and stops holding: the dialog finishes closing. */
  release: () => void;
}

type FrameApi = 'requestAnimationFrame' | 'cancelAnimationFrame';

/** Puts `value` in place of `window[name]`; the returned function puts the original back. */
function replace<K extends FrameApi>(name: K, value: Window[K]): () => void {
  const original = Object.getOwnPropertyDescriptor(window, name);
  Object.defineProperty(window, name, { configurable: true, writable: true, value });
  return () => {
    if (original) Object.defineProperty(window, name, original);
    else Reflect.deleteProperty(window, name);
  };
}

export function holdExitTransitions(): HeldTransitions {
  const realCancel = window.cancelAnimationFrame.bind(window);
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 1_000_000;
  let holding = true;

  const restoreRequest = replace('requestAnimationFrame', (callback) => {
    nextId += 1;
    queue.set(nextId, callback);
    return nextId;
  });
  const restoreCancel = replace('cancelAnimationFrame', (id) => {
    if (!queue.delete(id)) realCancel(id);
  });

  const stop = () => {
    if (!holding) return;
    holding = false;
    restoreRequest();
    restoreCancel();
  };
  onTestFinished(() => {
    stop();
    queue.clear();
  });

  return {
    get pending() {
      return queue.size;
    },
    release: () => {
      stop();
      const frames = Array.from(queue.values());
      queue.clear();
      act(() => {
        for (const frame of frames) frame(performance.now());
      });
    },
  };
}
