import { describe, expect, it } from 'vitest';

import { foldText, matchesQuery } from '../../src/lib/text';

describe('name search', () => {
  it('drops accents and case', () => {
    expect(foldText('Élida Ramos')).toBe('elida ramos');
    expect(foldText('JOÃO Araújo')).toBe('joao araujo');
    expect(foldText('Çé')).toBe('ce');
  });

  it.each([
    ['Fábio Lima', 'fabio', true],
    ['Fábio Lima', 'FÁBIO', true],
    ['Ana Souza', '  ana   souza ', true],
    ['Ana Souza', 'souza', true],
    ['Ana Souza', 'bruno', false],
    ['Ana Souza', '', true],
    ['Ana Souza', '   ', true],
  ])('"%s" matches "%s": %s', (name, query, expected) => {
    expect(matchesQuery(name, query)).toBe(expected);
  });
});
