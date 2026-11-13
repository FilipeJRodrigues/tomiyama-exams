import { describe, expect, it } from 'vitest';

import {
  KYU_OPTIONS,
  beltInputOf,
  firstInvalidField,
  formValuesOf,
  limitsInputOf,
  validateBeltForm,
  validateLimits,
  type BeltFormValues,
} from '../../../src/features/belts/beltFormModel';
import { mockBelts } from '../../../src/mocks/data';

const BRANCA = mockBelts.find((belt) => belt.name === 'Branca')!;
const CINZA_AZUL = mockBelts.find((belt) => belt.name === 'Cinza/Azul')!;

function valuesWith(changes: Partial<BeltFormValues>): BeltFormValues {
  return { ...formValuesOf(CINZA_AZUL), ...changes };
}

describe('belt form model (§ 6.5)', () => {
  it('starts from the belt and sends it back unchanged', () => {
    expect(beltInputOf(formValuesOf(CINZA_AZUL))).toEqual({
      name: 'Cinza/Azul',
      kyu: 9,
      sort_order: 3,
      level: 'BASIC',
      min_age_years: 6,
      min_months_previous: 6,
      color_primary: '#9E9E9E',
      color_secondary: '#1E63C6',
    });
  });

  it('sends null for no kyū and for no tip color', () => {
    const values = formValuesOf(BRANCA);
    expect(values.kyu).toBe('');
    expect(values.colorSecondary).toBe('');
    expect(beltInputOf(values)).toMatchObject({ kyu: null, color_secondary: null });
  });

  it('trims the texts and writes the colors in upper case', () => {
    expect(
      beltInputOf(
        valuesWith({
          name: '  Cinza/Azul ',
          sortOrder: ' 4 ',
          colorPrimary: ' #abcdef ',
          colorSecondary: '   ',
        }),
      ),
    ).toMatchObject({
      name: 'Cinza/Azul',
      sort_order: 4,
      color_primary: '#ABCDEF',
      color_secondary: null,
    });
  });

  it('accepts the belt as it is', () => {
    expect(validateBeltForm(formValuesOf(CINZA_AZUL))).toEqual({});
    expect(validateBeltForm(formValuesOf(BRANCA))).toEqual({});
  });

  it('asks for the required fields', () => {
    const errors = validateBeltForm(
      valuesWith({
        name: ' ',
        sortOrder: '',
        minAgeYears: '',
        minMonthsPrevious: '',
        colorPrimary: '',
      }),
    );
    expect(errors).toEqual({
      name: 'Informe o nome.',
      sortOrder: 'Informe a ordem.',
      minAgeYears: 'Informe a idade mínima.',
      minMonthsPrevious: 'Informe a carência.',
      colorPrimary: 'Informe a cor.',
    });
    expect(firstInvalidField(errors)).toBe('name');
  });

  it('rn015 refuses negative, decimal and non-numeric values (whole numbers from 0)', () => {
    for (const value of ['-1', '1.5', '1,5', 'seis', '1e3']) {
      expect(validateBeltForm(valuesWith({ minAgeYears: value })).minAgeYears).toBe(
        'Use um número inteiro de 0 a 99.',
      );
    }
    expect(validateBeltForm(valuesWith({ sortOrder: '0', minMonthsPrevious: '0' }))).toEqual({});
  });

  it('rn015 accepts each number up to its ceiling (order 99, age 99, months 240)', () => {
    expect(
      validateBeltForm(
        valuesWith({ sortOrder: '99', minAgeYears: '99', minMonthsPrevious: '240' }),
      ),
    ).toEqual({});
  });

  it('rn015 refuses each number one past its ceiling, with the accepted range', () => {
    const errors = validateBeltForm(
      valuesWith({ sortOrder: '100', minAgeYears: '100', minMonthsPrevious: '241' }),
    );
    expect(errors).toEqual({
      sortOrder: 'Use um número inteiro de 0 a 99.',
      minAgeYears: 'Use um número inteiro de 0 a 99.',
      minMonthsPrevious: 'Use um número inteiro de 0 a 240.',
    });
    expect(firstInvalidField(errors)).toBe('sortOrder');
  });

  it('rn015 refuses a huge number with the range, not as a non-integer', () => {
    const huge = '99999999999999999999';
    const errors = validateBeltForm(
      valuesWith({ sortOrder: huge, minAgeYears: huge, minMonthsPrevious: huge }),
    );
    expect(errors.sortOrder).toBe('Use um número inteiro de 0 a 99.');
    expect(errors.minAgeYears).toBe('Use um número inteiro de 0 a 99.');
    expect(errors.minMonthsPrevious).toBe('Use um número inteiro de 0 a 240.');
  });

  it('rn015 refuses colors outside #RRGGBB', () => {
    for (const value of ['9E9E9E', '#9E9', '#GGGGGG', 'cinza']) {
      expect(validateBeltForm(valuesWith({ colorPrimary: value })).colorPrimary).toBe(
        'Use o formato #RRGGBB.',
      );
      expect(validateBeltForm(valuesWith({ colorSecondary: value })).colorSecondary).toBe(
        'Use o formato #RRGGBB.',
      );
    }
  });

  it('limits the name to 40 characters, counted like the API', () => {
    expect(validateBeltForm(valuesWith({ name: 'a'.repeat(40) })).name).toBeUndefined();
    expect(validateBeltForm(valuesWith({ name: 'a'.repeat(41) })).name).toBe(
      'Use no máximo 40 caracteres.',
    );
    // 40 letters with a macron are 40 code points.
    expect(validateBeltForm(valuesWith({ name: 'ū'.repeat(40) })).name).toBeUndefined();
  });

  it('offers no kyū and 11 down to 1 in the kyū select', () => {
    expect(KYU_OPTIONS.map((option) => option.value)).toEqual([
      '',
      '11',
      '10',
      '9',
      '8',
      '7',
      '6',
      '5',
      '4',
      '3',
      '2',
      '1',
    ]);
    expect(KYU_OPTIONS[0]?.label).toBe('Sem kyū');
  });
});

