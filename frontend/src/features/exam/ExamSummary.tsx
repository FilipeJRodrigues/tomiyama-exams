import {
  Box,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconGavel } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import type { ExamSummary as Summary, ExamView, Examiner, RequirementKind } from '../../api/types';
import { REQUIREMENT_KIND_LABELS } from '../../lib/labels';
import { REQUIREMENT_KINDS, examinerName, percentLabel } from './examModel';

/** § 6.7: the percentages are computed data; the hint explains how. */
const PERCENT_HINT = 'Acertos ÷ itens do tipo; item não marcado conta como não acertado.';

function Score({
  kind,
  summary,
  compact,
}: {
  kind: RequirementKind;
  summary: Summary;
  compact: boolean;
}) {
  const score = summary[kind];
  return (
    <Stack gap={0} data-score={kind}>
      <Text size="sm" fw={500}>
        {REQUIREMENT_KIND_LABELS[kind]}
      </Text>
      <Text fz={compact ? 24 : 32} fw={700} lh={1.2}>
        {percentLabel(score)}
      </Text>
      <Text size="xs" c="dimmed">
        {`marcados ${score.marked} de ${score.total}`}
      </Text>
    </Stack>
  );
}

function MarkingProgress({ summary }: { summary: Summary }) {
  const total = summary.THEORY.total + summary.PRACTICE.total;
  const marked = summary.THEORY.marked + summary.PRACTICE.marked;
  const value = total === 0 ? 0 : Math.round((marked / total) * 100);
  const text = `${marked} de ${total} itens marcados`;
  return (
    <Stack gap={4}>
      <Progress.Root
        size="md"
        role="progressbar"
        aria-label="Marcação"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={text}
      >
        <Progress.Section value={value} withAria={false} />
      </Progress.Root>
      <Text size="xs" c="dimmed">
        {text}
      </Text>
    </Stack>
  );
}

interface DecisionAreaProps {
  exam: ExamView;
  examiners: Examiner[] | undefined;
}

/**
 * Decision area (§ 6.4). A decided exam shows who decided. The sensei's Aprovar/Reprovar and
 * the notices for the other examiners come in step 3; the certificate in card #27.
 */
export function DecisionArea({ exam, examiners }: DecisionAreaProps) {
  if (exam.status === 'IN_PROGRESS' || !exam.decided_by_id) return null;
  const name = examiners ? examinerName(examiners, exam.decided_by_id) : undefined;
  let text: string;
  if (name) text = `Decidido por ${name}`;
  else if (examiners) text = 'Decidido por um examinador que não está mais ativo';
  else text = 'Decidido';
  return (
    <Stack gap={2} data-slot="decision">
      <Group gap={6} wrap="nowrap" align="flex-start">
        <IconGavel size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
        <Text size="sm" fw={500}>
          {text}
        </Text>
      </Group>
      {exam.notes && (
        <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
          {`Observação: ${exam.notes}`}
        </Text>
      )}
    </Stack>
  );
}

interface ExamSummaryProps extends DecisionAreaProps {
  summary: Summary;
  /** No mark on its way: the percentages are the API's. */
  settled?: boolean;
}

/** Quiet time after the last change before the percentages are read out. */
export const ANNOUNCE_DELAY_MS = 1000;

function spokenPercent(kind: RequirementKind, summary: Summary): string {
  const { percent } = summary[kind];
  const label = REQUIREMENT_KIND_LABELS[kind];
  return percent === null ? `${label} sem itens` : `${label} ${percentLabel(summary[kind])}`;
}

/** `Teórico 66,7%, Prático 25%`. */
export function percentsAnnouncement(summary: Summary): string {
  return REQUIREMENT_KINDS.map((kind) => spokenPercent(kind, summary)).join(', ');
}

/**
 * § 6.7: the percentages are read out when they change, but not at every click: only once
 * no mark is on its way (the API's numbers) and nothing changed for `ANNOUNCE_DELAY_MS`,
 * and never the values the screen opened with.
 */
function PercentAnnouncer({ summary, settled }: { summary: Summary; settled: boolean }) {
  const text = percentsAnnouncement(summary);
  const [announced, setAnnounced] = useState('');
  const lastSpoken = useRef(text);
  useEffect(() => {
    if (!settled || text === lastSpoken.current) return;
    const timer = setTimeout(() => {
      lastSpoken.current = text;
      setAnnounced(text);
    }, ANNOUNCE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [settled, text]);
  return (
    <VisuallyHidden role="status" aria-live="polite" aria-atomic="true" data-testid="percent-live">
      {announced}
    </VisuallyHidden>
  );
}

/**
 * % teórico and % prático (from the API, RN007; moved at once by a click until the API
 * answers), the marking progress and the decision area.
 */
function SummaryContent({
  summary,
  exam,
  examiners,
  compact,
  settled = true,
}: ExamSummaryProps & { compact: boolean }) {
  return (
    <Stack gap={compact ? 'xs' : 'md'}>
      <Title order={2} size={compact ? 'h5' : 'h4'}>
        Resumo
      </Title>
      <Text size="xs" c="dimmed">
        {PERCENT_HINT}
      </Text>
      <PercentAnnouncer summary={summary} settled={settled} />
      <div data-testid="exam-scores">
        <SimpleGrid cols={2} spacing="sm">
          {REQUIREMENT_KINDS.map((kind) => (
            <Score key={kind} kind={kind} summary={summary} compact={compact} />
          ))}
        </SimpleGrid>
      </div>
      <MarkingProgress summary={summary} />
      <DecisionArea exam={exam} examiners={examiners} />
    </Stack>
  );
}

/** Notebook: a column at the right that stays in view while the items scroll. */
export function SummaryColumn(props: ExamSummaryProps) {
  return (
    <Paper
      component="aside"
      aria-label="Resumo do exame"
      withBorder
      p="md"
      w={300}
      style={{
        flex: 'none',
        position: 'sticky',
        top: 'calc(var(--app-shell-header-offset, 60px) + var(--mantine-spacing-md))',
      }}
    >
      <SummaryContent {...props} compact={false} />
    </Paper>
  );
}

/**
 * Phone and tablet: a bar fixed at the bottom (right of the side menu, under the drawer),
 * with a spacer of the same height so the last item is never covered.
 */
export function SummaryBar(props: ExamSummaryProps) {
  const { ref, height } = useElementSize();
  return (
    <>
      {/* The measured height leaves out the padding and the border of the bar. */}
      <Box
        aria-hidden
        h={`calc(${height}px + 2 * var(--mantine-spacing-xs) + 2px)`}
        data-testid="summary-spacer"
      />
      <Paper
        ref={ref}
        component="aside"
        aria-label="Resumo do exame"
        withBorder
        shadow="md"
        radius={0}
        px="md"
        py="xs"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 'var(--app-shell-navbar-offset, 0rem)',
          right: 0,
          zIndex: 99,
          maxHeight: '50vh',
          overflowY: 'auto',
        }}
      >
        <SummaryContent {...props} compact />
      </Paper>
    </>
  );
}
