import { Alert, Box, Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconCircleCheck } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';

import { errorMessage, networkError } from '../../api/client';
import {
  useDeleteLogo,
  useLogo,
  useLogoChange,
  useLogoWrites,
  useUploadLogo,
  type LogoWriteKind,
} from '../../api/queries';
import type { LogoSlot } from '../../api/types';
import { markOutcomeUnknown } from '../exam/examModel';
import { focusIfLost } from '../exam/focus';
import { LoadError } from '../students/screenStates';
import { useRetryFocus } from '../students/useRetryFocus';
import { RemoveLogoDialog } from './RemoveLogoDialog';
import {
  LOGO_ACCEPT,
  LOGO_SLOT_LABELS,
  describeLogo,
  logoName,
  logoWriteErrorTitle,
  logoWriteUnknownHint,
  prepareLogo,
} from './logoModel';

const PREVIEW_HEIGHT = 120;

/** What a read waiting for the network shows: the browser is offline. */
const OFFLINE_ERROR = networkError();

/** A failed write shown above the preview. */
interface WriteError {
  kind: LogoWriteKind;
  error: unknown;
}

/** The red notice above the preview: the chosen file or a failed write. */
interface ErrorNotice {
  title: string;
  message: string;
  /** What to do when the write may have been stored anyway. */
  hint: string | null;
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
 * After a write that stored the logo, or may have, and no read that worked, the slot's mark
 * "the logo may have changed" is on (`useLogoChange`, kept in the query cache, so also after
 * leaving the screen and coming back): the old preview (or "Nenhum logo") may not be the
 * slot's, so the slot shows the read error with "Tentar de novo", without "Trocar"/"Remover",
 * until a read works. "salvo" only comes with a read that brings the logo sent. A read that
 * waits for the network (the browser is offline) does not end by itself: with the mark on it
 * is shown as the read error too, and it goes on once the network is back.
 *
 * A write goes on after leaving the screen. The panel opened while one of the slot's writes
 * is on its way (`useLogoWrites`) shows the slot as the panel that started it did: busy, with
 * no action, until it ends; then what it left, with its "salvo"/"removido" or its error.
 */
export function LogoSlotPanel({ slot, fullScreenDialog }: Props) {
  const label = LOGO_SLOT_LABELS[slot];
  const name = logoName(slot);
  const titleId = useId();
  const hintId = useId();
  const brokenId = useId();

  const logo = useLogo(slot);
  const change = useLogoChange(slot);
  const upload = useUploadLogo(slot);
  const remove = useDeleteLogo(slot);
  const writes = useLogoWrites(slot);

  const [preparing, setPreparing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeOpened, setRemoveOpened] = useState(false);
  /** URL whose image could not be shown even after a new read. */
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  /**
   * Writes ended so far, the panel's sendings and the writes it took over: after each one the
   * focus goes back to the slot's button (once enabled).
   */
  const [writesEnded, setWritesEnded] = useState(0);
  /**
   * The slot's writes on their way when the panel opened, started by a panel no longer on
   * screen (the screen was left): their end is shown here, as in the panel that started them.
   */
  const [adopted, setAdopted] = useState<readonly number[]>(() =>
    writes.filter((write) => write.status === 'pending').map((write) => write.id),
  );
  /** The error of a write taken over (`adopted`); this panel's own is on `upload.error`. */
  const [adoptedError, setAdoptedError] = useState<WriteError | null>(null);
  /** The slot's mark on the last render: when a read turns it off, the slot says so. */
  const [seenChange, setSeenChange] = useState(change);
  /** Times a button of the slot went away under the focus: it goes back to the slot. */
  const [focusBack, setFocusBack] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  // "Tentar de novo" of the read error: once the read it asked for ends, the focus goes to it
  // again (failed again) or stays in the slot ("Carregar"/"Trocar") (§ 6.7).
  const loadRetry = useRetryFocus([logo], chooseRef);
  const { buttonRef: loadRetryRef } = loadRetry;
  const dialogRef = useRef<HTMLDivElement>(null);
  /** Synchronous lock of the slot: `isPending` only arrives on the next render. */
  const busy = useRef(false);
  /** Whether the slot was already read again because its image failed to load. */
  const reloadedForImage = useRef(false);

  /** A write of the slot on its way: this panel's, or one it took over. */
  const writing = (kind: LogoWriteKind) =>
    writes.some((write) => write.kind === kind && write.status === 'pending');
  const sending = preparing || upload.isPending || writing('upload');
  const removing = remove.isPending || writing('remove');
  const current = logo.data ?? null;
  /** The cached logo may not be the slot's: only the read error or the loading is shown. */
  const mayHaveChanged = change !== null;

  // A write taken over ended: the slot shows what it left (the read again is over, and the
  // mark is on when it failed), and says how it ended, as the panel that started it would.
  const adoptedEnded = writes.filter(
    (write) => adopted.includes(write.id) && write.status !== 'pending',
  );
  if (adoptedEnded.length > 0) {
    const endedIds = adoptedEnded.map((write) => write.id);
    setAdopted(adopted.filter((id) => !endedIds.includes(id)));
    for (const write of adoptedEnded) {
      if (write.status === 'error') {
        setAdoptedError({ kind: write.kind, error: write.error });
      } else if (write.kind === 'remove') {
        setBrokenUrl(null);
        setNotice(`${label} removido.`);
      } else {
        setBrokenUrl(null);
        // Without the read the slot's mark is on: "salvo" waits for a read that works.
        if (write.reloaded) setNotice(`${label} salvo.`);
      }
    }
    setWritesEnded((count) => count + 1);
  }

  // A read of the slot worked and turned the mark off: what the slot has is on screen now,
  // and with it the logo sent, when the API had stored it.
  if (seenChange !== change) {
    setSeenChange(change);
    if (seenChange !== null && change === null) {
      if (seenChange.outcome === 'stored') setNotice(`${label} salvo.`);
      setFocusBack((count) => count + 1);
    }
  }

  const clearMessages = () => {
    setNotice(null);
    setFileError(null);
    setAdoptedError(null);
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
      // Without the read the slot's mark is on: "salvo" waits for a read that works.
      if (reloaded) setNotice(`${label} salvo.`);
    } catch {
      // The error is on `upload.error`, shown above the preview. The read again is over: a
      // logo that may have changed is already marked.
    } finally {
      setPreparing(false);
      busy.current = false;
      setWritesEnded((count) => count + 1);
    }
  };

