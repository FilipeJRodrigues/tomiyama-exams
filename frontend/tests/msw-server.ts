import { setupServer } from 'msw/node';

import { createMockDb } from '../src/mocks/data';
import { createHandlers } from '../src/mocks/handlers';

/** Base URL of the API in the tests (`test.env` in `vite.config.ts`). */
export const TEST_API_URL = 'http://api.test';

export const server = setupServer();

/** Fresh simulated API (new data each call) for the current test. */
export function installMockApi(): void {
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
}
