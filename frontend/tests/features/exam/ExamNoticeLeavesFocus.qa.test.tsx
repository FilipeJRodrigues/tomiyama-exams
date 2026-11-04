/**
 * § 6.4 / § 6.7 (RN006, RN010), card #49 step 3: where the focus goes when the refusal notice
 * leaves the page by itself with the focus inside (cases the qa-frontend added).
 *
 * - Under "Só não marcados", the saved item is kept on the screen and takes the focus.
 * - With the item of the notice on another tab, the focus goes to the exam title.
 * - The notice stays and only its "Tentar de novo" goes away when a reload turns the exam
 *   read-only: the title takes the focus without moving the page (`useReadOnlyFocus`).
 *
 * Helena (open event, exam in progress): Parar (Teórico) não marcado.
 */
import { focusManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const FORBIDDEN = 'Esta área é dos examinadores';

/** How the API answers the next mark of an item; `gate…` waits for `openGate()` first. */
type Outcome = 'busy' | 'forbidden' | 'gate' | 'gateForbidden';

let db: MockDb;
let outcomes: Record<string, Outcome[]> = {};
let gates: (() => void)[] = [];

function openGate() {
  const gate = gates.shift();
  if (gate === undefined) throw new Error('Nenhuma marcação está esperando.');
  gate();
}

async function answer(outcome: Outcome | undefined): Promise<Response | undefined> {
  if (outcome === 'gate' || outcome === 'gateForbidden') {
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    return answer(outcome === 'gate' ? undefined : 'forbidden');
  }
  if (outcome === undefined) return undefined;
  const [status, message] = outcome === 'busy' ? [503, BUSY] : [403, FORBIDDEN];
  return HttpResponse.json({ message }, { status });
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
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

function button(name: string) {
  return screen.getByRole('button', { name });
}

describe('focus of a notice that leaves by itself (qa, § 6.4, § 6.7, RN006, #49)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    focusManager.setFocused(undefined);
  });

  it('rn006 under "Só não marcados" the saved item takes the focus of its notice', async () => {
    outcomes[PARAR] = ['forbidden', 'gate'];
    const { user } = await openHelena();
    await user.click(screen.getByRole('switch', { name: 'Só não marcados' }));
    await user.click(button('Certo: Parar'));
    const alert = await screen.findByRole('alert');
    await user.click(button('Errado: Parar'));
    await waitFor(() => {
      expect(gates).toHaveLength(1);
    });
    act(() => {
      within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
    });

    act(() => {
      openGate();
    });

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    await waitFor(() => {
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(button('Errado: Parar')).toHaveFocus();
  });

  it('rn006 the notice leaves by itself with its item on another tab: the focus goes to the title', async () => {
    outcomes[PARAR] = ['forbidden', 'gate'];
    const { user, title } = await openHelena();
    await user.click(button('Certo: Parar'));
    const alert = await screen.findByRole('alert');
    // Taps that do not move the focus (Safari): the examiner then goes back to the notice.
    fireEvent.click(button('Errado: Parar'), { detail: 1 });
    await waitFor(() => {
      expect(gates).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole('tab', { name: /Prático/ }), { detail: 1 });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Errado: Parar' })).toBeNull();
    });
    act(() => {
      within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
    });
    vi.spyOn(title, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: -600, width: 600, height: 40 }),
    );

    act(() => {
      openGate();
    });

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(title).toHaveFocus();
  });

  it('rn010 "Tentar de novo" gone with a reload to read-only: the title, without scrolling', async () => {
    outcomes[PARAR] = ['busy', 'busy', 'busy'];
    const { user, title } = await openHelena();
    await user.click(button('Certo: Parar'));
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    act(() => {
      within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }).focus();
    });
    vi.spyOn(title, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: -600, width: 600, height: 40 }),
    );
    const focus = vi.spyOn(title, 'focus');
    decideHelena();
    vi.setSystemTime(Date.now() + 120_000);

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Certo: Parar' })).toBeNull();
    });
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
    expect(screen.getByRole('alert')).toBe(alert);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });
});
