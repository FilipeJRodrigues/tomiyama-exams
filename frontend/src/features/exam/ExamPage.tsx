import { Alert, Box, Button, Group, Stack, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconArrowLeft, IconLock, IconUserOff } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { ApiError } from '../../api/client';
import { useBelts, useExamSheet, useExaminers } from '../../api/queries';
import type { ExamSheet, RequirementKind } from '../../api/types';
import { EXAM_SIDE_SUMMARY_QUERY } from '../../app/breakpoints';
import { LoadError, LoadingState } from '../students/screenStates';
import { ExamHeader, ExamNav } from './ExamHeader';
import { ExamItems, MarkText, type RenderMark } from './ExamItems';
import { SummaryBar, SummaryColumn } from './ExamSummary';
import { DELETED_STUDENT, examDayPath, markState } from './examModel';

const MSG_EVENT_NOT_FOUND = 'Evento não encontrado';

/** Step 1: every item read-only. Step 2 swaps in Certo/Errado while `canMark` holds. */
const renderReadOnlyMark: RenderMark = (item) => <MarkText state={markState(item)} />;

/** Title while there is no exam to name the page after. */
function PageTitle() {
  return (
    <Title order={1} size="h2">
      Exame do aluno
    </Title>
  );
}

/** 404 of the exam or of the event, with the API message and a way back to the exam day. */
function NotFound({ error, eventId }: { error: ApiError; eventId: string }) {
  const eventMissing = error.message === MSG_EVENT_NOT_FOUND;
  return (
    <Stack gap="sm" align="flex-start">
      <Title order={1} size="h2">
        {error.message}
      </Title>
      <Text>
        {eventMissing
          ? 'O evento não existe ou foi excluído.'
          : 'Este aluno não tem presença confirmada neste evento.'}
      </Text>
      <Button
        component={Link}
        to={eventMissing ? examDayPath() : examDayPath(eventId)}
        variant="default"
        leftSection={<IconArrowLeft size={18} aria-hidden />}
      >
        Voltar ao Dia do exame
      </Button>
    </Stack>
  );
}

/** Notices above the items: deleted student (RN018) and closed event (RN016, RN008a). */
function Notices({ sheet }: { sheet: ExamSheet }) {
  return (
    <>
      {sheet.student === null && (
        <Alert color="gray" variant="light" role="note" icon={<IconUserOff aria-hidden />}>
          O cadastro do aluno foi excluído. O exame continua registrado.
        </Alert>
      )}
      {sheet.event.status === 'CLOSED' && sheet.exam.status === 'IN_PROGRESS' && (
        <Alert
          color="orange"
          variant="light"
          role="note"
          icon={<IconLock aria-hidden />}
          title="Evento encerrado"
        >
          Os itens não podem mais ser marcados. O sensei ainda pode decidir o exame.
        </Alert>
      )}
    </>
  );
}

interface ExamContentProps {
  sheet: ExamSheet;
  kind: RequirementKind;
  onKindChange: (kind: RequirementKind) => void;
  onlyUnmarked: boolean;
  onOnlyUnmarkedChange: (value: boolean) => void;
}

function ExamContent({ sheet, ...itemProps }: ExamContentProps) {
  const belts = useBelts();
  const examiners = useExaminers();
  const sideSummary = useMediaQuery(EXAM_SIDE_SUMMARY_QUERY, true, {
    getInitialValueInEffect: false,
  });
  const summaryProps = { summary: sheet.summary, exam: sheet.exam, examiners: examiners.data };

  const main = (
    <Stack gap="md">
      <ExamHeader sheet={sheet} belts={belts.data} />
      <Notices sheet={sheet} />
      <ExamItems
        items={sheet.items}
        summary={sheet.summary}
        renderMark={renderReadOnlyMark}
        {...itemProps}
      />
    </Stack>
  );

  if (sideSummary) {
    return (
      <Group align="flex-start" gap="lg" wrap="nowrap">
        <Box miw={0} style={{ flex: 1 }}>
          {main}
        </Box>
        <SummaryColumn {...summaryProps} />
      </Group>
    );
  }
  return (
    <>
      {main}
      <SummaryBar {...summaryProps} />
    </>
  );
}

/**
 * § 6.4 a student's exam, examiners only (step 1: read-only). Header with the way back to
 * the exam day and the previous/next present student, the items by kind and category, and
 * the RN007 summary. The exam reloads when the window gets the focus back.
 */
export function ExamPage() {
  const { eventId = '', studentId = '' } = useParams();
  const sheet = useExamSheet(eventId, studentId);
  // Kept while moving to the previous/next student.
  const [kind, setKind] = useState<RequirementKind>('THEORY');
  const [onlyUnmarked, setOnlyUnmarked] = useState(false);

  const data = sheet.data;
  let content: ReactNode;
  if (data === undefined && sheet.isError) {
    const error = sheet.error;
    content =
      error instanceof ApiError && error.status === 404 ? (
        <NotFound error={error} eventId={eventId} />
      ) : (
        <>
          <PageTitle />
          <LoadError
            title="Não foi possível carregar o exame"
            error={error}
            retrying={sheet.isFetching}
            onRetry={() => void sheet.refetch()}
          />
        </>
      );
  } else if (data === undefined) {
    content = (
      <>
        <PageTitle />
        <LoadingState label="Carregando exame…" />
      </>
    );
  } else {
    content = (
      <ExamContent
        sheet={data}
        kind={kind}
        onKindChange={setKind}
        onlyUnmarked={onlyUnmarked}
        onOnlyUnmarkedChange={setOnlyUnmarked}
      />
    );
  }

  const studentName = data
    ? (data.student?.full_name ?? data.exam.student_name ?? DELETED_STUDENT)
    : undefined;

  return (
    <Stack gap="md">
      <ExamNav eventId={eventId} studentId={studentId} studentName={studentName} />
      {content}
    </Stack>
  );
}
