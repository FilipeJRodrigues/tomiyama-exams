import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { Ref } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import type { Requirement } from '../../api/types';
import { kindLabel, shortText } from './requirementText';

function errorTitle(error: unknown): string {
  return error instanceof ApiError && error.status === 403
    ? 'Sem permissão'
    : 'Não foi possível excluir';
}

interface Props {
  ref?: Ref<HTMLDivElement>;
  requirement: Requirement | null;
  beltName: string | undefined;
  opened: boolean;
  deleting: boolean;
  error: unknown;
  fullScreen: boolean;
  onConfirm: () => void;
  onClose: () => void;
  onClosed: () => void;
}

/**
 * Confirmation of `DELETE /requirements/{id}` (§ 6.5). `Esc`, "Fechar" and "Cancelar" close
 * it, except while the request is on its way. An item with answers is refused by the API
 * with 409; the message stays in the dialog.
 */
export function DeleteRequirementDialog({
  ref,
  requirement,
  beltName,
  opened,
  deleting,
  error,
  fullScreen,
  onConfirm,
  onClose,
  onClosed,
}: Props) {
  const hasError = error !== null && error !== undefined;
  return (
    <Modal
      ref={ref}
      opened={opened}
      onClose={onClose}
      title="Excluir requisito"
      centered
      fullScreen={fullScreen}
      closeOnEscape={!deleting}
      closeOnClickOutside={!deleting}
      returnFocus={false}
      onExitTransitionEnd={onClosed}
      closeButtonProps={{ 'aria-label': 'Fechar', disabled: deleting }}
    >
      {requirement && (
        <Stack gap="md">
          <Text style={{ overflowWrap: 'anywhere' }}>
            Excluir o item “{shortText(requirement.description)}” ({kindLabel(requirement.kind)}
            {beltName ? `, faixa ${beltName}` : ''})? Esta ação não pode ser desfeita.
          </Text>
          {hasError && (
            <Alert
              color="red"
              variant="light"
              role="alert"
              icon={<IconAlertCircle aria-hidden />}
              title={errorTitle(error)}
            >
              {errorMessage(error)}
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={onClose} disabled={deleting} data-autofocus>
              Cancelar
            </Button>
            {/* red.9: white text at 4.5:1 or more, also on hover (§ 6.7). */}
            <Button color="red.9" loading={deleting} onClick={onConfirm}>
              Excluir
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
