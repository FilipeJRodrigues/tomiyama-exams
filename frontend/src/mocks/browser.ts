import { setupWorker } from 'msw/browser';

import { MOCK_USER_IDS } from '../auth/mockConstants';
import { createMockDb } from './data';
import { createHandlers } from './handlers';

/** Start MSW in the browser; requests outside the API pass through untouched. */
export async function startMockWorker(baseUrl: string): Promise<void> {
  const worker = setupWorker(
    ...createHandlers({
      baseUrl,
      db: createMockDb({ includeShowcase: true, senseiId: MOCK_USER_IDS.examiner }),
    }),
  );
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true });
}
