import { Alert, Button, Group, Modal, NativeSelect, Stack, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconCircleCheck, IconPlus } from '@tabler/icons-react';
import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';

import {
  compareRequirements,
  useBelts,
  useCreateRequirement,
  useDeleteRequirement,
  useRequirements,
  useUpdateRequirement,
} from '../../api/queries';
import type { Belt, Requirement, RequirementInput, RequirementKind } from '../../api/types';
import { MOBILE_QUERY } from '../../app/breakpoints';
import { sortBelts } from '../belts/beltText';
import { focusIfLost } from '../exam/focus';
import { LoadError, LoadingState } from '../students/screenStates';
import { useRetryFocus } from '../students/useRetryFocus';
import { DeleteRequirementDialog } from './DeleteRequirementDialog';
import { RequirementForm } from './RequirementForm';
import { RequirementsCards, RequirementsTable } from './RequirementsList';
import {
  KIND_OPTIONS,
  formValuesOf,
  isRequirementKind,
  newFormValues,
} from './requirementFormModel';
import { countSummary, defaultBeltId, emptyLabel, kindLabel } from './requirementText';
import { ACTION_ATTRIBUTE, actionButton, actionKey } from './rowActions';

const TITLE_ID = 'requirements-title';

const KIND_FILTER_OPTIONS = [{ value: '', label: 'Todos' }, ...KIND_OPTIONS];

interface EditorState {
  /** `null`: a new item. */
  requirement: Requirement | null;
  opened: boolean;
  /** New key on every opening: the form starts again from the item (or blank). */
  key: number;
}

interface DeleteState {
  requirement: Requirement;
  opened: boolean;
}

interface FiltersProps {
  belts: readonly Belt[];
  beltId: string;
  kind: RequirementKind | null;
  onBelt: (beltId: string) => void;
  onKind: (kind: RequirementKind | null) => void;
}

/** Belt and kind of the list (§ 6.5); enums as selects with pt-BR labels. */
function Filters({ belts, beltId, kind, onBelt, onKind }: FiltersProps) {
  return (
    <Group gap="md" align="flex-end" wrap="wrap">
      <NativeSelect
        label="Faixa"
        data={sortBelts(belts).map((belt) => ({ value: belt.id, label: belt.name }))}
        value={beltId}
        onChange={(event) => {
          onBelt(event.currentTarget.value);
        }}
        miw={200}
      />
      <NativeSelect
        label="Tipo"
        data={KIND_FILTER_OPTIONS}
        value={kind ?? ''}
        onChange={(event) => {
          const { value } = event.currentTarget;
          onKind(isRequirementKind(value) ? value : null);
        }}
        miw={160}
      />
    </Group>
  );
}

/**
 * § 6.5 requirements screen (examiners): the items of one belt in sheet order, filtered by
 * belt (default Branca/Cinza) and kind, with create, edit and delete dialogs (RN017, checked
 * by the API; its messages are shown as they come).
 */
