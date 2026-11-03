import { Anchor, Badge, Breadcrumbs, Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { Link } from 'react-router';

import { useEventExams } from '../../api/queries';
import type { Belt, ExamSheet, ExamStatus, ExamView } from '../../api/types';
import { examPath } from '../../app/navigation';
import { EVENT_STATUS_LABELS, EXAM_STATUS_LABELS } from '../../lib/labels';
import { dateLabel } from '../students/studentText';
import { DELETED_STUDENT, examAgeLabel, examDayPath, examTitle, neighbors } from './examModel';
import { TOUCH_TARGET } from './touch';

interface ExamNavProps {
  eventId: string;
  studentId: string;
  /** Student shown in the trail; undefined while the exam loads. */
  studentName: string | undefined;
}

function neighborName(exam: ExamView): string {
  return exam.student_name ?? DELETED_STUDENT;
}

function NeighborLink({
  exam,
  direction,
}: {
  exam: ExamView | undefined;
  direction: 'previous' | 'next';
}) {
  const previous = direction === 'previous';
  const label = previous ? 'Anterior' : 'Próximo';
  const icon = previous ? (
    <IconChevronLeft size={18} aria-hidden />
  ) : (
    <IconChevronRight size={18} aria-hidden />
  );
  const sides = previous ? { leftSection: icon } : { rightSection: icon };
  if (!exam) {
    return (
      <Button variant="default" disabled style={TOUCH_TARGET} {...sides}>
        {label}
      </Button>
    );
  }
  return (
    <Button
      component={Link}
      to={examPath(exam.event_id, exam.student_id)}
      variant="default"
      style={TOUCH_TARGET}
      aria-label={`${label}: ${neighborName(exam)}`}
      {...sides}
    >
      {label}
    </Button>
  );
}

/**
 * Trail back to the exam day (same event selected) and the previous/next present student,
 * in the order the exam day lists them. Rendered outside the exam content, so the focus
 * stays on "Próximo" while the next exam loads.
 */
export function ExamNav({ eventId, studentId, studentName }: ExamNavProps) {
  const exams = useEventExams(eventId);
  const { previous, next } = neighbors(exams.data ?? [], studentId);
  return (
    <Group justify="space-between" align="center" gap="sm">
      <nav aria-label="Caminho">
        <Breadcrumbs separator="/" separatorMargin="xs">
          <Anchor component={Link} to={examDayPath(eventId)}>
            Dia do exame
          </Anchor>
          <Text component="span" aria-current="page">
            {studentName ?? 'Exame do aluno'}
          </Text>
        </Breadcrumbs>
      </nav>
      <Group gap="xs" role="group" aria-label="Alunos presentes" wrap="nowrap">
        <NeighborLink exam={previous} direction="previous" />
        <NeighborLink exam={next} direction="next" />
      </Group>
    </Group>
  );
}

const STATUS_COLORS: Record<ExamStatus, string> = {
  IN_PROGRESS: 'blue',
  APPROVED: 'green',
  FAILED: 'red',
};

/** Result seal: the status is written out; the color only reinforces it (§ 6.7). */
export function ResultBadge({ status }: { status: ExamStatus }) {
  return (
    <Badge size="lg" variant="light" color={STATUS_COLORS[status]} data-status={status}>
      {EXAM_STATUS_LABELS[status]}
    </Badge>
  );
}

interface ExamHeaderProps {
  sheet: ExamSheet;
  belts: Belt[] | undefined;
}

/** Student name and result, then age, exam (`Faixa X` / `Grau na faixa X (rumo à Y)`) and event. */
export function ExamHeader({ sheet, belts }: ExamHeaderProps) {
  const name = sheet.student?.full_name ?? sheet.exam.student_name ?? DELETED_STUDENT;
  const age = examAgeLabel(sheet.student, sheet.event);
  const { event } = sheet;
  return (
    <Stack gap={4}>
      <Group gap="sm" align="center">
        <Title order={1} size="h2">
          {name}
        </Title>
        <ResultBadge status={sheet.exam.status} />
      </Group>
      <Text data-testid="exam-meta">
        {[age, examTitle(sheet, belts)].filter(Boolean).join(' · ')}
      </Text>
      <Text size="sm" c="dimmed">
        {`${event.name} · ${dateLabel(event.exam_date)} · ${EVENT_STATUS_LABELS[event.status]}`}
      </Text>
    </Stack>
  );
}
