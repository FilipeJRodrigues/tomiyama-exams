import { Alert, Button, Group, NativeSelect, Stack, TextInput, Textarea } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useId, useState, type SubmitEvent } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import type { Belt, RequirementInput } from '../../api/types';
import { sortBelts } from '../belts/beltText';
import {
  KIND_OPTIONS,
  MAX_CATEGORY_LENGTH,
  MAX_SORT_ORDER,
  MAX_TEXT_LENGTH,
  firstInvalidField,
  isRequirementKind,
  requirementInputOf,
  validateRequirementForm,
  type RequirementField,
  type RequirementFormErrors,
  type RequirementFormValues,
} from './requirementFormModel';

function apiErrorTitle(error: unknown): string {
  return error instanceof ApiError && error.status === 403
    ? 'Sem permissão'
    : 'Não foi possível salvar';
}

interface Props {
  belts: readonly Belt[];
  initialValues: RequirementFormValues;
  /** A new item may leave the order blank (end of the belt); an edit always sends it. */
  isNew: boolean;
  /** Accessible name of the form (the dialog title). */
  label: string;
  /** Error of the last API attempt (shown above the fields), or null. */
  error: unknown;
  saving: boolean;
  onSubmit: (input: RequirementInput) => void;
  onCancel: () => void;
}

/**
 * Requirement form of § 6.5, inside the create and edit dialogs. The edit always sends every
 * field (resending the same belt and kind is accepted for an item with answers); the API
 * checks RN017 and its message is shown as is.
 */
export function RequirementForm({
  belts,
  initialValues,
  isNew,
  label,
  error,
  saving,
  onSubmit,
  onCancel,
}: Props) {
  const errorId = useId();
  const fieldPrefix = useId();
  const fieldId = (field: RequirementField) => `${fieldPrefix}-${field}`;
  const [values, setValues] = useState<RequirementFormValues>(initialValues);
  const [errors, setErrors] = useState<RequirementFormErrors>({});

  const beltOptions = sortBelts(belts).map((belt) => ({ value: belt.id, label: belt.name }));
  const kindOptions = [
    ...(values.kind === '' ? [{ value: '', label: 'Escolha o tipo' }] : []),
    ...KIND_OPTIONS,
  ];

  const change = <K extends RequirementField>(field: K, value: RequirementFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    // The message goes away as soon as the field is edited; submitting checks again.
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  };

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const found = validateRequirementForm(values, { orderRequired: !isNew });
    setErrors(found);
    const invalid = firstInvalidField(found);
    if (invalid) {
      document.getElementById(fieldId(invalid))?.focus();
      return;
    }
    onSubmit(requirementInputOf(values));
  };

  const hasApiError = error !== null && error !== undefined;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={label}
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
        <NativeSelect
          id={fieldId('beltId')}
          label="Faixa"
          required
          data={beltOptions}
          value={values.beltId}
          error={errors.beltId}
          onChange={(event) => {
            change('beltId', event.currentTarget.value);
          }}
          data-autofocus
        />
        <NativeSelect
          id={fieldId('kind')}
          label="Tipo"
          required
          data={kindOptions}
          value={values.kind}
          error={errors.kind}
          onChange={(event) => {
            const { value } = event.currentTarget;
            if (isRequirementKind(value)) change('kind', value);
          }}
        />
        <TextInput
          id={fieldId('category')}
          label="Categoria"
          description={`Por exemplo, Naguewaza, Vocabulário. Até ${String(MAX_CATEGORY_LENGTH)} caracteres.`}
          required
          autoComplete="off"
          value={values.category}
          error={errors.category}
          onChange={(event) => {
            change('category', event.currentTarget.value);
          }}
        />
        <Textarea
          id={fieldId('description')}
          label="Descrição"
          description={`O que se pergunta ou pede no exame. Até ${String(MAX_TEXT_LENGTH)} caracteres.`}
          required
          rows={3}
          resize="vertical"
          value={values.description}
          error={errors.description}
          onChange={(event) => {
            change('description', event.currentTarget.value);
          }}
        />
        <Textarea
          id={fieldId('expectedAnswer')}
          label="Resposta esperada"
          description={`Opcional; aparece para o examinador. Até ${String(MAX_TEXT_LENGTH)} caracteres.`}
          rows={3}
          resize="vertical"
          value={values.expectedAnswer}
          error={errors.expectedAnswer}
          onChange={(event) => {
            change('expectedAnswer', event.currentTarget.value);
          }}
        />
        <TextInput
          id={fieldId('sortOrder')}
          label="Ordem"
          description={
            isNew
              ? `Posição na folha, de 0 a ${String(MAX_SORT_ORDER)}. Em branco, o item vai para o fim da faixa.`
              : `Posição na folha, de 0 a ${String(MAX_SORT_ORDER)}.`
          }
          required={!isNew}
          inputMode="numeric"
          autoComplete="off"
          value={values.sortOrder}
          error={errors.sortOrder}
          onChange={(event) => {
            change('sortOrder', event.currentTarget.value);
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
