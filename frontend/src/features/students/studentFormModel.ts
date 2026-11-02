/**
 * Values, client checks and API body of the student form (§ 6.2, § 3.3).
 *
 * The checks here are a convenience: the API validates the same fields and its message
 * is the one that counts (shown above the form). Nothing here knows whether the student
 * has exams, so the graduation lock (RN013) is left to the API.
 */
import type { Belt, StudentInput, StudentView } from '../../api/types';
import { parseIsoDate } from '../../lib/dates';

export const MAX_NAME_LENGTH = 120;
export const MAX_FEDERATION_ID_LENGTH = 30;
export const MAX_STRIPES = 4;

/** Same text as the API (`validate_dates` in `backend/src/domain/students.py`). */
export const INVALID_DATES_MESSAGE = 'Datas inválidas: verifique nascimento e data da faixa atual';

export interface StudentFormValues {
  fullName: string;
  beltId: string;
  /** `AAAA-MM-DD` from the native date input; empty when blank or incomplete. */
  birthDate: string;
  beltSince: string;
  /** `'0'` to `'4'`, the value of the select. */
  stripes: string;
  federationId: string;
  active: boolean;
}

export type StudentField = keyof StudentFormValues;
export type StudentFormErrors = Partial<Record<StudentField, string>>;

/** Order of the fields on the screen (focus goes to the first invalid one). */
export const FIELD_ORDER: readonly StudentField[] = [
  'fullName',
  'beltId',
  'birthDate',
  'beltSince',
  'stripes',
  'federationId',
  'active',
];

export const EMPTY_STUDENT_FORM: StudentFormValues = {
  fullName: '',
  beltId: '',
  birthDate: '',
  beltSince: '',
  stripes: '0',
  federationId: '',
  active: true,
};

export function formValuesOf(student: StudentView): StudentFormValues {
  return {
    fullName: student.full_name,
    beltId: student.current_belt_id,
    birthDate: student.birth_date,
    beltSince: student.current_belt_since,
    stripes: String(student.stripes),
    federationId: student.federation_id ?? '',
    active: student.active,
  };
}

/** Body of `POST`/`PUT /students`: every field, always (RN013 accepts unchanged values). */
export function studentInputOf(values: StudentFormValues): StudentInput {
  const federationId = values.federationId.trim();
  return {
    full_name: values.fullName.trim(),
    birth_date: values.birthDate,
    current_belt_id: values.beltId,
    current_belt_since: values.beltSince,
    stripes: Number(values.stripes),
    federation_id: federationId || null,
    active: values.active,
  };
}

/** Python counts code points, not UTF-16 units: keep the same limit as the API. */
function lengthOf(text: string): number {
  return Array.from(text).length;
}

function dateProblem(value: string, missing: string): string | undefined {
  if (!value) return missing;
  return parseIsoDate(value) ? undefined : 'Data inválida.';
}

/**
 * Field errors in pt-BR, empty when the form can be sent.
 *
 * RN014 (no future dates, belt date not before birth) uses the API text, on the date that
 * breaks the rule.
 */
export function validateStudentForm(values: StudentFormValues, today: string): StudentFormErrors {
  const errors: StudentFormErrors = {};

  const name = values.fullName.trim();
  if (!name) errors.fullName = 'Informe o nome.';
  else if (lengthOf(name) > MAX_NAME_LENGTH) {
    errors.fullName = `Use no máximo ${MAX_NAME_LENGTH} caracteres.`;
  }

  if (!values.beltId) errors.beltId = 'Selecione a faixa atual.';

  const birthProblem = dateProblem(values.birthDate, 'Informe a data de nascimento.');
  const sinceProblem = dateProblem(values.beltSince, 'Informe desde quando está na faixa atual.');
  if (birthProblem) errors.birthDate = birthProblem;
  else if (values.birthDate > today) errors.birthDate = INVALID_DATES_MESSAGE;
  if (sinceProblem) errors.beltSince = sinceProblem;
  else if (values.beltSince > today || (!birthProblem && values.beltSince < values.birthDate)) {
    errors.beltSince = INVALID_DATES_MESSAGE;
  }

  const stripes = Number(values.stripes);
  if (!Number.isInteger(stripes) || stripes < 0 || stripes > MAX_STRIPES) {
    errors.stripes = `Escolha de 0 a ${MAX_STRIPES} graus.`;
  }

  if (lengthOf(values.federationId.trim()) > MAX_FEDERATION_ID_LENGTH) {
    errors.federationId = `Use no máximo ${MAX_FEDERATION_ID_LENGTH} caracteres.`;
  }

  return errors;
}

export function firstInvalidField(errors: StudentFormErrors): StudentField | undefined {
  return FIELD_ORDER.find((field) => errors[field]);
}

/** `Nenhum`, `1 grau`, `2 graus`… for the stripes select. */
export function stripesOptionLabel(stripes: number): string {
  if (stripes === 0) return 'Nenhum';
  return stripes === 1 ? '1 grau' : `${stripes} graus`;
}

export interface BeltOption {
  value: string;
  label: string;
}

/**
 * Belts in graduation order, with the API names. A belt that no longer exists keeps its
 * id selected under a visible label, so the form does not silently pick another one.
 */
export function beltOptions(belts: readonly Belt[], currentBeltId: string): BeltOption[] {
  const options = [...belts]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((belt) => ({ value: belt.id, label: belt.name }));
  if (currentBeltId && !belts.some((belt) => belt.id === currentBeltId)) {
    options.unshift({ value: currentBeltId, label: 'Faixa não encontrada' });
  }
  return options;
}
