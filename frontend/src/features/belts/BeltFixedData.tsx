import { Box, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useId } from 'react';

import type { Belt } from '../../api/types';
import { Field } from '../students/studentCells';
import { colorsLabel, levelLabel } from './beltText';

/**
 * The belt drawn as a horizontal bar in its color, with the tips in the second color of the
 * two-color belts (as on the certificate, § 7). Decorative: the colors are written below. The
 * gray outline keeps the white belt visible.
 */
function BeltDrawing({ belt }: { belt: Belt }) {
  const primary = belt.color_primary;
  const tips = belt.color_secondary;
  const background = tips
    ? `linear-gradient(to right, ${tips} 0 18%, ${primary} 18% 82%, ${tips} 82% 100%)`
    : primary;
  return (
    <Box
      aria-hidden
      data-testid="belt-drawing"
      style={{
        width: '100%',
        maxWidth: 240,
        height: 20,
        borderRadius: 4,
        border: '1px solid var(--mantine-color-dimmed)',
        background,
      }}
    />
  );
}

/**
 * Name, order, kyū, level and colors of the belt for an examiner who is not the admin master
 * (#143): read-only text in a list, never fields that look disabled, with the reason written
 * next to the heading. The form sends these values back as they are.
 */
export function BeltFixedData({ belt }: { belt: Belt }) {
  const titleId = useId();
  const noteId = useId();
  return (
    <Paper
      component="section"
      withBorder
      p="sm"
      radius="sm"
      aria-labelledby={titleId}
      aria-describedby={noteId}
    >
      <Stack gap="xs">
        <Group gap={6} wrap="nowrap">
          <IconLock size={18} aria-hidden style={{ flex: 'none' }} />
          <Title order={3} size="h5" id={titleId}>
            Dados da faixa
          </Title>
        </Group>
        <Text size="sm" id={noteId}>
          Só o administrador master altera nome, ordem, kyū, nível e cores.
        </Text>
        <BeltDrawing belt={belt} />
        <Stack component="dl" gap="xs" m={0}>
          <Field label="Nome">
            <Box component="span" style={{ overflowWrap: 'anywhere' }}>
              {belt.name}
            </Box>
          </Field>
          <Field label="Ordem">{belt.sort_order}</Field>
          <Field label="Kyū">{belt.kyu === null ? 'Sem kyū' : belt.kyu}</Field>
          <Field label="Nível">{levelLabel(belt)}</Field>
          <Field label="Cores">{colorsLabel(belt)}</Field>
        </Stack>
      </Stack>
    </Paper>
  );
}
