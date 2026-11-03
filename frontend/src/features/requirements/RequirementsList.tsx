/**
 * The items of one belt (§ 6.5): a table on the notebook and the tablet, cards on the phone.
 * Every row has "Editar" and "Excluir", marked with `ACTION_ATTRIBUTE` (see `rowActions.ts`).
 */
import { Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { IconPencil, IconTrash } from '@tabler/icons-react';

import type { Requirement } from '../../api/types';
import { Field } from '../students/studentCells';
import { kindLabel, shortText } from './requirementText';
import { ACTION_ATTRIBUTE, actionKey } from './rowActions';

/**
 * Narrowest width at which the six columns read well, with the texts wrapping. At 768 px the
 * side menu stays open and the table scrolls inside its own container, so the page never
 * scrolls sideways (§ 6.7). The container takes focus so the keyboard can scroll it too.
 */
const TABLE_MIN_WIDTH = 720;

/** Long texts (up to 2000 characters) wrap anywhere instead of widening the column. */
const WRAP = { overflowWrap: 'anywhere' } as const;

function expectedLabel(requirement: Requirement): string {
  return requirement.expected_answer ?? '—';
}

interface ActionsProps {
  requirement: Requirement;
  onEdit: (requirement: Requirement) => void;
  onDelete: (requirement: Requirement) => void;
}

function RowActions({ requirement, onEdit, onDelete }: ActionsProps) {
  const name = shortText(requirement.description);
  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        variant="default"
        size="xs"
        leftSection={<IconPencil size={16} aria-hidden />}
        aria-label={`Editar ${name}`}
        {...{ [ACTION_ATTRIBUTE]: actionKey('edit', requirement.id) }}
        onClick={() => {
          onEdit(requirement);
        }}
      >
        Editar
      </Button>
      <Button
        variant="default"
        size="xs"
        leftSection={<IconTrash size={16} aria-hidden />}
        aria-label={`Excluir ${name}`}
        {...{ [ACTION_ATTRIBUTE]: actionKey('delete', requirement.id) }}
        onClick={() => {
          onDelete(requirement);
        }}
      >
        Excluir
      </Button>
    </Group>
  );
}

interface ListProps {
  requirements: readonly Requirement[];
  /** Id of the page title, the name of the table or list. */
  labelledBy: string;
  onEdit: (requirement: Requirement) => void;
  onDelete: (requirement: Requirement) => void;
}

export function RequirementsTable({ requirements, labelledBy, onEdit, onDelete }: ListProps) {
  return (
    <Table.ScrollContainer
      type="native"
      minWidth={TABLE_MIN_WIDTH}
      tabIndex={0}
      role="region"
      aria-label="Lista de requisitos"
      className="mantine-focus-auto"
    >
      <Table aria-labelledby={labelledBy} verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Ordem</Table.Th>
            <Table.Th scope="col">Tipo</Table.Th>
            <Table.Th scope="col">Categoria</Table.Th>
            <Table.Th scope="col">Descrição</Table.Th>
            <Table.Th scope="col">Resposta esperada</Table.Th>
            <Table.Th scope="col">Ações</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {requirements.map((requirement) => (
            <Table.Tr key={requirement.id}>
              <Table.Td>{requirement.sort_order}</Table.Td>
              <Table.Td>{kindLabel(requirement.kind)}</Table.Td>
              <Table.Td style={WRAP}>{requirement.category}</Table.Td>
              <Table.Th scope="row" fw={500} style={WRAP}>
                {requirement.description}
              </Table.Th>
              <Table.Td style={WRAP}>{expectedLabel(requirement)}</Table.Td>
              <Table.Td>
                <RowActions requirement={requirement} onEdit={onEdit} onDelete={onDelete} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function RequirementsCards({ requirements, labelledBy, onEdit, onDelete }: ListProps) {
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
      {requirements.map((requirement) => (
        <Card key={requirement.id} component="li" withBorder padding="md">
          <Title order={2} size="h4" mb="xs" style={WRAP}>
            {requirement.description}
          </Title>
          <Stack component="dl" gap="xs" m={0} mb="sm">
            <Field label="Ordem">{requirement.sort_order}</Field>
            <Field label="Tipo">{kindLabel(requirement.kind)}</Field>
            <Field label="Categoria">
              <Text component="span" size="sm" style={WRAP}>
                {requirement.category}
              </Text>
            </Field>
            <Field label="Resposta esperada">
              <Text component="span" size="sm" style={WRAP}>
                {expectedLabel(requirement)}
              </Text>
            </Field>
          </Stack>
          <RowActions requirement={requirement} onEdit={onEdit} onDelete={onDelete} />
        </Card>
      ))}
    </Stack>
  );
}
