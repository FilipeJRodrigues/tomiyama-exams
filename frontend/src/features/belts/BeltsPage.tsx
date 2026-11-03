import { Alert, Button, Card, Group, Modal, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconCircleCheck, IconPencil } from '@tabler/icons-react';
import { useRef, useState, type ReactNode } from 'react';

import { useBelts, useUpdateBelt } from '../../api/queries';
import type { Belt, BeltInput } from '../../api/types';
import { MOBILE_QUERY } from '../../app/breakpoints';
import { focusIfLost } from '../exam/focus';
import { LoadError, LoadingState } from '../students/screenStates';
import { BeltSwatch, Field } from '../students/studentCells';
import { BeltForm } from './BeltForm';
import {
  colorsLabel,
  kyuLabel,
  levelLabel,
  minAgeLabel,
  minMonthsLabel,
  sortBelts,
} from './beltText';

const TITLE_ID = 'belts-title';

/**
 * Narrowest width at which the eight columns read well. At 768 px the side menu stays open
 * and the table scrolls inside its own container, so the page never scrolls sideways
 * (§ 6.7). The container takes focus so the keyboard can scroll it too.
 */
const TABLE_MIN_WIDTH = 760;

/** Marks the edit button of each belt, to give it the focus back after the dialog. */
const EDIT_ATTRIBUTE = 'data-belt-edit';

function editButtonOf(beltId: string): Element | null {
  const buttons = Array.from(document.querySelectorAll(`[${EDIT_ATTRIBUTE}]`));
  return buttons.find((button) => button.getAttribute(EDIT_ATTRIBUTE) === beltId) ?? null;
}

interface EditButtonProps {
  belt: Belt;
  onEdit: (belt: Belt) => void;
}

function EditButton({ belt, onEdit }: EditButtonProps) {
  return (
    <Button
      variant="default"
      size="xs"
      leftSection={<IconPencil size={16} aria-hidden />}
      aria-label={`Editar faixa ${belt.name}`}
      {...{ [EDIT_ATTRIBUTE]: belt.id }}
      onClick={() => {
        onEdit(belt);
      }}
    >
      Editar
    </Button>
  );
}

function BeltName({ belt }: { belt: Belt }) {
  return (
    <Group gap={8} wrap="nowrap">
      <BeltSwatch belt={belt} />
      <span>{belt.name}</span>
    </Group>
  );
}

interface ListProps {
  belts: Belt[];
  onEdit: (belt: Belt) => void;
}

