/**
 * Exam notices of the student's profile, for the guardian (RN019): how an item of
 * `GET /students/{id}/exam-notices` is written. Which events have a notice, their order, the
 * target belt and the kind come from the API and are never recalculated here.
 */
import type { ExamNotice } from '../../api/types';
import { examTitleText } from '../exam/examModel';
import { dateLabel } from './studentText';

/** Name of the notices area (its region) for screen readers. */
export const NOTICES_LABEL = 'Avisos de exame';

export const NOTICES_LOADING = 'Verificando avisos de exame…';

export const NOTICES_ERROR = 'Não foi possível carregar os avisos de exame';

/**
 * `Exame de faixas dia 05/12/2026`: the sentence of RN019, the same for a belt and a stripe
 * exam. The date is the calendar day the API sent, never converted to a time zone.
 */
export function examNoticeTitle(notice: Pick<ExamNotice, 'event_date'>): string {
  return `Exame de faixas dia ${dateLabel(notice.event_date)}`;
}

/**
 * `Exame dezembro/2026 · Faixa Cinza/Azul` or `Exame dezembro/2026 · Grau (rumo à Roxa)`: the
 * event and what the exam is for, with the texts of the students list and the exam history
 * (`examTitleText`).
 */
export function examNoticeDetail(
  notice: Pick<ExamNotice, 'event_name' | 'kind' | 'target_belt_name'>,
): string {
  return `${notice.event_name} · ${examTitleText(notice.kind, notice.target_belt_name)}`;
}

/**
 * Colors of a notice (`tests/features/students/student-notice-contrast.test.ts`): Mantine's
 * `light` variant of the primary color, which the theme keeps at 4.5:1 or more in both schemes.
 */
export const NOTICE_COLOR = 'blue';
