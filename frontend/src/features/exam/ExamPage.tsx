import { Alert, Box, Button, Stack, Text, Title, VisuallyHidden } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconArrowLeft,
  IconLock,
  IconRefresh,
  IconUserOff,
} from '@tabler/icons-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { Link, useParams } from 'react-router';

import { ApiError } from '../../api/client';
import { useBelts, useExamSheet, useExaminers } from '../../api/queries';
import type { ExamSheet, ExamSheetItem, RequirementKind } from '../../api/types';
import { EXAM_SIDE_SUMMARY_QUERY } from '../../app/breakpoints';
import { LoadError, LoadingState } from '../students/screenStates';
import { useRetryFocus } from '../students/useRetryFocus';
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
import { HEADER_SCROLL_PADDING, focusIfLost, focusIsLost, useScrollPadding } from './focus';
import { DOUBLE_TAP_MS, useMarkClickGuard } from './markClickGuard';
import { TOUCH_TARGET } from './touch';
import { useDecisionFlow, type DecisionFlow, type SummaryLayout } from './useDecisionFlow';
import { useExamMarking, type MarkFailure } from './useExamMarking';

const MSG_EVENT_NOT_FOUND = 'Evento não encontrado';

const NOTHING_KEPT: ReadonlySet<string> = new Set();

/** Decided exam or closed event: every item read-only (§ 6.4). */
const renderReadOnlyMark: RenderMark = (item) => <MarkText state={markState(item)} />;

/**
 * The page title (`h1`) of each state of the screen shares the screen's `titleRef`: the focus
 * goes to the one on the screen (§ 6.7).
 */
interface TitleRefProps {
  titleRef: Ref<HTMLHeadingElement>;
}

/** Title while there is no exam to name the page after. */
function PageTitle({ titleRef }: TitleRefProps) {
  return (
    <Title order={1} size="h2" ref={titleRef} tabIndex={-1}>
      Exame do aluno
    </Title>
  );
}

