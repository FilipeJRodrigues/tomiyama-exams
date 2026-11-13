import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';

import { paths } from '../../app/navigation';
import { MOCK_EXPIRED_CODE, MOCK_RESET_CODE } from '../../auth/mockConstants';
import { AuthError } from '../../auth/types';
import { useAuth } from '../../auth/useAuth';
import { TOUCH_TARGET } from '../exam/touch';
import { AuthCard } from './AuthCard';
import { TOUCH_LINK } from './touchLink';
import { ErrorAlert } from './ErrorAlert';
import { PASSWORD_HINT, emailProblem, newPasswordProblem } from './passwordRules';
import {
  draftEmailOf,
  resetEmailOf,
  resetRequiredOf,
  type ForgotPasswordPageState,
  type LoginPageState,
  type SignUpPageState,
} from './routeState';

const CODE_PATTERN = /^\d{6}$/;

/** Sender of the Cognito default e-mail (COGNITO_DEFAULT, no SES): the text is in English. */
const COGNITO_SENDER = 'no-reply@verificationemail.com';

/** Field a client-side check points at (`aria-invalid` + `aria-errormessage`). */
type Field = 'email' | 'code' | 'password' | 'confirmation';

interface FormError {
  message: string;
  field: Field | null;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof AuthError ? error.message : fallback;
}

/** Props that tie a field to the form error when the error is about that field. */
function fieldErrorProps(error: FormError | null, field: Field, errorId: string) {
  const invalid = error?.field === field;
  return {
    error: invalid,
    // Explicit: PasswordInput does not set it from `error`.
    'aria-invalid': invalid || undefined,
    'aria-errormessage': invalid ? errorId : undefined,
  };
}

/**
 * False once the step is gone (the person went back to the login or used the browser back):
 * a late answer then neither navigates nor changes the screen she chose (#146).
 */
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function BackToLogin() {
  return (
    <Text size="sm">
      <Anchor component={Link} to={paths.login} style={TOUCH_LINK}>
        Voltar para o login
      </Anchor>
    </Text>
  );
}

interface RequestCodeFormProps {
  initialEmail: string;
  onSent: (email: string) => void;
}

/** Step 1: the e-mail of the account. The answer never says whether the account exists. */
function RequestCodeForm({ initialEmail, onSent }: RequestCodeFormProps) {
  const { resetPassword } = useAuth();
  const errorId = useId();
  const busy = useRef(false);
  const mounted = useMounted();
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<FormError | null>(null);
  /** E-mail of an account that still needs the sign-up code (offers that step). */
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    setUnconfirmedEmail(null);
    const problem = emailProblem(email);
    if (problem) {
      setError({ message: problem, field: 'email' });
      return;
    }
    const cleanEmail = email.trim();
    busy.current = true;
    setSubmitting(true);
    setError(null);
    let sent = false;
    try {
      await resetPassword(cleanEmail);
      sent = true;
    } catch (caught) {
      if (!mounted.current) return;
      setError({
        message: messageOf(caught, 'Não foi possível enviar o código. Tente de novo.'),
        field: null,
      });
      if (caught instanceof AuthError && caught.code === 'USER_NOT_CONFIRMED') {
        setUnconfirmedEmail(cleanEmail);
      }
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
    if (sent && mounted.current) onSent(cleanEmail);
  };

  return (
    <AuthCard title="Recuperar senha" focusTitle>
      <Text>Enviaremos um código para o e-mail da sua conta.</Text>
      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        aria-describedby={error ? errorId : undefined}
      >
        <Stack gap="md">
          <ErrorAlert message={error?.message ?? null} id={errorId}>
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
            autoComplete="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.currentTarget.value);
            }}
            {...fieldErrorProps(error, 'email', errorId)}
          />
          <Button type="submit" loading={submitting} style={TOUCH_TARGET}>
            Enviar código
          </Button>
        </Stack>
      </form>
      <BackToLogin />
    </AuthCard>
  );
}

interface ResetFormProps {
  email: string;
  /** The academy reset the password in the console (the code went out at that time). */
  resetRequired: boolean;
  simulated: boolean;
  onDone: () => void;
  onChangeEmail: () => void;
}

