/**
 * Exam screen (§ 6.4): how the sheet sent by `GET /events/{id}/exams/{student_id}` is
 * grouped and labelled. Target belt, kind, marks and percentages (RN004, RN006, RN007) come
 * from the API; nothing here recalculates them.
 */
import type {
  Belt,
  ExamEvent,
  ExamSheet,
  ExamSheetItem,
  ExamSheetStudent,
  ExamView,
  Examiner,
  KindSummary,
  RequirementKind,
} from '../../api/types';
import { paths } from '../../app/navigation';
import { ageInYears, parseIsoDate } from '../../lib/dates';
import { formatPercent } from '../../lib/format';
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
function stripeBelt(
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
  if (!item.answer) return 'unmarked';
  return item.answer.correct ? 'correct' : 'wrong';
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
 * `onlyUnmarked`, the marked items are hidden and so are the categories left empty; the
 * `x/N` count stays the one of the whole category.
 */
export function groupByCategory(
  items: readonly ExamSheetItem[],
  onlyUnmarked = false,
): CategoryGroup[] {
  const groups = new Map<string, ExamSheetItem[]>();
  for (const item of items) {
    const group = groups.get(item.category);
    if (group) group.push(item);
    else groups.set(item.category, [item]);
  }
  return Array.from(groups, ([category, all]) => ({
    category,
    items: onlyUnmarked ? all.filter((item) => item.answer === null) : all,
    marked: markedCount(all),
    total: all.length,
  })).filter((group) => group.items.length > 0);
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
