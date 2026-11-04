/**
 * Values, client checks and API body of the academy data form (§ 6.6, model in § 3.7).
 *
 * The checks here are a convenience: the API validates the same fields and decides who may
 * change the sensei (only the admin master; the others resend the stored one). Its message is
 * the one that counts (shown above the fields).
 */
import type {
  AcademySettings,
  AcademySettingsInput,
  Examiner,
  SettingsSensei,
} from '../../api/types';
import { personName } from '../exam/decisionModel';

/** Limits of `domain/settings.py` (`MAX_ACADEMY_NAME`, `MAX_CERTIFICATE_CITY`). */
export const MAX_ACADEMY_NAME_LENGTH = 255;
export const MAX_CERTIFICATE_CITY_LENGTH = 80;

/** Value of the "Sem sensei" option of the selector. */
export const NO_SENSEI = '';

export interface AcademyFormValues {
  academyName: string;
  /** `sub` of the sensei, or `NO_SENSEI`. Only the admin master changes it. */
  senseiId: string;
  certificateCity: string;
}

export type AcademyField = keyof AcademyFormValues;
export type AcademyFormErrors = Partial<Record<AcademyField, string>>;

/** Order of the fields on the screen (focus goes to the first invalid one). */
export const FIELD_ORDER: readonly AcademyField[] = ['academyName', 'senseiId', 'certificateCity'];

export interface SenseiOption {
  value: string;
  label: string;
}

/** Values of the stored settings; every field is empty before the first save. */
export function formValuesOf(settings: AcademySettings): AcademyFormValues {
  return {
    academyName: settings.academy_name ?? '',
    senseiId: settings.sensei_user_id ?? NO_SENSEI,
    certificateCity: settings.certificate_city ?? '',
  };
}

/** Whether two sets of form values are the same, field by field. */
export function sameFormValues(a: AcademyFormValues, b: AcademyFormValues): boolean {
  return FIELD_ORDER.every((field) => a[field] === b[field]);
}

/**
 * The fields after the settings were read again (`incoming`): a field still as it was at the
 * last sync (`synced`), so not edited since then, shows the new value; an edited one (any
 * other value) keeps what the user typed. There is no conflict notice nor lock in the API.
 */
export function followReload(
  values: AcademyFormValues,
  synced: AcademyFormValues,
  incoming: AcademyFormValues,
): AcademyFormValues {
  const next = { ...values };
  for (const field of FIELD_ORDER) {
    if (values[field] === synced[field]) next[field] = incoming[field];
  }
  return next;
}

/**
 * The fields after a save: those still as submitted show what the API stored (trimmed, blanks
 * as empty), so none of them counts as edited; those changed while the save was on its way
 * keep what was typed.
 */
export function followSave(
  current: AcademyFormValues,
  submitted: AcademyFormValues,
  saved: AcademyFormValues,
): AcademyFormValues {
  const next = { ...current };
  for (const field of FIELD_ORDER) {
    if (current[field] === submitted[field]) next[field] = saved[field];
  }
  return next;
}

/** Fields whose value differs between `before` and `after`, in screen order. */
export function changedFields(before: AcademyFormValues, after: AcademyFormValues): AcademyField[] {
  return FIELD_ORDER.filter((field) => before[field] !== after[field]);
}

/** The field errors without those of `fields` (their value was replaced under them). */
export function withoutErrors(
  errors: AcademyFormErrors,
  fields: readonly AcademyField[],
): AcademyFormErrors {
  if (!fields.some((field) => errors[field])) return errors;
  const next = { ...errors };
  for (const field of fields) next[field] = undefined;
  return next;
}

/** Whether nothing was saved yet (`GET /settings` before the first `PUT`). */
export function isFirstUse(settings: AcademySettings): boolean {
  return settings.academy_name === null;
}

/** Whether the stored sensei can no longer decide (account disabled or out of `admin`). */
export function hasInactiveSensei(settings: AcademySettings): boolean {
  return settings.sensei !== null && !settings.sensei.active;
}

