/**
 * § 6.4 exam of a student, step 1: edge cases of the contract and of the layout that the
 * main suite does not cover (expired session, examiners list failing, a belt with no items,
 * 200% zoom, keyboard).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const { open: OPEN, closed: CLOSED } = MOCK_EVENT_IDS;
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const HELENA_URL = `${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`;

let db: MockDb;

function openExam(eventId: string, studentId: string) {
  return renderApp({ route: examPath(eventId, studentId), signedInAs: 'examiner' });
}

describe('exam of a student, edge cases (§ 6.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends the session when the exam answers 401', async () => {
    server.use(
      http.get(HELENA_URL, () => HttpResponse.json({ message: 'Unauthorized' }, { status: 401 })),
    );
    const { router } = await openExam(OPEN, HELENA);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
  });

  it('still says the exam was decided when the examiners list fails', async () => {
    server.use(
      http.get(`${TEST_API_URL}/examiners`, () =>
        HttpResponse.json({ message: 'Erro interno. Tente de novo.' }, { status: 500 }),
      ),
    );
    await openExam(CLOSED, ELIDA);
    await screen.findByRole('heading', { level: 1, name: 'Élida Ramos' });
    const summary = screen.getByRole('complementary', { name: 'Resumo do exame' });
    expect(await within(summary).findByText(/^Decidido/)).toBeInTheDocument();
  });

  it('rn007 shows "—" for both kinds and the empty notices for a belt without items', async () => {
    db.requirements = [];
    await openExam(OPEN, HELENA);
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    expect(screen.getByText('Esta faixa não tem itens teóricos.')).toBeInTheDocument();
    const scores = screen.getByTestId('exam-scores');
    expect(within(scores).getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('0 de 0 itens marcados')).toBeInTheDocument();
  });

  it('keeps the drawer, the trail, previous/next and the bar at 200% zoom (640 px)', async () => {
    setViewportWidth(640);
    await openExam(OPEN, HELENA);
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    expect(
      within(screen.getByRole('navigation', { name: 'Caminho' })).getByRole('link', {
        name: 'Dia do exame',
      }),
    ).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Alunos presentes' });
    expect(
      within(group).getAllByRole('button').length + within(group).queryAllByRole('link').length,
    ).toBe(2);
    expect(screen.getByRole('complementary', { name: 'Resumo do exame' })).toHaveStyle({
      position: 'fixed',
    });
  });

  it('reaches the trail, previous/next, the tabs and the filter by Tab', async () => {
    const { user } = await openExam(OPEN, HELENA);
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    const wanted = [
      within(screen.getByRole('navigation', { name: 'Caminho' })).getByRole('link', {
        name: 'Dia do exame',
      }),
      screen.getByRole('tab', { name: /^Teórico/ }),
      screen.getByRole('switch', { name: 'Só não marcados' }),
    ];
    const reached = new Set<Element>();
    for (let i = 0; i < 40; i += 1) {
      await user.tab();
      if (document.activeElement) reached.add(document.activeElement);
    }
    for (const element of wanted) expect(reached.has(element)).toBe(true);
  });
});
