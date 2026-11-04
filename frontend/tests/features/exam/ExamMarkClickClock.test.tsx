/**
 * § 6.4 (RN006), card #49 step 3: the double tap filter of Certo/Errado measures the time
 * between clicks with the `timeStamp` of the click events (monotonic in the browser), not
 * with `Date.now()`, which jumps when the system clock is set. Here `Date` stays still or
 * jumps while the events carry their own times.
 *
 * Helena (open event, exam in progress): Parar não marcado.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { DOUBLE_TAP_MS } from '../../../src/features/exam/markClickGuard';
import { MOCK_EVENT_IDS, createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;

let writes: string[] = [];

/** A tap on `button` whose event says it happened at `at` ms. */
function tapAt(button: HTMLElement, at: number) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
  Object.defineProperty(event, 'timeStamp', { value: at });
  act(() => {
    button.dispatchEvent(event);
  });
}

async function settled(expected: string[]) {
  await waitFor(() => {
    expect(writes).toEqual(expected);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(writes).toEqual(expected);
}

describe('clock of the double tap filter (§ 6.4, RN006, #49)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    writes = [];
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
    server.use(
      http.put(ANSWER_URL, () => {
        writes.push('PUT');
        return undefined;
      }),
      http.delete(ANSWER_URL, () => {
        writes.push('DELETE');
        return undefined;
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function parar() {
    await renderApp({ route: examPath(MOCK_EVENT_IDS.open, HELENA), signedInAs: 'examiner' });
    return screen.findByRole('button', { name: 'Certo: Parar' });
  }

  it('rn006 two taps far apart by their events count, with the system clock standing still', async () => {
    const certo = await parar();
    tapAt(certo, 1_000);
    await settled(['PUT']);
    tapAt(certo, 1_000 + DOUBLE_TAP_MS);
    await settled(['PUT', 'DELETE']);
    expect(certo).toHaveAttribute('aria-pressed', 'false');
  });

  it('rn006 two taps close by their events are a double tap, even when the system clock jumps', async () => {
    const certo = await parar();
    tapAt(certo, 1_000);
    await settled(['PUT']);
    // The system clock is set ten seconds ahead between the two taps.
    vi.setSystemTime(Date.now() + 10_000);
    tapAt(certo, 1_000 + DOUBLE_TAP_MS - 1);
    await settled(['PUT']);
    expect(certo).toHaveAttribute('aria-pressed', 'true');
  });
});