function BeltsTable({ belts, onEdit }: ListProps) {
  return (
    <Table.ScrollContainer
      type="native"
      minWidth={TABLE_MIN_WIDTH}
      tabIndex={0}
      role="region"
      aria-label="Lista de faixas"
      className="mantine-focus-auto"
    >
      <Table aria-labelledby={TITLE_ID} verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Ordem</Table.Th>
            <Table.Th scope="col">Faixa</Table.Th>
            <Table.Th scope="col">Kyū</Table.Th>
            <Table.Th scope="col">Nível</Table.Th>
            <Table.Th scope="col">Idade mínima</Table.Th>
            <Table.Th scope="col">Carência na faixa anterior</Table.Th>
            <Table.Th scope="col">Cores</Table.Th>
            <Table.Th scope="col">Ações</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {belts.map((belt) => (
            <Table.Tr key={belt.id}>
              <Table.Td>{belt.sort_order}</Table.Td>
              <Table.Th scope="row" fw={500}>
                <BeltName belt={belt} />
              </Table.Th>
              <Table.Td>{kyuLabel(belt.kyu)}</Table.Td>
              <Table.Td>{levelLabel(belt)}</Table.Td>
              <Table.Td>{minAgeLabel(belt.min_age_years)}</Table.Td>
              <Table.Td>{minMonthsLabel(belt.min_months_previous)}</Table.Td>
              <Table.Td>{colorsLabel(belt)}</Table.Td>
              <Table.Td>
                <EditButton belt={belt} onEdit={onEdit} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function BeltsCards({ belts, onEdit }: ListProps) {
  return (
    <Stack
      component="ul"
      role="list"
      aria-labelledby={TITLE_ID}
      gap="sm"
      p={0}
      m={0}
      style={{ listStyle: 'none' }}
    >
      {belts.map((belt) => (
        <Card key={belt.id} component="li" withBorder padding="md">
          <Title order={2} size="h4" mb="xs">
            <BeltName belt={belt} />
          </Title>
          <Stack component="dl" gap="xs" m={0} mb="sm">
            <Field label="Ordem">{belt.sort_order}</Field>
            <Field label="Kyū">{kyuLabel(belt.kyu)}</Field>
            <Field label="Nível">{levelLabel(belt)}</Field>
            <Field label="Idade mínima">{minAgeLabel(belt.min_age_years)}</Field>
            <Field label="Carência na faixa anterior">
              {minMonthsLabel(belt.min_months_previous)}
            </Field>
            <Field label="Cores">{colorsLabel(belt)}</Field>
          </Stack>
          <Group>
            <EditButton belt={belt} onEdit={onEdit} />
          </Group>
        </Card>
      ))}
    </Stack>
  );
}

interface DialogState {
  belt: Belt;
  opened: boolean;
  /** New key on every opening: the form starts again from the belt. */
  key: number;
}

/**
 * § 6.5 belts screen (examiners): the belts in graduation order and the edit dialog
 * (`PUT /belts/{id}`, RN015). Belts are never created or deleted, so there is no "Nova faixa"
 * nor "Excluir".
 */
export function BeltsPage() {
  const belts = useBelts();
  const update = useUpdateBelt();
  const isMobile = useMediaQuery(MOBILE_QUERY, false, { getInitialValueInEffect: false });
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openings = useRef(0);
  /** Synchronous lock: `update.isPending` only arrives on the next render (double click). */
  const busy = useRef(false);

  const openEditor = (belt: Belt) => {
    update.reset();
    setSavedName(null);
    openings.current += 1;
    setDialog({ belt, opened: true, key: openings.current });
  };

  const closeEditor = () => {
    // Nothing closes the dialog while the belt is on its way to the API.
    if (busy.current || update.isPending) return;
    setDialog((current) => current && { ...current, opened: false });
  };

  /** The dialog is gone: the focus goes back to the belt's edit button (§ 6.7). */
  const dialogClosed = () => {
    const beltId = dialog?.belt.id;
    setDialog(null);
    focusIfLost([beltId ? editButtonOf(beltId) : null, titleRef.current], {
      leaving: [dialogRef.current],
    });
  };

  const save = (input: BeltInput) => {
    if (!dialog || busy.current || update.isPending) return;
    busy.current = true;
    update.mutate(
      { id: dialog.belt.id, input },
      {
        onSuccess: (saved) => {
          setSavedName(saved.name);
          setDialog((current) => current && { ...current, opened: false });
        },
        onSettled: () => {
          busy.current = false;
        },
      },
    );
  };

  const closeNotice = () => {
    setSavedName(null);
    // The close button went away with the notice.
    window.setTimeout(() => {
      focusIfLost(titleRef.current);
    }, 0);
  };

  let content: ReactNode;
  if (belts.data === undefined && belts.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar as faixas"
        error={belts.error}
        retrying={belts.isFetching}
        onRetry={() => void belts.refetch()}
      />
    );
  } else if (belts.data === undefined) {
    content = <LoadingState label="Carregando faixas…" />;
  } else if (belts.data.length === 0) {
    content = <Text>Nenhuma faixa cadastrada.</Text>;
  } else if (isMobile) {
    content = <BeltsCards belts={sortBelts(belts.data)} onEdit={openEditor} />;
  } else {
    content = <BeltsTable belts={sortBelts(belts.data)} onEdit={openEditor} />;
  }

  return (
    <Stack gap="md">
      <Title order={1} size="h2" id={TITLE_ID} ref={titleRef} tabIndex={-1}>
        Faixas
      </Title>
      {savedName !== null && (
        <Alert
          color="green"
          variant="light"
          role="status"
          icon={<IconCircleCheck aria-hidden />}
          withCloseButton
          closeButtonLabel="Fechar aviso"
          onClose={closeNotice}
        >
          Faixa {savedName} salva.
        </Alert>
      )}
      {content}
      <Modal
        ref={dialogRef}
        opened={dialog?.opened ?? false}
        onClose={closeEditor}
        title={dialog ? `Editar faixa ${dialog.belt.name}` : 'Editar faixa'}
        centered
        fullScreen={isMobile}
        closeOnEscape={!update.isPending}
        closeOnClickOutside={!update.isPending}
        // The button may have moved (new order) or changed layout: `dialogClosed` gives the
        // focus back (§ 6.7).
        returnFocus={false}
        onExitTransitionEnd={dialogClosed}
        closeButtonProps={{ 'aria-label': 'Fechar', disabled: update.isPending }}
      >
        {dialog && (
          <BeltForm
            key={dialog.key}
            belt={dialog.belt}
            error={update.error}
            saving={update.isPending}
            onSubmit={save}
            onCancel={closeEditor}
          />
        )}
      </Modal>
    </Stack>
  );
}
