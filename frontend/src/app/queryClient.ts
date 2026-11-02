import { QueryClient } from '@tanstack/react-query';

import { ApiError, NETWORK_ERROR_STATUS } from '../api/client';

const MAX_RETRIES = 2;

/** Retry network and server failures; a 4xx answer will not change by retrying. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (error instanceof ApiError) {
    return error.status === NETWORK_ERROR_STATUS || error.status >= 500;
  }
  return false;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // § 6.4: reload when the window gets focus back (two examiners on the same exam).
        refetchOnWindowFocus: true,
        retry: shouldRetry,
      },
      mutations: { retry: false },
    },
  });
}
