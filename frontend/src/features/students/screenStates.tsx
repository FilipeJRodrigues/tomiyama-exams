import { Alert, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';

import { ApiError, errorMessage } from '../../api/client';
import type { RetryFocus } from './useRetryFocus';

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
  /**
   * The screen's `useRetryFocus`: where the focus goes once the reload asked by "Tentar de
   * novo" ends (§ 6.7). Its `buttonRef` is the "Tentar de novo" of this error.
   */
  retryFocus: RetryFocus;
}

/** Error loading data: the API message, with "Tentar de novo" unless it is a 403. */
export function LoadError({
  title,
  error,
  retrying,
  onRetry,
  retryFocus: { buttonRef, pressed },
}: LoadErrorProps) {
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
          <Button
            ref={buttonRef}
            variant="default"
            loading={retrying}
            onClick={() => {
              pressed();
              onRetry();
            }}
          >
            Tentar de novo
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
