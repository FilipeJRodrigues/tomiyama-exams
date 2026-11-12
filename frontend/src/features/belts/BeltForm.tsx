import { Alert, Box, Button, Group, NativeSelect, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertCircle, IconCircleCheck } from '@tabler/icons-react';
import { useId, useRef, useState, type SubmitEvent } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import type { Belt, BeltInput, BeltLevel } from '../../api/types';
import { BELT_LEVEL_LABELS } from '../../lib/labels';
import { focusIfLost } from '../exam/focus';
import { BeltFixedData } from './BeltFixedData';
import {
  KYU_OPTIONS,
  MSG_ONLY_MASTER_EDITS_BELT,
  beltInputOf,
  firstInvalidField,
  formValuesOf,
  isHexColor,
  limitsInputOf,
  validateBeltForm,
  validateLimits,
  type BeltField,
  type BeltFormErrors,
  type BeltFormValues,
} from './beltFormModel';

const LEVEL_OPTIONS = (Object.keys(BELT_LEVEL_LABELS) as BeltLevel[]).map((level) => ({
  value: level,
  label: BELT_LEVEL_LABELS[level],
}));

function isBeltLevel(value: string): value is BeltLevel {
  return value in BELT_LEVEL_LABELS;
}

/** Decorative sample of a typed color; the hex text in the field is what counts. */
function ColorSample({ value }: { value: string }) {
  if (!isHexColor(value)) return null;
  return (
    <Box
      component="span"
      aria-hidden
      data-testid="color-sample"
      style={{
        display: 'inline-block',
        width: 16,
        height: 16,
        borderRadius: 3,
        border: '1px solid var(--mantine-color-dimmed)',
        background: value.trim(),
      }}
    />
  );
}

function apiErrorTitle(error: unknown): string {
  return error instanceof ApiError && error.status === 403
    ? 'Sem permissão'
    : 'Não foi possível salvar';
}

/** The 403 of a belt the admin master changed after this examiner read it (#143). */
function isBeltChangedMeanwhile(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.message === MSG_ONLY_MASTER_EDITS_BELT
  );
}

interface Props {
  belt: Belt;
  /**
   * Admin master: every field. Any other examiner edits only the minimum age and months
   * (RN001, RN002) and sees the rest as text (#143).
   */
  isMaster: boolean;
  /** Error of the last API attempt (shown above the fields), or null. */
  error: unknown;
  saving: boolean;
  onSubmit: (input: BeltInput) => void;
  onCancel: () => void;
  /**
   * Reads the belt again after the 403 of a belt changed meanwhile: resolves with the stored
   * belt (which becomes `belt`) or rejects with the reason.
   */
  onReread: () => Promise<Belt>;
}

/**
 * Belt form of § 6.5, inside the edit dialog. It always sends every field; the API checks
 * RN015 (ranges, colors, unique name and order) and its message is shown as is.
 *
 * The admin master edits every field. Any other examiner edits the minimum age and months
 * only, sees the rest as text and sends it back as read (#143); if the master changed it
 * meanwhile, the API answers 403 and the belt can be read again from the error.
 */
