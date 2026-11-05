/**
 * Exam history of the student (RN018) in the edit form: how `GET /students/{id}/exams` is
 * labelled. Order, target belt, kind and status come from the API and are never recalculated;
 * the exam texts and who decided follow the exam screen (§ 6.4).
 */
import type {
  Belt,
  ExamStatus,
  Examiner,
  SettingsSensei,
  StudentHistoryEntry,
} from '../../api/types';
import { localDateOf } from '../../lib/dates';
import { decidedByText, deciderName } from '../exam/decisionModel';
import { examTitleText, stripeBelt } from '../exam/examModel';
import { dateLabel } from './studentText';

/** Shown for an exam whose event no longer exists (removed by hand: RN016 keeps it). */
export const MISSING_EVENT = 'Evento não encontrado';

/** The history of a student without exams. */
export const EMPTY_HISTORY = 'Nenhum exame registrado.';

type EventFields = Pick<StudentHistoryEntry, 'event_name' | 'exam_date'>;

/** Whether the exam's event still exists: without it the API sends its name and date `null`. */
export function hasEvent(entry: EventFields): boolean {
  return entry.event_name !== null || entry.exam_date !== null;
}

export function historyEventName(entry: EventFields): string {
  return entry.event_name ?? MISSING_EVENT;
}

/** The event date as `dd/mm/aaaa`; `—` without the event. */
export function historyDateLabel(entry: EventFields): string {
  return entry.exam_date === null ? '—' : dateLabel(entry.exam_date);
}

type TitleFields = Pick<
  StudentHistoryEntry,
  'kind' | 'target_belt_id' | 'target_belt_name' | 'source'
>;

/**
 * `Faixa Azul` or `Grau na faixa Roxa (rumo à Marrom)`: the texts of `examTitle` (§ 6.4). The
 * belt of the stripe comes from `stripeBelt`, as on the exam screen: the source belt, else
 * (no source, or its belt was removed) the belt right before the target in the order. The
 * target's name is the one the API sends. Without the belts (or the target among them), the
 * names the API sends: `Grau (rumo à Marrom)` when the source has no name.
 */
export function historyExamTitle(entry: TitleFields, belts?: readonly Belt[]): string {
  const target =
    entry.kind === 'STRIPE' && belts
      ? belts.find((belt) => belt.id === entry.target_belt_id)
      : undefined;
  const current = target && belts ? stripeBelt(entry.source?.belt_id, target, belts) : undefined;
  return examTitleText(
    entry.kind,
    entry.target_belt_name,
    current ? current.name : entry.source?.belt_name,
  );
}

/**
 * `Abrir exame: Faixa Azul, Exame setembro/2027, 25/09/2027`: the accessible name of the link
 * says which exam it opens (every row has one), and starts with the text on screen.
 */
export function openExamLabel(
  entry: TitleFields & Pick<StudentHistoryEntry, 'event_name' | 'exam_date'>,
  belts?: readonly Belt[],
): string {
  return `Abrir exame: ${historyExamTitle(entry, belts)}, ${historyEventName(entry)}, ${historyDateLabel(entry)}`;
}

/** What the screen has to name who decided: the active examiners and the sensei. */
export interface DeciderNames {
  /** `GET /examiners`; undefined while it loads or when it failed. */
  examiners: readonly Examiner[] | undefined;
  /** The sensei of `GET /settings`; undefined while it loads or when it failed. */
  sensei: SettingsSensei | null | undefined;
  /**
   * As on the exam screen: `GET /examiners` answered and `GET /settings` is no longer loading
   * (answered or failed). Then a decider that neither names is "no longer active"; while the
   * examiners load or after they failed, the text stays neutral ("Decidido"). The settings
   * only name the sensei.
   */
  loaded: boolean;
}

export interface DecisionLabel {
  /** `Decidido por Sensei Simulado`, with the texts of the exam screen (`decidedByText`). */
  who: string;
  /** Day of `decided_at` in the user's time zone, `dd/mm/aaaa`; undefined without it. */
  when: string | undefined;
}

/**
 * Who decided and when, with the criterion of the exam screen (`deciderName`): an active
 * examiner, else the sensei of the settings, else "um examinador que não está mais ativo".
 * Undefined while the exam is in progress.
 */
export function decisionLabel(
  entry: Pick<StudentHistoryEntry, 'status' | 'decided_by_id' | 'decided_at'>,
  names: DeciderNames,
): DecisionLabel | undefined {
  if (entry.status === 'IN_PROGRESS') return undefined;
  const name = entry.decided_by_id
    ? deciderName(entry.decided_by_id, names.examiners, names.sensei)
    : undefined;
  const day = entry.decided_at ? localDateOf(entry.decided_at) : null;
  return {
    who: decidedByText(name, names.loaded),
    when: day ? dateLabel(day) : undefined,
  };
}

/**
 * Colors of the status (`tests/features/students/student-history-contrast.test.ts`): the
 * failure is red as a blocked student (4.5:1 for the text), the approval has a green icon
 * (3:1, an indicator); the rest keeps the text color. The text always says the status.
 */
export const HISTORY_STATUS_COLORS: Record<ExamStatus, { icon?: string; text?: string }> = {
  IN_PROGRESS: {},
  APPROVED: { icon: 'var(--mantine-color-green-light-color)' },
  FAILED: { icon: 'var(--mantine-color-error)', text: 'var(--mantine-color-error)' },
};

/** The note of the decision, without blank ones. */
export function historyNotes(entry: Pick<StudentHistoryEntry, 'notes'>): string | undefined {
  return entry.notes?.trim() || undefined;
}
