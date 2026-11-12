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
  /**
   * One line instead of the box: the title and the message in a sentence, with "Tentar de novo"
   * beside them (below them where the line is too narrow). For an error that comes with the
   * screen already in use, above what the user is filling in: it must push that down as little
   * as it can.
   */
  compact?: boolean;
}

/**
 * Narrowest text of the compact error with the button still beside it; below that the button
 * wraps under the text instead of squeezing it into a tall column.
 */
const COMPACT_TEXT_BASIS = '16rem';

/** Error loading data: the API message, with "Tentar de novo" unless it is a 403. */
export function LoadError({
  title,
  error,
  retrying,
  onRetry,
  retryFocus: { buttonRef, pressed },
  compact = false,
}: LoadErrorProps) {
  const forbidden = error instanceof ApiError && error.status === 403;
  const heading = forbidden ? 'Sem permissão' : title;
  const retry = !forbidden && (
    <Button
      ref={buttonRef}
      variant="default"
      loading={retrying}
      style={compact ? { flex: 'none' } : undefined}
      onClick={() => {
        pressed();
        onRetry();
      }}
    >
      Tentar de novo
    </Button>
  );

  if (compact) {
    return (
      <Group role="alert" gap="xs" wrap="wrap" align="center">
        <Group
          gap="xs"
          wrap="nowrap"
          align="flex-start"
          style={{ flex: `1 1 ${COMPACT_TEXT_BASIS}`, minWidth: 0 }}
        >
          {/* Decorative: the sentence says it is an error; the color only reinforces it. */}
          <IconAlertCircle
            size={18}
            aria-hidden
            style={{ flex: 'none', marginTop: 1, color: 'var(--mantine-color-error)' }}
          />
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            <Text span inherit fw={600}>
              {`${heading}.`}
            </Text>{' '}
            {errorMessage(error)}
          </Text>
        </Group>
        {retry}
      </Group>
    );
  }

  return (
    <Alert
      color="red"
      variant="light"
      role="alert"
      icon={<IconAlertCircle aria-hidden />}
      title={heading}
    >
      <Stack gap="sm" align="flex-start">
        <Text size="sm">{errorMessage(error)}</Text>
        {retry}
      </Stack>
    </Alert>
  );
}
