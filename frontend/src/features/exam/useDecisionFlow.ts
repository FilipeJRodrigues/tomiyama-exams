/**
 * State of the sensei decision of one exam (§ 6.4, RN008, RN010), shared by the summary
 * (column, bar, phone panel) and the confirmation dialog. See `ExamDecision.tsx`.
 */
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';

import { errorMessage } from '../../api/client';
import { isAlreadyDecided, useDecideExam } from '../../api/queries';
import type { DecisionResult } from '../../api/types';
import { decisionAnnouncement } from './decisionModel';

/** Where the decision area is drawn: notebook column, phone bar, or the phone panel. */
export type DecisionLayout = 'column' | 'bar' | 'panel';

type AreaRefs = Record<DecisionLayout, (element: HTMLElement | null) => void>;

/** The focus fell on the page (the element that had it is gone). */
function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

function focusable(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && element !== document.body;
}

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
  dismissNotice: () => void;
  /** Live region text (§ 6.7). */
  announcement: string;
  /** "Decidido por …" should take the focus when it shows. */
  focusDecided: boolean;
  decidedFocused: () => void;
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
  const decidedFocused = useCallback(() => {
    setFocusDecided(false);
  }, []);
  const dialogOpener = useRef<Element | null>(null);
  const panelOpener = useRef<Element | null>(null);
  const areas = useRef<Partial<Record<DecisionLayout, HTMLElement | null>>>({});
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

  /** After the closing renders: the opener, else the first decision area shown, else the title. */
  const giveFocusBack = (opener: Element | null, layouts: DecisionLayout[]) => {
    window.setTimeout(() => {
      // The focus went elsewhere on its own ("Decidido por …", a click): leave it.
      if (!focusLost()) return;
      const area = layouts.map((layout) => areas.current[layout] ?? null).find(focusable);
      const target = [opener, area ?? null, titleRef?.current ?? null].find(focusable);
      target?.focus({ preventScroll: opener === target });
    }, 0);
  };

  const finish = () => {
    busy.current = false;
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
    dismissNotice: () => {
      setNotice(null);
    },
    announcement,
    focusDecided,
    decidedFocused,
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
  };
}
