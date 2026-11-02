import { Alert } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

interface Props {
  message: string | null;
  /** Lets the form point at the alert with `aria-describedby`. */
  id?: string;
  children?: ReactNode;
}

/** Form error of the login and sign-up screens. */
export function ErrorAlert({ message, id, children }: Props) {
  if (!message) return null;
  return (
    <Alert
      id={id}
      color="red"
      variant="light"
      icon={<IconAlertCircle aria-hidden />}
      role="alert"
      title="Erro"
    >
      {message}
      {children}
    </Alert>
  );
}
