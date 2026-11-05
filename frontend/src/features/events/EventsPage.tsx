import { Alert, Button, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconCircleCheck, IconPlus } from '@tabler/icons-react';
import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';

import {
  compareEvents,
  useCreateEvent,
  useDeleteEvent,
  useEvents,
  useUpdateEvent,
} from '../../api/queries';
import type { ExamEvent } from '../../api/types';
import { MOBILE_QUERY } from '../../app/breakpoints';
import { focusIfLost } from '../exam/focus';
import { LoadError, LoadingState } from '../students/screenStates';
import { useRetryFocus } from '../students/useRetryFocus';
import { DeleteEventDialog } from './DeleteEventDialog';
import { EventForm } from './EventForm';
import { EventsCards, EventsTable } from './EventsList';
import {
  createInputOf,
  eventValuesOf,
  newEventValues,
  updateInputOf,
  type EventFormValues,
} from './eventFormModel';
import { ACTION_ATTRIBUTE, actionButton, actionKey } from './rowActions';

const TITLE_ID = 'events-title';

interface EditorState {
  /** `null`: a new event. */
  event: ExamEvent | null;
  opened: boolean;
  /** New key on every opening: the form starts again from the event (or blank). */
  key: number;
}

interface DeleteState {
  event: ExamEvent;
  opened: boolean;
}

/**
 * § 6.5 events screen (examiners): the events from the most recent to the oldest, with create,
 * edit (name and status; a closed event may be reopened; the date never changes) and delete
 * dialogs. RN016 is checked by the API; its messages are shown as they come.
 */
