/**
 * Exam screen (§ 6.4): how the sheet sent by `GET /events/{id}/exams/{student_id}` is
 * grouped and labelled. Target belt, kind, marks and percentages (RN004, RN006, RN007) come
 * from the API; nothing here recalculates them.
 */
import { ApiError } from '../../api/client';
import type {
  Belt,
  ExamAnswer,
  ExamEvent,
  ExamSheet,
  ExamSheetItem,
  ExamSheetStudent,
  ExamSummary,
  ExamView,
  Examiner,
  KindSummary,
  RequirementKind,
} from '../../api/types';
import { paths } from '../../app/navigation';
import { ageInYears, parseIsoDate } from '../../lib/dates';
import { formatPercent } from '../../lib/format';
import { REQUIREMENT_KIND_LABELS } from '../../lib/labels';
import { EVENT_PARAM } from '../exam-day/examDayModel';
import { ageLabel } from '../students/studentText';

export const REQUIREMENT_KINDS: readonly RequirementKind[] = ['THEORY', 'PRACTICE'];

export function isRequirementKind(value: string | null): value is RequirementKind {
  return (REQUIREMENT_KINDS as readonly (string | null)[]).includes(value);
}

/** Name shown for an exam whose student was deleted (`student` and `student_name` null). */
export const DELETED_STUDENT = 'Aluno excluído';

/** `/dia-do-exame?evento={id}`: back to the exam day with the same event selected. */
export function examDayPath(eventId?: string): string {
  if (!eventId) return paths.examDay;
  return `${paths.examDay}?${new URLSearchParams({ [EVENT_PARAM]: eventId }).toString()}`;
}

/**
 * `Faixa Cinza/Azul` (belt exam) or `Grau na faixa Roxa (rumo à Marrom)` (stripe exam). The
 * stripe is earned in the student's belt (RN004, RN011): the exam's `source_belt_id`, else
 * (older exams) the belt right before the target in the order; while the belts load,
 * `Grau (rumo à Marrom)` as in the students list.
 */
export function examTitle(sheet: Pick<ExamSheet, 'exam' | 'target_belt'>, belts?: Belt[]) {
  const target = sheet.target_belt;
  if (!target) return sheet.exam.kind === 'BELT' ? 'Faixa —' : 'Grau';
  if (sheet.exam.kind === 'BELT') return `Faixa ${target.name}`;
  const current = belts && stripeBelt(sheet.exam.source_belt_id, target, belts);
  return current
    ? `Grau na faixa ${current.name} (rumo à ${target.name})`
    : `Grau (rumo à ${target.name})`;
}

/**
 * The belt the stripe is earned in: the exam's source belt when known, else the belt with the
 * highest `sort_order` below the target's (orders may have gaps, as in the backend's
 * `previous_belt`).
 */
export function stripeBelt(
  sourceBeltId: string | null | undefined,
  target: Pick<Belt, 'id' | 'sort_order'>,
  belts: readonly Belt[],
): Belt | undefined {
  if (sourceBeltId) {
    const source = belts.find((belt) => belt.id === sourceBeltId);
    if (source) return source;
  }
  let previous: Belt | undefined;
  for (const belt of belts) {
    if (
      belt.sort_order < target.sort_order &&
      (!previous || belt.sort_order > previous.sort_order)
    ) {
      previous = belt;
    }
  }
  return previous;
}

/**
 * `8 anos`: completed years on the event date, the reference date of the exam (RN015);
 * undefined without the student or with a date that is not a calendar date.
 */
export function examAgeLabel(
  student: Pick<ExamSheetStudent, 'birth_date'> | null,
  event: Pick<ExamEvent, 'exam_date'>,
): string | undefined {
  if (!student || !parseIsoDate(student.birth_date) || !parseIsoDate(event.exam_date)) {
    return undefined;
  }
  return ageLabel(ageInYears(student.birth_date, event.exam_date));
}

/**
 * RN006/RN016/RN010: items can be marked only while the exam is in progress and the event
 * is open. Otherwise the screen is read-only ("Certo", "Errado", "Não marcado").
 */
