import {
  Box,
  Drawer,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';

import type { ExamSummary as Summary, ExamView, Examiner, RequirementKind } from '../../api/types';
import { REQUIREMENT_KIND_LABELS } from '../../lib/labels';
import { DecisionArea, type DecisionLayout } from './ExamDecision';
import type { DecisionFlow } from './useDecisionFlow';
import {
  ANNOUNCE_DELAY_MS,
  REQUIREMENT_KINDS,
  percentLabel,
  percentsAnnouncement,
} from './examModel';

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

interface ExamSummaryProps {
  summary: Summary;
  exam: ExamView;
  examiners: Examiner[] | undefined;
  flow: DecisionFlow;
  /** No mark on its way: the percentages are the API's. */
  settled?: boolean;
  /** The student's record was deleted (RN018): the exam cannot be decided. */
  studentDeleted?: boolean;
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
 * answers), the marking progress and the decision area. The phone panel repeats it without
 * the title and the live region (the bar under it keeps those).
 */
function SummaryContent({
  summary,
  exam,
  examiners,
  flow,
  layout,
  settled = true,
  studentDeleted = false,
}: ExamSummaryProps & { layout: DecisionLayout }) {
  const compact = layout === 'bar';
  const panel = layout === 'panel';
  return (
    <Stack gap={compact ? 'xs' : 'md'}>
      {!panel && (
        <Title order={2} size={compact ? 'h5' : 'h4'}>
          Resumo
        </Title>
      )}
      <Text size="xs" c="dimmed">
        {PERCENT_HINT}
      </Text>
      {!panel && <PercentAnnouncer summary={summary} settled={settled} />}
      <div data-testid={panel ? undefined : 'exam-scores'}>
        <SimpleGrid cols={2} spacing="sm">
          {REQUIREMENT_KINDS.map((kind) => (
            <Score key={kind} kind={kind} summary={summary} compact={compact} />
          ))}
        </SimpleGrid>
      </div>
      <MarkingProgress summary={summary} />
      <DecisionArea
        exam={exam}
        examiners={examiners}
        flow={flow}
        layout={layout}
        studentDeleted={studentDeleted}
      />
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
      <SummaryContent {...props} layout="column" />
    </Paper>
  );
}

/**
 * Phone and tablet: a bar fixed at the bottom (right of the side menu, under the drawer),
 * with a spacer of the same height so the last item is never covered. The sensei's
 * "Decidir" opens a panel from the bottom with the same summary and Aprovar / Reprovar
 * (§ 6.4); `Esc` closes it, but not while the confirmation dialog is open over it.
 */
export function SummaryBar(props: ExamSummaryProps) {
  const { ref, height } = useElementSize();
  const { flow } = props;
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
        <SummaryContent {...props} layout="bar" />
      </Paper>
      <Drawer
        opened={flow.panelOpened && props.exam.status === 'IN_PROGRESS' && !props.studentDeleted}
        onClose={flow.closePanel}
        position="bottom"
        title="Decidir o exame"
        closeOnEscape={flow.asking === null}
        // "Decidir" may be gone after a refusal: the flow gives the focus back (§ 6.7).
        returnFocus={false}
        onExitTransitionEnd={flow.panelClosed}
        closeButtonProps={{ 'aria-label': 'Fechar' }}
        styles={{ content: { height: 'auto', maxHeight: '90dvh' } }}
      >
        <SummaryContent {...props} layout="panel" />
      </Drawer>
    </>
  );
}
