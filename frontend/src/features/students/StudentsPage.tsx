import { Alert, Anchor, Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconCircleCheck, IconPlus } from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { useBelts, useStudents } from '../../api/queries';
import type { Belt, StudentView } from '../../api/types';
import { MOBILE_QUERY } from '../../app/breakpoints';
import { paths, studentPath } from '../../app/navigation';
import { focusIfLost } from '../exam/focus';
import { NOTICE_TEXTS, noticeOf } from './routeState';
import { LoadError, LoadingState } from './screenStates';
import { BeltCell, Field, StatusText } from './studentCells';
import { ageLabel, dateLabel, nextExamLabel, studentStatus } from './studentText';
import { useRetryFocus } from './useRetryFocus';

const TITLE_ID = 'students-title';

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

/**
 * Notice left by the student form after saving or deleting. It takes focus so screen
 * readers read it, and the router state is cleared so it does not come back on reload.
 * Closing it gives the focus to the title of the list (`titleRef`, § 6.7).
 */
function SavedNotice({ titleRef }: { titleRef: RefObject<HTMLHeadingElement | null> }) {
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
        // The close button went away with the notice.
        window.setTimeout(() => {
          focusIfLost(titleRef.current);
        }, 0);
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
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRetryFocus([students], titleRef);

  const beltsById = new Map((belts.data ?? []).map((belt) => [belt.id, belt]));

  let content: ReactNode;
  if (students.isPending) {
    content = <LoadingState label="Carregando alunos…" />;
  } else if (students.isError) {
    content = (
      <LoadError
        title="Não foi possível carregar os alunos"
        error={students.error}
        retrying={students.isFetching}
        onRetry={() => void students.refetch()}
        retryFocus={retryFocus}
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
        <Title order={1} size="h2" id={TITLE_ID} ref={titleRef} tabIndex={-1}>
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
      <SavedNotice titleRef={titleRef} />
      {content}
    </Stack>
  );
}
