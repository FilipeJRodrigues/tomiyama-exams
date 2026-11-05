/**
 * "Histórico de exames" of the edit form (RN018), for examiners only: every exam of the
 * student, most recent first, in the order `GET /students/{id}/exams` sends them. A table on
 * the notebook and the tablet, cards on the phone (§ 6.7). It loads and fails apart from the
 * form: its error never replaces the form, and the form never waits for it.
 *
 * Who decided comes from `GET /examiners` and `GET /settings`, as on the exam screen (§ 6.4);
 * when one of them fails the history shows all the same, without the name.
 */
import { Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconCircleCheck,
  IconCircleX,
  IconClipboardList,
  IconHourglass,
} from '@tabler/icons-react';
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useBelts, useExaminers, useSettings, useStudentExams } from '../../api/queries';
import type { Belt, ExamStatus, StudentHistoryEntry } from '../../api/types';
import { MOBILE_QUERY } from '../../app/breakpoints';
import { examPath } from '../../app/navigation';
import { EXAM_STATUS_LABELS } from '../../lib/labels';
import { TOUCH_TARGET } from '../exam/touch';
import { LoadError, LoadingState } from './screenStates';
import { Field } from './studentCells';
import {
  EMPTY_HISTORY,
  HISTORY_STATUS_COLORS,
  decisionLabel,
  hasEvent,
  historyDateLabel,
  historyEventName,
  historyExamTitle,
  historyNotes,
  openExamLabel,
  type DeciderNames,
} from './studentHistoryModel';
import { useRetryFocus } from './useRetryFocus';

const TITLE_ID = 'student-history-title';

/**
 * Narrowest width at which the six columns read well. At 768 px the side menu stays open and
 * the table scrolls inside its own container, so the page never scrolls sideways (§ 6.7). The
 * container takes focus so the keyboard can scroll it too.
 */
const TABLE_MIN_WIDTH = 760;

/** Long names and notes (up to 500 characters) wrap instead of widening the column. */
const WRAP = { overflowWrap: 'anywhere' } as const;

const STATUS_ICONS = {
  IN_PROGRESS: IconHourglass,
  APPROVED: IconCircleCheck,
  FAILED: IconCircleX,
} as const;

/** The status is always written out; the icon and the color only reinforce it (§ 6.7). */
function HistoryStatus({ status }: { status: ExamStatus }) {
  const Icon = STATUS_ICONS[status];
  const colors = HISTORY_STATUS_COLORS[status];
  return (
    <Group gap={6} wrap="nowrap" align="flex-start" data-status={status}>
      <Icon size={18} aria-hidden style={{ flex: 'none', marginTop: 1, color: colors.icon }} />
      <Text component="span" size="sm" c={colors.text} fw={status === 'FAILED' ? 500 : undefined}>
        {EXAM_STATUS_LABELS[status]}
      </Text>
    </Group>
  );
}

interface EntryProps {
  entry: StudentHistoryEntry;
  names: DeciderNames;
}

/** `Decidido por …` and, below it, `em dd/mm/aaaa`; `—` while in progress. */
function DecisionText({ entry, names }: EntryProps) {
  const decision = decisionLabel(entry, names);
  if (!decision) return <>—</>;
  return (
    <Stack gap={0} component="span">
      <Text component="span" size="sm" style={WRAP}>
        {decision.who}
      </Text>
      {decision.when && (
        <Text component="span" size="sm" c="dimmed">
          {`em ${decision.when}`}
        </Text>
      )}
    </Stack>
  );
}

interface LinkProps {
  entry: StudentHistoryEntry;
  studentId: string;
  belts: readonly Belt[] | undefined;
  /** Phone cards: a touch target of 44 px. */
  touch?: boolean;
}

/** The exam screen (§ 6.4) of this exam; nothing when the event no longer exists. */
function OpenExamLink({ entry, studentId, belts, touch = false }: LinkProps) {
  if (!hasEvent(entry)) return null;
  return (
    <Button
      component={Link}
      to={examPath(entry.event_id, studentId)}
      variant="default"
      size="xs"
      style={touch ? TOUCH_TARGET : undefined}
      leftSection={<IconClipboardList size={16} aria-hidden />}
      aria-label={openExamLabel(entry, belts)}
    >
      Abrir exame
    </Button>
  );
}

interface ListProps {
  entries: readonly StudentHistoryEntry[];
  studentId: string;
  names: DeciderNames;
  /** `GET /belts`, for the belt of a stripe exam as on the exam screen. */
  belts: readonly Belt[] | undefined;
}