describe('belt form model of an examiner who is not the admin master (#143)', () => {
  it('rn001 rn002 sends the typed age and months, and every other field as read', () => {
    // Even fields the form would change (spaces, lower case) go exactly as read.
    const read = { ...CINZA_AZUL, name: ' Cinza/Azul ', color_secondary: '#1e63c6' };
    const values = valuesWith({
      name: 'Outra',
      sortOrder: '50',
      kyu: '1',
      level: 'INTERMEDIATE',
      colorPrimary: '#000000',
      colorSecondary: '',
      minAgeYears: ' 8 ',
      minMonthsPrevious: '240',
    });
    expect(limitsInputOf(read, values)).toEqual({
      name: ' Cinza/Azul ',
      kyu: 9,
      sort_order: 3,
      level: 'BASIC',
      min_age_years: 8,
      min_months_previous: 240,
      color_primary: '#9E9E9E',
      color_secondary: '#1e63c6',
    });
  });

  it('keeps null kyū and tips as read', () => {
    expect(limitsInputOf(BRANCA, formValuesOf(BRANCA))).toMatchObject({
      kyu: null,
      color_secondary: null,
    });
  });

  it('rn001 rn002 checks only the age and the months, with the same messages', () => {
    const errors = validateLimits(
      valuesWith({ name: '', colorPrimary: 'cinza', minAgeYears: '100', minMonthsPrevious: '' }),
    );
    expect(errors).toEqual({
      minAgeYears: 'Use um número inteiro de 0 a 99.',
      minMonthsPrevious: 'Informe a carência.',
    });
    expect(firstInvalidField(errors)).toBe('minAgeYears');
    expect(validateLimits(valuesWith({ minAgeYears: '', minMonthsPrevious: '241' }))).toEqual({
      minAgeYears: 'Informe a idade mínima.',
      minMonthsPrevious: 'Use um número inteiro de 0 a 240.',
    });
  });

  it('rn001 rn002 accepts 0 and the ceilings (age 99, months 240)', () => {
    expect(validateLimits(valuesWith({ minAgeYears: '0', minMonthsPrevious: '0' }))).toEqual({});
    expect(validateLimits(valuesWith({ minAgeYears: '99', minMonthsPrevious: '240' }))).toEqual({});
  });
});
