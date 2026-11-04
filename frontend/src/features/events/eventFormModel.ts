/**
 * Values, client checks and API bodies of the event form (§ 6.5, model in § 3.4, RN016).
 *
 * The checks here are a convenience: the API validates the same fields (and refuses another
 * `exam_date` on an edit) and its message is the one that counts (shown in the dialog).
 */
import type { EventCreateInput, EventStatus, EventUpdateInput, ExamEvent } from '../../api/types';
import { parseIsoDate } from '../../lib/dates';
import { EVENT_STATUS_LABELS } from '../../lib/labels';

/** Limit of `domain/events.py` (`MAX_NAME`). */
export const MAX_EVENT_NAME_LENGTH = 80;

export interface EventFormValues {
  name: string;
  /** `AAAA-MM-DD`, or `''` until chosen. Read only on an edit (it never changes). */
  examDate: string;
  status: EventStatus;
}

export type EventField = keyof EventFormValues;
export type EventFormErrors = Partial<Record<EventField, string>>;

/** Order of the fields on the screen (focus goes to the first invalid one). */
export const FIELD_ORDER: readonly EventField[] = ['name', 'examDate', 'status'];

export const STATUS_OPTIONS: readonly { value: EventStatus; label: string }[] = (
  Object.keys(EVENT_STATUS_LABELS) as EventStatus[]
).map((status) => ({ value: status, label: EVENT_STATUS_LABELS[status] }));

/** Effect of the status (RN016, RN008a), shown next to the field. */
export const STATUS_HELP =
  'Encerrado bloqueia a confirmação de presença e a marcação dos itens; o sensei ainda decide os exames em andamento.';

export function isEventStatus(value: string): value is EventStatus {
  return value in EVENT_STATUS_LABELS;
}

/** `Aberto`, `Encerrado`. */
export function statusLabel(status: EventStatus): string {
  return EVENT_STATUS_LABELS[status];
}

/** Values of a new event: no name or date yet, open (the API default). */
export function newEventValues(): EventFormValues {
  return { name: '', examDate: '', status: 'OPEN' };
}

/** Values of an existing event (edit dialog). */
export function eventValuesOf(event: ExamEvent): EventFormValues {
  return { name: event.name, examDate: event.exam_date, status: event.status };
}

/** Body of `POST /events`. */
export function createInputOf(values: EventFormValues): EventCreateInput {
  return { name: values.name.trim(), exam_date: values.examDate, status: values.status };
}

/** Body of `PUT /events/{id}`: the name and the status only. */
export function updateInputOf(values: EventFormValues): EventUpdateInput {
  return { name: values.name.trim(), status: values.status };
}

/** Python counts code points, not UTF-16 units: keep the same limit as the API. */
function lengthOf(text: string): number {
  return Array.from(text).length;
}

/**
 * Field errors in pt-BR, empty when the form can be sent. `checkDate`: only a new event
 * sends the date (on an edit it is read only).
 */
export function validateEventForm(
  values: EventFormValues,
  { checkDate }: { checkDate: boolean },
): EventFormErrors {
  const errors: EventFormErrors = {};
  const name = values.name.trim();
  if (!name) errors.name = 'Informe o nome.';
  else if (lengthOf(name) > MAX_EVENT_NAME_LENGTH) {
    errors.name = `Use no máximo ${String(MAX_EVENT_NAME_LENGTH)} caracteres.`;
  }
  if (checkDate) {
    if (!values.examDate) errors.examDate = 'Informe a data do exame.';
    else if (!parseIsoDate(values.examDate)) errors.examDate = 'Use uma data válida.';
  }
  return errors;
}

export function firstInvalidField(errors: EventFormErrors): EventField | undefined {
  return FIELD_ORDER.find((field) => errors[field]);
}
