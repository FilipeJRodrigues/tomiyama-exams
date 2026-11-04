import { Alert, Box, Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconCircleCheck } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import { useDeleteLogo, useLogo, useUploadLogo } from '../../api/queries';
import type { LogoSlot } from '../../api/types';
import { markOutcomeUnknown } from '../exam/examModel';
import { focusIfLost } from '../exam/focus';
import { LoadError } from '../students/screenStates';
import { RemoveLogoDialog } from './RemoveLogoDialog';
import { LOGO_ACCEPT, LOGO_SLOT_LABELS, describeLogo, logoName, prepareLogo } from './logoModel';

const PREVIEW_HEIGHT = 120;

function uploadErrorTitle(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Sem permissão';
  if (markOutcomeUnknown(error)) return 'Não foi possível confirmar o envio';
  return 'Não foi possível enviar o logo';
}

interface Props {
  slot: LogoSlot;
  /** The confirmation takes the whole screen on the phone. */
  fullScreenDialog: boolean;
}

/**
 * One logo space of § 6.6 (RN012): the preview (or "Nenhum logo"), "Carregar"/"Trocar" and
 * "Remover" with confirmation. Each slot has its own requests and lock: sending one logo does
 * not hold the other.
 *
 * The pre-signed URL of the preview lasts 5 minutes. The read stays fresh for 4 (reload on
 * focus or on opening the screen again); when the image fails to load (an expired URL, while
 * the screen stayed open), the slot is read once more for a new URL. If the new one fails too,
 * or the read brings the same URL (it only changes from one second to the next), the slot says
 * so and offers "Tentar de novo" (no loop of reloads).
 *
 * "salvo" only comes with the new URL: when the logo is stored but the read again fails, the
 * old preview (or "Nenhum logo") is not the slot's any more, so the slot shows the read error
 * with "Tentar de novo" until a read brings the logo sent.
 */
