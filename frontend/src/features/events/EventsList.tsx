/**
 * The events (§ 6.5), most recent first: a table on the notebook and the tablet, cards on the
 * phone. Every row has "Editar" and "Excluir", marked with `ACTION_ATTRIBUTE` so the page can
 * give them the focus back after a dialog or a change of layout (§ 6.7).
 */
import { Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { IconLock, IconLockOpen, IconPencil, IconTrash } from '@tabler/icons-react';

import type { EventStatus, ExamEvent } from '../../api/types';
import { formatDate } from '../../lib/dates';
import { Field } from '../students/studentCells';
import { statusLabel } from './eventFormModel';
import { ACTION_ATTRIBUTE, actionKey } from './rowActions';

/**
 * Narrowest width at which the four columns read well. At 768 px the side menu stays open
 * and the table scrolls inside its own container, so the page never scrolls sideways
 * (§ 6.7). The container takes focus so the keyboard can scroll it too.
 */
const TABLE_MIN_WIDTH = 560;

/** Long names (up to 80 characters) wrap anywhere instead of widening the column. */
const WRAP = { overflowWrap: 'anywhere' } as const;

/** The status is always written out; the lock icon only reinforces it (§ 6.7). */
export function EventStatusText({ status }: { status: EventStatus }) {
  const Icon = status === 'OPEN' ? IconLockOpen : IconLock;
  return (
    <Group gap={6} wrap="nowrap" data-status={status}>
      <Icon size={18} aria-hidden style={{ flex: 'none' }} />
      <Text component="span" size="sm">
        {statusLabel(status)}
      </Text>
    </Group>
  );
}

interface ActionsProps {
  event: ExamEvent;
  onEdit: (event: ExamEvent) => void;
  onDelete: (event: ExamEvent) => void;
}

function RowActions({ event, onEdit, onDelete }: ActionsProps) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        variant="default"
        size="xs"
        leftSection={<IconPencil size={16} aria-hidden />}
        aria-label={`Editar evento ${event.name}`}
        {...{ [ACTION_ATTRIBUTE]: actionKey('edit', event.id) }}
        onClick={() => {
          onEdit(event);
        }}
      >
        Editar
      </Button>
      <Button
        variant="default"
        size="xs"
        leftSection={<IconTrash size={16} aria-hidden />}
        aria-label={`Excluir evento ${event.name}`}
        {...{ [ACTION_ATTRIBUTE]: actionKey('delete', event.id) }}
        onClick={() => {
          onDelete(event);
        }}
      >
        Excluir
      </Button>
    </Group>
  );
}

interface ListProps {
  events: readonly ExamEvent[];
  /** Id of the page title, the name of the table or list. */
  labelledBy: string;
  onEdit: (event: ExamEvent) => void;
  onDelete: (event: ExamEvent) => void;
}

export function EventsTable({ events, labelledBy, onEdit, onDelete }: ListProps) {
  return (
    <Table.ScrollContainer
      type="native"
      minWidth={TABLE_MIN_WIDTH}
      tabIndex={0}
      role="region"
      aria-label="Lista de eventos"
      className="mantine-focus-auto"
    >
      <Table aria-labelledby={labelledBy} verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Nome</Table.Th>
            <Table.Th scope="col">Data do exame</Table.Th>
            <Table.Th scope="col">Situação</Table.Th>
            <Table.Th scope="col">Ações</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {events.map((event) => (
            <Table.Tr key={event.id}>
              <Table.Th scope="row" fw={500} style={WRAP}>
                {event.name}
              </Table.Th>
              <Table.Td>{formatDate(event.exam_date)}</Table.Td>
              <Table.Td>
                <EventStatusText status={event.status} />
              </Table.Td>
              <Table.Td>
                <RowActions event={event} onEdit={onEdit} onDelete={onDelete} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function EventsCards({ events, labelledBy, onEdit, onDelete }: ListProps) {
  return (
    <Stack
      component="ul"
      role="list"
      aria-labelledby={labelledBy}
      gap="sm"
      p={0}
      m={0}
      style={{ listStyle: 'none' }}
    >
      {events.map((event) => (
        <Card key={event.id} component="li" withBorder padding="md">
          <Title order={2} size="h4" mb="xs" style={WRAP}>
            {event.name}
          </Title>
          <Stack component="dl" gap="xs" m={0} mb="sm">
            <Field label="Data do exame">{formatDate(event.exam_date)}</Field>
            <Field label="Situação">
              <EventStatusText status={event.status} />
            </Field>
          </Stack>
          <RowActions event={event} onEdit={onEdit} onDelete={onDelete} />
        </Card>
      ))}
    </Stack>
  );
}
