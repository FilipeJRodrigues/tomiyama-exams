/**
 * State of the sensei decision of one exam (§ 6.4, RN008, RN010), shared by the summary
 * (column, bar, phone panel) and the confirmation dialog. See `ExamDecision.tsx`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { errorMessage } from '../../api/client';
import { isAlreadyDecided, useDecideExam } from '../../api/queries';
import type { DecisionResult } from '../../api/types';
import { decisionAnnouncement } from './decisionModel';
import { focusIfLost } from './focus';

/** Where the decision area is drawn: notebook column, phone bar, or the phone panel. */
export type DecisionLayout = 'column' | 'bar' | 'panel';

/** The layout of the summary on the screen: column (notebook) or bar (phone, tablet). */
export type SummaryLayout = Exclude<DecisionLayout, 'panel'>;

const DECISION_LAYOUTS: readonly string[] = ['column', 'bar', 'panel'] satisfies DecisionLayout[];

function isDecisionLayout(value: string | null | undefined): value is DecisionLayout {
  return value != null && DECISION_LAYOUTS.includes(value);
}

/** The decision area (and its layout) holding an element, if any. */
function decisionLayoutOf(target: EventTarget | null): DecisionLayout | null {
  if (!(target instanceof Element)) return null;
  const layout = target.closest('[data-decision-area]')?.getAttribute('data-decision-area');
  return isDecisionLayout(layout) ? layout : null;
}

type AreaRefs = Record<DecisionLayout, (element: HTMLElement | null) => void>;

export interface DecisionFlow {
  /** The result being confirmed (dialog open), or null. */
  asking: DecisionResult | null;
  ask: (result: DecisionResult) => void;
  /** Close the dialog; ignored while the decision is on its way. */
  cancel: () => void;
  confirm: (notes: string) => void;
  sending: boolean;
  /** Refusal shown in the dialog. */
  error: unknown;
  /** Message shown in the decision area once the dialog closed ("Exame já decidido"). */
  notice: string | null;
  /**
   * Close the notice of one layout. The focus, if it was in the notice (whose close button is
   * going away), goes to "Decidido por …" or to the decision area, else to the title.
   */
  dismissNotice: (layout: DecisionLayout, notice: HTMLElement | null) => void;
  /** Live region text (§ 6.7). */
  announcement: string;
  /** "Decidido por …" may take the focus when it shows (only if the focus is lost). */
  focusDecided: boolean;
  /** "Decidido por …" showed: it takes the focus if the focus is lost, once. */
  takeDecidedFocus: (decided: HTMLElement | null) => void;
  /** Phone: the panel opened by "Decidir". */
  panelOpened: boolean;
  openPanel: () => void;
  closePanel: () => void;
  /** Ref of the decision area of each layout: where the focus goes when its opener is gone. */
  areaRef: AreaRefs;
  /** The dialog finished closing: give the focus back (§ 6.7). */
  dialogClosed: () => void;
  /** The phone panel finished closing: give the focus back (§ 6.7). */
  panelClosed: () => void;
  /**
   * The summary changed layout (the window crossed 1024 px): the phone panel closes, and a
   * focus that was in the decision area of the layout that left (and went with it) goes to
   * the decision area of the new one (§ 6.7). Call it after the new layout is on the screen.
   */
  layoutChanged: (layout: SummaryLayout) => void;
}

/**
 * State of the decision of one exam; mount it once per exam (keyed by the exam).
 *
 * The dialog and the panel give the focus back themselves (§ 6.7): to the button that opened
 * them or, when a refusal swapped Aprovar/Reprovar (or "Decidir") for "A decisão é do sensei …"
 * or "Sem sensei definido", to the decision area, and else to the exam title (`titleRef`).
 */