  // The button was disabled while sending: the focus may have left it (§ 6.7). The hidden file
  // input cannot keep it either. It goes back once the button is enabled again.
  // With the mark on the slot shows the read error: the focus goes to its "Tentar de novo".
  useEffect(() => {
    if (writesEnded === 0 || sending) return;
    focusIfLost([chooseRef.current, loadRetryRef.current], { leaving: [inputRef.current] });
  }, [writesEnded, sending, loadRetryRef]);

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

  /**
   * The confirmation is gone: back to "Remover", to "Carregar" once removed, or to "Tentar de
   * novo" when the removal may have happened and the slot could not be read again.
   */
  const removeClosed = () => {
    focusIfLost([removeRef.current, chooseRef.current, loadRetryRef.current], {
      leaving: [dialogRef.current],
    });
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

  const writeError: WriteError | null =
    upload.error !== null ? { kind: 'upload', error: upload.error } : adoptedError;
  let errorNotice: ErrorNotice | null = null;
  if (fileError !== null) {
    errorNotice = { title: 'Não foi possível enviar o logo', message: fileError, hint: null };
  } else if (writeError !== null) {
    errorNotice = {
      title: logoWriteErrorTitle(writeError.kind, writeError.error),
      message: errorMessage(writeError.error),
      hint: markOutcomeUnknown(writeError.error)
        ? logoWriteUnknownHint(writeError.kind, mayHaveChanged)
        : null,
    };
  }
  const broken = current !== null && brokenUrl === current.url;
  /** With the mark on, a read paused until the network is back is the read error (offline). */
  const readWaitsForNetwork = mayHaveChanged && logo.isPaused;

  let body: ReactNode;
  if ((logo.isError || readWaitsForNetwork) && (logo.data === undefined || mayHaveChanged)) {
    body = (
      <LoadError
        title={`Não foi possível carregar o ${name}`}
        error={logo.error ?? OFFLINE_ERROR}
        retrying={logo.isFetching}
        onRetry={() => void logo.refetch()}
        retryFocus={loadRetry}
      />
    );
  } else if (logo.data === undefined || mayHaveChanged) {
    // With the mark on and no error, a read is on its way (opening the screen again).
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
      {errorNotice && (
        <Alert
          color="red"
          variant="light"
          role="alert"
          icon={<IconAlertCircle aria-hidden />}
          title={errorNotice.title}
        >
          <Text size="sm">{errorNotice.message}</Text>
          {errorNotice.hint && (
            <Text size="sm" mt="xs">
              {errorNotice.hint}
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
        mayHaveChanged={mayHaveChanged}
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
