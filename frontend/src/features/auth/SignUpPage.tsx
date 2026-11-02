import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';

import { paths } from '../../app/navigation';
import {
  MOCK_EXISTING_EMAIL,
  MOCK_EXPIRED_CODE,
  MOCK_SIGN_UP_CODE,
} from '../../auth/mockConstants';
import { AuthError, type ConfirmSignUpResult } from '../../auth/types';
import { useAuth } from '../../auth/useAuth';
import { AuthCard } from './AuthCard';
import { ErrorAlert } from './ErrorAlert';
import { PASSWORD_HINT, emailProblem, newPasswordProblem } from './passwordRules';
import { confirmEmailOf, type LoginPageState, type SignUpPageState } from './routeState';

const CODE_PATTERN = /^\d{6}$/;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof AuthError ? error.message : fallback;
}

interface AccountFormProps {
  initialEmail: string;
  /** Back from step (b): the focus goes to the title. */
  returning: boolean;
  simulated: boolean;
  onCreated: (email: string) => void;
}

/** Step (a): e-mail, password and its confirmation. */
function AccountForm({ initialEmail, returning, simulated, onCreated }: AccountFormProps) {
  const { signUp } = useAuth();
  const errorId = useId();
  const busy = useRef(false);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    const problem =
      emailProblem(email) ?? newPasswordProblem(password, confirmation, 'Informe a senha.');
    if (problem) {
      setError(problem);
      return;
    }
    busy.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await signUp(email.trim(), password);
      onCreated(email.trim());
    } catch (caught) {
      setError(messageOf(caught, 'Não foi possível criar a conta. Tente de novo.'));
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title="Cadastre-se" focusTitle={returning}>
      {simulated && (
        <Alert color="orange" variant="light" title="Dados simulados" role="note">
          O e-mail “{MOCK_EXISTING_EMAIL}” simula uma conta que já existe.
        </Alert>
      )}
      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        aria-describedby={error ? errorId : undefined}
      >
        <Stack gap="md">
          <ErrorAlert message={error} id={errorId} />
          <TextInput
            label="E-mail"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.currentTarget.value);
            }}
          />
          <PasswordInput
            label="Senha"
            description={PASSWORD_HINT}
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
            }}
          />
          <PasswordInput
            label="Confirme a senha"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.currentTarget.value);
            }}
          />
          <Button type="submit" loading={submitting}>
            Criar conta
          </Button>
        </Stack>
      </form>
      <Text size="sm">
        Já tem conta?{' '}
        <Anchor component={Link} to={paths.login}>
          Entrar
        </Anchor>
      </Text>
    </AuthCard>
  );
}

interface ConfirmFormProps {
  email: string;
  simulated: boolean;
  onConfirmed: (signedIn: boolean) => void;
  onChangeEmail: () => void;
}

