/**
 * § 6.4 step 3, sensei decision: cases added by the QA (qa-frontend, card #24): the stripe
 * exam (RN004, RN009), a blank note, repeated clicks on confirm, the keyboard inside the
 * dialog, an expired session and "Exame já decidido" from the phone panel.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecisionInput } from '../../../src/api/types';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { examPath } from '../../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const DECISION_URL = `${TEST_API_URL}/events/:id/exams/:studentId/decision`;
const ROXA = mockBelts.find((belt) => belt.name === 'Roxa')!;

let db: MockDb;
let decisions: DecisionInput[] = [];

function summary() {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

function helenaExam() {
  return db.exams.find((exam) => exam.student_id === HELENA)!;
}

async function openExam() {
  const rendered = await renderApp({
    route: examPath(MOCK_EVENT_IDS.open, HELENA),
    signedInAs: 'examiner',
  });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

async function openDialog(user: Awaited<ReturnType<typeof openExam>>['user'], name: string) {
  await user.click(await within(summary()).findByRole('button', { name }));
  return screen.findByRole('dialog', { name: `${name} exame` });
}

describe('sensei decision, QA cases (§ 6.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    decisions = [];
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    server.use(
      http.post(DECISION_URL, async ({ request }) => {
        decisions.push((await request.clone().json()) as DecisionInput);
        return undefined;
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn004 rn009 asks about the stripe in the current belt and approves it', async () => {
    helenaExam().kind = 'STRIPE';
    const { user } = await openExam();
    const modal = await openDialog(user, 'Aprovar');
    expect(modal).toHaveTextContent(
      'Aprovar Helena Prado no exame de grau na faixa Roxa? A decisão não pode ser desfeita.',
    );
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    await within(summary()).findByText('Decidido por Sensei Simulado');
    const student = db.students.find((item) => item.student.id === HELENA)!.student;
    expect(student).toMatchObject({ current_belt_id: ROXA.id, stripes: 5 });
  });

  it('sends a note of spaces only as null', async () => {
    const { user } = await openExam();
    const modal = await openDialog(user, 'Reprovar');
    await user.type(within(modal).getByRole('textbox', { name: /Observação/ }), '    ');
    await user.click(within(modal).getByRole('button', { name: 'Reprovar' }));
    await within(summary()).findByText('Decidido por Sensei Simulado');
    expect(decisions).toEqual([{ result: 'FAILED', notes: null }]);
  });

  it('rn010 sends once even with clicks before the next render', async () => {
    const { user } = await openExam();
    const modal = await openDialog(user, 'Aprovar');
    const confirm = within(modal).getByRole('button', { name: 'Aprovar' });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await within(summary()).findByText('Decidido por Sensei Simulado');
    expect(decisions).toHaveLength(1);
  });

  it('keeps Tab inside the dialog (§ 6.7)', async () => {
    const { user } = await openExam();
    const modal = await openDialog(user, 'Aprovar');
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(modal).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('ends the session on a 401 of the decision', async () => {
    server.use(
      http.post(DECISION_URL, () =>
        HttpResponse.json({ message: 'Faça login para continuar' }, { status: 401 }),
      ),
    );
    const { user, router } = await openExam();
    const modal = await openDialog(user, 'Aprovar');
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
    expect(helenaExam().status).toBe('IN_PROGRESS');
  });

  it('rn010 phone: "Exame já decidido" from the panel closes it and the bar says so', async () => {
    setViewportWidth(390);
    server.use(
      http.post(DECISION_URL, () => {
        Object.assign(helenaExam(), {
          status: 'FAILED',
          decided_by_id: MOCK_USER_IDS.examiner,
          decided_at: '2026-11-21T12:00:00+00:00',
        });
        return HttpResponse.json({ message: 'Exame já decidido' }, { status: 409 });
      }),
    );
    const { user } = await openExam();
    await user.click(await within(summary()).findByRole('button', { name: 'Decidir' }));
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    await user.click(within(panel).getByRole('button', { name: 'Aprovar' }));
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await within(summary()).findByRole('alert')).toHaveTextContent('Exame já decidido');
    expect(await within(summary()).findByText('Decidido por Sensei Simulado')).toBeInTheDocument();
    expect(within(summary()).queryByRole('button', { name: 'Decidir' })).not.toBeInTheDocument();
  });
});
