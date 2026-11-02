import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleMinus,
  IconPlus,
} from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { ApiError, errorMessage } from '../../api/client';
import { useBelts, useStudents } from '../../api/queries';
import type { Belt, StudentView } from '../../api/types';
import { MOBILE_QUERY } from '../../app/breakpoints';
import { paths, studentPath } from '../../app/navigation';
import { NOTICE_TEXTS, noticeOf } from './routeState';
import {
  ageLabel,
  beltLabel,
  dateLabel,
  nextExamLabel,
  studentStatus,
  type StudentStatus,
} from './studentText';

const TITLE_ID = 'students-title';

/**
 * Belt color sample, decorative only (the name is always written next to it). The border
 * keeps the white belt visible on a white page.
 */
function BeltSwatch({ belt }: { belt: Belt | undefined }) {
  if (!belt) return null;
  const background = belt.color_secondary
    ? `linear-gradient(to right, ${belt.color_primary} 50%, ${belt.color_secondary} 50%)`
    : belt.color_primary;
  return (
    <Box
      component="span"
      aria-hidden
      data-testid="belt-swatch"
      style={{
        display: 'inline-block',
        flex: 'none',
        width: 28,
        height: 12,
        borderRadius: 3,
        border: '1px solid var(--mantine-color-dimmed)',
        background,
      }}
    />
  );
}

function BeltCell({ student, belt }: { student: StudentView; belt: Belt | undefined }) {
  return (
    <Group gap={8} wrap="nowrap">
      <BeltSwatch belt={belt} />
      <span>{beltLabel(student.current_belt_name, student.stripes)}</span>
    </Group>
  );
}

const STATUS_ICONS = {
  inactive: IconCircleMinus,
  eligible: IconCircleCheck,
  blocked: IconAlertTriangle,
} as const;

/** The state is always written out; the icon and the red only reinforce it (§ 6.7). */
function StatusText({ status }: { status: StudentStatus }) {
  const Icon = STATUS_ICONS[status.kind];
  const color =
    status.kind === 'blocked'
      ? 'var(--mantine-color-error)'
      : status.kind === 'inactive'
        ? 'var(--mantine-color-dimmed)'
        : undefined;
  const iconColor = status.kind === 'eligible' ? 'var(--mantine-color-green-light-color)' : color;
  return (
    <Group gap={6} wrap="nowrap" align="flex-start" data-status={status.kind}>
      <Icon size={18} aria-hidden style={{ flex: 'none', marginTop: 1, color: iconColor }} />
      {/* Long block reasons wrap instead of widening the column. */}
      <Text
        component="span"
        size="sm"
        c={color}
        fw={status.kind === 'blocked' ? 500 : undefined}
        miw={0}
        style={{ overflowWrap: 'anywhere' }}
      >
        {status.label}
      </Text>
    </Group>
  );
}

interface ListProps {
  students: StudentView[];
  beltsById: Map<string, Belt>;
}

/**
 * Narrowest width at which the six columns read well, with the status text wrapping. At
 * 768 px the side menu stays open and the table gets about 500 px, so it scrolls inside
 * its own container and the page never scrolls sideways (§ 6.7). The container takes
 * focus so the keyboard can scroll it too.
 */
const TABLE_MIN_WIDTH = 640;

