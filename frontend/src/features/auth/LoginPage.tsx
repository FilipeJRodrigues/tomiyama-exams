import {
  Alert,
  Anchor,
  Button,
  PasswordInput,
  Radio,
  Stack,
  Text,
  TextInput,
  Group,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState, type SubmitEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';

import { paths } from '../../app/navigation';
import type { LoginRedirectState } from '../../app/guards';
import { MOCK_TEMPORARY_PASSWORD } from '../../auth/mockConstants';
import { AuthError, ROLE_LABELS, type Role } from '../../auth/types';
import { useAuth } from '../../auth/useAuth';
import { AuthCard } from './AuthCard';

const MIN_PASSWORD_LENGTH = 8;
const EDGE_SPACE_MESSAGE = 'A senha não pode começar nem terminar com espaço.';

function messageOf(error: unknown): string {
  return error instanceof AuthError ? error.message : 'Não foi possível entrar. Tente de novo.';
}

function redirectTarget(state: unknown): string {
  const from = (state as LoginRedirectState | null)?.from;
  return from && from !== paths.login ? from : paths.students;
}

function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert color="red" icon={<IconAlertCircle aria-hidden />} role="alert" title="Erro">
      {message}
    </Alert>
  );
}

function NewPasswordForm({ onDone }: { onDone: () => void }) {
  const { confirmNewPassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password.trim()) {
      setError('Informe a nova senha.');
      return;
    }
    if (password !== password.trim()) {
      // Cognito rejects a password that starts or ends with a space.
      setError(EDGE_SPACE_MESSAGE);
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (password !== confirmation) {
      setError('As senhas não conferem.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const step = await confirmNewPassword(password);
      if (step === 'DONE') onDone();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title="Defina uma nova senha">
      <Text size="sm">A senha recebida por e-mail é temporária e precisa ser trocada.</Text>
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Stack gap="md">
          <ErrorAlert message={error} />
          <PasswordInput
            label="Nova senha"
            description={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres`}
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
            }}
          />
          <PasswordInput
            label="Confirme a nova senha"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.currentTarget.value);
            }}
          />
          <Button type="submit" loading={submitting}>
            Salvar senha e entrar
          </Button>
        </Stack>
      </form>
    </AuthCard>
  );
}

/** § 6.1: login by e-mail and password, with the first-login password change. */
export function LoginPage() {
  const { status, signIn, supportsRoleChoice } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('examiner');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsNewPassword, setNeedsNewPassword] = useState(false);

  const target = redirectTarget(location.state);
  const goToApp = () => void navigate(target, { replace: true });

  if (status === 'signedIn' && !needsNewPassword) return <Navigate to={target} replace />;
  if (needsNewPassword) return <NewPasswordForm onDone={goToApp} />;

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError('Informe o e-mail e a senha.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const step = await signIn({ email, password, role });
      if (step === 'NEW_PASSWORD_REQUIRED') setNeedsNewPassword(true);
      else goToApp();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title="Entrar">
      {supportsRoleChoice && (
        <Alert color="orange" title="Dados simulados" role="note">
          Qualquer e-mail entra. A senha “{MOCK_TEMPORARY_PASSWORD}” simula o primeiro acesso.
        </Alert>
      )}
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Stack gap="md">
          <ErrorAlert message={error} />
          <TextInput
            label="E-mail"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.currentTarget.value);
            }}
          />
          <PasswordInput
            label="Senha"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
            }}
          />
          {supportsRoleChoice && (
            <Radio.Group
              label="Perfil simulado"
              value={role}
              onChange={(value) => {
                setRole(value === 'guardian' ? 'guardian' : 'examiner');
              }}
            >
              <Group gap="md" mt={4}>
                <Radio value="examiner" label={ROLE_LABELS.examiner} />
                <Radio value="guardian" label={ROLE_LABELS.guardian} />
              </Group>
            </Radio.Group>
          )}
          <Button type="submit" loading={submitting}>
            Entrar
          </Button>
        </Stack>
      </form>
      <Text size="sm">
        Não tem conta?{' '}
        <Anchor component={Link} to={paths.signUp}>
          Cadastre-se
        </Anchor>
      </Text>
    </AuthCard>
  );
}
