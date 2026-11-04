import { Alert, Button, Group, NativeSelect, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertCircle, IconAlertTriangle } from '@tabler/icons-react';
import { useId, useRef, useState, type SubmitEvent } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import type { AcademySettings, AcademySettingsInput, Examiner } from '../../api/types';
import { focusIfLost } from '../exam/focus';
import { markOutcomeUnknown } from '../exam/examModel';
import {
  MAX_ACADEMY_NAME_LENGTH,
  MAX_CERTIFICATE_CITY_LENGTH,
  NO_SENSEI,
  changedFields,
  firstInvalidField,
  followReload,
  followSave,
  formValuesOf,
  hasInactiveSensei,
  inactiveSenseiText,
  sameFormValues,
  senseiOptions,
  settingsInputOf,
  storedSenseiLabel,
  validateAcademyForm,
  withoutErrors,
  type AcademyField,
  type AcademyFormErrors,
  type AcademyFormValues,
} from './academyFormModel';

/** 403 of `PUT /settings` for a non-master whose stored sensei changed meanwhile. */
const MSG_ONLY_MASTER_CHOOSES_SENSEI = 'Somente o administrador master escolhe o sensei';

function apiErrorTitle(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Sem permissão';
  if (markOutcomeUnknown(error)) return 'Não foi possível confirmar o salvamento';
  return 'Não foi possível salvar';
}

/** What follows the API message, when the screen knows more than the message says. */
function apiErrorHint(error: unknown, isMaster: boolean): string | null {
  if (markOutcomeUnknown(error)) {
    return 'Os dados podem ter sido salvos. Confira os campos e salve de novo se precisar.';
  }
  if (!isMaster && error instanceof ApiError && error.message === MSG_ONLY_MASTER_CHOOSES_SENSEI) {
    return 'O sensei foi trocado enquanto a tela estava aberta. Confira o sensei atual e salve de novo.';
  }
  return null;
}

/**
 * The selector's description: only the sensei decides the exams (RN008) and only the admin
 * master chooses him (§ 6.6).
 */
function senseiDescription(isMaster: boolean): string {
  return isMaster
    ? 'Só o sensei decide os exames.'
    : 'Só o sensei decide os exames. Só o administrador master troca o sensei.';
}

/** Keeps the disabled selector of the other examiners readable (§ 6.7: 4.5:1 on text). */
const READ_ONLY_SELECT_STYLES = {
  input: { opacity: 1, color: 'var(--mantine-color-text)' },
} as const;

interface Props {
  settings: AcademySettings;
  /** Active examiners for the master's selector; `null` for the other examiners. */
  examiners: readonly Examiner[] | null;
  isMaster: boolean;
  /** Id of the heading that names the form. */
  labelledBy: string;
  /** Error of the last API attempt (shown above the fields), or null. */
  error: unknown;
  saving: boolean;
  /** Sends the body; resolves with the saved settings, or null when the API refused it. */
  onSubmit: (input: AcademySettingsInput) => Promise<AcademySettings | null>;
  /** A field changed (the "saved" notice no longer describes the fields). */
  onEdit: () => void;
}

/**
 * Academy data of § 6.6 (model in § 3.7): name, sensei and city of the certificate. Every
 * examiner saves the name and the city; only the admin master changes the sensei, and the
 * others resend the stored one (always the latest read), as `PUT /settings` asks.
 *
 * The fields follow the settings read again (window focus, reload after a refusal, the save
 * itself): a field still as it was at the last sync shows the new value, an edited one keeps
 * what the user typed.
 */