export function canMark(exam: Pick<ExamView, 'status'>, event: Pick<ExamEvent, 'status'>) {
  return exam.status === 'IN_PROGRESS' && event.status === 'OPEN';
}

export type MarkState = 'correct' | 'wrong' | 'unmarked';

export function markState(item: Pick<ExamSheetItem, 'answer'>): MarkState {
  return answerState(item.answer);
}

export function answerState(answer: Pick<ExamAnswer, 'correct'> | null): MarkState {
  if (!answer) return 'unmarked';
  return answer.correct ? 'correct' : 'wrong';
}

/**
 * Clicking a button: Certo or Errado marks the item; clicking the one already pressed
 * takes the mark off (back to "não marcado").
 */
export function nextMarkState(current: MarkState, clicked: 'correct' | 'wrong'): MarkState {
  return current === clicked ? 'unmarked' : clicked;
}

/** Marks clicked but not confirmed by the API yet, by item id. */
export type PendingMarks = Readonly<Record<string, MarkState>>;

function optimisticAnswer(item: ExamSheetItem, state: MarkState): ExamAnswer | null {
  if (state === 'unmarked') return null;
  // Who and when come with the API answer; until then the previous ones stay.
  return {
    requirement_id: item.id,
    correct: state === 'correct',
    marked_by: item.answer?.marked_by ?? '',
    marked_at: item.answer?.marked_at ?? '',
  };
}

/** One decimal, half up, like the API (RN007); only while a mark is on its way. */
function optimisticPercent(correct: number, total: number): number | null {
  return total === 0 ? null : Math.round((correct * 1000) / total) / 10;
}

/**
 * The summary moved by the marks that changed from `before` to `after` (same items, same
 * order). Only a preview: the API answer replaces it (RN007 is computed by the API).
 */
export function shiftSummary(
  summary: ExamSummary,
  before: readonly ExamSheetItem[],
  after: readonly ExamSheetItem[],
): ExamSummary {
  const next: ExamSummary = { THEORY: { ...summary.THEORY }, PRACTICE: { ...summary.PRACTICE } };
  let changed = false;
  for (const [index, item] of before.entries()) {
    const from = markState(item);
    const to = markState(after[index] ?? item);
    if (from === to) continue;
    changed = true;
    const score = next[item.kind];
    score.marked += Number(to !== 'unmarked') - Number(from !== 'unmarked');
    score.correct += Number(to === 'correct') - Number(from === 'correct');
  }
  if (!changed) return summary;
  for (const kind of REQUIREMENT_KINDS) {
    const score = next[kind];
    score.marked = Math.min(Math.max(score.marked, 0), score.total);
    score.correct = Math.min(Math.max(score.correct, 0), score.marked);
    score.percent = optimisticPercent(score.correct, score.total);
  }
  return next;
}

/** The sheet as the examiner sees it: the API data with the marks still on their way. */
export function withPendingMarks(sheet: ExamSheet, pending: PendingMarks): ExamSheet {
  if (Object.keys(pending).length === 0) return sheet;
  const items = sheet.items.map((item) => {
    const state = pending[item.id];
    if (state === undefined || state === markState(item)) return item;
    return { ...item, answer: optimisticAnswer(item, state) };
  });
  return { ...sheet, items, summary: shiftSummary(sheet.summary, sheet.items, items) };
}

/**
 * The sheet after the API saved one item: the answer it sent, and its summary when that
 * one can be trusted (no other mark on its way at the same time); otherwise the summary
 * is moved by this item only, until the exam reloads.
 */
export function withSavedAnswer(
  sheet: ExamSheet,
  requirementId: string,
  answer: ExamAnswer | null,
  summary: ExamSummary | undefined,
): ExamSheet {
  const items = sheet.items.map((item) => (item.id === requirementId ? { ...item, answer } : item));
  return { ...sheet, items, summary: summary ?? shiftSummary(sheet.summary, sheet.items, items) };
}

/** API messages after which the exam reloads (RN010, RN016, item gone or of another belt). */
const MSG_EXAM_DECIDED = 'Exame já decidido';
const MSG_EVENT_CLOSED = 'Evento encerrado';
const MSG_ITEM_NOT_IN_BELT = 'Item não pertence à faixa do exame';

