/**
 * Texts of the "Encerrar" / "Reabrir" action of an event (§ 6.5, RN016), shared by the button
 * that opens the confirmation (events list, exam day) and by `ChangeEventStatusDialog`.
 *
 * The effects written here (attendance and marking blocked, the sensei still deciding, RN008a)
 * are the API's rules; the screen only tells them, the API applies them.
 */
import type { EventStatus, ExamEvent } from '../../api/types';
import { formatDate } from '../../lib/dates';

export interface StatusChangeTexts {
  /** Button label: "Encerrar" or "Reabrir". */
  action: string;
  /** Dialog title. */
  title: string;
  /** Title of the error inside the dialog (other than 403). */
  failure: string;
  /** Notice once the API saved it. */
  done: string;
}

const TEXTS: Record<EventStatus, StatusChangeTexts> = {
  CLOSED: {
    action: 'Encerrar',
    title: 'Encerrar evento',
    failure: 'Não foi possível encerrar',
    done: 'Evento encerrado.',
  },
  OPEN: {
    action: 'Reabrir',
    title: 'Reabrir evento',
    failure: 'Não foi possível reabrir',
    done: 'Evento reaberto.',
  },
};

/** The status the action moves the event to: an open event closes, a closed one reopens. */
export function nextStatus(status: EventStatus): EventStatus {
  return status === 'OPEN' ? 'CLOSED' : 'OPEN';
}

/** Texts of the change that takes an event to `target`. */
export function statusChangeTexts(target: EventStatus): StatusChangeTexts {
  return TEXTS[target];
}

/** Accessible name of the button: "Encerrar evento {nome}" or "Reabrir evento {nome}". */
export function statusChangeLabel(event: ExamEvent): string {
  return `${statusChangeTexts(nextStatus(event.status)).action} evento ${event.name}`;
}

/**
 * Visible text of a button that stands alone, with no row to say which event (exam day, next to
 * the event picker): "Encerrar evento" or "Reabrir evento". Its accessible name is
 * `statusChangeLabel`, which starts with this text and adds the name.
 */
export function statusChangeButtonText(status: EventStatus): string {
  return `${statusChangeTexts(nextStatus(status)).action} evento`;
}

/** The question of the confirmation, with the name and the date of the event. */
export function statusChangeQuestion(event: ExamEvent): string {
  const what = `o evento “${event.name}” (${formatDate(event.exam_date)})`;
  return nextStatus(event.status) === 'CLOSED'
    ? `Encerrar ${what}? A presença e a marcação dos itens ficam bloqueadas, mas o sensei ainda pode decidir os exames em andamento. O evento pode ser reaberto depois.`
    : `Reabrir ${what}? A presença e a marcação dos itens voltam a ser permitidas.`;
}