/** Step 2: the 6-digit code from the e-mail, the new password and its confirmation. */
function ResetForm({ email, resetRequired, simulated, onDone, onChangeEmail }: ResetFormProps) {
  const { confirmResetPassword, resetPassword } = useAuth();
  const errorId = useId();
  const busy = useRef(false);
  const mounted = useMounted();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<FormError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<'confirm' | 'resend' | null>(null);

  const clientProblem = (cleanCode: string): FormError | null => {
    if (!CODE_PATTERN.test(cleanCode)) {
      return { message: 'Informe o código de 6 dígitos.', field: 'code' };
    }
    const passwordIssue = newPasswordProblem(password, password, 'Informe a nova senha.');
    if (passwordIssue) return { message: passwordIssue, field: 'password' };
    const confirmationIssue = newPasswordProblem(password, confirmation, 'Informe a nova senha.');
    if (confirmationIssue) return { message: confirmationIssue, field: 'confirmation' };
    return null;
  };

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    const cleanCode = code.replace(/\s/g, '');
    setNotice(null);
    const problem = clientProblem(cleanCode);
    if (problem) {
      setError(problem);
      return;
    }
    busy.current = true;
    setAction('confirm');
    setError(null);
    let done = false;
    try {
      await confirmResetPassword(email, cleanCode, password);
      done = true;
    } catch (caught) {
      if (!mounted.current) return;
      setError({
        message: messageOf(caught, 'Não foi possível redefinir a senha. Tente de novo.'),
        field: null,
      });
    } finally {
      busy.current = false;
      setAction(null);
    }
    if (done && mounted.current) onDone();
  };

  const handleResend = async () => {
    if (busy.current) return;
    busy.current = true;
    setAction('resend');
    setError(null);
    setNotice(null);
    try {
      await resetPassword(email);
      if (!mounted.current) return;
      setNotice(`Se o e-mail estiver cadastrado, enviamos um novo código para ${email}.`);
    } catch (caught) {
      if (!mounted.current) return;
      setError({
        message: messageOf(caught, 'Não foi possível reenviar o código. Tente de novo.'),
        field: null,
      });
    } finally {
      busy.current = false;
      setAction(null);
    }
  };

  return (
    <AuthCard title="Crie uma nova senha" focusTitle>
      {resetRequired ? (
        <Alert
          color="blue"
          variant="light"
          icon={<IconInfoCircle aria-hidden />}
          title="A academia redefiniu sua senha"
        >
          Enviamos um código para {email} quando a senha foi redefinida. Se ele não chegou ou
          expirou, peça um novo.
        </Alert>
      ) : (
        <Text>Se o e-mail estiver cadastrado, enviamos um código para {email}.</Text>
      )}
      <Text size="sm">
        O código chega num e-mail em inglês, enviado por{' '}
        {/* One piece: at 360 px it would break at the hyphen. */}
        <span style={{ whiteSpace: 'nowrap' }}>{COGNITO_SENDER}</span>. Se ele não aparecer em
        alguns minutos, veja a caixa de spam.
      </Text>
      {simulated && (
        <Alert color="orange" variant="light" title="Dados simulados" role="note">
          O código é “{MOCK_RESET_CODE}”; “{MOCK_EXPIRED_CODE}” simula um código expirado.
        </Alert>
      )}
      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        aria-describedby={error ? errorId : undefined}
      >
        <Stack gap="md">
          <ErrorAlert message={error?.message ?? null} id={errorId} />
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
            {...fieldErrorProps(error, 'code', errorId)}
          />
          <PasswordInput
            label="Nova senha"
            description={PASSWORD_HINT}
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
            }}
            {...fieldErrorProps(error, 'password', errorId)}
          />
          <PasswordInput
            label="Confirme a nova senha"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.currentTarget.value);
            }}
            {...fieldErrorProps(error, 'confirmation', errorId)}
          />
          <Button
            type="submit"
            loading={action === 'confirm'}
            disabled={action === 'resend'}
            style={TOUCH_TARGET}
          >
            Salvar nova senha
          </Button>
          <Button
            type="button"
            variant="default"
            loading={action === 'resend'}
            disabled={action === 'confirm'}
            style={TOUCH_TARGET}
            onClick={() => void handleResend()}
          >
            Reenviar código
          </Button>
        </Stack>
      </form>
      <Text size="sm">
        Não é este e-mail? {/* Not while a request runs: its answer belongs to this e-mail. */}
        <Anchor
          component="button"
          type="button"
          disabled={action !== null}
          onClick={onChangeEmail}
          style={TOUCH_LINK}
        >
          Trocar e-mail
        </Anchor>
      </Text>
      <BackToLogin />
    </AuthCard>
  );
}

/**
 * § 2 and § 6.1: password recovery by e-mail, for every profile. Step 1 asks for the e-mail
 * and sends the code (same answer for an unknown e-mail); step 2 takes the code and the new
 * password, then goes back to the login with the e-mail filled in.
 */
export function ForgotPasswordPage() {
  const { status, supportsRoleChoice } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Both steps live in router state (memory, never the URL), like the sign-up code step.
  const resetEmail = resetEmailOf(location.state);
  const resetRequired = resetRequiredOf(location.state);
  const draftEmail = draftEmailOf(location.state) ?? '';

  if (status === 'signedIn') return <Navigate to={paths.students} replace />;

  if (resetEmail) {
    return (
      <ResetForm
        key={resetEmail}
        email={resetEmail}
        resetRequired={resetRequired}
        simulated={supportsRoleChoice}
        onDone={() => {
          const state: LoginPageState = { passwordResetEmail: resetEmail };
          void navigate(paths.login, { replace: true, state });
        }}
        onChangeEmail={() => {
          const state: ForgotPasswordPageState = { draftEmail: resetEmail };
          void navigate(paths.forgotPassword, { replace: true, state });
        }}
      />
    );
  }

  return (
    <RequestCodeForm
      key={draftEmail}
      initialEmail={draftEmail}
      onSent={(sentTo) => {
        const state: ForgotPasswordPageState = { resetEmail: sentTo };
        void navigate(paths.forgotPassword, { replace: true, state });
      }}
    />
  );
}