/**
 * A refused mark that means the screen is out of date: the exam was decided (409), the
 * event closed or the item left the belt (400), or something is gone (404). The exam
 * reloads and turns read-only when it no longer takes marks. A 409 of a transaction
 * conflict, a 503 or a network error only ask to try again.
 */
export function reloadsExam(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404) return true;
  if (error.status === 409) return error.message === MSG_EXAM_DECIDED;
  if (error.status === 400) {
    return error.message === MSG_EVENT_CLOSED || error.message === MSG_ITEM_NOT_IN_BELT;
  }
  return false;
}

export const MARK_LABELS: Record<MarkState, string> = {
  correct: 'Certo',
  wrong: 'Errado',
  unmarked: 'Não marcado',
};

export function itemsOfKind(items: readonly ExamSheetItem[], kind: RequirementKind) {
  return items.filter((item) => item.kind === kind);
}

export function markedCount(items: readonly ExamSheetItem[]): number {
  return items.filter((item) => item.answer !== null).length;
}

export interface CategoryGroup {
  category: string;
  /** Items shown (all of them, or only the unmarked ones). */
  items: ExamSheetItem[];
  /** Marked items of the whole category, whatever the filter. */
  marked: number;
  /** Items of the whole category. */
  total: number;
}

/**
 * Items grouped by category in sheet order (a category comes where its first item is). With
 * `onlyUnmarked`, the marked items are hidden and so are the categories left empty, except
 * the ones in `keep` (marked while the filter was on: they leave when the tab or the filter
 * changes, not under the finger); the `x/N` count stays the one of the whole category.
 */
export function groupByCategory(
  items: readonly ExamSheetItem[],
  onlyUnmarked = false,
  keep: ReadonlySet<string> = new Set(),
): CategoryGroup[] {
  const groups = new Map<string, ExamSheetItem[]>();
  for (const item of items) {
    const group = groups.get(item.category);
    if (group) group.push(item);
    else groups.set(item.category, [item]);
  }
  return Array.from(groups, ([category, all]) => ({
    category,
    items: onlyUnmarked ? all.filter((item) => item.answer === null || keep.has(item.id)) : all,
    marked: markedCount(all),
    total: all.length,
  })).filter((group) => group.items.length > 0);
}

/** Quiet time after the last change before the percentages are read out (§ 6.7). */
export const ANNOUNCE_DELAY_MS = 1000;

/** `Teórico 66,7%, Prático 25%` for the live region; "sem itens" instead of "—". */
export function percentsAnnouncement(summary: ExamSummary): string {
  return REQUIREMENT_KINDS.map((kind) => {
    const label = REQUIREMENT_KIND_LABELS[kind];
    return summary[kind].percent === null
      ? `${label} sem itens`
      : `${label} ${percentLabel(summary[kind])}`;
  }).join(', ');
}

/** `72,5%`, or `—` when the belt has no item of the kind (RN007). */
export function percentLabel(summary: Pick<KindSummary, 'percent'>): string {
  return summary.percent === null ? '—' : formatPercent(summary.percent);
}

export interface Neighbors {
  previous: ExamView | undefined;
  next: ExamView | undefined;
}

/**
 * The present students before and after this one, in the order of `GET /events/{id}/exams`
 * (by student name, as the exam day lists them). Nothing on either side at the ends, or when
 * the student is not in the list.
 */
export function neighbors(exams: readonly ExamView[], studentId: string): Neighbors {
  const index = exams.findIndex((exam) => exam.student_id === studentId);
  if (index < 0) return { previous: undefined, next: undefined };
  return { previous: exams[index - 1], next: exams[index + 1] };
}

/** The examiner's name, else the e-mail; undefined when not among the active examiners. */
export function examinerName(examiners: readonly Examiner[], id: string): string | undefined {
  const examiner = examiners.find((candidate) => candidate.id === id);
  if (!examiner) return undefined;
  return examiner.name?.trim() || examiner.email;
}
