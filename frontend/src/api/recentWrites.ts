/**
 * Recent writes confirmed by the API, laid over the lists that may come back late.
 *
 * Some lists are read in a way that is eventually consistent: `GET /requirements?belt_id`
 * reads the `by_belt` GSI and `GET /events` is a `Scan` without `ConsistentRead`. Right after
 * a write such a read may still answer the list from before it, and a read asked before the
 * write may answer after it. Neither may undo what the API has just confirmed (201/200/204,
 * or a 404 saying the item no longer exists). So each confirmed write is kept for
 * `RECENT_WRITE_WINDOW_MS`, and every list that reaches the cache goes through the overlay of
 * its resource (`recentRequirementWrites`, `recentEventWrites`). Nothing is cancelled: a late
 * answer is simply corrected.
 *
 * The record is per `QueryClient` (a session's cache), never module-wide, and is dropped
 * with the cache at the end of the session (`forgetRecentWrites`).
 */
import type { QueryClient } from '@tanstack/react-query';

import type { ExamEvent, Requirement } from './types';

/** How long a confirmed write overrides the reads (the reads catch up well within it). */
export const RECENT_WRITE_WINDOW_MS = 30_000;

/** The resources whose lists get the overlay, with the item each one saves. */
export interface RecentWriteItems {
  requirements: Requirement;
  events: ExamEvent;
}

export type RecentWriteResource = keyof RecentWriteItems;

export interface RecentWrite<T> {
  /** The item as the API saved it, or `null` when it no longer exists (deleted, 404). */
  saved: T | null;
  /** `Date.now()` when the API confirmed it. */
  confirmedAt: number;
}

/** id → its latest confirmed write. */
export type WriteLog<T> = Map<string, RecentWrite<T>>;

type SessionLogs = { [R in RecentWriteResource]: WriteLog<RecentWriteItems[R]> };

const sessions = new WeakMap<QueryClient, SessionLogs>();

function sessionOf(queryClient: QueryClient): SessionLogs {
  let logs = sessions.get(queryClient);
  if (!logs) {
    logs = { requirements: new Map(), events: new Map() };
    sessions.set(queryClient, logs);
  }
  return logs;
}

function logOf<R extends RecentWriteResource>(
  queryClient: QueryClient,
  resource: R,
): WriteLog<RecentWriteItems[R]> {
  return sessionOf(queryClient)[resource];
}

/**
 * Keeps a write confirmed by the API: the saved item, or `null` for an id that no longer
 * exists. Confirmations are recorded as they arrive, so a newer write of the same id
 * replaces the older one.
 */
export function recordRecentWrite<R extends RecentWriteResource>(
  queryClient: QueryClient,
  resource: R,
  id: string,
  saved: RecentWriteItems[R] | null,
  now: number = Date.now(),
): void {
  logOf(queryClient, resource).set(id, { saved, confirmedAt: now });
}

/** The writes of a resource still inside the window; the expired ones are dropped. */
export function liveRecentWrites<R extends RecentWriteResource>(
  queryClient: QueryClient,
  resource: R,
  now: number = Date.now(),
): WriteLog<RecentWriteItems[R]> {
  const log = logOf(queryClient, resource);
  for (const [id, write] of log) {
    if (now - write.confirmedAt >= RECENT_WRITE_WINDOW_MS) log.delete(id);
  }
  return log;
}

/** Drops the recorded writes of one resource, or of all of them (end of session). */
export function forgetRecentWrites(queryClient: QueryClient, resource?: RecentWriteResource): void {
  if (resource === undefined) sessions.delete(queryClient);
  else sessions.get(queryClient)?.[resource].clear();
}