export function LogoSlotPanel({ slot, fullScreenDialog }: Props) {
  const label = LOGO_SLOT_LABELS[slot];
  const name = logoName(slot);
  const titleId = useId();
  const hintId = useId();
  const brokenId = useId();

  const logo = useLogo(slot);
  const upload = useUploadLogo(slot);
  const remove = useDeleteLogo(slot);

  const [preparing, setPreparing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeOpened, setRemoveOpened] = useState(false);
  /** URL whose image could not be shown even after a new read. */
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  /** Sendings ended so far: after each one the focus goes back to its button (once enabled). */
  const [sendsEnded, setSendsEnded] = useState(0);
  /** The logo was stored but the read again failed: the cached logo is not the slot's. */
  const [outdated, setOutdated] = useState(false);
  /** Times a button of the slot went away under the focus: it goes back to the slot. */
  const [focusBack, setFocusBack] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const loadRetryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** Synchronous lock of the slot: `isPending` only arrives on the next render. */
  const busy = useRef(false);
  /** Whether the slot was already read again because its image failed to load. */
  const reloadedForImage = useRef(false);

  const sending = preparing || upload.isPending;
  const removing = remove.isPending;
  const current = logo.data ?? null;

  // A read brought the slot again after the read that failed: now the logo sent is on screen.
  if (outdated && logo.isSuccess) {
    setOutdated(false);
    setNotice(`${label} salvo.`);
    setFocusBack((count) => count + 1);
  }

  const clearMessages = () => {
    setNotice(null);
    setFileError(null);
    upload.reset();
  };

  const openPicker = () => {
    if (busy.current || sending || removing) return;
    inputRef.current?.click();
  };

  const send = async (file: File) => {
    if (busy.current) return;
    busy.current = true;
    clearMessages();
    setPreparing(true);
    try {
      const prepared = await prepareLogo(file);
      if (!prepared.ok) {
        setFileError(prepared.message);
        return;
      }
      const { reloaded } = await upload.mutateAsync(prepared.input);
      reloadedForImage.current = false;
      setBrokenUrl(null);
      setOutdated(!reloaded);
      if (reloaded) setNotice(`${label} salvo.`);
    } catch {
      // The error is on `upload.error`, shown above the preview.
    } finally {
      setPreparing(false);
      busy.current = false;
      setSendsEnded((count) => count + 1);
    }
  };

  // The button was disabled while sending: the focus may have left it (§ 6.7). The hidden file
  // input cannot keep it either. It goes back once the button is enabled again.
  // Without the new URL the slot shows the read error: the focus goes to its "Tentar de novo".
  useEffect(() => {
    if (sendsEnded === 0 || sending) return;
    focusIfLost([chooseRef.current, loadRetryRef.current], { leaving: [inputRef.current] });
  }, [sendsEnded, sending]);

  // "Tentar de novo" goes away once pressed (§ 6.7): the focus stays in the slot.
  useEffect(() => {
    if (focusBack === 0) return;
    focusIfLost(chooseRef.current);
  }, [focusBack]);

  const fileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Choosing the same file again must fire the change again.
    input.value = '';
    if (file) void send(file);
  };

  const imageFailed = (url: string) => {
    if (!reloadedForImage.current) {
      reloadedForImage.current = true;
      // The same URL makes no new image, so the browser fires no other `error`: it is broken.
      void logo.refetch().then((result) => {
        if (result.data?.url === url) setBrokenUrl(url);
      });
      return;
    }
    setBrokenUrl(url);
  };

  const showAgain = () => {
    setBrokenUrl(null);
    setFocusBack((count) => count + 1);
    void logo.refetch();
  };

  const openRemove = () => {
    if (busy.current || sending || removing) return;
    clearMessages();
    remove.reset();
    setRemoveOpened(true);
  };

  const closeRemove = () => {
    if (busy.current || removing) return;
    setRemoveOpened(false);
  };

  /** The confirmation is gone: back to "Remover", or to "Carregar" once removed. */
  const removeClosed = () => {
    focusIfLost([removeRef.current, chooseRef.current], { leaving: [dialogRef.current] });
  };

  const confirmRemove = () => {
    if (busy.current || removing) return;
    busy.current = true;
    remove.mutate(undefined, {
      onSuccess: () => {
        setBrokenUrl(null);
        setNotice(`${label} removido.`);
        setRemoveOpened(false);
      },
      onSettled: () => {
        busy.current = false;
      },
    });
  };

  const closeNotice = () => {
    setNotice(null);
    // The close button went away with the notice.
    window.setTimeout(() => {
      focusIfLost(chooseRef.current);
    }, 0);
  };

  const uploadError: unknown = fileError ?? upload.error;
  const hasUploadError = uploadError !== null && uploadError !== undefined;
  const broken = current !== null && brokenUrl === current.url;

  let body: ReactNode;
  if (logo.isError && (logo.data === undefined || outdated)) {
    body = (
      <LoadError
        title={`Não foi possível carregar o ${name}`}
        error={logo.error}
        retrying={logo.isFetching}
        onRetry={() => void logo.refetch()}
        retryRef={loadRetryRef}
      />
    );
  } else if (logo.data === undefined) {
    body = (
      <Preview busy>
        <Text size="sm" c="dimmed">
          Carregando logo…
        </Text>
      </Preview>
    );
  } else {
    let preview: ReactNode;
    if (current === null) {
      preview = (
        <Text size="sm" c="dimmed">
          Nenhum logo
        </Text>
      );
    } else if (broken) {
      preview = (
        <Text size="sm" id={brokenId} ta="center" px="sm">
          Não foi possível mostrar o logo.
        </Text>
      );
    } else {
      preview = (
        <img
          key={current.url}
          src={current.url}
          alt={`${label} da academia`}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          onLoad={() => {
            reloadedForImage.current = false;
          }}
          onError={() => {
            imageFailed(current.url);
          }}
        />
      );
    }
    body = (
      <Stack gap="xs">
        <Preview busy={sending || removing}>{preview}</Preview>
        {current && <Text size="sm">{describeLogo(current.content_type, current.size)}</Text>}
        <Text size="sm" c="dimmed" id={hintId}>
          PNG ou JPEG de até 2 MB.
        </Text>
        <input
          ref={inputRef}
          type="file"
          accept={LOGO_ACCEPT}
          hidden
          tabIndex={-1}
          aria-label={`Arquivo do ${name}`}
          disabled={sending || removing}
          onChange={fileChosen}
        />
        <Group gap="sm">
          <Button
            ref={chooseRef}
            variant="default"
            loading={sending}
            disabled={removing}
            aria-label={`${current ? 'Trocar' : 'Carregar'} ${name}`}
            aria-describedby={hintId}
            onClick={openPicker}
          >
            {current ? 'Trocar' : 'Carregar'}
          </Button>
          {current && (
            <Button
              ref={removeRef}
              variant="default"
              disabled={sending || removing}
              aria-label={`Remover ${name}`}
              onClick={openRemove}
            >
              Remover
            </Button>
          )}
          {broken && (
            <Button
              variant="default"
              loading={logo.isFetching}
              aria-describedby={brokenId}
              onClick={showAgain}
            >
              Tentar de novo
            </Button>
          )}
        </Group>
      </Stack>
    );
  }

  return (
    <Stack component="section" gap="sm" aria-labelledby={titleId}>
      <Title order={3} size="h4" id={titleId}>
        {label}
      </Title>
      {notice && (
        <Alert
          color="green"
          variant="light"
          role="status"
          icon={<IconCircleCheck aria-hidden />}
          withCloseButton
          closeButtonLabel={`Fechar aviso do ${name}`}
          onClose={closeNotice}
        >
          {notice}
        </Alert>
      )}
      {hasUploadError && (
        <Alert
          color="red"
          variant="light"
          role="alert"
          icon={<IconAlertCircle aria-hidden />}
          title={fileError ? 'Não foi possível enviar o logo' : uploadErrorTitle(uploadError)}
        >
          <Text size="sm">{fileError ?? errorMessage(uploadError)}</Text>
          {!fileError && markOutcomeUnknown(uploadError) && (
            <Text size="sm" mt="xs">
              O logo pode ter sido salvo. Confira a prévia e envie de novo se precisar.
            </Text>
          )}
        </Alert>
      )}
      {body}
      <RemoveLogoDialog
        ref={dialogRef}
        slot={slot}
        opened={removeOpened}
        removing={removing}
        error={remove.error}
        fullScreen={fullScreenDialog}
        onConfirm={confirmRemove}
        onClose={closeRemove}
        onClosed={removeClosed}
      />
    </Stack>
  );
}

/** The frame of the preview, the same height with or without a logo. */
function Preview({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <Box
      aria-busy={busy}
      h={PREVIEW_HEIGHT}
      p="xs"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
      }}
    >
      {children}
    </Box>
  );
}
