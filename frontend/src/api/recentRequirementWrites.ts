/**
 * Recent writes of requirements confirmed by the API, laid over every `GET /requirements`.
 *
 * `GET /requirements?belt_id` reads the `by_belt` GSI, which is eventually consistent: right
 * after a write it may still answer the list from before it, and a read asked before the
 * write may answer after it. Neither may undo what the API has just confirmed (201/200/204,
 * or a 404 saying the item no longer exists). So each confirmed write is kept for
 * `RECENT_WRITE_WINDOW_MS`, and every list that reaches the cache (a read or the patch right
 * after the write) goes through `overlayRecentWrites`. Nothing is cancelled: a late answer is
 * simply corrected.
 *
 * The record is per `QueryClient` (a session's cache), never module-wide, and is dropped
 * with the cache at the end of the session (`forgetRecentRequirementWrites`).
 */
import type { QueryClient } from '@tanstack/react-query';

import type { Requirement, RequirementFilters } from './types';

/** How long a confirmed write overrides the reads (the GSI catches up well within it). */
export const RECENT_WRITE_WINDOW_MS = 30_000;

interface RecentWrite {
  /** The item as the API saved it, or `null` when it no longer exists (deleted, 404). */
  saved: Requirement | null;
  /** `Date.now()` when the API confirmed it. */
  confirmedAt: number;
}

/** id → its latest confirmed write. */
type WriteLog = Map<string, RecentWrite>;

const logs = new WeakMap<QueryClient, WriteLog>();

function logOf(queryClient: QueryClient): WriteLog {
  let log = logs.get(queryClient);
  if (!log) {
    log = new Map();
    logs.set(queryClient, log);
  }
  return log;
}

/** The writes still inside the window; the expired ones are dropped. */
function liveWrites(queryClient: QueryClient, now: number): WriteLog {
  const log = logOf(queryClient);
  for (const [id, write] of log) {
    if (now - write.confirmedAt >= RECENT_WRITE_WINDOW_MS) log.delete(id);
  }
  return log;
}

/**
 * Keeps a write confirmed by the API: the saved item, or `null` for an id that no longer
 * exists. Confirmations are recorded as they arrive, so a newer write of the same id
 * replaces the older one.
 */
export function recordRequirementWrite(
  queryClient: QueryClient,
  id: string,
  saved: Requirement | null,
  now: number = Date.now(),
): void {
  logOf(queryClient).set(id, { saved, confirmedAt: now });
}

/** Drops every recorded write (end of session, with the rest of the cache). */
export function forgetRecentRequirementWrites(queryClient: QueryClient): void {
  logs.delete(queryClient);
}

/** Sheet order inside a belt, as the API sends it: `sort_order`, then id. */
export function compareRequirements(a: Requirement, b: Requirement): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function matchesFilters(item: Requirement, filters: RequirementFilters): boolean {
  return (
    (filters.belt_id === undefined || filters.belt_id === item.belt_id) &&
    (filters.kind === undefined || filters.kind === item.kind)
  );
}

/**
 * The list of one filter with the recent writes laid over it: deleted ids leave, saved items
 * replace the read ones and leave the lists whose filter they no longer match (an edit that
 * changed the belt or the kind). In a list of one belt, a saved item that matches enters and
 * the list is put in sheet order. A list without a belt filter is in belt order, which this
 * module does not know: there a saved item only replaces the read one in place.
 */
export function overlayRecentWrites(
  queryClient: QueryClient,
  filters: RequirementFilters,
  items: readonly Requirement[],
  now: number = Date.now(),
): Requirement[] {
  const writes = liveWrites(queryClient, now);
  if (writes.size === 0) return [...items];

  const result: Requirement[] = [];
  for (const item of items) {
    const write = writes.get(item.id);
    if (!write) {
      result.push(item);
    } else if (write.saved && matchesFilters(write.saved, filters)) {
      result.push(write.saved);
    }
  }
  if (filters.belt_id === undefined) return result;

  const present = new Set(result.map((item) => item.id));
  for (const [id, write] of writes) {
    if (write.saved && !present.has(id) && matchesFilters(write.saved, filters)) {
      result.push(write.saved);
    }
  }
  return result.sort(compareRequirements);
}
