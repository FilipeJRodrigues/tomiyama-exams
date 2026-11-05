import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createSendLock, useSendLock } from '../../src/lib/sendLock';

describe('createSendLock', () => {
  it('starts free and takes once: a second take before the release sends nothing', () => {
    const lock = createSendLock();
    expect(lock.held()).toBe(false);
    expect(lock.take()).toBe(true);
    expect(lock.held()).toBe(true);
    expect(lock.take()).toBe(false);
  });

  it('a failed request gives it back: a new try may go', () => {
    const lock = createSendLock();
    lock.take();
    lock.release();
    expect(lock.held()).toBe(false);
    expect(lock.take()).toBe(true);
  });

  it('a request that worked keeps it until the dialog finishes closing (#88)', () => {
    const lock = createSendLock();
    lock.take();
    lock.keepUntilClosed();
    expect(lock.held()).toBe(true);
    expect(lock.take()).toBe(false);

    lock.closed();
    expect(lock.held()).toBe(false);
    expect(lock.take()).toBe(true);
  });

  it('the end of a closing without a request that worked leaves a taken lock alone', () => {
    const lock = createSendLock();
    lock.closed();
    expect(lock.held()).toBe(false);

    // "Cancelar" closed the dialog while another request of the screen took the lock.
    lock.take();
    lock.closed();
    expect(lock.held()).toBe(true);
    expect(lock.take()).toBe(false);
  });

  it('opening the dialog again frees a lock kept for its closing', () => {
    const lock = createSendLock();
    lock.take();
    lock.keepUntilClosed();
    lock.release();
    expect(lock.held()).toBe(false);
    expect(lock.take()).toBe(true);
  });
});

describe('useSendLock', () => {
  it('keeps the same lock across renders', () => {
    const { result, rerender } = renderHook(() => useSendLock());
    const first = result.current;
    expect(first.take()).toBe(true);
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.held()).toBe(true);
  });

  it('gives each component its own lock', () => {
    const one = renderHook(() => useSendLock());
    const other = renderHook(() => useSendLock());
    one.result.current.take();
    expect(other.result.current.held()).toBe(false);
  });
});
