/**
 * Erro: o sensei confirma a decisão, mas o exame já tinha sido decidido em outro aparelho
 * (409 "Exame já decidido"). O diálogo fecha e a área de decisão do resumo mostra o aviso
 * com o botão "Fechar aviso". Ao fechar o aviso pelo teclado (Enter no botão), o botão some
 * junto com o aviso e o foco cai no `body`: quem usa teclado ou leitor de tela perde o lugar
 * na página.
 * Esperado: ao fechar o aviso, o foco fica na tela (na área de decisão, em "Decidido por …",
 * ou no título do exame), nunca no `body` (§ 6.7; mesmo cuidado da devolução de foco do
 * diálogo de decisão).
 * Issue: #24 (QA da etapa 3, decisão do sensei)
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { examPath } from '../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const DECISION_URL = `${TEST_API_URL}/events/:id/exams/:studentId/decision`;

let db: MockDb;

function summary() {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

describe('rn010 foco ao fechar o aviso "Exame já decidido" (§ 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    // Decided on another device meanwhile.
    server.use(
      http.post(DECISION_URL, () => {
        Object.assign(
          db.exams.find((exam) => exam.student_id === HELENA)!,
          {
            status: 'FAILED',
            decided_by_id: MOCK_USER_IDS.examiner,
            decided_at: '2026-11-21T12:00:00+00:00',
          },
        );
        return HttpResponse.json({ message: 'Exame já decidido' }, { status: 409 });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { layout: 'notebook', width: undefined, opener: 'Aprovar' },
    { layout: 'phone', width: 390, opener: 'Decidir' },
  ])('$layout: o foco não cai no body ao fechar o aviso', async ({ width, opener }) => {
    if (width !== undefined) setViewportWidth(width);
    const { user } = await renderApp({
      route: examPath(MOCK_EVENT_IDS.open, HELENA),
      signedInAs: 'examiner',
    });
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    await user.click(await within(summary()).findByRole('button', { name: opener }));
    if (opener === 'Decidir') {
      const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
      await user.click(within(panel).getByRole('button', { name: 'Aprovar' }));
    }
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    const alert = await within(summary()).findByRole('alert');
    expect(alert).toHaveTextContent('Exame já decidido');
    await within(summary()).findByText('Decidido por Sensei Simulado');

    within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(within(summary()).queryByRole('alert')).not.toBeInTheDocument();
    });

    await waitFor(
      () => {
        const active = document.activeElement;
        expect(active).not.toBeNull();
        expect(active).not.toBe(document.body);
        const title = screen.getByRole('heading', { level: 1, name: 'Helena Prado' });
        expect(summary().contains(active) || active === title).toBe(true);
      },
      { timeout: 1500 },
    );
  });
});
