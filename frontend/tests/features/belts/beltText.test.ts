import { describe, expect, it } from 'vitest';

import {
  colorsLabel,
  kyuLabel,
  levelLabel,
  minAgeLabel,
  minMonthsLabel,
  sortBelts,
} from '../../../src/features/belts/beltText';
import { mockBelts } from '../../../src/mocks/data';

describe('belt texts (§ 6.5)', () => {
  it('writes the kyū, or a dash without one', () => {
    expect(kyuLabel(null)).toBe('—');
    expect(kyuLabel(11)).toBe('11');
  });

  it('writes the level in pt-BR', () => {
    expect(levelLabel({ level: 'BASIC' })).toBe('Básico');
    expect(levelLabel({ level: 'INTERMEDIATE' })).toBe('Intermediário');
  });

  it('writes the minimum age and the waiting time', () => {
    expect(minAgeLabel(0)).toBe('Sem mínimo');
    expect(minAgeLabel(1)).toBe('1 ano');
    expect(minAgeLabel(14)).toBe('14 anos');
    expect(minMonthsLabel(0)).toBe('Sem carência');
    expect(minMonthsLabel(1)).toBe('1 mês');
    expect(minMonthsLabel(12)).toBe('12 meses');
  });

  it('writes the colors, with the tips of two-color belts', () => {
    expect(colorsLabel({ color_primary: '#9E9E9E', color_secondary: null })).toBe('#9E9E9E');
    expect(colorsLabel({ color_primary: '#9E9E9E', color_secondary: '#1E63C6' })).toBe(
      '#9E9E9E, pontas #1E63C6',
    );
  });

  it('sorts by graduation order, also with gaps, without touching the input', () => {
    const input = [...mockBelts]
      .reverse()
      .map((belt) => ({ ...belt, sort_order: belt.sort_order * 10 }));
    const sorted = sortBelts(input);
    expect(sorted.map((belt) => belt.name)).toEqual(mockBelts.map((belt) => belt.name));
    expect(input[0]?.name).toBe('Marrom');
  });
});
