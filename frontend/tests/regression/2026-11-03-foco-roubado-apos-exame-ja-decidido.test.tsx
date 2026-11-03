/**
 * Erro: o sensei confirma a decisão, mas o exame já tinha sido decidido em outro aparelho
 * (409 "Exame já decidido"). O diálogo fecha e o foco volta para "Aprovar", que continua na
 * tela até o exame recarregar. Se nesse meio-tempo o usuário leva o foco para outro lugar
 * (por exemplo, o link "Dia do exame" da trilha), quando o exame recarregado chega a tela
 * puxa o foco para "Decidido por …" e tira o usuário de onde ele estava: o pedido de foco
 * do 409 (`focusDecided`) fica pendente até o "Decidido por" aparecer e é atendido sem olhar
 * onde o foco está.
 * Esperado: o foco que já está em outro lugar da tela não é tirado (§ 6.7); "Decidido por …"
 * só recebe o foco quando o foco estaria perdido (o botão de decisão sumiu com ele).
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

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const DECISION_URL = `${TEST_API_URL}/events/:id/exams/:studentId/decision`;
const SHEET_URL = `${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`;

let db: MockDb;

function summary() {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

describe('rn010 foco depois do 409 "Exame já decidido" (§ 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('não tira o foco que o usuário levou para outro lugar antes de o exame recarregar', async () => {
    const releases: (() => void)[] = [];
    let holdReload = false;
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
      // The reload of the exam after the 409 waits until released (a slow network).
      http.get(SHEET_URL, async () => {
        if (holdReload) {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        }
        return undefined;
      }),
    );
    const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    holdReload = true;

    const approve = await within(summary()).findByRole('button', { name: 'Aprovar' });
    await user.click(approve);
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(releases.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(approve).toHaveFocus();
    });

    // The user moves on before the exam reloads.
    const trail = within(screen.getByRole('navigation', { name: 'Caminho' }));
    const [dayLink] = trail.getAllByRole('link');
    if (dayLink === undefined) throw new Error('O caminho deveria ter um link para o dia.');
    dayLink.focus();
    holdReload = false;
    releases.forEach((release) => {
      release();
    });

    await within(summary()).findByText('Decidido por Sensei Simulado');
    // Leave time for any late focus move.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(dayLink).toHaveFocus();
  });
});