/** Step (b): the 6-digit code sent to the e-mail. */
function ConfirmForm({ email, simulated, onConfirmed, onChangeEmail }: ConfirmFormProps) {
  const { confirmSignUp, resendSignUpCode } = useAuth();
  const errorId = useId();
  const busy = useRef(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The confirmation or the resend found the account already confirmed. */
  const [alreadyConfirmed, setAlreadyConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<'confirm' | 'resend' | null>(null);

  const showError = (caught: unknown, fallback: string) => {
    setError(messageOf(caught, fallback));
    setAlreadyConfirmed(caught instanceof AuthError && caught.code === 'ALREADY_CONFIRMED');
  };

  const clearMessages = () => {
    setError(null);
    setAlreadyConfirmed(false);
    setNotice(null);
  };

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    const cleanCode = code.replace(/\s/g, '');
    if (!CODE_PATTERN.test(cleanCode)) {
      clearMessages();
      setError('Informe o código de 6 dígitos.');
      return;
    }
    busy.current = true;
    setAction('confirm');
    clearMessages();
    let result: ConfirmSignUpResult | null = null;
    try {
      result = await confirmSignUp(email, cleanCode);
    } catch (caught) {
      showError(caught, 'Não foi possível confirmar o e-mail. Tente de novo.');
    } finally {
      busy.current = false;
      setAction(null);
    }
    if (result) onConfirmed(result === 'SIGNED_IN');
  };

  const handleResend = async () => {
    if (busy.current) return;
    busy.current = true;
    setAction('resend');
    clearMessages();
    try {
      await resendSignUpCode(email);
      setNotice(`Enviamos um novo código para ${email}.`);
    } catch (caught) {
      showError(caught, 'Não foi possível reenviar o código. Tente de novo.');
    } finally {
      busy.current = false;
      setAction(null);
    }
  };

  return (
    <AuthCard title="Confirme seu e-mail" focusTitle>
      <Text>Enviamos um código para {email}.</Text>
      {simulated && (
        <Alert color="orange" variant="light" title="Dados simulados" role="note">
          O código é “{MOCK_SIGN_UP_CODE}”; “{MOCK_EXPIRED_CODE}” simula um código expirado.
        </Alert>
      )}
      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        aria-describedby={error ? errorId : undefined}
      >
        <Stack gap="md">
          <ErrorAlert message={error} id={errorId}>
            {alreadyConfirmed && (
              <Text size="sm" mt="xs">
                {/* Inherits the alert text color: the link color is under 4.5:1 on it. */}
                <Anchor
                  component={Link}
                  c="inherit"
                  fw={700}
                  underline="always"
                  to={paths.login}
                  state={{ confirmedEmail: email } satisfies LoginPageState}
                >
                  Entrar
                </Anchor>
              </Text>
            )}
          </ErrorAlert>
          {notice && (
            <Alert
              color="green"
              variant="light"
              icon={<IconCircleCheck aria-hidden />}
              role="status"
              title="Novo código enviado"
            >
              {notice}
            </Alert>
          )}
          <TextInput
            label="Código"
            description="6 dígitos"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(event) => {
              setCode(event.currentTarget.value);
            }}
          />
          <Button type="submit" loading={action === 'confirm'} disabled={action === 'resend'}>
            Confirmar
          </Button>
          <Button
            type="button"
            variant="default"
            loading={action === 'resend'}
            disabled={action === 'confirm'}
            onClick={() => void handleResend()}
          >
            Reenviar código
          </Button>
        </Stack>
      </form>
      <Text size="sm">
        Não é este e-mail? {/* Not while a request runs: its answer belongs to this e-mail. */}
        <Anchor component="button" type="button" disabled={action !== null} onClick={onChangeEmail}>
          Trocar e-mail
        </Anchor>
      </Text>
    </AuthCard>
  );
}

/**
 * § 6.1 and § 2: open sign-up with e-mail and password (creates a guardian), then the
 * e-mail code. After the code the user is signed in, or sent to the login when the
 * automatic sign-in is not possible.
 */
export function SignUpPage() {
  const { status, supportsRoleChoice } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // The code step lives in router state (memory, never the URL), so a reload or the
  // history keeps it: set after "Criar conta" or by the login, for an unconfirmed account.
  const confirmEmail = confirmEmailOf(location.state);
  /** E-mail to fill in when going back from the code step. */
  const [draftEmail, setDraftEmail] = useState('');

  if (status === 'signedIn') return <Navigate to={paths.students} replace />;

  if (confirmEmail) {
    return (
      <ConfirmForm
        key={confirmEmail}
        email={confirmEmail}
        simulated={supportsRoleChoice}
        onConfirmed={(signedIn) => {
          if (signedIn) {
            void navigate(paths.students, { replace: true });
            return;
          }
          const state: LoginPageState = { confirmedEmail: confirmEmail };
          void navigate(paths.login, { replace: true, state });
        }}
        onChangeEmail={() => {
          setDraftEmail(confirmEmail);
          void navigate(paths.signUp, { replace: true, state: null });
        }}
      />
    );
  }

  return (
    <AccountForm
      initialEmail={draftEmail}
      returning={draftEmail !== ''}
      simulated={supportsRoleChoice}
      onCreated={(created) => {
        const state: SignUpPageState = { confirmEmail: created };
        void navigate(paths.signUp, { replace: true, state });
      }}
    />
  );
}
