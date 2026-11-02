import { describe, expect, it } from 'vitest';

import type { Belt, StudentView } from '../../../src/api/types';
import {
  EMPTY_STUDENT_FORM,
  INVALID_DATES_MESSAGE,
  beltOptions,
  firstInvalidField,
  formValuesOf,
  stripesOptionLabel,
  studentInputOf,
  validateStudentForm,
  type StudentFormValues,
} from '../../../src/features/students/studentFormModel';
import { mockBelts } from '../../../src/mocks/data';

const TODAY = '2026-11-02';

const VALID: StudentFormValues = {
  fullName: 'Ana Souza',
  beltId: 'faixa-cinza',
  birthDate: '2018-05-10',
  beltSince: '2026-03-14',
  stripes: '0',
  federationId: '',
  active: true,
};

describe('student form model (§ 6.2, § 3.3)', () => {
  it('accepts a complete form', () => {
    expect(validateStudentForm(VALID, TODAY)).toEqual({});
  });

  it('asks for every required field, in screen order', () => {
    const errors = validateStudentForm(EMPTY_STUDENT_FORM, TODAY);
    expect(errors).toEqual({
      fullName: 'Informe o nome.',
      beltId: 'Selecione a faixa atual.',
      birthDate: 'Informe a data de nascimento.',
      beltSince: 'Informe desde quando está na faixa atual.',
    });
    expect(firstInvalidField(errors)).toBe('fullName');
  });

  it('treats a name of only spaces as empty', () => {
    expect(validateStudentForm({ ...VALID, fullName: '   ' }, TODAY).fullName).toBe(
      'Informe o nome.',
    );
  });

  it('limits the name to 120 and the federation id to 30 characters, like the API', () => {
    expect(validateStudentForm({ ...VALID, fullName: 'a'.repeat(120) }, TODAY)).toEqual({});
    expect(validateStudentForm({ ...VALID, fullName: 'a'.repeat(121) }, TODAY).fullName).toBe(
      'Use no máximo 120 caracteres.',
    );
    expect(validateStudentForm({ ...VALID, federationId: 'x'.repeat(30) }, TODAY)).toEqual({});
    expect(
      validateStudentForm({ ...VALID, federationId: 'x'.repeat(31) }, TODAY).federationId,
    ).toBe('Use no máximo 30 caracteres.');
  });

  it('counts code points, not UTF-16 units, as the backend does', () => {
    // 120 emoji are 240 UTF-16 units, but 120 characters for Python.
    expect(validateStudentForm({ ...VALID, fullName: '😀'.repeat(120) }, TODAY)).toEqual({});
  });

  it('rejects stripes outside 0–4', () => {
    expect(validateStudentForm({ ...VALID, stripes: '5' }, TODAY).stripes).toBe(
      'Escolha de 0 a 4 graus.',
    );
    expect(validateStudentForm({ ...VALID, stripes: '4' }, TODAY)).toEqual({});
  });

  it('rn014 refuses a future birth date with the API message', () => {
    const errors = validateStudentForm(
      { ...VALID, birthDate: '2026-11-03', beltSince: '2026-11-03' },
      TODAY,
    );
    expect(errors.birthDate).toBe(INVALID_DATES_MESSAGE);
    expect(errors.beltSince).toBe(INVALID_DATES_MESSAGE);
  });

  it('rn014 refuses a future belt date', () => {
    expect(validateStudentForm({ ...VALID, beltSince: '2026-11-03' }, TODAY)).toEqual({
      beltSince: INVALID_DATES_MESSAGE,
    });
  });

  it('rn014 refuses a belt date before the birth date', () => {
    expect(validateStudentForm({ ...VALID, beltSince: '2018-05-09' }, TODAY)).toEqual({
      beltSince: INVALID_DATES_MESSAGE,
    });
  });

  it('rn014 accepts today and a belt date equal to the birth date', () => {
    expect(validateStudentForm({ ...VALID, birthDate: TODAY, beltSince: TODAY }, TODAY)).toEqual(
      {},
    );
  });

  it('rejects a date that does not exist', () => {
    expect(validateStudentForm({ ...VALID, birthDate: '2018-02-30' }, TODAY).birthDate).toBe(
      'Data inválida.',
    );
  });

  it('sends every field, trimmed, with an empty federation id as null', () => {
    expect(
      studentInputOf({ ...VALID, fullName: '  Ana Souza ', federationId: '  ', stripes: '3' }),
    ).toEqual({
      full_name: 'Ana Souza',
      birth_date: '2018-05-10',
      current_belt_id: 'faixa-cinza',
      current_belt_since: '2026-03-14',
      stripes: 3,
      federation_id: null,
      active: true,
    });
    expect(studentInputOf({ ...VALID, federationId: ' FPJ-123 ' }).federation_id).toBe('FPJ-123');
  });

  it('fills the form from the API student, dates untouched', () => {
    const view = {
      id: 's1',
      full_name: 'Ana',
      birth_date: '2018-03-01',
      current_belt_id: 'b1',
      current_belt_since: '2026-03-01',
      stripes: 2,
      federation_id: null,
      active: false,
    } as StudentView;
    expect(formValuesOf(view)).toEqual({
      fullName: 'Ana',
      beltId: 'b1',
      birthDate: '2018-03-01',
      beltSince: '2026-03-01',
      stripes: '2',
      federationId: '',
      active: false,
    });
  });

  it('lists the belts in graduation order with the API names', () => {
    const shuffled: Belt[] = [...mockBelts].reverse();
    expect(beltOptions(shuffled, '').map((option) => option.label)).toEqual(
      mockBelts.map((belt) => belt.name),
    );
  });

  it('keeps a belt that no longer exists selected under a visible label', () => {
    const [first] = beltOptions(mockBelts, 'faixa-apagada');
    expect(first).toEqual({ value: 'faixa-apagada', label: 'Faixa não encontrada' });
  });

  it('labels the stripes in pt-BR', () => {
    expect([0, 1, 2, 4].map(stripesOptionLabel)).toEqual([
      'Nenhum',
      '1 grau',
      '2 graus',
      '4 graus',
    ]);
  });
});
