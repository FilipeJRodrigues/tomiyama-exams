import { setupWorker } from 'msw/browser';

import { createHandlers } from './handlers';

/** Start MSW in the browser; requests outside the API pass through untouched. */
export async function startMockWorker(baseUrl: string): Promise<void> {
  const worker = setupWorker(...createHandlers({ baseUrl }));
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true });
}