function HistoryTable({ entries, studentId, names, belts }: ListProps) {
  return (
    <Table.ScrollContainer
      type="native"
      minWidth={TABLE_MIN_WIDTH}
      tabIndex={0}
      role="region"
      aria-label="Lista de exames"
      className="mantine-focus-auto"
    >
      <Table aria-labelledby={TITLE_ID} verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Data</Table.Th>
            <Table.Th scope="col">Evento</Table.Th>
            <Table.Th scope="col">Exame</Table.Th>
            <Table.Th scope="col">Situação</Table.Th>
            <Table.Th scope="col">Decisão</Table.Th>
            <Table.Th scope="col">Ação</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((entry) => {
            const notes = historyNotes(entry);
            return (
              <Table.Tr key={entry.event_id}>
                <Table.Td>{historyDateLabel(entry)}</Table.Td>
                <Table.Th scope="row" fw={500} style={WRAP}>
                  {historyEventName(entry)}
                </Table.Th>
                <Table.Td>{historyExamTitle(entry, belts)}</Table.Td>
                <Table.Td>
                  <HistoryStatus status={entry.status} />
                </Table.Td>
                <Table.Td>
                  <Stack gap={4}>
                    <DecisionText entry={entry} names={names} />
                    {notes && (
                      <Text component="span" size="sm" style={WRAP}>
                        {`Observação: ${notes}`}
                      </Text>
                    )}
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <OpenExamLink entry={entry} studentId={studentId} belts={belts} />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function HistoryCards({ entries, studentId, names, belts }: ListProps) {
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
      {entries.map((entry) => {
        const decision = decisionLabel(entry, names);
        const notes = historyNotes(entry);
        return (
          <Card key={entry.event_id} component="li" withBorder padding="md">
            <Title order={3} size="h4" mb="xs" style={WRAP}>
              {historyEventName(entry)}
            </Title>
            <Stack component="dl" gap="xs" m={0} mb={hasEvent(entry) ? 'sm' : 0}>
              <Field label="Data">{historyDateLabel(entry)}</Field>
              <Field label="Exame">{historyExamTitle(entry, belts)}</Field>
              <Field label="Situação">
                <HistoryStatus status={entry.status} />
              </Field>
              {decision && (
                <Field label="Decisão">
                  <DecisionText entry={entry} names={names} />
                </Field>
              )}
              {notes && (
                <Field label="Observação">
                  <span style={WRAP}>{notes}</span>
                </Field>
              )}
            </Stack>
            <OpenExamLink entry={entry} studentId={studentId} belts={belts} touch />
          </Card>
        );
      })}
    </Stack>
  );
}

interface StudentExamHistoryProps {
  studentId: string;
  /**
   * Shown with the form only. Mounted earlier (while the student loads), so the history is
   * asked at the same time as the student; hidden meanwhile, so a 404 of the student never
   * shows the section.
   */
  visible: boolean;
}

/** Mount only for examiners: the hooks here are examiner-only routes (403 for a guardian). */
export function StudentExamHistory({ studentId, visible }: StudentExamHistoryProps) {
  const history = useStudentExams(studentId);
  const examiners = useExaminers();
  // Already loaded by the edit form (the section shows with it): the same cached read.
  const belts = useBelts();
  const settings = useSettings();
  const isMobile = useMediaQuery(MOBILE_QUERY, false, { getInitialValueInEffect: false });
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRetryFocus([history], titleRef);

  if (!visible) return null;

  const names: DeciderNames = {
    examiners: examiners.data,
    sensei: settings.data?.sensei,
    loaded: examiners.data !== undefined && !settings.isPending,
  };

  // An error replaces the history only while there is none yet: a failed background reload
  // (window focus) keeps the exams on screen.
  let content: ReactNode;
  if (history.data === undefined && history.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar o histórico"
        error={history.error}
        retrying={history.isFetching}
        onRetry={() => void history.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (history.data === undefined) {
    content = <LoadingState label="Carregando histórico…" />;
  } else if (history.data.length === 0) {
    content = <Text>{EMPTY_HISTORY}</Text>;
  } else if (isMobile) {
    content = (
      <HistoryCards entries={history.data} studentId={studentId} names={names} belts={belts.data} />
    );
  } else {
    content = (
      <HistoryTable entries={history.data} studentId={studentId} names={names} belts={belts.data} />
    );
  }

  return (
    <Stack component="section" aria-labelledby={TITLE_ID} gap="sm" mt="lg">
      <Title order={2} size="h3" id={TITLE_ID} ref={titleRef} tabIndex={-1}>
        Histórico de exames
      </Title>
      {content}
    </Stack>
  );
}
