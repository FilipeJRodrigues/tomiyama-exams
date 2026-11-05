import {
  Alert,
  Button,
  Card,
  Group,
  NativeSelect,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconCircleCheck,
  IconClipboardList,
  IconLock,
  IconPlus,
  IconSearch,
  IconUserCheck,
} from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useSearchParams } from 'react-router';

import { errorMessage } from '../../api/client';
import {
  isAlreadyConfirmed,
  useBelts,
  useConfirmAttendance,
  useEventExams,
  useEvents,
  useStudents,
} from '../../api/queries';
import type { Belt, ExamEvent, ExamView, StudentView } from '../../api/types';
import { MOBILE_QUERY } from '../../app/breakpoints';
import { examPath, paths } from '../../app/navigation';
import { EVENT_STATUS_LABELS, EXAM_STATUS_LABELS } from '../../lib/labels';
import { focusIfLost } from '../exam/focus';
import { LoadError, LoadingState } from '../students/screenStates';
import { BeltCell, Field, StatusText } from '../students/studentCells';
import { ageLabel, dateLabel, nextExamLabel, studentStatus } from '../students/studentText';
import { useRetryFocus } from '../students/useRetryFocus';
import {
  EVENT_PARAM,
  FILTER_LABELS,
  ROSTER_FILTERS,
  buildRoster,
  countByFilter,
  isRosterFilter,
  matchesFilter,
  mergeCreatedExams,
  rosterAction,
  searchRoster,
  selectEvent,
  type RosterEntry,
  type RosterFilter,
} from './examDayModel';

const LIST_LABEL = 'Alunos do evento';
const NO_EXAMS: readonly ExamView[] = [];

/** `Exame novembro/2026 · 21/11/2026 · Aberto`. */
function eventLabel(event: ExamEvent): string {
  return `${event.name} · ${dateLabel(event.exam_date)} · ${EVENT_STATUS_LABELS[event.status]}`;
}

/** A link to the events screen, drawn as a button. */
function CreateEventLink() {
  return (
    <Button component={Link} to={paths.events} leftSection={<IconPlus size={18} aria-hidden />}>
      Criar evento
    </Button>
  );
}

function NoEvent({ message }: { message: string }) {
  return (
    <Stack gap="sm" align="flex-start">
      <Text>{message}</Text>
      <CreateEventLink />
    </Stack>
  );
}

interface EventPickerProps {
  events: ExamEvent[];
  selected: ExamEvent | undefined;
  onChange: (eventId: string) => void;
}

/** Native select: the phone's own picker, and every event (closed ones too) is listed. */
function EventPicker({ events, selected, onChange }: EventPickerProps) {
  const options = events.map((event) => ({ value: event.id, label: eventLabel(event) }));
  const data = selected
    ? options
    : [{ value: '', label: 'Nenhum evento escolhido', disabled: true }, ...options];
  return (
    <NativeSelect
      label="Evento"
      data={data}
      value={selected?.id ?? ''}
      maw={560}
      onChange={(event) => {
        onChange(event.currentTarget.value);
      }}
    />
  );
}

/** `Presente · Em andamento`, under the eligibility of a student with an exam. */
function PresenceText({ exam }: { exam: ExamView }) {
  return (
    <Group gap={6} wrap="nowrap" align="flex-start" data-presence={exam.status}>
      <IconUserCheck size={18} aria-hidden style={{ flex: 'none', marginTop: 1 }} />
      <Text component="span" size="sm">
        Presente · {EXAM_STATUS_LABELS[exam.status]}
      </Text>
    </Group>
  );
}

function SituationCell({ entry }: { entry: RosterEntry }) {
  return (
    <Stack gap={4}>
      <StatusText status={studentStatus(entry.student)} />
      {entry.exam && <PresenceText exam={entry.exam} />}
    </Stack>
  );
}

interface ActionHandlers {
  /**
   * True once for the student just confirmed: their "Abrir exame" link takes the focus
   * then, and not again when the row comes back later (search, filter, layout change).
   */
  takeFocus: (studentId: string) => boolean;
  /**
   * `button` is the "Confirmar presença" that was clicked, still mounted when the 201
   * arrives: the link only takes the focus if the user has not moved it elsewhere.
   */
  onConfirmed: (student: StudentView, exam: ExamView, button: HTMLButtonElement | null) => void;
  onFailed: (student: StudentView, error: unknown) => void;
  onStart: (student: StudentView) => void;
}

interface ConfirmButtonProps extends ActionHandlers {
  event: ExamEvent;
  student: StudentView;
}

/**
 * "Confirmar presença" (RN005). Loading while the API answers; the ref also stops a
 * second click that arrives before the next render.
 */
