import { describe, expect, it } from 'vitest';

import type { ExamEvent, ExamView, StudentView } from '../../../src/api/types';
import {
  buildRoster,
  chooseEvent,
  countByFilter,
  matchesFilter,
  mergeCreatedExams,
  rosterAction,
  searchRoster,
  selectEvent,
  type RosterEntry,
} from '../../../src/features/exam-day/examDayModel';

function event(id: string, status: ExamEvent['status'], examDate: string): ExamEvent {
  return {
    id,
    name: `Evento ${id}`,
    exam_date: examDate,
    status,
    created_at: '2026-10-01T12:00:00+00:00',
    updated_at: '2026-10-01T12:00:00+00:00',
  };
}

function student(id: string, fullName: string, eligible: boolean): StudentView {
  return {
    id,
    owner_id: 'dono',
    full_name: fullName,
    birth_date: '2015-01-01',
    current_belt_id: 'faixa',
    current_belt_since: '2025-01-01',
    stripes: 0,
    federation_id: null,
    active: true,
    created_at: '2026-10-01T12:00:00+00:00',
    updated_at: null,
    current_belt_name: 'Cinza',
    age: 11,
    eligibility: {
      eligible,
      kind: 'BELT',
      target_belt_id: 'alvo',
      target_belt_name: 'Cinza/Azul',
      reasons: eligible ? [] : ['Motivo'],
    },
  };
}

function exam(studentId: string): ExamView {
  return {
    id: `exame-${studentId}`,
    event_id: 'e1',
    student_id: studentId,
    target_belt_id: 'alvo',
    kind: 'BELT',
    status: 'IN_PROGRESS',
    decided_by_id: null,
    decided_at: null,
    notes: null,
    created_by: 'examinador',
    created_at: '2026-11-21T12:00:00+00:00',
    source_belt_id: null,
    source_belt_since: null,
    source_stripes: null,
    student_name: null,
  };
}

function nameOf(entry: RosterEntry): string {
  return entry.student.full_name;
}

// API order: most recent first.
const EVENTS = [
  event('c3', 'CLOSED', '2026-12-12'),
  event('o2', 'OPEN', '2026-11-21'),
  event('o1', 'OPEN', '2026-06-13'),
];

const roster = buildRoster(
  [student('a', 'Ana', true), student('b', 'Bruno', false), student('h', 'Helena', true)],
  [exam('h'), exam('fora-da-lista')],
);

const open = { status: 'OPEN' } as const;
const closed = { status: 'CLOSED' } as const;

describe('exam day model (§ 6.3)', () => {
  it('rn005 adds the created exams the reload does not bring yet', () => {
    const reloaded = { ...exam('a'), status: 'APPROVED' as const };
    const merged = mergeCreatedExams([reloaded], [exam('a'), exam('b')]);
    expect(merged.map((item) => [item.student_id, item.status])).toEqual([
      ['a', 'APPROVED'],
      ['b', 'IN_PROGRESS'],
    ]);
    expect(mergeCreatedExams([], [])).toEqual([]);
  });

  it('defaults to the most recent open event', () => {
    expect(selectEvent(EVENTS, null)?.id).toBe('o2');
  });

  it('keeps the chosen event, closed ones included', () => {
    expect(selectEvent(EVENTS, 'c3')?.id).toBe('c3');
    expect(selectEvent(EVENTS, 'o1')?.id).toBe('o1');
  });

  it('falls back to the default when the chosen event does not exist', () => {
    expect(selectEvent(EVENTS, 'outro')?.id).toBe('o2');
  });

  it('chooses nothing when every event is closed', () => {
    expect(selectEvent([event('c1', 'CLOSED', '2026-03-01')], null)).toBeUndefined();
    expect(selectEvent([], null)).toBeUndefined();
  });

  it('joins each student to the exam of the event', () => {
    expect(roster.map((entry) => entry.exam?.id ?? null)).toEqual([null, null, 'exame-h']);
  });

  it('counts every filter', () => {
    expect(countByFilter(roster)).toEqual({ all: 3, eligible: 2, blocked: 1, present: 1 });
    expect(roster.filter((entry) => matchesFilter(entry, 'present')).map(nameOf)).toEqual([
      'Helena',
    ]);
  });

  it('searches inside the roster', () => {
    expect(searchRoster(roster, 'HÉL').map(nameOf)).toEqual(['Helena']);
  });

  it('rn005 confirms an eligible student without exam', () => {
    expect(rosterAction(roster[0]!, open)).toBe('confirm');
  });

  it('rn005 opens the exam of a present student', () => {
    expect(rosterAction(roster[2]!, open)).toBe('open');
  });

  it('rn005 offers nothing to a blocked student', () => {
    expect(rosterAction(roster[1]!, open)).toBe('none');
  });

  it('rn016 takes no attendance in a closed event', () => {
    expect(rosterAction(roster[0]!, closed)).toBe('none');
    expect(rosterAction(roster[1]!, closed)).toBe('none');
    expect(roster.map((entry) => rosterAction(entry, closed))).not.toContain('confirm');
  });

  it('rn008a still opens the exam of a present student in a closed event', () => {
    expect(roster.map((entry) => rosterAction(entry, closed))).toEqual(['none', 'none', 'open']);
  });
});

describe('event of the exam day for the URL (§ 6.3, #28)', () => {
  function shown(chosenId: string | null, missingBefore: boolean) {
    const choice = chooseEvent(EVENTS, chosenId, missingBefore);
    return { event: choice.event?.id ?? null, missing: choice.missing };
  }

  it('defaults to the most recent open event when the URL brings none', () => {
    expect(shown(null, false)).toEqual({ event: 'o2', missing: false });
    // An empty `?evento=` is no choice either.
    expect(shown('', false)).toEqual({ event: 'o2', missing: false });
  });

  it('keeps the chosen event, closed ones included', () => {
    expect(shown('c3', false)).toEqual({ event: 'c3', missing: false });
    expect(shown('o1', false)).toEqual({ event: 'o1', missing: false });
  });

  it('rn005 a chosen event not in the list is missing: no event, not the default', () => {
    expect(shown('apagado', false)).toEqual({ event: null, missing: true });
    expect(shown('apagado', true)).toEqual({ event: null, missing: true });
  });

  it('rn005 stays missing once the id left the URL, with no default in its place', () => {
    expect(shown(null, true)).toEqual({ event: null, missing: true });
    expect(shown('', true)).toEqual({ event: null, missing: true });
  });

  it('an event the examiner puts in the URL ends the missing state, the default one too', () => {
    expect(shown('o1', true)).toEqual({ event: 'o1', missing: false });
    expect(shown('c3', true)).toEqual({ event: 'c3', missing: false });
    expect(shown('o2', true)).toEqual({ event: 'o2', missing: false });
  });

  it('with no open event and no choice, shows nothing and is not missing', () => {
    const closedOnly = [event('c1', 'CLOSED', '2026-03-01')];
    expect(chooseEvent(closedOnly, null, false)).toEqual({ event: undefined, missing: false });
    expect(chooseEvent([], null, false)).toEqual({ event: undefined, missing: false });
    expect(chooseEvent([], 'apagado', false)).toEqual({ event: undefined, missing: true });
  });
});
