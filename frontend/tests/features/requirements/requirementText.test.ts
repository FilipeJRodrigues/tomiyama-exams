/** Texts of the requirements screen (§ 6.5). */
import { describe, expect, it } from 'vitest';

import {
  countSummary,
  defaultBeltId,
  emptyLabel,
  itemCountLabel,
  kindLabel,
  shortText,
} from '../../../src/features/requirements/requirementText';
import { mockBelts } from '../../../src/mocks/data';

describe('requirement texts', () => {
  it('the default belt is Branca/Cinza, whatever the order the belts come in', () => {
    const brancaCinza = mockBelts.find((belt) => belt.name === 'Branca/Cinza')!;
    expect(defaultBeltId([...mockBelts].reverse())).toBe(brancaCinza.id);
    const renamed = mockBelts.map((belt) =>
      belt.id === brancaCinza.id ? { ...belt, name: 'Outra' } : belt,
    );
    expect(defaultBeltId(renamed)).toBe(brancaCinza.id);
    expect(defaultBeltId(mockBelts.slice(0, 1))).toBe(mockBelts[0]?.id);
    expect(defaultBeltId([])).toBeUndefined();
  });

  it('labels the kinds in pt-BR', () => {
    expect(kindLabel('THEORY')).toBe('Teórico');
    expect(kindLabel('PRACTICE')).toBe('Prático');
  });

  it('counts the items, by kind when both are there', () => {
    expect(itemCountLabel(1)).toBe('1 item');
    expect(itemCountLabel(0)).toBe('0 itens');
    expect(countSummary(['THEORY', 'PRACTICE', 'PRACTICE'])).toBe(
      '3 itens: 1 teórico e 2 práticos',
    );
    expect(countSummary(['THEORY', 'THEORY', 'PRACTICE'])).toBe('3 itens: 2 teóricos e 1 prático');
    expect(countSummary(['PRACTICE', 'PRACTICE'])).toBe('2 itens');
  });

  it('says what is empty for the filter', () => {
    expect(emptyLabel(null)).toBe('Nenhum item nesta faixa.');
    expect(emptyLabel('THEORY')).toBe('Nenhum item teórico nesta faixa.');
    expect(emptyLabel('PRACTICE')).toBe('Nenhum item prático nesta faixa.');
  });

  it('shortens a long description at a word, keeping a short one whole', () => {
    expect(shortText('  Osoto   gari ')).toBe('Osoto gari');
    const long = 'Demonstrar a forma correta de cair para trás e para os lados sem bater a cabeça';
    const short = shortText(long);
    expect(short.endsWith('…')).toBe(true);
    expect(Array.from(short).length).toBeLessThanOrEqual(61);
    expect(long.startsWith(short.slice(0, -1))).toBe(true);
  });
});
