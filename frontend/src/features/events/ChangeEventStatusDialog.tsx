import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useEffect, useState, type Ref } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import { useUpdateEvent } from '../../api/queries';
import type { ExamEvent } from '../../api/types';
import { useSendLock } from '../../lib/sendLock';
import { nextStatus, statusChangeQuestion, statusChangeTexts } from './eventStatusChange';

interface Props {
  ref?: Ref<HTMLDivElement>;
  /**
   * The event as the screen shows it. Read when the dialog opens: the texts and the request
   * stay those of the opening, also while the dialog fades out after the change.
   */
  event: ExamEvent | null;
  opened: boolean;
  fullScreen: boolean;
  /** "Cancelar", "Fechar" or `Esc`; never called while the change is on its way. */
  onClose: () => void;
  /** The API saved the change: the caller closes the dialog (`opened` false), and may say so. */
  onChanged: (saved: ExamEvent) => void;
  /** The dialog finished closing: the caller gives the focus back. */
  onClosed: () => void;
}

/**
 * Confirmation of "Encerrar" / "Reabrir" (§ 6.5, RN016): `PUT /events/{id}` with the name of
 * the event and the other status, the same body as the edit form (the date never changes and
 * is not sent). Closing blocks attendance and marking; the sensei still decides the exams in
 * progress (RN008a). The API decides; its message stays in the dialog (403, 404 of an event
 * deleted meanwhile, 503) and a new try may go.
 *
 * Self-contained, for any screen with an event (events list, exam day): it sends the request
 * itself, with one request at a time (`useSendLock`, also while it fades out after a change
 * that worked, #88). `useUpdateEvent` updates the events list and what is cached under the
 * event.
 */
export function ChangeEventStatusDialog({
  ref,
  event,
  opened,
  fullScreen,
  onClose,
  onChanged,
  onClosed,
}: Props) {
  const update = useUpdateEvent();
  const lock = useSendLock();
  const sending = update.isPending;

  const [shown, setShown] = useState<ExamEvent | null>(opened ? event : null);
  const [error, setError] = useState<unknown>(null);
  const [wasOpened, setWasOpened] = useState(opened);
  // A new opening starts from the event as it is now, without the error of the previous one.
  if (opened !== wasOpened) {
    setWasOpened(opened);
    if (opened) {
      setShown(event);
      setError(null);
    }
  } else if (opened && event !== null && event.id !== shown?.id) {
    setShown(event);
    setError(null);
  }

  // Opening again cancels the closing, and with it `onExitTransitionEnd`: free the lock here.
  useEffect(() => {
    if (opened) lock.release();
  }, [opened, lock]);

  const requestClose = () => {
    if (lock.held() || sending) return;
    onClose();
  };

  const confirm = () => {
    if (!shown || sending || !lock.take()) return;
    setError(null);
    update.mutate(
      { id: shown.id, input: { name: shown.name, status: nextStatus(shown.status) } },
      {
        onSuccess: (saved) => {
          // No new PUT while the dialog fades out: until `onExitTransitionEnd`.
          lock.keepUntilClosed();
          onChanged(saved);
        },
        onError: (failure) => {
          // The dialog stays open with the API message: a new try may go.
          lock.release();
          setError(failure);
        },
      },
    );
  };

  const closed = () => {
    lock.closed();
    onClosed();
  };

  const texts = statusChangeTexts(shown ? nextStatus(shown.status) : 'CLOSED');
  const hasError = error !== null && error !== undefined;

  return (
    <Modal
      ref={ref}
      opened={opened}
      onClose={requestClose}
      title={texts.title}
      centered
      fullScreen={fullScreen}
      closeOnEscape={!sending}
      closeOnClickOutside={!sending}
      returnFocus={false}
      onExitTransitionEnd={closed}
      closeButtonProps={{ 'aria-label': 'Fechar', disabled: sending }}
    >
      {shown && (
        <Stack gap="md">
          <Text style={{ overflowWrap: 'anywhere' }}>{statusChangeQuestion(shown)}</Text>
          {hasError && (
            <Alert
              color="red"
              variant="light"
              role="alert"
              icon={<IconAlertCircle aria-hidden />}
              title={
                error instanceof ApiError && error.status === 403 ? 'Sem permissão' : texts.failure
              }
            >
              {errorMessage(error)}
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={requestClose} disabled={sending} data-autofocus>
              Cancelar
            </Button>
            <Button loading={sending} onClick={confirm}>
              {texts.action}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