export function EventsPage() {
  const events = useEvents();
  const isMobile = useMediaQuery(MOBILE_QUERY, false, { getInitialValueInEffect: false });

  const create = useCreateEvent();
  const update = useUpdateEvent();
  const remove = useDeleteEvent();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<DeleteState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRetryFocus([events], titleRef);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const deleteRef = useRef<HTMLDivElement>(null);
  const openings = useRef(0);
  /** Id of the event just created, to give its edit button the focus. */
  const createdId = useRef<string | null>(null);
  /** Last row button with the focus, to find it again after a change of layout. */
  const lastAction = useRef<string | null>(null);
  /** Synchronous lock: `isPending` only arrives on the next render (double click). */
  const busy = useRef(false);

  const saving = create.isPending || update.isPending;

  // Table and cards are different elements: a focus on a row button would fall on the page
  // when the width crosses the phone breakpoint (zoom, rotation). It goes to the same button.
  useEffect(() => {
    if (lastAction.current) focusIfLost(actionButton(lastAction.current));
  }, [isMobile]);

  const rememberAction = (event: FocusEvent<HTMLDivElement>) => {
    const key = event.target.getAttribute(ACTION_ATTRIBUTE);
    if (key) lastAction.current = key;
  };

  const openEditor = (event: ExamEvent | null) => {
    create.reset();
    update.reset();
    setNotice(null);
    createdId.current = null;
    openings.current += 1;
    setEditor({ event, opened: true, key: openings.current });
  };

  const closeEditor = () => {
    // Nothing closes the dialog while the event is on its way to the API.
    if (busy.current || saving) return;
    setEditor((current) => current && { ...current, opened: false });
  };

  /** The dialog is gone: the focus goes back to the row (or to "Novo evento"). */
  const editorClosed = () => {
    const editedId = editor?.event?.id ?? createdId.current;
    setEditor(null);
    focusIfLost(
      [
        editedId ? actionButton(actionKey('edit', editedId)) : null,
        newButtonRef.current,
        titleRef.current,
      ],
      { leaving: [editorRef.current] },
    );
  };

  const save = (values: EventFormValues) => {
    if (!editor || busy.current || saving) return;
    busy.current = true;
    const current = editor.event;
    const done = {
      onSuccess: (saved: ExamEvent) => {
        if (!current) createdId.current = saved.id;
        setNotice(current ? 'Evento salvo.' : 'Evento criado.');
        setEditor((state) => state && { ...state, opened: false });
      },
      onSettled: () => {
        busy.current = false;
      },
    };
    if (current) update.mutate({ id: current.id, input: updateInputOf(values) }, done);
    else create.mutate(createInputOf(values), done);
  };

  const openDelete = (event: ExamEvent) => {
    remove.reset();
    setNotice(null);
    setDeleting({ event, opened: true });
  };

  const closeDelete = () => {
    if (busy.current || remove.isPending) return;
    setDeleting((current) => current && { ...current, opened: false });
  };

  /** The confirmation is gone: back to the row's button, or to the title once deleted. */
  const deleteClosed = () => {
    const id = deleting?.event.id;
    setDeleting(null);
    focusIfLost([id ? actionButton(actionKey('delete', id)) : null, titleRef.current], {
      leaving: [deleteRef.current],
    });
  };

  const confirmDelete = () => {
    if (!deleting || busy.current || remove.isPending) return;
    busy.current = true;
    remove.mutate(deleting.event.id, {
      onSuccess: () => {
        setNotice('Evento excluído.');
        setDeleting((current) => current && { ...current, opened: false });
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
      focusIfLost(titleRef.current);
    }, 0);
  };

  let content: ReactNode;
  if (events.data === undefined && events.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar os eventos"
        error={events.error}
        retrying={events.isFetching}
        onRetry={() => void events.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (events.data === undefined) {
    content = <LoadingState label="Carregando eventos…" />;
  } else if (events.data.length === 0) {
    content = <Text>Nenhum evento cadastrado.</Text>;
  } else {
    const items = [...events.data].sort(compareEvents);
    const List = isMobile ? EventsCards : EventsTable;
    content = (
      <Stack gap="sm" onFocus={rememberAction}>
        <List events={items} labelledBy={TITLE_ID} onEdit={openEditor} onDelete={openDelete} />
      </Stack>
    );
  }

  const editorTitle = editor?.event ? 'Editar evento' : 'Novo evento';

  return (
    <Stack gap="md">
      <Group justify="space-between" gap="sm">
        <Title order={1} size="h2" id={TITLE_ID} ref={titleRef} tabIndex={-1}>
          Eventos
        </Title>
        <Button
          ref={newButtonRef}
          leftSection={<IconPlus size={18} aria-hidden />}
          onClick={() => {
            openEditor(null);
          }}
        >
          Novo evento
        </Button>
      </Group>
      {notice !== null && (
        <Alert
          color="green"
          variant="light"
          role="status"
          icon={<IconCircleCheck aria-hidden />}
          withCloseButton
          closeButtonLabel="Fechar aviso"
          onClose={closeNotice}
        >
          {notice}
        </Alert>
      )}
      {content}
      <Modal
        ref={editorRef}
        opened={editor?.opened ?? false}
        onClose={closeEditor}
        title={editorTitle}
        centered
        fullScreen={isMobile}
        closeOnEscape={!saving}
        closeOnClickOutside={!saving}
        // The row may have moved (new event in the middle): `editorClosed` gives the focus back.
        returnFocus={false}
        onExitTransitionEnd={editorClosed}
        closeButtonProps={{ 'aria-label': 'Fechar', disabled: saving }}
      >
        {editor && (
          <EventForm
            key={editor.key}
            initialValues={editor.event ? eventValuesOf(editor.event) : newEventValues()}
            isNew={editor.event === null}
            label={editorTitle}
            error={editor.event ? update.error : create.error}
            saving={saving}
            onSubmit={save}
            onCancel={closeEditor}
          />
        )}
      </Modal>
      <DeleteEventDialog
        ref={deleteRef}
        event={deleting?.event ?? null}
        opened={deleting?.opened ?? false}
        deleting={remove.isPending}
        error={remove.error}
        fullScreen={isMobile}
        onConfirm={confirmDelete}
        onClose={closeDelete}
        onClosed={deleteClosed}
      />
    </Stack>
  );
}
