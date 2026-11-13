/**
 * Exam day list (§ 6.3): which event is shown, how the students are filtered and which
 * action each row gets. Eligibility, age and next exam come from the API on the event
 * date (RN001–RN004, RN015); nothing here recalculates them.
 */
import type { ExamEvent, ExamView, StudentView } from '../../api/types';
import { matchesQuery } from '../../lib/text';

/** Query string key of the chosen event (`?evento={id}`), so a reload keeps it. */
export const EVENT_PARAM = 'evento';

/** The chosen event, or the most recent open one (`GET /events` is most recent first). */
export function selectEvent(events: readonly ExamEvent[], chosenId: string | null) {
  const chosen = chosenId ? events.find((event) => event.id === chosenId) : undefined;
  return chosen ?? events.find((event) => event.status === 'OPEN');
}

/** What the exam day shows for the event in the URL (§ 6.3). */
export interface EventChoice {
  /**
   * The event whose list is on the screen: the chosen one or, with none chosen, the most recent
   * open one. None while `missing`, or with no choice and no open event.
   */
  event: ExamEvent | undefined;
  /**
   * The chosen event is not in the list (deleted meanwhile, or a link to one that is gone): the
   * screen says so and waits for the examiner to pick one. It never moves to another event on
   * its own, where a confirmed attendance would create the exam (RN005).
   */
  missing: boolean;
}

/**
 * The event of the exam day for `chosenId` (the `?evento=` of the URL). `missingBefore` is the
 * `missing` of the previous choice: the screen takes a missing id out of the URL, and the
 * choice stays missing while the URL brings no event, so no default takes its place. An event
 * in the URL (the examiner picked one) ends it; a new screen (reload) starts without it.
 */
export function chooseEvent(
  events: readonly ExamEvent[],
  chosenId: string | null,
  missingBefore: boolean,
): EventChoice {
  const missing = chosenId ? !events.some((event) => event.id === chosenId) : missingBefore;
  return { event: missing ? undefined : selectEvent(events, chosenId), missing };
}

export interface RosterEntry {
  student: StudentView;
  /** The student's exam in the event; present means attendance confirmed. */
  exam: ExamView | undefined;
}

/** Students in the API order (alphabetical), each with its exam in the event. */
export function buildRoster(
  students: readonly StudentView[],
  exams: readonly ExamView[],
): RosterEntry[] {
  const byStudent = new Map(exams.map((exam) => [exam.student_id, exam]));
  return students.map((student) => ({ student, exam: byStudent.get(student.id) }));
}

/**
 * The reloaded exams plus the ones this session created (from the 201 of
 * `POST /events/{id}/exams`) that the reload does not bring yet: the read right after the
 * write is eventually consistent and may come back without the new exam.
 */
export function mergeCreatedExams(
  fetched: readonly ExamView[],
  created: readonly ExamView[],
): ExamView[] {
  const known = new Set(fetched.map((exam) => exam.student_id));
  return [...fetched, ...created.filter((exam) => !known.has(exam.student_id))];
}

export type RosterFilter = 'all' | 'eligible' | 'blocked' | 'present';

export const ROSTER_FILTERS: readonly RosterFilter[] = ['all', 'eligible', 'blocked', 'present'];

export const FILTER_LABELS: Record<RosterFilter, string> = {
  all: 'Todos',
  eligible: 'Elegíveis',
  blocked: 'Bloqueados',
  present: 'Presentes',
};

export function isRosterFilter(value: string): value is RosterFilter {
  return (ROSTER_FILTERS as readonly string[]).includes(value);
}

/** Elegíveis and Bloqueados follow the API eligibility; Presentes, the exams of the event. */
export function matchesFilter(entry: RosterEntry, filter: RosterFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'eligible':
      return entry.student.eligibility.eligible;
    case 'blocked':
      return !entry.student.eligibility.eligible;
    case 'present':
      return entry.exam !== undefined;
  }
}

export function searchRoster(entries: readonly RosterEntry[], query: string): RosterEntry[] {
  return entries.filter((entry) => matchesQuery(entry.student.full_name, query));
}

export function countByFilter(entries: readonly RosterEntry[]): Record<RosterFilter, number> {
  const counts: Record<RosterFilter, number> = { all: 0, eligible: 0, blocked: 0, present: 0 };
  for (const entry of entries) {
    for (const filter of ROSTER_FILTERS) {
      if (matchesFilter(entry, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

export type RosterAction = 'confirm' | 'open' | 'none';

/**
 * RN005/RN016: "Abrir exame" for a present student, "Confirmar presença" for an eligible
 * one without exam, nothing for a blocked one. A closed event takes no new attendance, but
 * its exams still open (RN008a: the sensei decides the ones in progress; § 6.4 read-only).
 */
export function rosterAction(entry: RosterEntry, event: Pick<ExamEvent, 'status'>): RosterAction {
  if (entry.exam) return 'open';
  if (event.status !== 'OPEN') return 'none';
  return entry.student.eligibility.eligible ? 'confirm' : 'none';
}
