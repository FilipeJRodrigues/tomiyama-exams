/**
 * § 6.4 / § 6.7 (#49, step 3): when the exam turns read-only while shown and the focus was on
 * a Certo/Errado that went away, the focus goes to the exam title. The page scrolls up to it
 * only when the examiner's own mark caused it (409 "Exame já decidido" or 400 "Evento
 * encerrado" of the item last acted on): the reason comes into view. A reload on window focus
 * or the refusal of another item while the examiner works elsewhere in the list moves the
 * focus without moving the page (`focus({ preventScroll: true })`).
 *
 * jsdom has no layout: the title is put above the viewport (`getBoundingClientRect`), so
 * `focusIfLost` would scroll to it unless told not to.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const FOUNDER = 'Nome do fundador do Judô';

let db: MockDb;

function decideHelena() {
  Object.assign(
    db.exams.find((item) => item.student_id === HELENA)!,
    {
      status: 'APPROVED',
      decided_by_id: 'mock-examiner',
      decided_at: '2026-11-21T12:00:00+00:00',
    },
  );
}

function closeEvent() {
  db.events = db.events.map((event) =>
    event.id === OPEN ? { ...event, status: 'CLOSED' } : event,
  );
}

/** The title, put above the viewport, with a spy on its `focus`. */
async function openHelenaScrolledDown() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  const title = await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  vi.spyOn(title, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 0, y: -600, width: 600, height: 40 }),
  );
  const focus = vi.spyOn(title, 'focus');
  return { ...rendered, title, focus };
}

function markButtons() {
  return screen.queryAllByRole('button', { name: /^(Certo|Errado):/ });
}

async function readOnlyWithTitleFocused(title: HTMLElement) {
  await waitFor(() => {
    expect(markButtons()).toHaveLength(0);
  });
  await waitFor(() => {
    expect(title).toHaveFocus();
  });
}

/** Holds every mark until `release` is called. */
function holdMarks() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.put(ANSWER_URL, async () => {
      await held;
      return undefined;
    }),
  );
  return () => {
    release();
  };
}

describe('scroll when the exam turns read-only (§ 6.4, § 6.7, #49)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rn010 scrolls to the title after the examiner\'s own mark got "Exame já decidido"', async () => {
    const { user, title, focus } = await openHelenaScrolledDown();
    decideHelena();
    await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Exame já decidido');
    await readOnlyWithTitleFocused(title);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });
  });

  it('rn016 scrolls to the title after the examiner\'s own mark got "Evento encerrado"', async () => {
    const { user, title, focus } = await openHelenaScrolledDown();
    closeEvent();
    await user.click(screen.getByRole('button', { name: 'Errado: Parar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Evento encerrado');
    await readOnlyWithTitleFocused(title);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: false });
  });

  it('rn010 keeps the page where it is after a reload on window focus', async () => {
    const { title, focus } = await openHelenaScrolledDown();
    act(() => {
      screen.getByRole('button', { name: 'Certo: Parar' }).focus();
    });
    decideHelena();
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    await readOnlyWithTitleFocused(title);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it('rn010 keeps the page where it is when the refusal is about another item', async () => {
    const release = holdMarks();
    const { user, title, focus } = await openHelenaScrolledDown();
    await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));
    // The examiner goes on down the list while Parar is on its way.
    act(() => {
      screen.getByRole('button', { name: `Certo: ${FOUNDER}` }).focus();
    });
    decideHelena();
    release();

    expect(await screen.findByRole('alert')).toHaveTextContent('Exame já decidido');
    await readOnlyWithTitleFocused(title);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });
});
