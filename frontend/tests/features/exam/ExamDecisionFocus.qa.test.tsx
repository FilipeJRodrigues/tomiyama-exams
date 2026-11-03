/**
 * § 6.4 / § 6.7, step 3: where the focus goes after the decision dialog closes, QA cases
 * beyond `ExamDecision.test.tsx` and the regressions of #24.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { examPath } from '../../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const DECISION_URL = `${TEST_API_URL}/events/:id/exams/:studentId/decision`;

let db: MockDb;

function summary() {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

async function openExam() {
  const rendered = await renderApp({
    route: examPath(MOCK_EVENT_IDS.open, HELENA),
    signedInAs: 'examiner',
  });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

async function waitDialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

describe('sensei decision, focus after the dialog, QA cases (§ 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn008 notebook: a 403 then Esc gives the focus to the decision area', async () => {
    server.use(
      http.post(DECISION_URL, () => {
        db.settings.sensei_user_id = 'mock-examiner-2';
        return HttpResponse.json(
          { message: 'Somente o sensei pode decidir o exame' },
          { status: 403 },
        );
      }),
    );
    const { user } = await openExam();
    await user.click(await within(summary()).findByRole('button', { name: 'Aprovar' }));
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    await within(summary()).findByText('A decisão é do sensei examinadora@example.com');
    await user.keyboard('{Escape}');
    await waitDialogGone();
    await waitFor(() => {
      expect(summary().querySelector('[data-decision-area="column"]')).toHaveFocus();
    });
  });

  it('a 503 then Cancelar gives the focus back to Aprovar, which is still there', async () => {
    server.use(
      http.post(DECISION_URL, () =>
        HttpResponse.json({ message: 'Serviço indisponível' }, { status: 503 }),
      ),
    );
    const { user } = await openExam();
    const approve = await within(summary()).findByRole('button', { name: 'Aprovar' });
    await user.click(approve);
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    await within(modal).findByRole('alert');
    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(approve).toHaveFocus();
    });
  });

  it('rn009 phone: a decision saved from the panel keeps the focus on "Decidido por"', async () => {
    setViewportWidth(390);
    const { user } = await openExam();
    await user.click(await within(summary()).findByRole('button', { name: 'Decidir' }));
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    await user.click(within(panel).getByRole('button', { name: 'Reprovar' }));
    const modal = await screen.findByRole('dialog', { name: 'Reprovar exame' });
    await user.click(within(modal).getByRole('button', { name: 'Reprovar' }));
    await waitDialogGone();
    const decided = await within(summary()).findByText('Decidido por Sensei Simulado');
    // Both closings (dialog and panel) have run their focus give-back by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(decided.closest('[data-slot="decision"]')).toHaveFocus();
  });

  it('keeps the focus on the page when the layout changes with the dialog open', async () => {
    const { user } = await openExam();
    await user.click(await within(summary()).findByRole('button', { name: 'Aprovar' }));
    await screen.findByRole('dialog', { name: 'Aprovar exame' });
    // The tablet turns: the notebook column gives way to the bottom bar.
    setViewportWidth(390);
    await user.keyboard('{Escape}');
    await waitDialogGone();
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
    });
  });
});
