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
import { IconCircleCheck } from '@tabler/icons-react';
import { useId, useState, type SubmitEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';

import { paths } from '../../app/navigation';
import type { LoginRedirectState } from '../../app/guards';
import {
  MOCK_MASTER_EMAIL,
  MOCK_RESET_CODE,
  MOCK_RESET_REQUIRED_EMAIL,
  MOCK_TEMPORARY_PASSWORD,
} from '../../auth/mockConstants';
import { AuthError, ROLE_LABELS, type Role } from '../../auth/types';
import { useAuth } from '../../auth/useAuth';
import { AuthCard } from './AuthCard';
import { TOUCH_LINK } from './touchLink';
import { ErrorAlert } from './ErrorAlert';
import { PASSWORD_HINT, newPasswordProblem } from './passwordRules';
import {
  confirmedEmailOf,
  passwordResetEmailOf,
  type ForgotPasswordPageState,
  type SignUpPageState,
} from './routeState';

function messageOf(error: unknown): string {
  return error instanceof AuthError ? error.message : 'Não foi possível entrar. Tente de novo.';
}

function redirectTarget(state: unknown): string {
  const from = (state as LoginRedirectState | null)?.from;
  return from && from !== paths.login ? from : paths.students;
}

function NewPasswordForm({ onDone }: { onDone: () => void }) {
  const { confirmNewPassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = newPasswordProblem(password, confirmation, 'Informe a nova senha.');
    if (problem) {
      setError(problem);
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
            description={PASSWORD_HINT}
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

/**
 * § 6.1: login by e-mail and password, with the first-login password change and the way to
 * the password recovery (also taken when the academy reset the password in the console).
 */
export function LoginPage() {
  const { status, signIn, supportsRoleChoice } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const errorId = useId();
  // After the e-mail confirmation, when the automatic sign-in did not happen.
  const [confirmedEmail] = useState(() => confirmedEmailOf(location.state));
  // After the password recovery.
  const [passwordResetEmail] = useState(() => passwordResetEmailOf(location.state));
  const [email, setEmail] = useState(confirmedEmail ?? passwordResetEmail ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(confirmedEmail ? 'guardian' : 'examiner');
  const [error, setError] = useState<string | null>(null);
  /** E-mail of an account that still needs the code (offers the confirmation step). */
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsNewPassword, setNeedsNewPassword] = useState(false);

  const target = redirectTarget(location.state);
  const goToApp = () => void navigate(target, { replace: true });

  if (status === 'signedIn' && !needsNewPassword) return <Navigate to={target} replace />;
  if (needsNewPassword) return <NewPasswordForm onDone={goToApp} />;

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    if (!email.trim() || !password) {
      setError('Informe o e-mail e a senha.');
      setUnconfirmedEmail(null);
      return;
    }
    setSubmitting(true);
    setError(null);
    setUnconfirmedEmail(null);
    try {
      const step = await signIn({ email, password, role });
      if (step === 'NEW_PASSWORD_REQUIRED') setNeedsNewPassword(true);
      else goToApp();
    } catch (caught) {
      if (caught instanceof AuthError && caught.code === 'PASSWORD_RESET_REQUIRED') {
        // The code went to the e-mail when the academy reset the password: straight to the
        // code step, which explains it and offers a new code.
        const state: ForgotPasswordPageState = { resetEmail: email.trim(), resetRequired: true };
        void navigate(paths.forgotPassword, { state });
        return;
      }
      setError(messageOf(caught));
      if (caught instanceof AuthError && caught.code === 'USER_NOT_CONFIRMED') {
        setUnconfirmedEmail(email.trim());
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title="Entrar" focusTitle={passwordResetEmail !== null}>
      {supportsRoleChoice && (
        <Alert color="orange" title="Dados simulados" role="note">
          Qualquer e-mail entra. A senha “{MOCK_TEMPORARY_PASSWORD}” simula o primeiro acesso. Como
          examinador, o e-mail “{MOCK_MASTER_EMAIL}” entra como administrador master. O e-mail “
          {MOCK_RESET_REQUIRED_EMAIL}” simula uma senha redefinida pela academia; na recuperação de
          senha, o código é “{MOCK_RESET_CODE}”.
        </Alert>
      )}
      {passwordResetEmail && (
        <Alert color="green" variant="light" icon={<IconCircleCheck aria-hidden />} role="status">
          Senha alterada. Entre com a nova senha.
        </Alert>
      )}
      {confirmedEmail && (
        <Alert color="green" variant="light" icon={<IconCircleCheck aria-hidden />} role="status">
          Conta confirmada. Entre com seu e-mail e senha.
        </Alert>
      )}
      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        aria-describedby={error ? errorId : undefined}
      >
        <Stack gap="md">
          <ErrorAlert message={error} id={errorId}>
            {unconfirmedEmail && (
              <Text size="sm" mt="xs">
                {/* Inherits the alert text color: the link color is under 4.5:1 on it. */}
                <Anchor
                  component={Link}
                  c="inherit"
                  fw={700}
                  underline="always"
                  to={paths.signUp}
                  state={{ confirmEmail: unconfirmedEmail } satisfies SignUpPageState}
                >
                  Confirmar e-mail
                </Anchor>
              </Text>
            )}
          </ErrorAlert>
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
        <Anchor
          component={Link}
          to={paths.forgotPassword}
          state={{ draftEmail: email.trim() || undefined } satisfies ForgotPasswordPageState}
          style={TOUCH_LINK}
        >
          Esqueci minha senha
        </Anchor>
      </Text>
      <Text size="sm">
        Não tem conta?{' '}
        <Anchor component={Link} to={paths.signUp}>
          Cadastre-se
        </Anchor>
      </Text>
    </AuthCard>
  );
}