/** `Tomiyama (sensei@example.com)`, or the e-mail alone without a name. */
export function examinerLabel(examiner: Examiner): string {
  const name = examiner.name?.trim();
  return name ? `${name} (${examiner.email})` : examiner.email;
}

/** The stored sensei as the selector shows him; `(inativo)` when he can no longer decide. */
export function storedSenseiLabel(sensei: SettingsSensei | null): string {
  if (sensei === null) return 'Sem sensei';
  const email = sensei.email?.trim();
  const name = sensei.name?.trim();
  const label = name && email ? `${name} (${email})` : name || email || 'Examinador não encontrado';
  return sensei.active ? label : `${label} (inativo)`;
}

/** First sentence of the inactive sensei notice: names him when the API still knows him. */
export function inactiveSenseiText(sensei: SettingsSensei): string {
  const name = personName(sensei);
  return name
    ? `O sensei ${name} não é mais um examinador ativo e não pode decidir os exames.`
    : 'O sensei escolhido não é mais um examinador ativo e não pode decidir os exames.';
}

/**
 * Options of the master's selector: "Sem sensei", then the active examiners in the API order.
 * A chosen id missing from them (the stored sensei, now inactive) stays as an option, so the
 * selector shows what is stored instead of silently picking another one.
 */
export function senseiOptions(
  examiners: readonly Examiner[],
  settings: AcademySettings,
  selectedId: string,
): SenseiOption[] {
  const options: SenseiOption[] = [
    { value: NO_SENSEI, label: 'Sem sensei' },
    ...examiners.map((examiner) => ({ value: examiner.id, label: examinerLabel(examiner) })),
  ];
  const missing = [settings.sensei_user_id ?? NO_SENSEI, selectedId].filter(
    (id, index, ids) =>
      id !== NO_SENSEI &&
      ids.indexOf(id) === index &&
      !examiners.some((examiner) => examiner.id === id),
  );
  for (const id of missing) {
    const sensei = settings.sensei?.id === id ? settings.sensei : null;
    options.push({
      value: id,
      label: sensei ? storedSenseiLabel(sensei) : 'Examinador não encontrado (inativo)',
    });
  }
  return options;
}

/** Python counts code points, not UTF-16 units: keep the same limit as the API. */
function lengthOf(text: string): number {
  return Array.from(text).length;
}

/** Field errors in pt-BR, empty when the form can be sent. */
export function validateAcademyForm(values: AcademyFormValues): AcademyFormErrors {
  const errors: AcademyFormErrors = {};
  const name = values.academyName.trim();
  if (!name) errors.academyName = 'Informe o nome da academia.';
  else if (lengthOf(name) > MAX_ACADEMY_NAME_LENGTH) {
    errors.academyName = `Use no máximo ${String(MAX_ACADEMY_NAME_LENGTH)} caracteres.`;
  }
  if (lengthOf(values.certificateCity.trim()) > MAX_CERTIFICATE_CITY_LENGTH) {
    errors.certificateCity = `Use no máximo ${String(MAX_CERTIFICATE_CITY_LENGTH)} caracteres.`;
  }
  return errors;
}

export function firstInvalidField(errors: AcademyFormErrors): AcademyField | undefined {
  return FIELD_ORDER.find((field) => errors[field]);
}

/**
 * Body of `PUT /settings`: always the three fields. The admin master sends his choice; anyone
 * else resends the stored sensei (`storedSenseiId`, what the screen shows), as the API asks.
 */
export function settingsInputOf(
  values: AcademyFormValues,
  { isMaster, storedSenseiId }: { isMaster: boolean; storedSenseiId: string | null },
): AcademySettingsInput {
  const city = values.certificateCity.trim();
  return {
    academy_name: values.academyName.trim(),
    sensei_user_id: isMaster ? values.senseiId || null : storedSenseiId,
    certificate_city: city || null,
  };
}
