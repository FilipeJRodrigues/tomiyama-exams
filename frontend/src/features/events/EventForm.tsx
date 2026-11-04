import { Alert, Button, Group, NativeSelect, Stack, TextInput } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useId, useState, type SubmitEvent } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import { formatDate } from '../../lib/dates';
import {
  MAX_EVENT_NAME_LENGTH,
  STATUS_HELP,
  STATUS_OPTIONS,
  firstInvalidField,
  isEventStatus,
  validateEventForm,
  type EventField,
  type EventFormErrors,
  type EventFormValues,
} from './eventFormModel';

function apiErrorTitle(error: unknown): string {
  return error instanceof ApiError && error.status === 403
    ? 'Sem permissão'
    : 'Não foi possível salvar';
}

interface Props {
  initialValues: EventFormValues;
  /** A new event chooses its date; an edit shows it read only (it never changes). */
  isNew: boolean;
  /** Accessible name of the form (the dialog title). */
  label: string;
  /** Error of the last API attempt (shown above the fields), or null. */
  error: unknown;
  saving: boolean;
  onSubmit: (values: EventFormValues) => void;
  onCancel: () => void;
}

/**
 * Event form of § 6.5 (model in § 3.4), inside the create and edit dialogs. The API checks
 * the fields and RN016, and its message is shown as is.
 */
export function EventForm({
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
  const fieldId = (field: EventField) => `${fieldPrefix}-${field}`;
  const [values, setValues] = useState<EventFormValues>(initialValues);
  const [errors, setErrors] = useState<EventFormErrors>({});

  const change = <K extends EventField>(field: K, value: EventFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    // The message goes away as soon as the field is edited; submitting checks again.
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  };

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const found = validateEventForm(values, { checkDate: isNew });
    setErrors(found);
    const invalid = firstInvalidField(found);
    if (invalid) {
      document.getElementById(fieldId(invalid))?.focus();
      return;
    }
    onSubmit(values);
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
        <TextInput
          id={fieldId('name')}
          label="Nome"
          description={`Por exemplo, Exame março/2027. Até ${String(MAX_EVENT_NAME_LENGTH)} caracteres.`}
          required
          autoComplete="off"
          value={values.name}
          error={errors.name}
          onChange={(event) => {
            change('name', event.currentTarget.value);
          }}
          data-autofocus
        />
        {isNew ? (
          <TextInput
            id={fieldId('examDate')}
            type="date"
            label="Data do exame"
            description="Referência da idade e da carência dos alunos. Não muda depois da criação."
            required
            value={values.examDate}
            error={errors.examDate}
            onChange={(event) => {
              change('examDate', event.currentTarget.value);
            }}
          />
        ) : (
          <TextInput
            id={fieldId('examDate')}
            label="Data do exame"
            description="Não muda depois da criação."
            readOnly
            value={formatDate(values.examDate)}
          />
        )}
        <NativeSelect
          id={fieldId('status')}
          label="Situação"
          description={STATUS_HELP}
          required
          data={STATUS_OPTIONS}
          value={values.status}
          onChange={(event) => {
            const { value } = event.currentTarget;
            if (isEventStatus(value)) change('status', value);
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
