import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { Ref } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import type { LogoSlot } from '../../api/types';
import { markOutcomeUnknown } from '../exam/examModel';
import { logoName } from './logoModel';

function errorTitle(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Sem permissão';
  if (markOutcomeUnknown(error)) return 'Não foi possível confirmar a remoção';
  return 'Não foi possível remover';
}

interface Props {
  ref?: Ref<HTMLDivElement>;
  slot: LogoSlot;
  opened: boolean;
  removing: boolean;
  error: unknown;
  /** The slot's mark is on: the slot could not be read again, there is no preview to check. */
  mayHaveChanged: boolean;
  fullScreen: boolean;
  onConfirm: () => void;
  onClose: () => void;
  onClosed: () => void;
}

/**
 * Confirmation of `DELETE /settings/logos/{slot}` (§ 6.6), like the other delete dialogs:
 * `Esc`, "Fechar" and "Cancelar" close it, except while the request is on its way; the API
 * message stays in the dialog.
 */
export function RemoveLogoDialog({
  ref,
  slot,
  opened,
  removing,
  error,
  mayHaveChanged,
  fullScreen,
  onConfirm,
  onClose,
  onClosed,
}: Props) {
  const name = logoName(slot);
  const hasError = error !== null && error !== undefined;
  return (
    <Modal
      ref={ref}
      opened={opened}
      onClose={onClose}
      title={`Remover ${name}`}
      centered
      fullScreen={fullScreen}
      closeOnEscape={!removing}
      closeOnClickOutside={!removing}
      returnFocus={false}
      onExitTransitionEnd={onClosed}
      closeButtonProps={{ 'aria-label': 'Fechar', disabled: removing }}
    >
      <Stack gap="md">
        <Text>Remover o {name} da academia? Esta ação não pode ser desfeita.</Text>
        {hasError && (
          <Alert
            color="red"
            variant="light"
            role="alert"
            icon={<IconAlertCircle aria-hidden />}
            title={errorTitle(error)}
          >
            <Text size="sm">{errorMessage(error)}</Text>
            {markOutcomeUnknown(error) && (
              <Text size="sm" mt="xs">
                {/* Removing again is safe: the API answers 204 also for an empty slot. */}
                {mayHaveChanged
                  ? 'O logo pode ter sido removido, mas não foi possível conferir. Remova de novo para concluir.'
                  : 'O logo pode ter sido removido. Confira a prévia e remova de novo se precisar.'}
              </Text>
            )}
          </Alert>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={removing} data-autofocus>
            Cancelar
          </Button>
          {/* red.9: white text at 4.5:1 or more, also on hover (§ 6.7). */}
          <Button color="red.9" loading={removing} onClick={onConfirm}>
            Remover
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
