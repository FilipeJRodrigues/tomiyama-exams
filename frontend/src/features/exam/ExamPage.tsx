import { Alert, Box, Button, Stack, Text, Title, VisuallyHidden } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconAlertCircle, IconArrowLeft, IconLock, IconUserOff } from '@tabler/icons-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useParams } from 'react-router';

import { ApiError } from '../../api/client';
import { useBelts, useExamSheet, useExaminers } from '../../api/queries';
import type { ExamSheet, ExamSheetItem, RequirementKind } from '../../api/types';
import { EXAM_SIDE_SUMMARY_QUERY } from '../../app/breakpoints';
import { LoadError, LoadingState } from '../students/screenStates';
import { DecisionDialog } from './ExamDecision';
import { ExamHeader, ExamNav } from './ExamHeader';
import { ExamItems, MarkButtons, MarkText, type RenderMark } from './ExamItems';
import { SummaryBar, SummaryColumn } from './ExamSummary';
import {
  DELETED_STUDENT,
  canMark,
  examDayPath,
  markState,
  withPendingMarks,
  type MarkState,
} from './examModel';
import { focusIfLost, useScrollPadding } from './focus';
import { useDecisionFlow, type DecisionFlow, type SummaryLayout } from './useDecisionFlow';
import { useExamMarking, type MarkFailure } from './useExamMarking';

const MSG_EVENT_NOT_FOUND = 'Evento não encontrado';

const NOTHING_KEPT: ReadonlySet<string> = new Set();

/** Decided exam or closed event: every item read-only (§ 6.4). */
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

interface MarkFailureNoticeProps {
  failure: MarkFailure;
  onClose: () => void;
  /**
   * Where the focus goes when it was in the notice (its close button goes away, § 6.7) and
   * the item the notice names is no longer on the screen (another tab, the filter).
   */
  focusTarget: RefObject<HTMLElement | null>;
}

/**
 * The Certo/Errado button of an item on the screen: the pressed one, else the first. The
 * examiner keeps the place in the list when the notice about that item closes.
 */
function markButtonOf(itemId: string): HTMLElement | null {
  const item = Array.from(document.querySelectorAll<HTMLElement>('[data-item]')).find(
    (element) => element.dataset.item === itemId,
  );
  if (item === undefined) return null;
  return (
    item.querySelector<HTMLElement>('button[data-choice][aria-pressed="true"]') ??
    item.querySelector<HTMLElement>('button[data-choice]')
  );
}

/**
 * A refused mark (§ 6.4: "em erro, volta e avisa"), with the API message. Sticky at the top
 * of the items, so it is seen wherever the examiner is in the list.
 */
function MarkFailureNotice({ failure, onClose, focusTarget }: MarkFailureNoticeProps) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <Alert
      color="red"
      variant="light"
      role="alert"
      icon={<IconAlertCircle aria-hidden />}
      title={`Não foi possível salvar a marcação de "${failure.item}"`}
      withCloseButton
      closeButtonLabel="Fechar aviso"
      onClose={() => {
        focusIfLost([markButtonOf(failure.itemId), focusTarget.current], {
          leaving: [ref.current],
        });
        onClose();
      }}
      ref={ref}
      style={{
        position: 'sticky',
        top: 'calc(var(--app-shell-header-offset, 60px) + var(--mantine-spacing-xs))',
        zIndex: 2,
      }}
    >
      {failure.message}
    </Alert>
  );
}

/**
 * When the exam turns read-only while shown (409 "Exame já decidido", 400 "Evento encerrado"),
 * the Certo/Errado button that had the focus is gone and the focus falls on the page body.
 * Then it goes to the exam title (§ 6.7), not to the notice: the notice is an alert, already
 * announced, and focusing it would make the screen reader read it twice. A focus elsewhere
 * (the trail, Próximo) is left alone.
 */
function useReadOnlyFocus(readOnly: boolean) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const wasReadOnly = useRef(readOnly);
  useEffect(() => {
    const turned = readOnly && !wasReadOnly.current;
    wasReadOnly.current = readOnly;
    if (!turned) return;
    focusIfLost(titleRef.current);
  }, [readOnly]);
  return titleRef;
}

/** Clear of the fixed header when the focus scrolls a target into view (§ 6.7). */
const HEADER_SCROLL_PADDING =
  'calc(var(--app-shell-header-offset, 60px) + var(--mantine-spacing-xs))';

/**
 * The summary is a column from 1024 px and a bar below (§ 6.4). Crossing that width (turning
 * the tablet, 200% zoom) swaps only the summary: the items stay mounted, so a focused
 * Certo/Errado keeps the focus, and a focus in the decision area that left goes to the
 * decision area of the new layout, never to the page (§ 6.7).
 */
function useSummaryLayout(flow: DecisionFlow): SummaryLayout {
  const sideSummary = useMediaQuery(EXAM_SIDE_SUMMARY_QUERY, true, {
    getInitialValueInEffect: false,
  });
  const layout: SummaryLayout = sideSummary ? 'column' : 'bar';
  const shown = useRef(layout);
  const { layoutChanged } = flow;
  useLayoutEffect(() => {
    if (shown.current === layout) return;
    shown.current = layout;
    layoutChanged(layout);
  }, [layout, layoutChanged]);
  return layout;
}