export function RequirementsPage() {
  const belts = useBelts();
  const isMobile = useMediaQuery(MOBILE_QUERY, false, { getInitialValueInEffect: false });
  const [chosenBeltId, setChosenBeltId] = useState<string | null>(null);
  const [kind, setKind] = useState<RequirementKind | null>(null);
  const beltId = chosenBeltId ?? (belts.data ? defaultBeltId(belts.data) : undefined);
  const requirements = useRequirements({ belt_id: beltId, kind: kind ?? undefined }, !!beltId);

  const create = useCreateRequirement();
  const update = useUpdateRequirement();
  const remove = useDeleteRequirement();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<DeleteState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  // Also waits for the requirements, read once the belts come.
  const retryFocus = useRetryFocus([belts, requirements], titleRef);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const deleteRef = useRef<HTMLDivElement>(null);
  const openings = useRef(0);
  /** Id of the item just created, to give its edit button the focus. */
  const createdId = useRef<string | null>(null);
  /** Last row button with the focus, to find it again after a change of layout. */
  const lastAction = useRef<string | null>(null);
  /** Synchronous lock: `isPending` only arrives on the next render (double click). */
  const busy = useRef(false);

  const saving = create.isPending || update.isPending;
  const beltsById = new Map((belts.data ?? []).map((belt) => [belt.id, belt]));

  // Table and cards are different elements: a focus on a row button would fall on the page
  // when the width crosses the phone breakpoint (zoom, rotation). It goes to the same button.
  useEffect(() => {
    if (lastAction.current) focusIfLost(actionButton(lastAction.current));
  }, [isMobile]);

  const rememberAction = (event: FocusEvent<HTMLDivElement>) => {
    const key = event.target.getAttribute(ACTION_ATTRIBUTE);
    if (key) lastAction.current = key;
  };

  const openEditor = (requirement: Requirement | null) => {
    create.reset();
    update.reset();
    setNotice(null);
    createdId.current = null;
    openings.current += 1;
    setEditor({ requirement, opened: true, key: openings.current });
  };

  const closeEditor = () => {
    // Nothing closes the dialog while the item is on its way to the API.
    if (busy.current || saving) return;
    setEditor((current) => current && { ...current, opened: false });
  };

  /** The dialog is gone: the focus goes back to the row (or to "Novo requisito"). */
  const editorClosed = () => {
    const editedId = editor?.requirement?.id ?? createdId.current;
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

  const savedNotice = (saved: Requirement, created: boolean): string => {
    const base = created ? 'Requisito criado' : 'Requisito salvo';
    const outside = saved.belt_id !== beltId || (kind !== null && saved.kind !== kind);
    if (!outside) return `${base}.`;
    const beltName = beltsById.get(saved.belt_id)?.name ?? 'escolhida';
    return `${base} na faixa ${beltName} (${kindLabel(saved.kind)}), fora do filtro atual.`;
  };

  const save = (input: RequirementInput) => {
    if (!editor || busy.current || saving) return;
    busy.current = true;
    const current = editor.requirement;
    const done = {
      onSuccess: (saved: Requirement) => {
        if (!current) createdId.current = saved.id;
        setNotice(savedNotice(saved, current === null));
        setEditor((state) => state && { ...state, opened: false });
      },
      onSettled: () => {
        busy.current = false;
      },
    };
    if (current) update.mutate({ id: current.id, input }, done);
    else create.mutate(input, done);
  };

  const openDelete = (requirement: Requirement) => {
    remove.reset();
    setNotice(null);
    setDeleting({ requirement, opened: true });
  };

  const closeDelete = () => {
    if (busy.current || remove.isPending) return;
    setDeleting((current) => current && { ...current, opened: false });
  };

  /** The confirmation is gone: back to the row's button, or to the title once deleted. */
  const deleteClosed = () => {
    const id = deleting?.requirement.id;
    setDeleting(null);
    focusIfLost([id ? actionButton(actionKey('delete', id)) : null, titleRef.current], {
      leaving: [deleteRef.current],
    });
  };

  const confirmDelete = () => {
    if (!deleting || busy.current || remove.isPending) return;
    busy.current = true;
    remove.mutate(deleting.requirement.id, {
      onSuccess: () => {
        setNotice('Requisito excluído.');
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
  let filters: ReactNode = null;
  if (belts.data === undefined && belts.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar as faixas"
        error={belts.error}
        retrying={belts.isFetching}
        onRetry={() => void belts.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (belts.data === undefined) {
    content = <LoadingState label="Carregando faixas…" />;
  } else if (!beltId) {
    content = <Text>Nenhuma faixa cadastrada.</Text>;
  } else {
    filters = (
      <Filters
        belts={belts.data}
        beltId={beltId}
        kind={kind}
        onBelt={setChosenBeltId}
        onKind={setKind}
      />
    );
    if (requirements.data === undefined && requirements.isError) {
      content = (
        <LoadError
          title="Não foi possível carregar os requisitos"
          error={requirements.error}
          retrying={requirements.isFetching}
          onRetry={() => void requirements.refetch()}
          retryFocus={retryFocus}
        />
      );
    } else if (requirements.data === undefined) {
      content = <LoadingState label="Carregando requisitos…" />;
    } else if (requirements.data.length === 0) {
      content = <Text>{emptyLabel(kind)}</Text>;
    } else {
      const items = [...requirements.data].sort(compareRequirements);
      const List = isMobile ? RequirementsCards : RequirementsTable;
      content = (
        <Stack gap="sm" onFocus={rememberAction}>
          <Text size="sm" c="dimmed">
            {countSummary(items.map((item) => item.kind))}
          </Text>
          <List
            requirements={items}
            labelledBy={TITLE_ID}
            onEdit={openEditor}
            onDelete={openDelete}
          />
        </Stack>
      );
    }
  }

  const editorTitle = editor?.requirement ? 'Editar requisito' : 'Novo requisito';
  const deletingBelt = deleting ? beltsById.get(deleting.requirement.belt_id)?.name : undefined;

  return (
    <Stack gap="md">
      <Group justify="space-between" gap="sm">
        <Title order={1} size="h2" id={TITLE_ID} ref={titleRef} tabIndex={-1}>
          Requisitos
        </Title>
        {beltId && belts.data && (
          <Button
            ref={newButtonRef}
            leftSection={<IconPlus size={18} aria-hidden />}
            onClick={() => {
              openEditor(null);
            }}
          >
            Novo requisito
          </Button>
        )}
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
      {filters}
      {content}
      <Modal
        ref={editorRef}
        opened={editor?.opened ?? false}
        onClose={closeEditor}
        title={editorTitle}
        centered
        size="lg"
        fullScreen={isMobile}
        closeOnEscape={!saving}
        closeOnClickOutside={!saving}
        // The row may have moved (new order, other belt): `editorClosed` gives the focus back.
        returnFocus={false}
        onExitTransitionEnd={editorClosed}
        closeButtonProps={{ 'aria-label': 'Fechar', disabled: saving }}
      >
        {editor && belts.data && beltId && (
          <RequirementForm
            key={editor.key}
            belts={belts.data}
            initialValues={
              editor.requirement ? formValuesOf(editor.requirement) : newFormValues(beltId, kind)
            }
            isNew={editor.requirement === null}
            label={editorTitle}
            error={editor.requirement ? update.error : create.error}
            saving={saving}
            onSubmit={save}
            onCancel={closeEditor}
          />
        )}
      </Modal>
      <DeleteRequirementDialog
        ref={deleteRef}
        requirement={deleting?.requirement ?? null}
        beltName={deletingBelt}
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
