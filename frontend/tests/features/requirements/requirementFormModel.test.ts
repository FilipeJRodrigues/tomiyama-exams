/** Client checks and API body of the requirement form (§ 6.5, RN017). */
import { describe, expect, it } from 'vitest';

import type { Requirement } from '../../../src/api/types';
import {
  firstInvalidField,
  formValuesOf,
  newFormValues,
  requirementInputOf,
  validateRequirementForm,
  type RequirementFormValues,
} from '../../../src/features/requirements/requirementFormModel';

const ITEM: Requirement = {
  id: 'r1',
  belt_id: 'b1',
  kind: 'PRACTICE',
  category: 'Naguewaza',
  description: 'Osoto gari',
  expected_answer: null,
  sort_order: 4,
};

const VALID: RequirementFormValues = {
  beltId: 'b1',
  kind: 'THEORY',
  category: 'Vocabulário',
  description: 'Professor',
  expectedAnswer: 'Sensei',
  sortOrder: '',
};

describe('requirement form model', () => {
  it('starts an edit from the item and a new one from the filter', () => {
    expect(formValuesOf(ITEM)).toEqual({
      beltId: 'b1',
      kind: 'PRACTICE',
      category: 'Naguewaza',
      description: 'Osoto gari',
      expectedAnswer: '',
      sortOrder: '4',
    });
    expect(newFormValues('b2', null)).toMatchObject({ beltId: 'b2', kind: '', sortOrder: '' });
    expect(newFormValues('b2', 'THEORY').kind).toBe('THEORY');
  });

  it('trims the texts, sends null for a blank answer and leaves a blank order out', () => {
    expect(
      requirementInputOf({ ...VALID, category: ' Vocabulário ', expectedAnswer: '  ' }),
    ).toEqual({
      belt_id: 'b1',
      kind: 'THEORY',
      category: 'Vocabulário',
      description: 'Professor',
      expected_answer: null,
    });
    expect(requirementInputOf({ ...VALID, sortOrder: ' 0 ' }).sort_order).toBe(0);
    expect(requirementInputOf(formValuesOf(ITEM))).toEqual({
      belt_id: 'b1',
      kind: 'PRACTICE',
      category: 'Naguewaza',
      description: 'Osoto gari',
      expected_answer: null,
      sort_order: 4,
    });
  });

  it('asks for belt, kind, category and description; the order only on an edit', () => {
    const empty = newFormValues('', null);
    expect(validateRequirementForm(empty, { orderRequired: false })).toEqual({
      beltId: 'Escolha a faixa.',
      kind: 'Escolha o tipo.',
      category: 'Informe a categoria.',
      description: 'Informe a descrição.',
    });
    expect(validateRequirementForm(VALID, { orderRequired: false })).toEqual({});
    expect(validateRequirementForm(VALID, { orderRequired: true })).toEqual({
      sortOrder: 'Informe a ordem.',
    });
    expect(firstInvalidField(validateRequirementForm(empty, { orderRequired: true }))).toBe(
      'beltId',
    );
  });

  it('rn015 accepts orders 0 to 9999 and refuses the rest with the range', () => {
    for (const order of ['0', '9999', '0042']) {
      expect(
        validateRequirementForm({ ...VALID, sortOrder: order }, { orderRequired: true }),
      ).toEqual({});
    }
    for (const order of ['10000', '-1', '1.5', '1e3', 'abc', '9'.repeat(40)]) {
      expect(
        validateRequirementForm({ ...VALID, sortOrder: order }, { orderRequired: true }).sortOrder,
      ).toBe('Use um número inteiro de 0 a 9999.');
    }
  });

  it('keeps the limits of the API, counting code points', () => {
    const ok = validateRequirementForm(
      {
        ...VALID,
        category: '🥋'.repeat(60),
        description: 'x'.repeat(2000),
        expectedAnswer: 'y'.repeat(2000),
      },
      { orderRequired: false },
    );
    expect(ok).toEqual({});
    const long = validateRequirementForm(
      {
        ...VALID,
        category: 'c'.repeat(61),
        description: 'x'.repeat(2001),
        expectedAnswer: 'y'.repeat(2001),
      },
      { orderRequired: false },
    );
    expect(long).toEqual({
      category: 'Use no máximo 60 caracteres.',
      description: 'Use no máximo 2000 caracteres.',
      expectedAnswer: 'Use no máximo 2000 caracteres.',
    });
  });
});
