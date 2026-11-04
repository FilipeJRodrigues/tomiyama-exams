/**
 * `GET /events` is a `Scan` without `ConsistentRead` (`repository/events.py`): right after a
 * write it may still answer the list from before it. The recent writes laid over the list
 * (`recentEventWrites`) keep what the API confirmed while it is recent
 * (`RECENT_WRITE_WINDOW_MS`), in the API order; the record is per session (`QueryClient`) and
 * shared with the requirements one (`recentWrites`) without mixing them.
 */
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  compareEvents,
  overlayRecentEventWrites,
  recordEventWrite,
} from '../../../src/api/recentEventWrites';
import {
  overlayRecentWrites,
  recordRequirementWrite,
} from '../../../src/api/recentRequirementWrites';
import { RECENT_WRITE_WINDOW_MS, forgetRecentWrites } from '../../../src/api/recentWrites';
import type { ExamEvent, Requirement } from '../../../src/api/types';
import { makeEvent } from './helpers';

const T0 = 1_800_000_000_000;

function ids(events: readonly ExamEvent[]): string[] {
  return events.map((event) => event.id);
}

const READ: readonly ExamEvent[] = [
  makeEvent('nov', { exam_date: '2026-11-21' }),
  makeEvent('mar', { exam_date: '2026-03-01', status: 'CLOSED' }),
];

describe('compareEvents', () => {
  it('rn016 puts the most recent exam date first, then the newest created, then the id', () => {
    const events = [
      makeEvent('a', { exam_date: '2026-01-01' }),
      makeEvent('b', { exam_date: '2027-01-01', created_at: '2026-10-01T12:00:00+00:00' }),
      makeEvent('c', { exam_date: '2027-01-01', created_at: '2026-10-02T12:00:00+00:00' }),
      makeEvent('d', { exam_date: '2027-01-01', created_at: '2026-10-02T12:00:00+00:00' }),
    ];
    expect(ids([...events].sort(compareEvents))).toEqual(['d', 'c', 'b', 'a']);
  });
});

describe('overlayRecentEventWrites', () => {
  it('without writes keeps the read, in the API order', () => {
    const queryClient = new QueryClient();
    expect(ids(overlayRecentEventWrites(queryClient, [...READ].reverse(), T0))).toEqual([
      'nov',
      'mar',
    ]);
  });

  it('adds a created event the read does not have yet, in its place', () => {
    const queryClient = new QueryClient();
    recordEventWrite(queryClient, 'jun', makeEvent('jun', { exam_date: '2026-06-20' }), T0);
    expect(ids(overlayRecentEventWrites(queryClient, READ, T0 + 1))).toEqual(['nov', 'jun', 'mar']);
  });

  it('replaces an edited event and drops a deleted one', () => {
    const queryClient = new QueryClient();
    recordEventWrite(queryClient, 'mar', makeEvent('mar', { exam_date: '2026-03-01' }), T0);
    recordEventWrite(queryClient, 'nov', null, T0);
    const result = overlayRecentEventWrites(queryClient, READ, T0 + 1);
    expect(ids(result)).toEqual(['mar']);
    expect(result[0]?.status).toBe('OPEN');
  });

  it('the newest confirmation of an id wins', () => {
    const queryClient = new QueryClient();
    recordEventWrite(queryClient, 'nov', makeEvent('nov', { name: 'Primeiro' }), T0);
    recordEventWrite(queryClient, 'nov', makeEvent('nov', { name: 'Segundo' }), T0 + 10);
    expect(overlayRecentEventWrites(queryClient, READ, T0 + 20)[0]?.name).toBe('Segundo');
    recordEventWrite(queryClient, 'nov', null, T0 + 30);
    expect(ids(overlayRecentEventWrites(queryClient, READ, T0 + 40))).toEqual(['mar']);
  });

  it('stops overriding the read once the write is no longer recent', () => {
    const queryClient = new QueryClient();
    recordEventWrite(queryClient, 'nov', null, T0);
    const justBefore = T0 + RECENT_WRITE_WINDOW_MS - 1;
    expect(ids(overlayRecentEventWrites(queryClient, READ, justBefore))).toEqual(['mar']);
    const atTheEnd = T0 + RECENT_WRITE_WINDOW_MS;
    expect(ids(overlayRecentEventWrites(queryClient, READ, atTheEnd))).toEqual(['nov', 'mar']);
  });

  it('keeps each session apart and is dropped with it, without touching the requirements', () => {
    const first = new QueryClient();
    const second = new QueryClient();
    recordEventWrite(first, 'nov', null, T0);
    expect(ids(overlayRecentEventWrites(second, READ, T0 + 1))).toEqual(['nov', 'mar']);
    expect(ids(overlayRecentEventWrites(first, READ, T0 + 1))).toEqual(['mar']);

    // An event write never reaches a requirements list with the same id.
    const requirement: Requirement = {
      id: 'nov',
      belt_id: 'cinza',
      kind: 'THEORY',
      category: 'Vocabulário',
      description: 'Começar',
      expected_answer: 'Hajime',
      sort_order: 1,
    };
    expect(overlayRecentWrites(first, { belt_id: 'cinza' }, [requirement], T0 + 1)).toEqual([
      requirement,
    ]);
    recordRequirementWrite(first, 'r1', null, T0);

    forgetRecentWrites(first);
    expect(ids(overlayRecentEventWrites(first, READ, T0 + 1))).toEqual(['nov', 'mar']);
  });

  it('forgetting one resource keeps the other', () => {
    const queryClient = new QueryClient();
    recordEventWrite(queryClient, 'nov', null, T0);
    forgetRecentWrites(queryClient, 'requirements');
    expect(ids(overlayRecentEventWrites(queryClient, READ, T0 + 1))).toEqual(['mar']);
    forgetRecentWrites(queryClient, 'events');
    expect(ids(overlayRecentEventWrites(queryClient, READ, T0 + 1))).toEqual(['nov', 'mar']);
  });
});
