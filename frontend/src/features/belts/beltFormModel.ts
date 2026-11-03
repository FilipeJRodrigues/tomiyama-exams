/**
 * Values, client checks and API body of the belt form (§ 6.5, RN015).
 *
 * The checks here are a convenience: the API validates the same fields, and also that name
 * and order are unique (409), and its message is the one that counts (shown in the dialog).
 */
import type { Belt, BeltInput, BeltLevel } from '../../api/types';

export const MAX_NAME_LENGTH = 40;
export const MIN_KYU = 1;
export const MAX_KYU = 11;
/** Ceilings of the API for the numbers (RN015, card #47); every one starts at 0. */
export const MAX_SORT_ORDER = 99;
export const MAX_MIN_AGE_YEARS = 99;
export const MAX_MIN_MONTHS_PREVIOUS = 240;

export interface BeltFormValues {
  name: string;
  /** `''` (no kyū) or `'1'` to `'11'`, the value of the select. */
  kyu: string;
  sortOrder: string;
  level: BeltLevel;
  minAgeYears: string;
  minMonthsPrevious: string;
  colorPrimary: string;
  /** `''` for a one-color belt. */
  colorSecondary: string;
}

export type BeltField = keyof BeltFormValues;
export type BeltFormErrors = Partial<Record<BeltField, string>>;

/** Order of the fields on the screen (focus goes to the first invalid one). */
export const FIELD_ORDER: readonly BeltField[] = [
  'name',
  'sortOrder',
  'kyu',
  'level',
  'minAgeYears',
  'minMonthsPrevious',
  'colorPrimary',
  'colorSecondary',
];

export const KYU_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Sem kyū' },
  ...Array.from({ length: MAX_KYU - MIN_KYU + 1 }, (_, index) => {
    const kyu = String(MAX_KYU - index);
    return { value: kyu, label: kyu };
  }),
];

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const NON_NEGATIVE_INT = /^\d+$/;

export function formValuesOf(belt: Belt): BeltFormValues {
  return {
    name: belt.name,
    kyu: belt.kyu === null ? '' : String(belt.kyu),
    sortOrder: String(belt.sort_order),
    level: belt.level,
    minAgeYears: String(belt.min_age_years),
    minMonthsPrevious: String(belt.min_months_previous),
    colorPrimary: belt.color_primary,
    colorSecondary: belt.color_secondary ?? '',
  };
}

/** Whether the text is a `#RRGGBB` color (for the sample next to the field). */
export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value.trim());
}

/** Body of `PUT /belts/{id}`: every field, always. */
export function beltInputOf(values: BeltFormValues): BeltInput {
  const secondary = values.colorSecondary.trim();
  return {
    name: values.name.trim(),
    kyu: values.kyu === '' ? null : Number(values.kyu),
    sort_order: Number(values.sortOrder.trim()),
    level: values.level,
    min_age_years: Number(values.minAgeYears.trim()),
    min_months_previous: Number(values.minMonthsPrevious.trim()),
    color_primary: values.colorPrimary.trim().toUpperCase(),
    color_secondary: secondary ? secondary.toUpperCase() : null,
  };
}

/** Python counts code points, not UTF-16 units: keep the same limit as the API. */
function lengthOf(text: string): number {
  return Array.from(text).length;
}

function wholeNumberProblem(value: string, missing: string, maximum: number): string | undefined {
  const text = value.trim();
  const range = `Use um número inteiro de 0 a ${maximum}.`;
  if (!text) return missing;
  // Digits only: no sign, decimals or exponent. A huge number is just out of range.
  if (!NON_NEGATIVE_INT.test(text)) return range;
  if (Number(text) > maximum) return range;
  return undefined;
}

/** Field errors in pt-BR, empty when the form can be sent. */
export function validateBeltForm(values: BeltFormValues): BeltFormErrors {
  const errors: BeltFormErrors = {};

  const name = values.name.trim();
  if (!name) errors.name = 'Informe o nome.';
  else if (lengthOf(name) > MAX_NAME_LENGTH) {
    errors.name = `Use no máximo ${MAX_NAME_LENGTH} caracteres.`;
  }

  const order = wholeNumberProblem(values.sortOrder, 'Informe a ordem.', MAX_SORT_ORDER);
  if (order) errors.sortOrder = order;

  if (values.kyu !== '') {
    const kyu = Number(values.kyu);
    if (!Number.isInteger(kyu) || kyu < MIN_KYU || kyu > MAX_KYU) {
      errors.kyu = `Escolha um kyū de ${MIN_KYU} a ${MAX_KYU}.`;
    }
  }

  const age = wholeNumberProblem(values.minAgeYears, 'Informe a idade mínima.', MAX_MIN_AGE_YEARS);
  if (age) errors.minAgeYears = age;
  const months = wholeNumberProblem(
    values.minMonthsPrevious,
    'Informe a carência.',
    MAX_MIN_MONTHS_PREVIOUS,
  );
  if (months) errors.minMonthsPrevious = months;

  if (!values.colorPrimary.trim()) errors.colorPrimary = 'Informe a cor.';
  else if (!isHexColor(values.colorPrimary)) errors.colorPrimary = 'Use o formato #RRGGBB.';
  if (values.colorSecondary.trim() && !isHexColor(values.colorSecondary)) {
    errors.colorSecondary = 'Use o formato #RRGGBB.';
  }

  return errors;
}

export function firstInvalidField(errors: BeltFormErrors): BeltField | undefined {
  return FIELD_ORDER.find((field) => errors[field]);
}
