import { Alert, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { Ref } from 'react';

import { ApiError, errorMessage } from '../../api/client';

/** Loading state announced to screen readers. */
export function LoadingState({ label }: { label: string }) {
  return (
    <Group role="status" gap="sm" py="xl" justify="center">
      <Loader size="sm" aria-hidden />
      <Text>{label}</Text>
    </Group>
  );
}

interface LoadErrorProps {
  /** Title for errors other than 403. */
  title: string;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  /** The "Tentar de novo" button, for a screen that moves the focus to it. */
  retryRef?: Ref<HTMLButtonElement>;
}

/** Error loading data: the API message, with "Tentar de novo" unless it is a 403. */
export function LoadError({ title, error, retrying, onRetry, retryRef }: LoadErrorProps) {
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <Alert
      color="red"
      variant="light"
      role="alert"
      icon={<IconAlertCircle aria-hidden />}
      title={forbidden ? 'Sem permissão' : title}
    >
      <Stack gap="sm" align="flex-start">
        <Text size="sm">{errorMessage(error)}</Text>
        {!forbidden && (
          <Button ref={retryRef} variant="default" loading={retrying} onClick={onRetry}>
            Tentar de novo
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