function StudentsTable({ students, beltsById }: ListProps) {
  return (
    <Table.ScrollContainer
      type="native"
      minWidth={TABLE_MIN_WIDTH}
      tabIndex={0}
      role="region"
      aria-label="Lista de alunos"
      className="mantine-focus-auto"
    >
      <Table aria-labelledby={TITLE_ID} verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Nome</Table.Th>
            <Table.Th scope="col">Faixa atual</Table.Th>
            <Table.Th scope="col">Idade</Table.Th>
            <Table.Th scope="col">Na faixa desde</Table.Th>
            <Table.Th scope="col">Próximo exame</Table.Th>
            <Table.Th scope="col">Situação</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {students.map((student) => (
            <Table.Tr key={student.id}>
              {/* The name is the row's only focus stop: the path to the edit form (§ 6.2),
                  pinned by tests/features/students/StudentsPage.scroll-region.test.tsx. */}
              <Table.Th scope="row" fw={500}>
                <Anchor component={Link} to={studentPath(student.id)} inherit>
                  {student.full_name}
                </Anchor>
              </Table.Th>
              <Table.Td>
                <BeltCell student={student} belt={beltsById.get(student.current_belt_id)} />
              </Table.Td>
              <Table.Td>{ageLabel(student.age)}</Table.Td>
              <Table.Td>{dateLabel(student.current_belt_since)}</Table.Td>
              <Table.Td>{nextExamLabel(student.eligibility)}</Table.Td>
              <Table.Td>
                <StatusText status={studentStatus(student)} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Text component="dt" size="sm" c="dimmed">
        {label}
      </Text>
      <Text component="dd" size="sm" m={0}>
        {children}
      </Text>
    </div>
  );
}

function StudentsCards({ students, beltsById }: ListProps) {
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
      {students.map((student) => (
        <Card key={student.id} component="li" withBorder padding="md">
          <Title order={2} size="h4" mb="xs">
            <Anchor component={Link} to={studentPath(student.id)} inherit>
              {student.full_name}
            </Anchor>
          </Title>
          <Stack component="dl" gap="xs" m={0}>
            <Field label="Faixa atual">
              <BeltCell student={student} belt={beltsById.get(student.current_belt_id)} />
            </Field>
            <Field label="Idade">{ageLabel(student.age)}</Field>
            <Field label="Na faixa desde">{dateLabel(student.current_belt_since)}</Field>
            <Field label="Próximo exame">{nextExamLabel(student.eligibility)}</Field>
            <Field label="Situação">
              <StatusText status={studentStatus(student)} />
            </Field>
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

function LoadingState() {
  return (
    <Group role="status" gap="sm" py="xl" justify="center">
      <Loader size="sm" aria-hidden />
      <Text>Carregando alunos…</Text>
    </Group>
  );
}

function ErrorState({
  error,
  retrying,
  onRetry,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <Alert
      color="red"
      variant="light"
      role="alert"
      icon={<IconAlertCircle aria-hidden />}
      title={forbidden ? 'Sem permissão' : 'Não foi possível carregar os alunos'}
    >
      <Stack gap="sm" align="flex-start">
        <Text size="sm">{errorMessage(error)}</Text>
        {!forbidden && (
          <Button variant="default" loading={retrying} onClick={onRetry}>
            Tentar de novo
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

/**
 * Notice left by the student form after saving or deleting. It takes focus so screen
 * readers read it, and the router state is cleared so it does not come back on reload.
 */
function SavedNotice() {
  const location = useLocation();
  const navigate = useNavigate();
  const [notice, setNotice] = useState(() => noticeOf(location.state));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!noticeOf(location.state)) return;
    ref.current?.focus();
    void navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  if (!notice) return null;
  return (
    <Alert
      ref={ref}
      tabIndex={-1}
      color="green"
      variant="light"
      role="status"
      icon={<IconCircleCheck aria-hidden />}
      withCloseButton
      closeButtonLabel="Fechar aviso"
      onClose={() => {
        setNotice(null);
      }}
    >
      {NOTICE_TEXTS[notice]}
    </Alert>
  );
}

/**
 * § 6.2 students list, for every profile. The API decides who sees whom (examiners see
 * everyone, guardians only their own), so the screen shows exactly what it receives.
 */
export function StudentsPage() {
  const students = useStudents();
  // Belts only feed the decorative color sample; the list does not wait for them.
  const belts = useBelts();
  const isMobile = useMediaQuery(MOBILE_QUERY, false, { getInitialValueInEffect: false });

  const beltsById = new Map((belts.data ?? []).map((belt) => [belt.id, belt]));

  let content: ReactNode;
  if (students.isPending) {
    content = <LoadingState />;
  } else if (students.isError) {
    content = (
      <ErrorState
        error={students.error}
        retrying={students.isFetching}
        onRetry={() => void students.refetch()}
      />
    );
  } else if (students.data.length === 0) {
    content = <Text>Nenhum aluno cadastrado.</Text>;
  } else if (isMobile) {
    content = <StudentsCards students={students.data} beltsById={beltsById} />;
  } else {
    content = <StudentsTable students={students.data} beltsById={beltsById} />;
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" gap="sm">
        <Title order={1} size="h2" id={TITLE_ID}>
          Alunos
        </Title>
        {/* A link (it opens another page), drawn as a button. */}
        <Button
          component={Link}
          to={paths.studentNew}
          leftSection={<IconPlus size={18} aria-hidden />}
        >
          Novo aluno
        </Button>
      </Group>
      <SavedNotice />
      {content}
    </Stack>
  );
}
