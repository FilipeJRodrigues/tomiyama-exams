/**
 * § 6.4 / § 6.7 (RN006, RN008, RN010), card #49 step 3: cases the qa-frontend added.
 *
 * - The screen removes its document listeners (last item acted on) when it leaves.
 * - Safari does not focus a tapped button: a tap still counts as the item acted on, so the
 *   own 409 "Exame já decidido" scrolls to the title and another item's does not.
 * - Click events with `timeStamp` 0 do not block a later click (React falls back to
 *   `Date.now()`).
 * - The space kept after a tap on the notice goes with the student (Anterior/Próximo).
 * - A newer notice without "Tentar de novo" gives the focus to its "Fechar aviso".
 * - The decision dialog gives the focus back to the same choice after the layout changes in
 *   the directions not covered by `ExamDecisionLayoutFocus.test.tsx`.
 *
 * Helena (open event, exam in progress): Parar and Nome do fundador do Judô não marcados.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { examPath } from '../../../src/app/navigation';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { mediaMatches, setViewportWidth } from '../../viewport';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const FABIO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e06';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const FOUNDER = mockRequirementId('Marrom', 7);
const FOUNDER_NAME = 'Nome do fundador do Judô';
const FORBIDDEN = 'Esta área é dos examinadores';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

/** How the API answers the next mark of an item; `gate` waits for `openGate()`, then 403. */
type Outcome = 'forbidden' | 'busy' | 'gate';

let db: MockDb;
let outcomes: Record<string, Outcome[]> = {};
let gates: (() => void)[] = [];

function openGate() {
  const gate = gates.shift();
  if (gate === undefined) throw new Error('Nenhuma marcação está esperando.');
  gate();
}

async function answer(outcome: Outcome | undefined): Promise<Response | undefined> {
  if (outcome === undefined) return undefined;
  if (outcome === 'gate') {
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    return answer('forbidden');
  }
  const [status, message] = outcome === 'busy' ? [503, BUSY] : [403, FORBIDDEN];
  return HttpResponse.json({ message }, { status });
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
  db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
  outcomes = {};
  gates = [];
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.put(ANSWER_URL, ({ params }) => answer(outcomes[String(params.requirementId)]?.shift())),
  );
}

function decideHelena() {
  Object.assign(
    db.exams.find((exam) => exam.student_id === HELENA)!,
    {
      status: 'APPROVED',
      decided_by_id: 'mock-examiner',
      decided_at: '2026-11-21T12:00:00+00:00',
    },
  );
}

async function openHelena() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  const title = await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return { ...rendered, title };
}

/** The title put above the viewport, with a spy on its `focus`. */
function scrolledAway(title: HTMLElement) {
  vi.spyOn(title, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 0, y: -600, width: 600, height: 40 }),
  );
  return vi.spyOn(title, 'focus');
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

function noticeSpace() {
  return document.querySelector<HTMLElement>('[data-notice-space]');
}

