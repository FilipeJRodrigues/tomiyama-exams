/**
 * § 6.4 / § 6.7: when the exam turns read-only while shown (409 "Exame já decidido", RN010;
 * 400 "Evento encerrado", RN016), the Certo/Errado button that had the focus is gone. The
 * focus goes to the exam title, not to the body, and not to the alert (already announced by
 * the screen reader). A focus the examiner moved elsewhere meanwhile is left alone.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
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

let db: MockDb;

function decideHelena() {
  const exam = db.exams.find((item) => item.student_id === HELENA)!;
  Object.assign(exam, {
    status: 'APPROVED',
    decided_by_id: 'mock-examiner',
    decided_at: '2026-11-21T12:00:00+00:00',
  });
}

function closeEvent() {
  db.events = db.events.map((event) =>
    event.id === OPEN ? { ...event, status: 'CLOSED' } : event,
  );
}

async function openHelena() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

function markButtons() {
  return screen.queryAllByRole('button', { name: /^(Certo|Errado):/ });
}

describe('focus when the exam turns read-only (§ 6.4, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn010 moves the focus to the exam title after "Exame já decidido"', async () => {
    const { user } = await openHelena();
    decideHelena();
    await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Exame já decidido');
    await waitFor(() => {
      expect(markButtons()).toHaveLength(0);
    });
    const title = screen.getByRole('heading', { level: 1, name: 'Helena Prado' });
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
    expect(screen.getByRole('alert')).not.toHaveFocus();
  });

  it('rn016 moves the focus to the exam title after "Evento encerrado"', async () => {
    const { user } = await openHelena();
    closeEvent();
    await user.click(screen.getByRole('button', { name: 'Errado: Parar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Evento encerrado');
    await waitFor(() => {
      expect(markButtons()).toHaveLength(0);
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Helena Prado' })).toHaveFocus();
    });
  });

  it('rn010 keeps a focus the examiner moved elsewhere meanwhile', async () => {
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
    const { user } = await openHelena();
    decideHelena();
    await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));
    const trail = screen.getByRole('navigation', { name: 'Caminho' });
    const trailLink = within(trail).getByRole('link', { name: 'Dia do exame' });
    act(() => {
      trailLink.focus();
    });
    release();

    expect(await screen.findByRole('alert')).toHaveTextContent('Exame já decidido');
    await waitFor(() => {
      expect(markButtons()).toHaveLength(0);
    });
    expect(trailLink).toHaveFocus();
  });

  it('keeps the title out of the tab order', async () => {
    await openHelena();
    expect(screen.getByRole('heading', { level: 1, name: 'Helena Prado' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });
});
