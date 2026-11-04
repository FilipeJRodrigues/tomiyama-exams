import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { server } from './msw-server';
import { controlledWaitForRetry, resetRetryWaits } from './retryWaits';
import { mediaMatches, resetViewport } from './viewport';

// The waits before a refused mark is sent again end at once or when the test says so
// (`tests/retryWaits.ts`), never after real time. `markRetry.test.ts` checks the real one.
vi.mock('../src/features/exam/markRetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/exam/markRetry')>()),
  waitForRetry: controlledWaitForRetry,
}));

// findBy*/waitFor waited only 1 s by default, which is not enough when the
// machine or CI is under load.
configure({ asyncUtilTimeout: 5000 });

// jsdom lacks these browser APIs used by Mantine.
window.HTMLElement.prototype.scrollIntoView = () => undefined;

class ResizeObserverStub {
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
}
window.ResizeObserver = ResizeObserverStub;

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: mediaMatches(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetRetryWaits();
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetViewport();
  document.documentElement.removeAttribute('data-mantine-color-scheme');
});

afterAll(() => {
  server.close();
});