describe('exam screen, step 3 (qa, § 6.4, § 6.7, RN006, RN010, #49)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rn010 removes its focusin/click listeners of the document when it leaves', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = await openHelena();
    const added = add.mock.calls.filter(([type]) => type === 'focusin' || type === 'click');
    expect(added.length).toBeGreaterThan(0);

    unmount();

    for (const [type, listener, options] of added) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      expect(
        remove.mock.calls.some(
          ([removedType, removed, removedOptions]) =>
            removedType === type &&
            removed === listener &&
            (typeof removedOptions === 'boolean'
              ? removedOptions
              : Boolean(removedOptions?.capture)) === capture,
        ),
      ).toBe(true);
    }
  });

  it('rn010 a tap that does not focus the button (Safari) still scrolls to the title after its own 409', async () => {
    const { title } = await openHelena();
    const focus = scrolledAway(title);
    decideHelena();

    fireEvent.click(button('Certo: Parar'), { detail: 1 });
    expect(document.activeElement).toBe(document.body);

    expect(await screen.findByRole('alert')).toHaveTextContent('Exame já decidido');
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });
  });

  it('rn010 a tap without focus on another item (Safari) keeps the page where it is', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.put(ANSWER_URL, async ({ params }) => {
        if (String(params.requirementId) === PARAR) await held;
        return undefined;
      }),
    );
    const { title } = await openHelena();
    const focus = scrolledAway(title);
    fireEvent.click(button('Certo: Parar'), { detail: 1 });
    fireEvent.click(button(`Certo: ${FOUNDER_NAME}`), { detail: 1 });
    await waitFor(() => {
      expect(button(`Certo: ${FOUNDER_NAME}`)).toHaveAttribute('aria-pressed', 'true');
    });
    decideHelena();
    release();

    expect(await screen.findByRole('alert')).toHaveTextContent('Exame já decidido');
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it('rn006 clicks whose events say timeStamp 0 are not taken as a double tap when far apart', async () => {
    const writes: string[] = [];
    server.use(
      http.put(ANSWER_URL, () => {
        writes.push('PUT');
        return undefined;
      }),
      http.delete(ANSWER_URL, () => {
        writes.push('DELETE');
        return undefined;
      }),
    );
    await openHelena();
    const certo = button('Certo: Parar');
    const tapAtZero = () => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(event, 'timeStamp', { value: 0 });
      act(() => {
        certo.dispatchEvent(event);
      });
    };

    tapAtZero();
    await waitFor(() => {
      expect(writes).toEqual(['PUT']);
    });
    vi.setSystemTime(Date.now() + 2_000);
    tapAtZero();

    await waitFor(() => {
      expect(writes).toEqual(['PUT', 'DELETE']);
    });
  });

  it('rn006 the space kept after a tap goes away with the student', async () => {
    db.exams.push({
      ...db.exams.find((exam) => exam.student_id === HELENA)!,
      id: '6f2c8d1e-4b3a-4c5d-9e6f-0201f2a3b4c9',
      student_id: FABIO,
    });
    outcomes[PARAR] = ['forbidden'];
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Fechar aviso' }), { detail: 1 });
    expect(noticeSpace()).not.toBeNull();

    await user.click(await screen.findByRole('link', { name: 'Anterior: Fábio Lima' }));

    await screen.findByRole('heading', { level: 1, name: 'Fábio Lima' });
    expect(noticeSpace()).toBeNull();
  });

  it('rn006 a newer notice without "Tentar de novo" takes the focus on "Fechar aviso"', async () => {
    outcomes[FOUNDER] = ['gate'];
    outcomes[PARAR] = ['busy', 'busy', 'busy'];
    const { user } = await openHelena();
    await user.click(button(`Certo: ${FOUNDER_NAME}`));
    await waitFor(() => {
      expect(gates).toHaveLength(1);
    });
    await user.click(button('Certo: Parar'));
    const first = await screen.findByRole('alert', {}, { timeout: 5000 });
    act(() => {
      within(first).getByRole('button', { name: 'Tentar de novo: Parar' }).focus();
    });

    act(() => {
      openGate();
    });

    let second: HTMLElement | undefined;
    await waitFor(() => {
      const current = screen.getByRole('alert');
      expect(current).not.toBe(first);
      second = current;
    });
    expect(within(second!).getByRole('button', { name: 'Fechar aviso' })).toHaveFocus();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('decision dialog and a change of layout, other directions (qa, § 6.7, RN008, #49)', () => {
  type Listener = (event: { matches: boolean; media: string }) => void;
  let listeners: { query: string; listener: Listener }[] = [];
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
    listeners = [];
    window.matchMedia = ((query: string) => ({
      matches: mediaMatches(query),
      media: query,
      onchange: null,
      addListener: (listener: Listener) => {
        listeners.push({ query, listener });
      },
      removeListener: () => undefined,
      addEventListener: (_type: string, listener: Listener) => {
        listeners.push({ query, listener });
      },
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    vi.useRealTimers();
  });

  function resizeTo(width: number) {
    setViewportWidth(width);
    act(() => {
      for (const { query, listener } of listeners) {
        listener({ matches: mediaMatches(query), media: query });
      }
    });
  }

  function decisionArea(layout: 'column' | 'bar'): HTMLElement {
    const area = document.querySelector<HTMLElement>(`[data-decision-area="${layout}"]`);
    if (area === null) throw new Error(`A área de decisão "${layout}" deveria estar na tela.`);
    return area;
  }

  it('rn008 opened in the phone panel, turned into the column: Esc gives the focus to the same button', async () => {
    setViewportWidth(390);
    const { user } = await openHelena();
    await user.click(await within(decisionArea('bar')).findByRole('button', { name: 'Decidir' }));
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    await user.click(within(panel).getByRole('button', { name: 'Reprovar' }));
    await screen.findByRole('dialog', { name: 'Reprovar exame' });

    resizeTo(1280);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Decidir o exame' })).not.toBeInTheDocument();
    });
    await user.keyboard('{Escape}');

    const same = within(decisionArea('column')).getByRole('button', { name: 'Reprovar' });
    await waitFor(() => {
      expect(same).toHaveFocus();
    });
  });

  it('rn008 opened in the column, turned into the phone bar: Cancelar gives the focus to "Decidir"', async () => {
    setViewportWidth(1280);
    const { user } = await openHelena();
    await user.click(
      await within(decisionArea('column')).findByRole('button', { name: 'Aprovar' }),
    );
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });

    resizeTo(390);
    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));

    const decide = within(decisionArea('bar')).getByRole('button', { name: 'Decidir' });
    await waitFor(() => {
      expect(decide).toHaveFocus();
    });
  });

  it('rn008 turned to the bar and back to the column: Esc gives the focus to the new column', async () => {
    setViewportWidth(1280);
    const { user } = await openHelena();
    await user.click(
      await within(decisionArea('column')).findByRole('button', { name: 'Reprovar' }),
    );
    await screen.findByRole('dialog', { name: 'Reprovar exame' });

    resizeTo(390);
    resizeTo(1280);
    await user.keyboard('{Escape}');

    const same = within(decisionArea('column')).getByRole('button', { name: 'Reprovar' });
    await waitFor(() => {
      expect(same).toHaveFocus();
    });
  });
});
