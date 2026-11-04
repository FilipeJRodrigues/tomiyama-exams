/** Values, client checks and API bodies of the event form (§ 6.5, § 3.4, RN016). */
import { describe, expect, it } from 'vitest';

import {
  STATUS_OPTIONS,
  createInputOf,
  eventValuesOf,
  firstInvalidField,
  isEventStatus,
  newEventValues,
  statusLabel,
  updateInputOf,
  validateEventForm,
} from '../../../src/features/events/eventFormModel';
import { makeEvent } from './helpers';

describe('event form model', () => {
  it('rn016 a new event starts open, with no name or date', () => {
    expect(newEventValues()).toEqual({ name: '', examDate: '', status: 'OPEN' });
  });

  it('offers the statuses with pt-BR labels', () => {
    expect(STATUS_OPTIONS).toEqual([
      { value: 'OPEN', label: 'Aberto' },
      { value: 'CLOSED', label: 'Encerrado' },
    ]);
    expect(statusLabel('CLOSED')).toBe('Encerrado');
    expect(isEventStatus('OPEN')).toBe(true);
    expect(isEventStatus('open')).toBe(false);
  });

  it('builds the POST with the trimmed name, the date and the status', () => {
    const values = { name: '  Exame março/2027 ', examDate: '2027-03-20', status: 'OPEN' as const };
    expect(createInputOf(values)).toEqual({
      name: 'Exame março/2027',
      exam_date: '2027-03-20',
      status: 'OPEN',
    });
  });

  it('rn016 the PUT carries only the name and the status (the date never changes)', () => {
    const values = eventValuesOf(makeEvent('a', { name: 'Exame', status: 'CLOSED' }));
    expect(values).toEqual({ name: 'Exame', examDate: '2027-03-20', status: 'CLOSED' });
    expect(updateInputOf({ ...values, name: ' Novo nome ', status: 'OPEN' })).toEqual({
      name: 'Novo nome',
      status: 'OPEN',
    });
  });

  it('asks for the name and, on a new event, a real date', () => {
    expect(validateEventForm(newEventValues(), { checkDate: true })).toEqual({
      name: 'Informe o nome.',
      examDate: 'Informe a data do exame.',
    });
    const wrongDate = { name: 'Exame', examDate: '2027-02-30', status: 'OPEN' as const };
    expect(validateEventForm(wrongDate, { checkDate: true })).toEqual({
      examDate: 'Use uma data válida.',
    });
    expect(validateEventForm(wrongDate, { checkDate: false })).toEqual({});
  });

  it('counts the name in code points, like the API (80 at most)', () => {
    const values = { name: '🥋'.repeat(80), examDate: '2027-03-20', status: 'OPEN' as const };
    expect(validateEventForm(values, { checkDate: true })).toEqual({});
    expect(validateEventForm({ ...values, name: 'x'.repeat(81) }, { checkDate: true })).toEqual({
      name: 'Use no máximo 80 caracteres.',
    });
  });

  it('the first invalid field follows the screen order', () => {
    expect(firstInvalidField({ examDate: 'x', name: 'y' })).toBe('name');
    expect(firstInvalidField({})).toBeUndefined();
  });
});
