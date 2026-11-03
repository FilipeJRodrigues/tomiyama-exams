/**
 * Erro: na tela "Exame do aluno" (§ 6.4), quando a marcação de um item é recusada (ex.: 503
 * "Sistema ocupado…") e o examinador clica de novo no mesmo item e a gravação dá certo, o
 * aviso vermelho "Não foi possível salvar a marcação de "Parar"" (role="alert") continua na
 * tela, ao lado do botão "Certo" pressionado e já gravado. A tela se contradiz: diz que a
 * marcação não foi salva quando ela foi.
 * Esperado: quando a marcação do item citado no aviso é gravada com sucesso, o aviso daquele
 * item some (RN006, "em erro, volta e avisa": o aviso é sobre a falha, não sobre o estado
 * atual). Avisos de outros itens não são afetados.
 * Issue: #24
 */
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, mockRequirementId, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

let db: MockDb;

function answerOf(requirementId: string) {
  const exam = db.exams.find((item) => item.student_id === HELENA)!;
  return db.answers.find(
    (item) => item.exam_id === exam.id && item.requirement_id === requirementId,
  );
}

describe('aviso de marcação recusada (§ 6.4, RN006)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn006 tira o aviso do item quando a nova tentativa grava a marcação', async () => {
    let refuse = true;
    server.use(
      http.put(ANSWER_URL, () =>
        refuse ? HttpResponse.json({ message: BUSY }, { status: 503 }) : undefined,
      ),
    );
    const { user } = await renderApp({
      route: examPath(OPEN, HELENA),
      signedInAs: 'examiner',
    });
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });

    await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível salvar a marcação de "Parar"',
    );

    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Certo: Parar' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
