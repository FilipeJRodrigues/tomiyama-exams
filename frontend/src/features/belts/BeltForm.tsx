import { Alert, Box, Button, Group, NativeSelect, Stack, TextInput } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useId, useState, type SubmitEvent } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import type { Belt, BeltInput, BeltLevel } from '../../api/types';
import { BELT_LEVEL_LABELS } from '../../lib/labels';
import {
  KYU_OPTIONS,
  beltInputOf,
  firstInvalidField,
  formValuesOf,
  isHexColor,
  validateBeltForm,
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

interface Props {
  belt: Belt;
  /** Error of the last API attempt (shown above the fields), or null. */
  error: unknown;
  saving: boolean;
  onSubmit: (input: BeltInput) => void;
  onCancel: () => void;
}

/**
 * Belt form of § 6.5, inside the edit dialog. It always sends every field; the API checks
 * RN015 (ranges, colors, unique name and order) and its message is shown as is.
 */
export function BeltForm({ belt, error, saving, onSubmit, onCancel }: Props) {
  const errorId = useId();
  const fieldPrefix = useId();
  const fieldId = (field: BeltField) => `${fieldPrefix}-${field}`;
  const [values, setValues] = useState<BeltFormValues>(() => formValuesOf(belt));
  const [errors, setErrors] = useState<BeltFormErrors>({});

  const change = <K extends BeltField>(field: K, value: BeltFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    // The message goes away as soon as the field is edited; submitting checks again.
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  };

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const found = validateBeltForm(values);
    setErrors(found);
    const invalid = firstInvalidField(found);
    if (invalid) {
      document.getElementById(fieldId(invalid))?.focus();
      return;
    }
    onSubmit(beltInputOf(values));
  };

  const hasApiError = error !== null && error !== undefined;

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
            {errorMessage(error)}
          </Alert>
        )}
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
        />
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