export function useDecisionFlow(
  eventId: string,
  studentId: string,
  titleRef?: RefObject<HTMLElement | null>,
): DecisionFlow {
  const decide = useDecideExam(eventId, studentId);
  const [asking, setAsking] = useState<DecisionResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusDecided, setFocusDecided] = useState(false);
  const [panelOpened, setPanelOpened] = useState(false);
  // Also covers a second click that arrives before the next render.
  const busy = useRef(false);
  // What had the focus when the dialog or the panel was closed by the decision: going away.
  const leaving = useRef<Element | null>(null);
  const takeDecidedFocus = useCallback((decided: HTMLElement | null) => {
    focusIfLost(decided, { leaving: [leaving.current] });
    leaving.current = null;
    setFocusDecided(false);
  }, []);
  const dialogOpener = useRef<Element | null>(null);
  const panelOpener = useRef<Element | null>(null);
  const areas = useRef<Partial<Record<DecisionLayout, HTMLElement | null>>>({});
  // The last element focused in a decision area, to follow it when the layout changes.
  const lastFocus = useRef<{ element: Element; layout: DecisionLayout } | null>(null);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const layout = decisionLayoutOf(event.target);
      lastFocus.current =
        layout !== null && event.target instanceof Element
          ? { element: event.target, layout }
          : null;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);
  const layoutChanged = useCallback(
    (layout: SummaryLayout) => {
      // The panel belongs to the phone bar: it does not come back on its own with the bar.
      if (layout === 'column') setPanelOpened(false);
      const last = lastFocus.current;
      if (last === null || last.layout === layout || last.element.isConnected) return;
      lastFocus.current = null;
      const area = areas.current[layout];
      focusIfLost([
        area?.querySelector('[data-decision-action]'),
        area?.querySelector('[data-slot="decision"]'),
        area,
        titleRef?.current,
      ]);
    },
    [titleRef],
  );
  const areaRef = useMemo<AreaRefs>(
    () => ({
      column: (element) => {
        areas.current.column = element;
      },
      bar: (element) => {
        areas.current.bar = element;
      },
      panel: (element) => {
        areas.current.panel = element;
      },
    }),
    [],
  );

  /**
   * After the closing renders: the opener, else the first decision area shown, else the
   * title. A focus that went elsewhere on its own ("Decidido por …", a click) stays.
   */
  const giveFocusBack = (opener: Element | null, layouts: DecisionLayout[]) => {
    window.setTimeout(() => {
      const areaTargets = layouts.map((layout) => areas.current[layout]);
      focusIfLost([opener, ...areaTargets, titleRef?.current]);
    }, 0);
  };

  const finish = () => {
    busy.current = false;
    // The dialog (or what has the focus) goes away with the decision.
    const active = document.activeElement;
    leaving.current =
      active === null || active === document.body
        ? null
        : (active.closest('[role="dialog"]') ?? active);
    setAsking(null);
    setPanelOpened(false);
    setFocusDecided(true);
  };

  return {
    asking,
    ask: (result) => {
      if (busy.current) return;
      decide.reset();
      setNotice(null);
      dialogOpener.current = document.activeElement;
      setAsking(result);
    },
    cancel: () => {
      if (busy.current) return;
      setAsking(null);
      decide.reset();
    },
    confirm: (notes) => {
      if (busy.current || asking === null) return;
      busy.current = true;
      decide.mutate(
        { result: asking, notes: notes.trim() || null },
        {
          onSuccess: ({ exam }) => {
            setAnnouncement(decisionAnnouncement(exam.status));
            finish();
          },
          onError: (error) => {
            if (isAlreadyDecided(error)) {
              setNotice(errorMessage(error));
              decide.reset();
              finish();
              return;
            }
            busy.current = false;
          },
        },
      );
    },
    sending: decide.isPending,
    error: decide.error,
    notice,
    dismissNotice: (layout, shown) => {
      const area = areas.current[layout];
      focusIfLost([area?.querySelector('[data-slot="decision"]'), area, titleRef?.current], {
        leaving: [shown],
      });
      setNotice(null);
    },
    announcement,
    focusDecided,
    takeDecidedFocus,
    panelOpened,
    openPanel: () => {
      panelOpener.current = document.activeElement;
      setPanelOpened(true);
    },
    closePanel: () => {
      if (asking === null) setPanelOpened(false);
    },
    areaRef,
    dialogClosed: () => {
      giveFocusBack(dialogOpener.current, panelOpened ? ['panel'] : ['column', 'bar']);
      dialogOpener.current = null;
    },
    panelClosed: () => {
      giveFocusBack(panelOpener.current, ['bar']);
      panelOpener.current = null;
    },
    layoutChanged,
  };
}