interface ExamContentProps {
  sheet: ExamSheet;
  kind: RequirementKind;
  onKindChange: (kind: RequirementKind) => void;
  onlyUnmarked: boolean;
  onOnlyUnmarkedChange: (value: boolean) => void;
  keep: ReadonlySet<string>;
  /** Certo/Errado; undefined while the exam is read-only. */
  onMark: ((item: ExamSheetItem, state: MarkState) => void) | undefined;
  /** No mark on its way. */
  settled: boolean;
  failure: MarkFailure | null;
  onDismissFailure: () => void;
}

function ExamContent({
  sheet,
  onMark,
  settled,
  failure,
  onDismissFailure,
  ...itemProps
}: ExamContentProps) {
  const belts = useBelts();
  const examiners = useExaminers();
  const titleRef = useReadOnlyFocus(onMark === undefined);
  const flow = useDecisionFlow(sheet.exam.event_id, sheet.exam.student_id, titleRef);
  const layout = useSummaryLayout(flow);
  useScrollPadding('top', HEADER_SCROLL_PADDING);
  const summaryProps = {
    summary: sheet.summary,
    exam: sheet.exam,
    examiners: examiners.data,
    flow,
    settled,
    studentDeleted: sheet.student === null,
  };
  const decision = (
    <>
      <DecisionDialog flow={flow} sheet={sheet} belts={belts.data} settled={settled} />
      <VisuallyHidden role="status" aria-live="polite" data-testid="decision-live">
        {flow.announcement}
      </VisuallyHidden>
    </>
  );
  const renderMark: RenderMark = onMark
    ? (item) => <MarkButtons item={item} onMark={onMark} />
    : renderReadOnlyMark;

  const main = (
    <Stack gap="md">
      <ExamHeader sheet={sheet} belts={belts.data} titleRef={titleRef} />
      <Notices sheet={sheet} />
      {failure && (
        <MarkFailureNotice failure={failure} onClose={onDismissFailure} focusTarget={titleRef} />
      )}
      <ExamItems
        items={sheet.items}
        summary={sheet.summary}
        renderMark={renderMark}
        {...itemProps}
      />
    </Stack>
  );

  const side = layout === 'column';
  // One container for both layouts: `main` keeps its place in the tree and is not remounted.
  return (
    <Box
      style={
        side
          ? { display: 'flex', alignItems: 'flex-start', gap: 'var(--mantine-spacing-lg)' }
          : undefined
      }
    >
      <Box miw={0} style={side ? { flex: 1 } : undefined}>
        {main}
      </Box>
      {side ? <SummaryColumn {...summaryProps} /> : <SummaryBar {...summaryProps} />}
      {decision}
    </Box>
  );
}

/**
 * § 6.4 a student's exam, examiners only. Header with the way back to the exam day and the
 * previous/next present student, the items by kind and category with Certo/Errado saved at
 * once (RN006; read-only once decided or with the event closed, RN010/RN016), and the RN007
 * summary. The exam reloads when the window gets the focus back, except while a mark is on
 * its way (it reloads right after).
 */
export function ExamPage() {
  const { eventId = '', studentId = '' } = useParams();
  const marking = useExamMarking(eventId, studentId);
  const sheet = useExamSheet(eventId, studentId, {
    canReloadOnFocus: marking.canReloadOnFocus,
  });
  // Kept while moving to the previous/next student.
  const [kind, setKind] = useState<RequirementKind>('THEORY');
  const [onlyUnmarked, setOnlyUnmarked] = useState(false);
  // Items marked on this exam since the tab or the filter last changed: under "Só não
  // marcados" they stay where they are instead of vanishing under the finger.
  const examKey = `${eventId}/${studentId}`;
  const [kept, setKept] = useState<{ examKey: string; ids: ReadonlySet<string> }>({
    examKey,
    ids: NOTHING_KEPT,
  });
  const keep = kept.examKey === examKey ? kept.ids : NOTHING_KEPT;
  const forgetKept = () => {
    setKept({ examKey, ids: NOTHING_KEPT });
  };

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
    const markable = canMark(data.exam, data.event);
    const onMark = (item: ExamSheetItem, state: MarkState) => {
      setKept((current) => ({
        examKey,
        ids: new Set([...(current.examKey === examKey ? current.ids : []), item.id]),
      }));
      marking.mark(item, state);
    };
    content = (
      <ExamContent
        // One decision state per exam: nothing carries over to the previous/next student.
        key={examKey}
        sheet={markable ? withPendingMarks(data, marking.pending) : data}
        kind={kind}
        onKindChange={(value) => {
          setKind(value);
          forgetKept();
        }}
        onlyUnmarked={onlyUnmarked}
        onOnlyUnmarkedChange={(value) => {
          setOnlyUnmarked(value);
          forgetKept();
        }}
        keep={keep}
        onMark={markable ? onMark : undefined}
        settled={!marking.busy}
        failure={marking.failure}
        onDismissFailure={marking.dismissFailure}
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
