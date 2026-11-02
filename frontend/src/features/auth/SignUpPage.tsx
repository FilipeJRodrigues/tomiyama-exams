import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';

import { paths } from '../../app/navigation';
import { AuthCard } from './AuthCard';

/**
 * § 6.1: open sign-up (creates a guardian). Placeholder: the fields are final, but the
 * account creation (Cognito `signUp` + e-mail code) is not wired yet.
 */
export function SignUpPage() {
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
  };

  return (
    <AuthCard title="Cadastre-se">
      <form onSubmit={handleSubmit} noValidate>
        <Stack gap="md">
          {submitted && (
            <Alert
              color="blue"
              icon={<IconInfoCircle aria-hidden />}
              role="status"
              title="Em breve"
            >
              O cadastro pelo site ainda não está disponível.
            </Alert>
          )}
          <TextInput label="E-mail" type="email" autoComplete="email" required />
          <PasswordInput
            label="Senha"
            description="Pelo menos 8 caracteres"
            autoComplete="new-password"
            required
          />
          <PasswordInput label="Confirme a senha" autoComplete="new-password" required />
          <Button type="submit">Criar conta</Button>
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