function ConfirmButton({ event, student, onConfirmed, onFailed, onStart }: ConfirmButtonProps) {
  const confirm = useConfirmAttendance(event.id);
  const busy = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = async () => {
    if (busy.current) return;
    busy.current = true;
    onStart(student);
    try {
      const exam = await confirm.mutateAsync(student.id);
      onConfirmed(student, exam, buttonRef.current);
    } catch (error) {
      busy.current = false;
      onFailed(student, error);
    }
  };

  return (
    <Button
      ref={buttonRef}
      size="sm"
      loading={confirm.isPending}
      aria-label={`Confirmar presença de ${student.full_name}`}
      onClick={() => void handleClick()}
    >
      Confirmar presença
    </Button>
  );
}

function OpenExamLink({
  event,
  student,
  takeFocus,
}: {
  event: ExamEvent;
  student: StudentView;
  takeFocus: (studentId: string) => boolean;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  // Every render: the pending focus may arrive with any of them, and is consumed once.
  useEffect(() => {
    if (takeFocus(student.id)) ref.current?.focus();
  });
  return (
    <Button
      ref={ref}
      component={Link}
      to={examPath(event.id, student.id)}
      variant="outline"
      size="sm"
      leftSection={<IconClipboardList size={18} aria-hidden />}
      aria-label={`Abrir exame de ${student.full_name}`}
    >
      Abrir exame
    </Button>
  );
}

interface RowActionProps extends ActionHandlers {
  event: ExamEvent;
  entry: RosterEntry;
}

function RowAction({ event, entry, ...handlers }: RowActionProps) {
  const action = rosterAction(entry, event);
  if (action === 'confirm') {
    return <ConfirmButton event={event} student={entry.student} {...handlers} />;
  }
  if (action === 'open') {
    return <OpenExamLink event={event} student={entry.student} takeFocus={handlers.takeFocus} />;
  }
  return null;
}

interface ListProps extends ActionHandlers {
  event: ExamEvent;
  entries: RosterEntry[];
  beltsById: Map<string, Belt>;
}

/**
 * Narrowest width at which the six columns read well. At 768 px the side menu stays open
 * and the table scrolls inside its own focusable region (§ 6.7), never the page.
 */
const TABLE_MIN_WIDTH = 760;

function RosterTable({ event, entries, beltsById, ...handlers }: ListProps) {
  return (
    <Table.ScrollContainer
      type="native"
      minWidth={TABLE_MIN_WIDTH}
      tabIndex={0}
      role="region"
      aria-label="Lista de alunos do evento"
      className="mantine-focus-auto"
    >
      <Table aria-label={LIST_LABEL} verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Aluno</Table.Th>
            <Table.Th scope="col">Idade</Table.Th>
            <Table.Th scope="col">Faixa atual</Table.Th>
            <Table.Th scope="col">Próximo exame</Table.Th>
            <Table.Th scope="col">Situação</Table.Th>
            <Table.Th scope="col">Ação</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((entry) => (
            <Table.Tr key={entry.student.id}>
              <Table.Th scope="row" fw={500}>
                {entry.student.full_name}
              </Table.Th>
              <Table.Td>{ageLabel(entry.student.age)}</Table.Td>
              <Table.Td>
                <BeltCell
                  student={entry.student}
                  belt={beltsById.get(entry.student.current_belt_id)}
                />
              </Table.Td>
              <Table.Td>{nextExamLabel(entry.student.eligibility)}</Table.Td>
              <Table.Td>
                <SituationCell entry={entry} />
              </Table.Td>
              <Table.Td>
                <RowAction event={event} entry={entry} {...handlers} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function RosterCards({ event, entries, beltsById, ...handlers }: ListProps) {
  return (
    <Stack
      component="ul"
      role="list"
      aria-label={LIST_LABEL}
      gap="sm"
      p={0}
      m={0}
      style={{ listStyle: 'none' }}
    >
      {entries.map((entry) => (
        <Card key={entry.student.id} component="li" withBorder padding="md">
          <Title order={2} size="h4" mb="xs">
            {entry.student.full_name}
          </Title>
          <Stack component="dl" gap="xs" m={0}>
            <Field label="Idade">{ageLabel(entry.student.age)}</Field>
            <Field label="Faixa atual">
              <BeltCell
                student={entry.student}
                belt={beltsById.get(entry.student.current_belt_id)}
              />
            </Field>
            <Field label="Próximo exame">{nextExamLabel(entry.student.eligibility)}</Field>
            <Field label="Situação">
              <SituationCell entry={entry} />
            </Field>
          </Stack>
          {rosterAction(entry, event) !== 'none' && (
            <Group mt="sm">
              <RowAction event={event} entry={entry} {...handlers} />
            </Group>
          )}
        </Card>
      ))}
    </Stack>
  );
}

interface Failure {
  studentName: string;
  message: string;
}

/**
 * The list of one event (§ 6.3): active students with the eligibility on the event date
 * (RN015) and the exams already confirmed. Keyed by event, so search, filter and notices
 * start over when the event changes.
 */
interface EventRosterProps {
  event: ExamEvent;
  /** Exams this session created in the event (201 of the confirmation). */
  created: readonly ExamView[];
  onCreated: (exam: ExamView) => void;
  /** The title of the screen: the focus goes there when a notice closes or the list loads. */
  titleRef: RefObject<HTMLHeadingElement | null>;
}

function EventRoster({ event, created, onCreated, titleRef }: EventRosterProps) {
  const students = useStudents({ active: true, reference_date: event.exam_date });
  const exams = useEventExams(event.id);
  const retryFocus = useRetryFocus([students, exams], titleRef);
  // Belts only feed the decorative color sample; the list does not wait for them.
  const belts = useBelts();
  const isMobile = useMediaQuery(MOBILE_QUERY, false, { getInitialValueInEffect: false });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RosterFilter>('all');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmed, setConfirmed] = useState<StudentView | null>(null);
  // Separate from the notice, and good for the next render only.
  const pendingFocus = useRef<string | null>(null);
  // The last "Confirmar presença" clicked: with two confirmations in flight, only it may
  // take the focus when the focus has fallen to the page body.
  const lastStarted = useRef<string | null>(null);

  // Runs after the children's effects: the link had its chance; it does not wait for a
  // row hidden by the search or the filter.
  useEffect(() => {
    pendingFocus.current = null;
  });

  const closed = event.status !== 'OPEN';
  const closedNotice = closed && (
    <Alert
      color="orange"
      variant="light"
      role="note"
      icon={<IconLock aria-hidden />}
      title="Evento encerrado"
    >
      A presença não pode mais ser confirmada neste evento.
    </Alert>
  );

  // A load error replaces the list only while there is no data yet: a failed background
  // refetch (window focus) keeps the list on screen.
  const loadFailure =
    students.data === undefined && students.isError
      ? students
      : exams.data === undefined && exams.isError
        ? exams
        : null;
  if (loadFailure) {
    return (
      <Stack gap="md">
        {closedNotice}
        <LoadError
          title="Não foi possível carregar os alunos"
          error={loadFailure.error}
          retrying={students.isFetching || exams.isFetching}
          onRetry={() => {
            if (students.isError) void students.refetch();
            if (exams.isError) void exams.refetch();
          }}
          retryFocus={retryFocus}
        />
      </Stack>
    );
  }
  if (students.data === undefined || exams.data === undefined) {
    return <LoadingState label="Carregando alunos…" />;
  }
  if (students.data.length === 0) {
    return (
      <Stack gap="md">
        {closedNotice}
        <Text>Nenhum aluno ativo.</Text>
      </Stack>
    );
  }

  const beltsById = new Map((belts.data ?? []).map((belt) => [belt.id, belt]));
  const found = searchRoster(
    buildRoster(students.data, mergeCreatedExams(exams.data, created)),
    query,
  );
  const counts = countByFilter(found);
  const shown = found.filter((entry) => matchesFilter(entry, filter));

  const handlers: ActionHandlers = {
    takeFocus: (studentId) => {
      if (pendingFocus.current !== studentId) return false;
      pendingFocus.current = null;
      return true;
    },
    onStart: (student) => {
      setFailure(null);
      setConfirmed(null);
      pendingFocus.current = null;
      lastStarted.current = student.id;
    },
    onConfirmed: (student, exam, button) => {
      // The focus follows to "Abrir exame" only if it is still on the clicked button, or
      // was lost to the body (button disabled while loading). If the user went to the
      // search, a filter or another row while waiting, it stays there (§ 6.7).
      const active = document.activeElement;
      const stillHere = button !== null && active === button;
      const lost =
        (active === null || active === document.body) && lastStarted.current === student.id;
      if (stillHere || lost) pendingFocus.current = student.id;
      onCreated(exam);
      setConfirmed(student);
    },
    onFailed: (student, error) => {
      // Someone else confirmed first: the reloaded list already shows "Abrir exame".
      if (isAlreadyConfirmed(error)) return;
      setFailure({ studentName: student.full_name, message: errorMessage(error) });
    },
  };

  // The close button went away with the notice: the focus goes to the title (§ 6.7).
  const focusTitleOnceClosed = () => {
    window.setTimeout(() => {
      focusIfLost(titleRef.current);
    }, 0);
  };

  const listProps: ListProps = { event, entries: shown, beltsById, ...handlers };
  let list: ReactNode;
  if (shown.length === 0) {
    list = <Text>Nenhum aluno encontrado.</Text>;
  } else if (isMobile) {
    list = <RosterCards {...listProps} />;
  } else {
    list = <RosterTable {...listProps} />;
  }

  return (
    <Stack gap="md">
      {closedNotice}
      <Group align="flex-end" gap="md">
        <TextInput
          type="search"
          label="Buscar por nome"
          value={query}
          w={isMobile ? '100%' : 320}
          leftSection={<IconSearch size={16} aria-hidden />}
          onChange={(change) => {
            setQuery(change.currentTarget.value);
          }}
        />
        <SegmentedControl
          aria-label="Filtrar alunos"
          value={filter}
          fullWidth={isMobile}
          orientation={isMobile ? 'vertical' : 'horizontal'}
          w={isMobile ? '100%' : undefined}
          data={ROSTER_FILTERS.map((value) => ({
            value,
            label: `${FILTER_LABELS[value]} (${String(counts[value])})`,
          }))}
          onChange={(value) => {
            if (isRosterFilter(value)) setFilter(value);
          }}
        />
      </Group>
      {confirmed && (
        <Alert
          color="green"
          variant="light"
          role="status"
          icon={<IconCircleCheck aria-hidden />}
          withCloseButton
          closeButtonLabel="Fechar aviso"
          onClose={() => {
            setConfirmed(null);
            focusTitleOnceClosed();
          }}
        >
          Presença de {confirmed.full_name} confirmada.
        </Alert>
      )}
      {failure && (
        <Alert
          color="red"
          variant="light"
          role="alert"
          icon={<IconAlertCircle aria-hidden />}
          title={`Não foi possível confirmar a presença de ${failure.studentName}`}
          withCloseButton
          closeButtonLabel="Fechar aviso"
          onClose={() => {
            setFailure(null);
            focusTitleOnceClosed();
          }}
        >
          {failure.message}
        </Alert>
      )}
      {list}
    </Stack>
  );
}

/**
 * § 6.3 exam day, examiners only: pick the event (default: the most recent open one,
 * kept in `?evento=`), then confirm attendance or open the exam of each student.
 */
export function ExamDayPage() {
  const events = useEvents();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRetryFocus([events], titleRef);
  const [searchParams, setSearchParams] = useSearchParams();
  const chosenId = searchParams.get(EVENT_PARAM);
  const selected = events.data ? selectEvent(events.data, chosenId) : undefined;
  // Exams confirmed in this session, by event: a stale reload does not hide them.
  const [createdByEvent, setCreatedByEvent] = useState<Record<string, ExamView[]>>({});

  // The default event goes into the URL too (replacing the entry), so it stays on screen
  // after a reload, and also when a refetch shows it was closed in the meantime (RN016).
  useEffect(() => {
    if (!selected || selected.id === chosenId) return;
    setSearchParams(
      (params) => {
        params.set(EVENT_PARAM, selected.id);
        return params;
      },
      { replace: true },
    );
  }, [selected, chosenId, setSearchParams]);

  let content: ReactNode;
  if (events.data === undefined && events.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar os eventos"
        error={events.error}
        retrying={events.isFetching}
        onRetry={() => void events.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (events.data === undefined) {
    content = <LoadingState label="Carregando eventos…" />;
  } else if (events.data.length === 0) {
    content = <NoEvent message="Nenhum evento cadastrado." />;
  } else {
    content = (
      <>
        <EventPicker
          events={events.data}
          selected={selected}
          onChange={(eventId) => {
            setSearchParams((params) => {
              params.set(EVENT_PARAM, eventId);
              return params;
            });
          }}
        />
        {selected ? (
          <EventRoster
            key={selected.id}
            event={selected}
            created={createdByEvent[selected.id] ?? NO_EXAMS}
            titleRef={titleRef}
            onCreated={(exam) => {
              setCreatedByEvent((current) => ({
                ...current,
                [exam.event_id]: [...(current[exam.event_id] ?? []), exam],
              }));
            }}
          />
        ) : (
          <NoEvent message="Nenhum evento aberto." />
        )}
      </>
    );
  }

  return (
    <Stack gap="md">
      <Title order={1} size="h2" ref={titleRef} tabIndex={-1}>
        Dia do exame
      </Title>
      {content}
    </Stack>
  );
}
