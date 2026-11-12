/**
 * Texts of the exam notices of the student's profile (RN019): the sentence with the date as
 * `dd/mm/aaaa`, and the event with the target of the exam.
 */
import { describe, expect, it } from 'vitest';

import {
  examNoticeDetail,
  examNoticeTitle,
} from '../../../src/features/students/studentNoticeModel';

describe('examNoticeTitle (RN019)', () => {
  it.each([
    ['2026-12-05', 'Exame de faixas dia 05/12/2026'],
    ['2027-01-01', 'Exame de faixas dia 01/01/2027'],
    ['2026-12-31', 'Exame de faixas dia 31/12/2026'],
    ['2028-02-29', 'Exame de faixas dia 29/02/2028'],
  ])('rn019 writes %s as "%s"', (iso, text) => {
    expect(examNoticeTitle({ event_date: iso })).toBe(text);
  });

  it('keeps the calendar day of the API where midnight UTC is still the day before', () => {
    // The suite runs in America/Sao_Paulo (`vite.config.ts`): there, `new Date('2026-12-05')`
    // is 04/12/2026 at 21:00, the error the title must not have.
    const asLocalDate = new Date('2026-12-05');
    expect(asLocalDate.getDate()).toBe(4);
    expect(examNoticeTitle({ event_date: '2026-12-05' })).toBe('Exame de faixas dia 05/12/2026');
    expect(examNoticeTitle({ event_date: '2027-01-01' })).toBe('Exame de faixas dia 01/01/2027');
  });

  it('never throws on something that is not a date', () => {
    expect(examNoticeTitle({ event_date: '2026-02-30' })).toBe('Exame de faixas dia —');
    expect(examNoticeTitle({ event_date: '' })).toBe('Exame de faixas dia —');
  });
});

describe('examNoticeDetail', () => {
  const event = { event_name: 'Exame dezembro/2026' };

  it('names the event and the belt of a belt exam (BELT)', () => {
    expect(examNoticeDetail({ ...event, kind: 'BELT', target_belt_name: 'Cinza/Azul' })).toBe(
      'Exame dezembro/2026 · Faixa Cinza/Azul',
    );
  });

  it('names the event and where a stripe exam leads (STRIPE)', () => {
    expect(examNoticeDetail({ ...event, kind: 'STRIPE', target_belt_name: 'Roxa' })).toBe(
      'Exame dezembro/2026 · Grau (rumo à Roxa)',
    );
  });

  it('falls back as the exam history when the target belt no longer exists', () => {
    expect(examNoticeDetail({ ...event, kind: 'BELT', target_belt_name: null })).toBe(
      'Exame dezembro/2026 · Faixa —',
    );
    expect(examNoticeDetail({ ...event, kind: 'STRIPE', target_belt_name: null })).toBe(
      'Exame dezembro/2026 · Grau',
    );
  });
});
