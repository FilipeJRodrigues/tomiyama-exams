import { Card, Group, Stack, Switch, Tabs, Text, Title, VisuallyHidden } from '@mantine/core';
import { IconCircleCheck, IconCircleDashed, IconCircleX } from '@tabler/icons-react';
import { useId, type ReactNode } from 'react';

import type { ExamSheetItem, ExamSummary, RequirementKind } from '../../api/types';
import { REQUIREMENT_KIND_LABELS } from '../../lib/labels';
import {
  MARK_LABELS,
  REQUIREMENT_KINDS,
  groupByCategory,
  isRequirementKind,
  itemsOfKind,
  type CategoryGroup,
  type MarkState,
} from './examModel';
import { TOUCH_TARGET } from './touch';

const MARK_ICONS = {
  correct: IconCircleCheck,
  wrong: IconCircleX,
  unmarked: IconCircleDashed,
} as const;

const MARK_COLORS: Record<MarkState, string | undefined> = {
  correct: undefined,
  wrong: 'var(--mantine-color-error)',
  unmarked: 'var(--mantine-color-dimmed)',
};

const MARK_ICON_COLORS: Record<MarkState, string> = {
  correct: 'var(--mantine-color-green-light-color)',
  wrong: 'var(--mantine-color-error)',
  unmarked: 'var(--mantine-color-dimmed)',
};

/**
 * Read-only mark (§ 6.4: decided exam or closed event): "Certo", "Errado" or "Não marcado"
 * in text with an icon, never disabled buttons (poor contrast).
 */
export function MarkText({ state }: { state: MarkState }) {
  const Icon = MARK_ICONS[state];
  return (
    <Group gap={6} wrap="nowrap" data-mark={state}>
      <Icon size={20} aria-hidden style={{ flex: 'none', color: MARK_ICON_COLORS[state] }} />
      <Text component="span" size="sm" fw={500} c={MARK_COLORS[state]}>
        {MARK_LABELS[state]}
      </Text>
    </Group>
  );
}

/** What goes at the right of each item: the read-only mark now, Certo/Errado in step 2. */
export type RenderMark = (item: ExamSheetItem) => ReactNode;

function ExamItem({ item, renderMark }: { item: ExamSheetItem; renderMark: RenderMark }) {
  return (
    <Card component="li" withBorder padding="sm" data-item={item.id}>
      <Group justify="space-between" align="center" gap="sm" wrap="wrap">
        <Stack gap={2} miw={0} style={{ flex: '1 1 16rem' }}>
          <Text fw={500} style={{ overflowWrap: 'anywhere' }}>
            {item.description}
          </Text>
          {item.expected_answer && (
            <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              <VisuallyHidden>Resposta esperada: </VisuallyHidden>
              {item.expected_answer}
            </Text>
          )}
        </Stack>
        <div style={{ flex: 'none' }}>{renderMark(item)}</div>
      </Group>
    </Card>
  );
}

function CategorySection({ group, renderMark }: { group: CategoryGroup; renderMark: RenderMark }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <Title order={3} size="h5" id={headingId} mb="xs">
        <Group component="span" justify="space-between" gap="sm" wrap="nowrap">
          <span>{group.category}</span>{' '}
          <Text component="span" size="sm" c="dimmed" fw={500}>
            {`${group.marked}/${group.total}`}
          </Text>
        </Group>
      </Title>
      <Stack component="ul" gap="xs" p={0} m={0} style={{ listStyle: 'none' }}>
        {group.items.map((item) => (
          <ExamItem key={item.id} item={item} renderMark={renderMark} />
        ))}
      </Stack>
    </section>
  );
}

const NO_ITEMS: Record<RequirementKind, string> = {
  THEORY: 'Esta faixa não tem itens teóricos.',
  PRACTICE: 'Esta faixa não tem itens práticos.',
};

const ALL_MARKED: Record<RequirementKind, string> = {
  THEORY: 'Todos os itens teóricos estão marcados.',
  PRACTICE: 'Todos os itens práticos estão marcados.',
};

function KindPanel({
  items,
  kind,
  onlyUnmarked,
  renderMark,
}: {
  items: ExamSheetItem[];
  kind: RequirementKind;
  onlyUnmarked: boolean;
  renderMark: RenderMark;
}) {
  const ofKind = itemsOfKind(items, kind);
  if (ofKind.length === 0) return <Text>{NO_ITEMS[kind]}</Text>;
  const groups = groupByCategory(ofKind, onlyUnmarked);
  if (groups.length === 0) return <Text>{ALL_MARKED[kind]}</Text>;
  return (
    <Stack gap="lg">
      {groups.map((group) => (
        <CategorySection key={group.category} group={group} renderMark={renderMark} />
      ))}
    </Stack>
  );
}

interface ExamItemsProps {
  items: ExamSheetItem[];
  summary: ExamSummary;
  kind: RequirementKind;
  onKindChange: (kind: RequirementKind) => void;
  onlyUnmarked: boolean;
  onOnlyUnmarkedChange: (value: boolean) => void;
  renderMark: RenderMark;
}

/**
 * Teórico and Prático tabs with "marked/total" (from the API summary), the "Só não marcados"
 * filter and the items grouped by category with "x/N" each.
 */
export function ExamItems({
  items,
  summary,
  kind,
  onKindChange,
  onlyUnmarked,
  onOnlyUnmarkedChange,
  renderMark,
}: ExamItemsProps) {
  return (
    <Tabs
      value={kind}
      keepMounted={false}
      onChange={(value) => {
        if (isRequirementKind(value)) onKindChange(value);
      }}
    >
      <Group justify="space-between" align="center" gap="sm" mb="md">
        <Tabs.List aria-label="Tipo de item">
          {REQUIREMENT_KINDS.map((value) => (
            <Tabs.Tab key={value} value={value} style={TOUCH_TARGET}>
              {REQUIREMENT_KIND_LABELS[value]}{' '}
              <Text component="span" size="sm" c="dimmed" fw={500}>
                {`${summary[value].marked}/${summary[value].total}`}
              </Text>
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Switch
          label="Só não marcados"
          checked={onlyUnmarked}
          onChange={(event) => {
            onOnlyUnmarkedChange(event.currentTarget.checked);
          }}
          styles={{ body: { ...TOUCH_TARGET, alignItems: 'center' } }}
        />
      </Group>
      {REQUIREMENT_KINDS.map((value) => (
        <Tabs.Panel key={value} value={value}>
          <KindPanel
            items={items}
            kind={value}
            onlyUnmarked={onlyUnmarked}
            renderMark={renderMark}
          />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
