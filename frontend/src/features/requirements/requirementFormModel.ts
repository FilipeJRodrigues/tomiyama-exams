/**
 * Values, client checks and API body of the requirement form (§ 6.5, RN017).
 *
 * The checks here are a convenience: the API validates the same fields (and that the belt
 * exists, that a full belt needs an explicit order, that an item with answers keeps its belt
 * and kind) and its message is the one that counts (shown in the dialog).
 */
import type { Requirement, RequirementInput, RequirementKind } from '../../api/types';
import { REQUIREMENT_KIND_LABELS } from '../../lib/labels';

/** Limits of `domain/requirements.py` (`MAX_CATEGORY`, `MAX_TEXT`, `MAX_SORT_ORDER`). */
export const MAX_CATEGORY_LENGTH = 60;
export const MAX_TEXT_LENGTH = 2000;
export const MAX_SORT_ORDER = 9999;

export interface RequirementFormValues {
  beltId: string;
  /** `''` until a kind is chosen (new item with the "Todos" filter). */
  kind: RequirementKind | '';
  category: string;
  description: string;
  expectedAnswer: string;
  /** `''` on a new item: the API puts it at the end of the belt. */
  sortOrder: string;
}

export type RequirementField = keyof RequirementFormValues;
export type RequirementFormErrors = Partial<Record<RequirementField, string>>;

/** Order of the fields on the screen (focus goes to the first invalid one). */
export const FIELD_ORDER: readonly RequirementField[] = [
  'beltId',
  'kind',
  'category',
  'description',
  'expectedAnswer',
  'sortOrder',
];

export const KIND_OPTIONS: readonly { value: RequirementKind; label: string }[] = (
  Object.keys(REQUIREMENT_KIND_LABELS) as RequirementKind[]
).map((kind) => ({ value: kind, label: REQUIREMENT_KIND_LABELS[kind] }));

export function isRequirementKind(value: string): value is RequirementKind {
  return value in REQUIREMENT_KIND_LABELS;
}

const NON_NEGATIVE_INT = /^\d+$/;

/** Values of an existing item (edit dialog). */
export function formValuesOf(requirement: Requirement): RequirementFormValues {
  return {
    beltId: requirement.belt_id,
    kind: requirement.kind,
    category: requirement.category,
    description: requirement.description,
    expectedAnswer: requirement.expected_answer ?? '',
    sortOrder: String(requirement.sort_order),
  };
}

/** Values of a new item: the belt and the kind of the current filter. */
export function newFormValues(beltId: string, kind: RequirementKind | null): RequirementFormValues {
  return {
    beltId,
    kind: kind ?? '',
    category: '',
    description: '',
    expectedAnswer: '',
    sortOrder: '',
  };
}

/**
 * Body of `POST`/`PUT /requirements`. A blank order is left out (end of the belt, only
 * allowed on a new item); a blank expected answer is `null`.
 */
export function requirementInputOf(values: RequirementFormValues): RequirementInput {
  const kind: RequirementKind = values.kind === '' ? 'THEORY' : values.kind;
  const expected = values.expectedAnswer.trim();
  const order = values.sortOrder.trim();
  return {
    belt_id: values.beltId,
    kind,
    category: values.category.trim(),
    description: values.description.trim(),
    expected_answer: expected ? expected : null,
    ...(order ? { sort_order: Number(order) } : {}),
  };
}

/** Python counts code points, not UTF-16 units: keep the same limit as the API. */
function lengthOf(text: string): number {
  return Array.from(text).length;
}

function tooLong(text: string, max: number): string | undefined {
  return lengthOf(text.trim()) > max ? `Use no máximo ${String(max)} caracteres.` : undefined;
}

/**
 * Field errors in pt-BR, empty when the form can be sent. `orderRequired`: the order may be
 * blank only on a new item.
 */
export function validateRequirementForm(
  values: RequirementFormValues,
  { orderRequired }: { orderRequired: boolean },
): RequirementFormErrors {
  const errors: RequirementFormErrors = {};
  const set = (field: RequirementField, message: string | undefined) => {
    if (message) errors[field] = message;
  };

  if (!values.beltId) set('beltId', 'Escolha a faixa.');
  if (values.kind === '') set('kind', 'Escolha o tipo.');

  set(
    'category',
    values.category.trim() ? tooLong(values.category, MAX_CATEGORY_LENGTH) : 'Informe a categoria.',
  );
  set(
    'description',
    values.description.trim()
      ? tooLong(values.description, MAX_TEXT_LENGTH)
      : 'Informe a descrição.',
  );
  set('expectedAnswer', tooLong(values.expectedAnswer, MAX_TEXT_LENGTH));

  const order = values.sortOrder.trim();
  if (!order) {
    if (orderRequired) set('sortOrder', 'Informe a ordem.');
  } else if (!NON_NEGATIVE_INT.test(order) || Number(order) > MAX_SORT_ORDER) {
    // Digits only: no sign, decimals or exponent. A huge number is just out of range.
    set('sortOrder', `Use um número inteiro de 0 a ${String(MAX_SORT_ORDER)}.`);
  }

  return errors;
}

export function firstInvalidField(errors: RequirementFormErrors): RequirementField | undefined {
  return FIELD_ORDER.find((field) => errors[field]);
}