export function AcademyForm({
  settings,
  examiners,
  isMaster,
  labelledBy,
  error,
  saving,
  onSubmit,
  onEdit,
}: Props) {
  const errorId = useId();
  const fieldPrefix = useId();
  const fieldId = (field: AcademyField) => `${fieldPrefix}-${field}`;
  const incoming = formValuesOf(settings);
  /** Values of the settings at the last sync: a field still equal to its value is not edited. */
  const [synced, setSynced] = useState<AcademyFormValues>(incoming);
  const [values, setValues] = useState<AcademyFormValues>(incoming);
  const [errors, setErrors] = useState<AcademyFormErrors>({});
  const submitRef = useRef<HTMLButtonElement>(null);

  // Settings read again with other values: the fields not edited since the last sync follow
  // them, with no validation and no focus change. Adjusted while rendering, not in an effect:
  // the old values are never painted.
  if (!sameFormValues(incoming, synced)) {
    const next = followReload(values, synced, incoming);
    setSynced(incoming);
    setValues(next);
    // A message about a value replaced under it would mislead.
    setErrors(withoutErrors(errors, changedFields(values, next)));
  }

  const change = <K extends AcademyField>(field: K, value: AcademyFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    // The message goes away as soon as the field is edited; submitting checks again.
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
    onEdit();
  };

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const found = validateAcademyForm(values);
    setErrors(found);
    const invalid = firstInvalidField(found);
    if (invalid) {
      document.getElementById(fieldId(invalid))?.focus();
      return;
    }
    const submitted = values;
    const saved = await onSubmit(
      settingsInputOf(values, { isMaster, storedSenseiId: settings.sensei_user_id }),
    );
    // The fields show what the API stored (trimmed, blanks as empty), unless the user typed
    // in them while it was on its way: what was typed stays. The answer is already in the
    // cache, so it becomes the last sync when `settings` brings it.
    if (saved) {
      const stored = formValuesOf(saved);
      setValues((current) => followSave(current, submitted, stored));
    }
    // The button was disabled while saving: the focus may have left it (§ 6.7).
    focusIfLost(submitRef.current);
  };

  const hasApiError = error !== null && error !== undefined;
  const hint = hasApiError ? apiErrorHint(error, isMaster) : null;
  const inactiveSensei = hasInactiveSensei(settings) ? settings.sensei : null;

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      aria-labelledby={labelledBy}
      aria-describedby={hasApiError ? errorId : undefined}
    >
      <Stack gap="md">
        {hasApiError && (
          <Alert
            id={errorId}
            color="red"
            variant="light"
            role="alert"
            icon={<IconAlertCircle aria-hidden />}
            title={apiErrorTitle(error)}
          >
            <Text size="sm">{errorMessage(error)}</Text>
            {hint && (
              <Text size="sm" mt="xs">
                {hint}
              </Text>
            )}
          </Alert>
        )}
        <TextInput
          id={fieldId('academyName')}
          label="Nome da academia"
          description={`Aparece no topo do certificado. Até ${String(MAX_ACADEMY_NAME_LENGTH)} caracteres.`}
          required
          autoComplete="organization"
          value={values.academyName}
          error={errors.academyName}
          onChange={(event) => {
            change('academyName', event.currentTarget.value);
          }}
        />
        {inactiveSensei && (
          // A standing notice of the loaded data, not an interruption: `note`, not `alert`.
          <Alert
            color="orange"
            variant="light"
            role="note"
            icon={<IconAlertTriangle aria-hidden />}
            title="Sensei inativo"
          >
            <Text size="sm">{inactiveSenseiText(inactiveSensei)}</Text>
            <Text size="sm" mt="xs">
              {isMaster
                ? 'Escolha outro sensei ou "Sem sensei" e salve.'
                : 'Só o administrador master pode escolher outro sensei.'}
            </Text>
          </Alert>
        )}
        {isMaster ? (
          <NativeSelect
            id={fieldId('senseiId')}
            label="Sensei"
            description={senseiDescription(true)}
            data={senseiOptions(examiners ?? [], settings, values.senseiId)}
            value={values.senseiId}
            error={errors.senseiId}
            onChange={(event) => {
              change('senseiId', event.currentTarget.value);
            }}
          />
        ) : (
          <NativeSelect
            id={fieldId('senseiId')}
            label="Sensei"
            description={senseiDescription(false)}
            disabled
            styles={READ_ONLY_SELECT_STYLES}
            data={[
              {
                value: settings.sensei_user_id ?? NO_SENSEI,
                label: storedSenseiLabel(settings.sensei),
              },
            ]}
            value={settings.sensei_user_id ?? NO_SENSEI}
            onChange={() => undefined}
          />
        )}
        <TextInput
          id={fieldId('certificateCity')}
          label="Cidade do certificado"
          description={`Opcional. Vem antes da data no certificado, por exemplo: Araraquara. Até ${String(MAX_CERTIFICATE_CITY_LENGTH)} caracteres.`}
          autoComplete="address-level2"
          value={values.certificateCity}
          error={errors.certificateCity}
          onChange={(event) => {
            change('certificateCity', event.currentTarget.value);
          }}
        />
        <Group justify="flex-end">
          <Button ref={submitRef} type="submit" loading={saving}>
            Salvar
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
