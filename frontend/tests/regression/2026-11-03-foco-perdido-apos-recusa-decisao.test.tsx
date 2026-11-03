/**
 * Erro: o sensei abre "Aprovar exame" e confirma, mas a API recusa porque o master trocou
 * (403 "Somente o sensei pode decidir o exame") ou removeu (409 "Defina o sensei nas
 * configurações da academia") o sensei no meio do exame. A tela recarrega as configurações
 * e troca Aprovar/Reprovar por "A decisão é do sensei …" (ou pelo aviso "Sem sensei
 * definido"). Ao fechar o diálogo com Cancelar (ou Esc), o foco volta para o botão
 * "Aprovar", que não existe mais, e cai no `body`: quem usa teclado ou leitor de tela
 * perde o lugar na página.
 * Esperado: ao fechar o diálogo, o foco vai para um lugar da tela (a área de decisão do
 * resumo ou o título do exame), nunca para o `body` (§ 6.7: foco no modal e devolução ao
 * fechar; mesmo cuidado do `useReadOnlyFocus` da etapa 2).
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

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const DECISION_URL = `${TEST_API_URL}/events/:id/exams/:studentId/decision`;

let db: MockDb;

function summary() {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

describe('rn008 foco depois de uma recusa que troca os botões de decisão (§ 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      status: 403,
      message: 'Somente o sensei pode decidir o exame',
      sensei: 'mock-examiner-2',
      shown: 'A decisão é do sensei examinadora@example.com',
    },
    {
      status: 409,
      message: 'Defina o sensei nas configurações da academia',
      sensei: null,
      shown: 'Sem sensei definido',
    },
  ])('$status "$message": o foco não cai no body ao fechar', async (refusal) => {
    server.use(
      http.post(DECISION_URL, () => {
        db.settings.sensei_user_id = refusal.sensei;
        return HttpResponse.json({ message: refusal.message }, { status: refusal.status });
      }),
    );
    const { user } = await renderApp({
      route: examPath(MOCK_EVENT_IDS.open, HELENA),
      signedInAs: 'examiner',
    });
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    await user.click(await within(summary()).findByRole('button', { name: 'Aprovar' }));
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    expect(await within(modal).findByRole('alert')).toHaveTextContent(refusal.message);
    // The settings reloaded: Aprovar/Reprovar are gone from the summary.
    expect(await within(summary()).findByText(refusal.shown)).toBeInTheDocument();

    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
