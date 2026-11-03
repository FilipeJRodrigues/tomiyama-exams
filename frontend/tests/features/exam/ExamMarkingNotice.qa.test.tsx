/**
 * § 6.4 / § 6.7, cases added by qa-frontend (card #24, reteste da etapa 2): the notice of a
 * refused mark leaves only when that same item is saved (a notice of another item stays), the
 * notice is not put back in the page (no second announcement) when the exam reloads, and the
 * focus is moved to the title only when it fell on the body.
 *
 * Helena (open event, Marrom belt, exam in progress): Teórico 1/3 marked (Professor certo;
 * Parar and Nome do fundador não marcados).
 */
import { act, screen, waitFor } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
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
const FOUNDER = mockRequirementId('Marrom', 7);
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

let db: MockDb;

function helenaExam() {
  return db.exams.find((exam) => exam.student_id === HELENA)!;
}

function answerOf(requirementId: string) {
  return db.answers.find(
    (item) => item.exam_id === helenaExam().id && item.requirement_id === requirementId,
  );
}

function decideHelena() {
  Object.assign(helenaExam(), {
    status: 'APPROVED',
    decided_by_id: 'mock-examiner',
    decided_at: '2026-11-21T12:00:00+00:00',
  });
}

async function openHelena() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

function markButtons() {
  return screen.queryAllByRole('button', { name: /^(Certo|Errado):/ });
}

/** Refuse the marks of the given items with 503; the others go through. */
function refuse(ids: Set<string>) {
  server.use(
    http.put(ANSWER_URL, ({ params }) =>
      ids.has(String(params.requirementId))
        ? HttpResponse.json({ message: BUSY }, { status: 503 })
        : undefined,
    ),
  );
}

describe('notice of a refused mark and focus, more cases (§ 6.4, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      focusManager.setFocused(undefined);
    });
  });

  it('rn006 keeps the notice of an item when another item is saved', async () => {
    refuse(new Set([PARAR]));
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível salvar a marcação de "Parar"',
    );

    await user.click(button('Errado: Nome do fundador do Judô'));
    await waitFor(() => {
      expect(answerOf(FOUNDER)?.correct).toBe(false);
    });
    await waitFor(() => {
      expect(button('Errado: Nome do fundador do Judô')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Não foi possível salvar a marcação de "Parar"',
    );
  });

  it('rn006 keeps the newer notice of another item when the older item is saved', async () => {
    const refused = new Set([PARAR, FOUNDER]);
    refuse(refused);
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    await screen.findByRole('alert');
    await user.click(button('Certo: Nome do fundador do Judô'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Não foi possível salvar a marcação de "Nome do fundador do Judô"',
      );
    });

    refused.delete(PARAR);
    await user.click(button('Certo: Parar'));
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(true);
    });
    await waitFor(() => {
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Não foi possível salvar a marcação de "Nome do fundador do Judô"',
    );
  });

  it('rn010 shows one notice, kept in place across the reload, with the focus on the title', async () => {
    const { user } = await openHelena();
    decideHelena();
    await user.click(button('Certo: Parar'));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Exame já decidido');

    await waitFor(() => {
      expect(markButtons()).toHaveLength(0);
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Helena Prado' })).toHaveFocus();
    });
    // The same node: the screen reader does not hear it again.
    expect(screen.getAllByRole('alert')).toEqual([notice]);
    expect(screen.getByTestId('percent-live')).toBeEmptyDOMElement();
  });

  it('rn010 keeps the focus on "Só não marcados" when the exam is found decided on window focus', async () => {
    const { user } = await openHelena();
    const onlyUnmarked = screen.getByRole('switch', { name: /Só não marcados/ });
    await user.click(onlyUnmarked);
    expect(onlyUnmarked).toHaveFocus();

    decideHelena();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => {
      expect(markButtons()).toHaveLength(0);
    });
    expect(screen.getByRole('switch', { name: /Só não marcados/ })).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rn010 moves the focus to the title when the focused button goes on window focus', async () => {
    const { user } = await openHelena();
    await user.tab();
    while (!(document.activeElement?.getAttribute('aria-label') ?? '').startsWith('Certo:')) {
      await user.tab();
    }
    decideHelena();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => {
      expect(markButtons()).toHaveLength(0);
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Helena Prado' })).toHaveFocus();
    });
  });

  it('keeps the focus when the exam opens already read-only', async () => {
    decideHelena();
    await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
    const title = await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    expect(title).not.toHaveFocus();
  });
});
