import { describe, expect, it } from 'vitest';

import type { Eligibility } from '../../../src/api/types';
import {
  ageLabel,
  beltLabel,
  dateLabel,
  nextExamLabel,
  stripesLabel,
  studentStatus,
} from '../../../src/features/students/studentText';

function eligibility(overrides: Partial<Eligibility> = {}): Eligibility {
  return {
    eligible: true,
    kind: 'BELT',
    target_belt_id: 'belt-id',
    target_belt_name: 'Cinza/Azul',
    reasons: [],
    ...overrides,
  };
}

describe('students list texts (§ 6.2)', () => {
  it.each([
    [0, ''],
    [1, '1 grau'],
    [2, '2 graus'],
    [4, '4 graus'],
  ])('stripes %i → "%s"', (stripes, label) => {
    expect(stripesLabel(stripes)).toBe(label);
  });

  it('shows the belt with its stripes only when there are some', () => {
    expect(beltLabel('Cinza', 0)).toBe('Cinza');
    expect(beltLabel('Verde', 1)).toBe('Verde · 1 grau');
    expect(beltLabel('Verde', 2)).toBe('Verde · 2 graus');
    expect(beltLabel(null, 0)).toBe('—');
  });

  it('writes the age in years, singular for one', () => {
    expect(ageLabel(0)).toBe('0 anos');
    expect(ageLabel(1)).toBe('1 ano');
    expect(ageLabel(8)).toBe('8 anos');
  });

  it('formats dates as dd/mm/aaaa without time-zone shift', () => {
    expect(dateLabel('2026-03-01')).toBe('01/03/2026');
    expect(dateLabel('2012-02-29')).toBe('29/02/2012');
    expect(dateLabel('não é data')).toBe('—');
  });

  it('names the next exam from the API target and kind', () => {
    expect(nextExamLabel(eligibility())).toBe('Faixa Cinza/Azul');
    expect(nextExamLabel(eligibility({ kind: 'STRIPE', target_belt_name: 'Roxa' }))).toBe(
      'Grau (rumo à Roxa)',
    );
    expect(
      nextExamLabel(
        eligibility({
          eligible: false,
          kind: null,
          target_belt_id: null,
          target_belt_name: null,
          reasons: ['Faixa preta é exame da federação'],
        }),
      ),
    ).toBe('—');
  });

  describe('rn001 rn004 status comes from the API eligibility', () => {
    it('is "Elegível" when the API says eligible', () => {
      expect(studentStatus({ active: true, eligibility: eligibility() })).toEqual({
        kind: 'eligible',
        label: 'Elegível',
      });
    });

    it('lists every API reason when blocked', () => {
      const status = studentStatus({
        active: true,
        eligibility: eligibility({
          eligible: false,
          reasons: ['Idade mínima para a faixa Laranja: 11 anos', 'Carência mínima de 12 meses'],
        }),
      });
      expect(status).toEqual({
        kind: 'blocked',
        label: 'Bloqueado: Idade mínima para a faixa Laranja: 11 anos; Carência mínima de 12 meses',
      });
    });

    it('says just "Bloqueado" if the API sends no reason', () => {
      expect(
        studentStatus({ active: true, eligibility: eligibility({ eligible: false }) }).label,
      ).toBe('Bloqueado');
    });

    it('shows "Inativo" over any eligibility', () => {
      expect(studentStatus({ active: false, eligibility: eligibility() })).toEqual({
        kind: 'inactive',
        label: 'Inativo',
      });
      expect(
        studentStatus({
          active: false,
          eligibility: eligibility({ eligible: false, reasons: ['x'] }),
        }).label,
      ).toBe('Inativo');
    });
  });
});
