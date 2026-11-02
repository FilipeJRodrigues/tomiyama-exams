import { Alert, Button, Group, NativeSelect, Stack, Switch, TextInput } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';

import { ApiError, errorMessage } from '../../api/client';
import type { Belt, StudentInput } from '../../api/types';
import { paths } from '../../app/navigation';
import { todayIso } from '../../lib/dates';
import {
  MAX_STRIPES,
  beltOptions,
  firstInvalidField,
  stripesOptionLabel,
  studentInputOf,
  validateStudentForm,
  type StudentField,
  type StudentFormErrors,
  type StudentFormValues,
} from './studentFormModel';

const STRIPE_OPTIONS = Array.from({ length: MAX_STRIPES + 1 }, (_, stripes) => ({
  value: String(stripes),
  label: stripesOptionLabel(stripes),
}));

interface Props {
  belts: readonly Belt[];
  initialValues: StudentFormValues;
  /** Id of the page title, which names the form. */
  labelledBy: string;
  submitLabel: string;
  /** Error of the last API attempt (shown above the fields), or null. */
  error: unknown;
  /** Sends the body to the API; resolves after the screen moved on. */
  onSubmit: (input: StudentInput) => Promise<unknown>;
}

function apiErrorTitle(error: unknown): string {
  return error instanceof ApiError && error.status === 403
    ? 'Sem permissão'
    : 'Não foi possível salvar';
}

/**
 * Student form of § 6.2, for creating and editing. It always sends every field; the API
 * decides what each profile may change (RN013) and its message is shown as is.
 */
export function StudentForm({
  belts,
  initialValues,
  labelledBy,
  submitLabel,
  error,
  onSubmit,
}: Props) {
  const errorId = useId();
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<StudentFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  // The state above only changes on the next render; this blocks a second Enter or click.
  const busy = useRef(false);
  const fieldPrefix = useId();
  const fieldId = (field: StudentField) => `${fieldPrefix}-${field}`;

  const change = <K extends StudentField>(field: K, value: StudentFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    // The message goes away as soon as the field is edited; submitting checks again.
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  };

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    const today = todayIso();
    const found = validateStudentForm(values, today);
    setErrors(found);
    const invalid = firstInvalidField(found);
    if (invalid) {
      document.getElementById(fieldId(invalid))?.focus();
      return;
    }
    busy.current = true;
    setSubmitting(true);
    try {
      await onSubmit(studentInputOf(values));
      // Saved: the page is leaving, so the form stays locked until it unmounts.
    } catch {
      // The page shows the API error through `error`; the user may try again.
      busy.current = false;
      setSubmitting(false);
    }
  };

  const today = todayIso();
  const hasApiError = error !== null && error !== undefined;

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      aria-labelledby={labelledBy}
      aria-describedby={hasApiError ? errorId : undefined}
    >
      <Stack gap="md" maw={560}>
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
          id={fieldId('fullName')}
          label="Nome"
          required
          autoComplete="off"
          value={values.fullName}
          error={errors.fullName}
          onChange={(event) => {
            change('fullName', event.currentTarget.value);
          }}
        />
        <NativeSelect
          id={fieldId('beltId')}
          label="Faixa atual"
          required
          value={values.beltId}
          error={errors.beltId}
          onChange={(event) => {
            change('beltId', event.currentTarget.value);
          }}
        >
          <option value="" disabled>
            Selecione a faixa
          </option>
          {beltOptions(belts, initialValues.beltId).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
        <TextInput
          id={fieldId('birthDate')}
          type="date"
          label="Nascimento"
          required
          max={today}
          value={values.birthDate}
          error={errors.birthDate}
          onChange={(event) => {
            change('birthDate', event.currentTarget.value);
          }}
        />
        <TextInput
          id={fieldId('beltSince')}
          type="date"
          label="Na faixa desde"
          description="Conta para a carência do próximo exame."
          required
          min={values.birthDate || undefined}
          max={today}
          value={values.beltSince}
          error={errors.beltSince}
          onChange={(event) => {
            change('beltSince', event.currentTarget.value);
          }}
        />
        <NativeSelect
          id={fieldId('stripes')}
          label="Graus"
          data={STRIPE_OPTIONS}
          value={values.stripes}
          error={errors.stripes}
          onChange={(event) => {
            change('stripes', event.currentTarget.value);
          }}
        />
        <TextInput
          id={fieldId('federationId')}
          label="Registro na federação"
          description="Opcional."
          autoComplete="off"
          value={values.federationId}
          error={errors.federationId}
          onChange={(event) => {
            change('federationId', event.currentTarget.value);
          }}
        />
        <Switch
          id={fieldId('active')}
          label="Ativo"
          description="Aluno inativo não pode fazer exame."
          checked={values.active}
          onChange={(event) => {
            change('active', event.currentTarget.checked);
          }}
        />
        <Group gap="sm">
          <Button type="submit" loading={submitting}>
            {submitLabel}
          </Button>
          <Button component={Link} to={paths.students} variant="default">
            Cancelar
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
