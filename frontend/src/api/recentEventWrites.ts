/**
 * Recent writes of exam events confirmed by the API, laid over every `GET /events`.
 *
 * `GET /events` is a `Scan` of the `Events` table without `ConsistentRead`
 * (`repository/events.py`), so right after a create, an edit or a deletion it may still
 * answer the list from before it. Every list that reaches the cache goes through
 * `overlayRecentEventWrites`; the record lives in `recentWrites` (per `QueryClient`, for
 * `RECENT_WRITE_WINDOW_MS`, dropped at the end of the session).
 */
import type { QueryClient } from '@tanstack/react-query';

import { liveRecentWrites, recordRecentWrite } from './recentWrites';
import type { ExamEvent } from './types';

/** Keeps a write confirmed by the API: the saved event, or `null` when it no longer exists. */
export function recordEventWrite(
  queryClient: QueryClient,
  id: string,
  saved: ExamEvent | null,
  now: number = Date.now(),
): void {
  recordRecentWrite(queryClient, 'events', id, saved, now);
}

/**
 * The order of `GET /events` (`sort_events` in the backend): the most recent `exam_date`
 * first, then the newest created, then the id, so the order is stable.
 */
export function compareEvents(a: ExamEvent, b: ExamEvent): number {
  const keys: readonly (readonly [string, string])[] = [
    [a.exam_date, b.exam_date],
    [a.created_at, b.created_at],
    [a.id, b.id],
  ];
  for (const [left, right] of keys) {
    if (left !== right) return left < right ? 1 : -1;
  }
  return 0;
}

/**
 * The events list with the recent writes laid over it: deleted ids leave, saved events
 * replace the read ones or enter when the read does not have them yet, and the list is put
 * in the API order (`compareEvents`).
 */
export function overlayRecentEventWrites(
  queryClient: QueryClient,
  items: readonly ExamEvent[],
  now: number = Date.now(),
): ExamEvent[] {
  const writes = liveRecentWrites(queryClient, 'events', now);
  const result: ExamEvent[] = [];
  for (const item of items) {
    const write = writes.get(item.id);
    if (!write) result.push(item);
    else if (write.saved) result.push(write.saved);
  }
  const present = new Set(result.map((item) => item.id));
  for (const [id, write] of writes) {
    if (write.saved && !present.has(id)) result.push(write.saved);
  }
  return result.sort(compareEvents);
}
