import {
  Button,
  Card,
  Group,
  Stack,
  Switch,
  Tabs,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import {
  IconCircleCheck,
  IconCircleCheckFilled,
  IconCircleDashed,
  IconCircleX,
  IconCircleXFilled,
} from '@tabler/icons-react';
import { useId, type ReactNode } from 'react';

import type { ExamSheetItem, ExamSummary, RequirementKind } from '../../api/types';
import { REQUIREMENT_KIND_LABELS } from '../../lib/labels';
import {
  MARK_LABELS,
  REQUIREMENT_KINDS,
  groupByCategory,
  isRequirementKind,
  itemsOfKind,
  markState,
  nextMarkState,
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

type MarkChoice = 'correct' | 'wrong';

const CHOICES: readonly MarkChoice[] = ['correct', 'wrong'];

/** Mantine color of the pressed button; its text uses the contrast-checked light color. */
const CHOICE_COLORS: Record<MarkChoice, string> = { correct: 'green', wrong: 'red' };

const CHOICE_ICONS = {
  correct: { off: IconCircleCheck, on: IconCircleCheckFilled },
  wrong: { off: IconCircleX, on: IconCircleXFilled },
} as const;

interface MarkButtonsProps {
  item: ExamSheetItem;
  onMark: (item: ExamSheetItem, state: MarkState) => void;
}

/**
 * Certo / Errado of one item (§ 6.4, RN006), at least 44 px tall. The pressed one has
 * `aria-pressed`, a filled icon, a border and a tinted background, so the state never
 * depends on color alone (§ 6.7); clicking it again takes the mark off. The accessible
 * name starts with the visible text and names the item ("Certo: Osoto gari").
 */
export function MarkButtons({ item, onMark }: MarkButtonsProps) {
  const state = markState(item);
  return (
    <Group gap="xs" wrap="nowrap" role="group" aria-label={`Marcação: ${item.description}`}>
      {CHOICES.map((choice) => {
        const pressed = state === choice;
        const Icon = CHOICE_ICONS[choice][pressed ? 'on' : 'off'];
        const color = CHOICE_COLORS[choice];
        return (
          <Button
            key={choice}
            variant={pressed ? 'light' : 'default'}
            color={pressed ? color : undefined}
            aria-pressed={pressed}
            aria-label={`${MARK_LABELS[choice]}: ${item.description}`}
            data-choice={choice}
            leftSection={<Icon size={20} aria-hidden />}
            onClick={() => {
              onMark(item, nextMarkState(state, choice));
            }}
            style={{
              ...TOUCH_TARGET,
              minWidth: 104,
              borderWidth: 2,
              borderStyle: 'solid',
              borderColor: pressed
                ? `var(--mantine-color-${color}-light-color)`
                : 'var(--mantine-color-default-border)',
            }}
          >
            {MARK_LABELS[choice]}
          </Button>
        );
      })}
    </Group>
  );
}

/** What goes at the right of each item: the read-only mark or the Certo/Errado buttons. */
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
  keep,
  renderMark,
}: {
  items: ExamSheetItem[];
  kind: RequirementKind;
  onlyUnmarked: boolean;
  keep: ReadonlySet<string>;
  renderMark: RenderMark;
}) {
  const ofKind = itemsOfKind(items, kind);
  if (ofKind.length === 0) return <Text>{NO_ITEMS[kind]}</Text>;
  const groups = groupByCategory(ofKind, onlyUnmarked, keep);
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
  /** Marked items still shown under "Só não marcados" (see `groupByCategory`). */
  keep?: ReadonlySet<string>;
  renderMark: RenderMark;
}

const KEEP_NONE: ReadonlySet<string> = new Set();

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
  keep = KEEP_NONE,
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
            keep={keep}
            renderMark={renderMark}
          />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