export function BeltForm({ belt, isMaster, error, saving, onSubmit, onCancel, onReread }: Props) {
  const errorId = useId();
  const fieldPrefix = useId();
  const fieldId = (field: BeltField) => `${fieldPrefix}-${field}`;
  const [values, setValues] = useState<BeltFormValues>(() => formValuesOf(belt));
  const [errors, setErrors] = useState<BeltFormErrors>({});
  const [rereading, setRereading] = useState(false);
  const [rereadError, setRereadError] = useState<unknown>(null);
  const [reread, setReread] = useState(false);
  const rereadButtonRef = useRef<HTMLButtonElement>(null);

  const change = <K extends BeltField>(field: K, value: BeltFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    // The message goes away as soon as the field is edited; submitting checks again.
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  };

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    // While the belt is read again, its old values would go.
    if (saving || rereading) return;
    const found = isMaster ? validateBeltForm(values) : validateLimits(values);
    setErrors(found);
    const invalid = firstInvalidField(found);
    if (invalid) {
      document.getElementById(fieldId(invalid))?.focus();
      return;
    }
    setReread(false);
    setRereadError(null);
    onSubmit(isMaster ? beltInputOf(values) : limitsInputOf(belt, values));
  };

  const rereadBelt = async () => {
    if (rereading) return;
    setRereading(true);
    setRereadError(null);
    try {
      await onReread();
      setReread(true);
      // The error and its button went away: the focus goes to the first field (§ 6.7).
      window.setTimeout(() => {
        focusIfLost(document.getElementById(fieldId('minAgeYears')));
      }, 0);
    } catch (problem) {
      setRereadError(problem);
      // The button was disabled while reading: the focus goes back to it (§ 6.7).
      window.setTimeout(() => {
        focusIfLost(rereadButtonRef.current);
      }, 0);
    } finally {
      setRereading(false);
    }
  };

  const hasApiError = error !== null && error !== undefined;
  const canReread = !isMaster && hasApiError && isBeltChangedMeanwhile(error);

  const ageField = (autofocus: boolean) => (
    <TextInput
      id={fieldId('minAgeYears')}
      label="Idade mínima (anos)"
      required
      inputMode="numeric"
      autoComplete="off"
      value={values.minAgeYears}
      error={errors.minAgeYears}
      onChange={(event) => {
        change('minAgeYears', event.currentTarget.value);
      }}
      data-autofocus={autofocus || undefined}
    />
  );

  const monthsField = (
    <TextInput
      id={fieldId('minMonthsPrevious')}
      label="Carência na faixa anterior (meses)"
      required
      inputMode="numeric"
      autoComplete="off"
      value={values.minMonthsPrevious}
      error={errors.minMonthsPrevious}
      onChange={(event) => {
        change('minMonthsPrevious', event.currentTarget.value);
      }}
    />
  );

  const limitFields = (
    <>
      <BeltFixedData belt={belt} />
      {ageField(true)}
      {monthsField}
    </>
  );

  const masterFields = (
    <>
      <TextInput
        id={fieldId('name')}
        label="Nome"
        required
        autoComplete="off"
        value={values.name}
        error={errors.name}
        onChange={(event) => {
          change('name', event.currentTarget.value);
        }}
        data-autofocus
      />
      <TextInput
        id={fieldId('sortOrder')}
        label="Ordem"
        description="Posição na graduação; 0 é a primeira faixa."
        required
        inputMode="numeric"
        autoComplete="off"
        value={values.sortOrder}
        error={errors.sortOrder}
        onChange={(event) => {
          change('sortOrder', event.currentTarget.value);
        }}
      />
      <NativeSelect
        id={fieldId('kyu')}
        label="Kyū"
        data={KYU_OPTIONS}
        value={values.kyu}
        error={errors.kyu}
        onChange={(event) => {
          change('kyu', event.currentTarget.value);
        }}
      />
      <NativeSelect
        id={fieldId('level')}
        label="Nível"
        description="Só as faixas intermediárias têm exame de grau."
        required
        data={LEVEL_OPTIONS}
        value={values.level}
        error={errors.level}
        onChange={(event) => {
          const { value } = event.currentTarget;
          if (isBeltLevel(value)) change('level', value);
        }}
      />
      {ageField(false)}
      {monthsField}
      <TextInput
        id={fieldId('colorPrimary')}
        label="Cor"
        description="Formato #RRGGBB."
        required
        autoComplete="off"
        spellCheck={false}
        leftSection={<ColorSample value={values.colorPrimary} />}
        value={values.colorPrimary}
        error={errors.colorPrimary}
        onChange={(event) => {
          change('colorPrimary', event.currentTarget.value);
        }}
      />
      <TextInput
        id={fieldId('colorSecondary')}
        label="Cor das pontas"
        description="Opcional, nas faixas de duas cores. Formato #RRGGBB."
        autoComplete="off"
        spellCheck={false}
        leftSection={<ColorSample value={values.colorSecondary} />}
        value={values.colorSecondary}
        error={errors.colorSecondary}
        onChange={(event) => {
          change('colorSecondary', event.currentTarget.value);
        }}
      />
    </>
  );

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={`Editar faixa ${belt.name}`}
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
            {canReread ? (
              <Stack gap="xs" align="flex-start">
                <Text size="sm">{errorMessage(error)}</Text>
                <Text size="sm">Os dados da faixa mudaram enquanto a tela estava aberta.</Text>
                {rereadError !== null && (
                  <Text size="sm">Não foi possível reler a faixa. {errorMessage(rereadError)}</Text>
                )}
                <Button
                  ref={rereadButtonRef}
                  variant="default"
                  loading={rereading}
                  disabled={saving}
                  onClick={() => void rereadBelt()}
                >
                  Reler a faixa
                </Button>
              </Stack>
            ) : (
              errorMessage(error)
            )}
          </Alert>
        )}
        {reread && !hasApiError && (
          <Alert color="green" variant="light" role="status" icon={<IconCircleCheck aria-hidden />}>
            Faixa relida com os dados atuais.
          </Alert>
        )}
        {isMaster ? masterFields : limitFields}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" loading={saving}>
            Salvar
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