/** 404 of the exam or of the event, with the API message and a way back to the exam day. */
function NotFound({
  error,
  eventId,
  titleRef,
}: { error: ApiError; eventId: string } & TitleRefProps) {
  const eventMissing = error.message === MSG_EVENT_NOT_FOUND;
  return (
    <Stack gap="sm" align="flex-start">
      <Title order={1} size="h2" ref={titleRef} tabIndex={-1}>
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

/** Which button of the notice had the focus when it left the page. */
type NoticeControl = 'close' | 'retry';

/**
 * The focus a notice had when it left the page by itself (saved item, newer refusal, exam
 * turned read-only), kept by the exam screen for the commit that took it away: a newer
 * notice takes it on the same button; with none, the item of the notice takes it.
 */
interface CarriedNoticeFocus {
  control: NoticeControl;
  itemId: string;
}

/**
 * Where the refusal notice sits: stuck under the fixed header while the list scrolls, over
 * the items (Mantine buttons are `position: relative`). The space kept after a tap
 * (`NoticeSpace`) uses the same, so it covers the same place on the screen.
 */
const NOTICE_PLACE: CSSProperties = {
  position: 'sticky',
  top: 'calc(var(--app-shell-header-offset, 60px) + var(--mantine-spacing-xs))',
  zIndex: 2,
};

const CLOSE_NOTICE_LABEL = 'Fechar aviso';

interface MarkFailureNoticeProps {
  failure: MarkFailure;
  onClose: () => void;
  /** "Tentar de novo", after passing refusals (`failure.retry`) while the exam takes marks. */
  onRetry: (() => void) | undefined;
  /**
   * Where the focus goes when it was in the notice (its close button goes away, § 6.7) and
   * the item the notice names is no longer on the screen (another tab, the filter).
   */
  focusTarget: RefObject<HTMLElement | null>;
  /**
   * The focus of the notice that left in this render (see `CarriedNoticeFocus`): this one
   * takes it on the same button, and fills it when it leaves with the focus.
   */
  carriedRef: RefObject<CarriedNoticeFocus | null>;
  /**
   * A pointer tap took the notice away; `height` is the space it took, which the screen
   * keeps for a moment so the list does not move up under the finger.
   */
  onTappedAway: (height: number) => void;
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

/** Title of the notice: "not saved", or "not confirmed" when the API may have saved it. */
function failureTitle(failure: MarkFailure): string {
  return failure.outcomeUnknown
    ? `Não foi possível confirmar a marcação de "${failure.item}"`
    : `Não foi possível salvar a marcação de "${failure.item}"`;
}

/**
 * A refused mark (§ 6.4: "em erro, volta e avisa"), with the API message. Sticky at the top
 * of the items, so it is seen wherever the examiner is in the list. After passing refusals
 * (busy server, network) it offers "Tentar de novo", which sends the mark again.
 *
 * - Mounted once per refusal (`key={failure.id}`): an alert put on the page is read out, so
 *   a new refusal with the same text is heard again, and the same one never twice. When it
 *   replaces a notice that had the focus, it takes the focus on the same button: the focus
 *   is never lost, nor taken from elsewhere (§ 6.7).
 * - After network or 504 the mark may have been saved (`outcomeUnknown`); the exam reloads
 *   and the item may show it. The notice says the mark could not be confirmed and asks to
 *   check the item, so it never contradicts the screen. It stays until closed, like any
 *   other: telling a reload that shows the mark apart from an older state of the cache
 *   would cost more than the examiner's look at the item.
 * - A pointer tap on its buttons takes it away: the exam screen keeps its space for a
 *   moment (`useNoticeSpace`), so the second tap of a double tap does not land on whatever
 *   moved up under the finger (a Certo/Errado, a tab).
 */
function MarkFailureNotice({
  failure,
  onClose,
  onRetry,
  focusTarget,
  carriedRef,
  onTappedAway,
}: MarkFailureNoticeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  // The click being handled comes from a pointer (`detail` 0: the keyboard).
  const tapped = useRef(false);

  useLayoutEffect(() => {
    // Replacing a notice that had the focus: the same button of this one takes it.
    const control = carriedRef.current?.control ?? null;
    carriedRef.current = null;
    const notice = ref.current;
    if (control !== null && focusIsLost()) {
      const close = notice?.querySelector<HTMLElement>(
        `button[aria-label="${CLOSE_NOTICE_LABEL}"]`,
      );
      const target = (control === 'retry' ? retryRef.current : null) ?? close;
      target?.focus({ preventScroll: true });
    }
    const retry = retryRef.current;
    const itemId = failure.itemId;
    return () => {
      // Runs before the notice leaves the page: a newer one, else the screen, places the focus.
      const active = document.activeElement;
      if (notice === null || active === null || !notice.contains(active)) return;
      carriedRef.current = {
        control: retry !== null && active === retry ? 'retry' : 'close',
        itemId,
      };
    };
    // Once per refusal: the notice is keyed by it (so is its item), and the ref of the screen
    // never changes.
  }, [carriedRef, failure.itemId]);

  // The notice leaves with the focused button: the focus goes to the item, else the title.
  const leave = () => {
    focusIfLost([markButtonOf(failure.itemId), focusTarget.current], {
      leaving: [ref.current],
    });
    if (tapped.current) onTappedAway(ref.current?.getBoundingClientRect().height ?? 0);
  };
  const canRetry = onRetry !== undefined && failure.retry !== undefined;
  return (
    <Alert
      color="red"
      variant="light"
      role="alert"
      icon={<IconAlertCircle aria-hidden />}
      title={failureTitle(failure)}
      withCloseButton
      closeButtonLabel={CLOSE_NOTICE_LABEL}
      onClickCapture={(event: MouseEvent<HTMLDivElement>) => {
        tapped.current = event.detail > 0;
      }}
      onClose={() => {
        leave();
        onClose();
      }}
      ref={ref}
      style={NOTICE_PLACE}
    >
      <Stack gap="xs" align="flex-start">
        <Text inherit>{failure.message}</Text>
        {failure.outcomeUnknown && (
          <Text inherit>
            {canRetry
              ? 'Ela pode ter sido salva; confira o item ou toque em Tentar de novo.'
              : 'Ela pode ter sido salva; confira o item.'}
          </Text>
        )}
        {canRetry && (
          <Button
            ref={retryRef}
            variant="default"
            leftSection={<IconRefresh size={18} aria-hidden />}
            aria-label={`Tentar de novo: ${failure.item}`}
            onClick={() => {
              leave();
              onRetry();
            }}
            style={TOUCH_TARGET}
          >
            Tentar de novo
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

/** The item (`data-item`) of an element, or null outside the list. */
function itemOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-item]')?.dataset.item ?? null;
}

/**
 * The item the examiner last acted on: the last focus or click on the screen, null when it
 * was outside the list. Clicks count too, as Safari does not focus a clicked button.
 */
function useLastItemActedOn(): RefObject<string | null> {
  const last = useRef<string | null>(null);
  useEffect(() => {
    const onAct = (event: Event) => {
      last.current = itemOf(event.target);
    };
    document.addEventListener('focusin', onAct);
    document.addEventListener('click', onAct, true);
    return () => {
      document.removeEventListener('focusin', onAct);
      document.removeEventListener('click', onAct, true);
    };
  }, []);
  return last;
}

/**
 * When the exam turns read-only while shown (409 "Exame já decidido", 400 "Evento encerrado"),
 * the Certo/Errado button that had the focus is gone and the focus falls on the page body.
 * Then it goes to the exam title (§ 6.7), not to the notice: the notice is an alert, already
 * announced, and focusing it would make the screen reader read it twice. A focus elsewhere
 * (the trail, Próximo) is left alone.
 *
 * The page scrolls to the title only when the examiner's own mark turned the exam read-only
 * (the refusal is about the item last acted on): the title and the reason come into view.
 * Otherwise (reload on window focus, the refusal of another item while the examiner works
 * elsewhere in the list) the title takes the focus without moving the page.
 */
function useReadOnlyFocus(
  titleRef: RefObject<HTMLHeadingElement | null>,
  readOnly: boolean,
  failure: MarkFailure | null,
) {
  const wasReadOnly = useRef(readOnly);
  const lastItem = useLastItemActedOn();
  useEffect(() => {
    const turned = readOnly && !wasReadOnly.current;
    wasReadOnly.current = readOnly;
    if (!turned) return;
    const ownMark = failure !== null && failure.outdated && failure.itemId === lastItem.current;
    focusIfLost(titleRef.current, ownMark ? {} : { preventScroll: true });
  }, [titleRef, readOnly, failure, lastItem]);
}

/**
 * The space of the refusal notice after a pointer tap took it away ("Fechar aviso",
 * "Tentar de novo"), kept for `DOUBLE_TAP_MS`: the list stays where it was, and the second tap
 * of a double tap lands on the empty space instead of a Certo/Errado that moved up under the
 * finger (§ 6.4, RN006). A newer notice takes the place at once and for good: the kept space
 * is dropped, so it never comes back when that notice leaves (by the keyboard, say).
 */
function useNoticeSpace(
  noticeShown: boolean,
): [{ height: number } | null, (height: number) => void] {
  const [space, setSpace] = useState<{ height: number } | null>(null);
  // Adjusted while rendering, not in an effect: the space is never painted with the notice.
  if (noticeShown && space !== null) setSpace(null);
  useEffect(() => {
    if (space === null) return;
    const timer = window.setTimeout(() => {
      setSpace(null);
    }, DOUBLE_TAP_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [space]);
  const keep = useCallback((height: number) => {
    setSpace({ height });
  }, []);
  return [space, keep];
}

/**
 * The space of a notice taken away by a tap, on the same place of the screen as the notice
 * (`NOTICE_PLACE`), scrolled list or not. Being over the items, it takes the second tap of a
 * double tap itself: a transparent box still gets the pointer (`pointer-events` stays `auto`),
 * so no background is needed. No width of its own: it is as wide as the list, never more.
 */
function NoticeSpace({ height }: { height: number }) {
  return <div aria-hidden data-notice-space style={{ ...NOTICE_PLACE, height }} />;
}

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
  /** "Tentar de novo" of the notice; undefined while the exam is read-only. */
  onRetryFailure: (() => void) | undefined;
  /** The exam title (`h1`), the screen's: the other states of the screen use it too. */
  titleRef: RefObject<HTMLHeadingElement | null>;
}

function ExamContent({
  sheet,
  onMark,
  settled,
  failure,
  onDismissFailure,
  onRetryFailure,
  titleRef,
  ...itemProps
}: ExamContentProps) {
  const belts = useBelts();
  const examiners = useExaminers();
  useReadOnlyFocus(titleRef, onMark === undefined, failure);
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
  // Lives here, not in the buttons: they remount when the tab or the filter changes.
  const acceptClick = useMarkClickGuard();
  const [noticeSpace, keepNoticeSpace] = useNoticeSpace(failure !== null);
  // The focus of a notice that left in this render: a newer notice takes it (its layout
  // effect runs first); with none, it goes to the item of the notice, else the title, as
  // when the notice is closed (§ 6.7). Never left on the page body.
  const carriedNoticeFocus = useRef<CarriedNoticeFocus | null>(null);
  useLayoutEffect(() => {
    const carried = carriedNoticeFocus.current;
    carriedNoticeFocus.current = null;
    if (carried !== null) focusIfLost([markButtonOf(carried.itemId), titleRef.current]);
  });
  const renderMark: RenderMark = onMark
    ? (item) => <MarkButtons item={item} onMark={onMark} acceptClick={acceptClick} />
    : renderReadOnlyMark;

  const main = (
    <Stack gap="md">
      <ExamHeader sheet={sheet} belts={belts.data} titleRef={titleRef} />
      <Notices sheet={sheet} />
      {failure && (
        <MarkFailureNotice
          // One notice per refusal: a new one is read out again (§ 6.7).
          key={failure.id}
          failure={failure}
          onClose={onDismissFailure}
          onRetry={onRetryFailure}
          focusTarget={titleRef}
          carriedRef={carriedNoticeFocus}
          onTappedAway={keepNoticeSpace}
        />
      )}
      {!failure && noticeSpace !== null && <NoticeSpace height={noticeSpace.height} />}
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
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRetryFocus([sheet], titleRef);
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
        <NotFound error={error} eventId={eventId} titleRef={titleRef} />
      ) : (
        <>
          <PageTitle titleRef={titleRef} />
          <LoadError
            title="Não foi possível carregar o exame"
            error={error}
            retrying={sheet.isFetching}
            onRetry={() => void sheet.refetch()}
            retryFocus={retryFocus}
          />
        </>
      );
  } else if (data === undefined) {
    content = (
      <>
        <PageTitle titleRef={titleRef} />
        <LoadingState label="Carregando exame…" />
      </>
    );
  } else {
    const markable = canMark(data.exam, data.event);
    // Marked items stay in place under "Só não marcados" until the tab or the filter changes.
    const keepItem = (itemId: string) => {
      setKept((current) => ({
        examKey,
        ids: new Set([...(current.examKey === examKey ? current.ids : []), itemId]),
      }));
    };
    const onMark = (item: ExamSheetItem, state: MarkState) => {
      keepItem(item.id);
      marking.mark(item, state);
    };
    const failure = marking.failure;
    const onRetryFailure = () => {
      if (failure) keepItem(failure.itemId);
      marking.retryFailure();
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
        failure={failure}
        onDismissFailure={marking.dismissFailure}
        onRetryFailure={markable ? onRetryFailure : undefined}
        titleRef={titleRef}
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
