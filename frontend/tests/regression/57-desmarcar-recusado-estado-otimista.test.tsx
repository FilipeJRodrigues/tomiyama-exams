/**
 * Erro: o teste "rn006 keeps the mark and the summary when taking it off is refused"
 * (`tests/features/exam/ExamMarking.qa.test.tsx`) falhava de forma intermitente (2 a 3 de 5
 * execuções, e no CI). Ele clicava em "Certo: Professor" para desmarcar e conferia logo em
 * seguida o estado otimista (`aria-pressed="false"`), mas o DELETE simulado respondia 503 na
 * hora; às vezes a recusa chegava e desfazia o estado otimista antes da conferência, e o teste
 * via `aria-pressed="true"`. Defeito do teste (corrida), não da tela.
 * Esperado: o cenário é verificado de forma determinística na tela "Exame do aluno" (§ 6.4,
 * RN006): com a resposta segura, a desmarcação aparece na hora (item sem marca, "Teórico 0/3",
 * 0%, sem aviso, nada gravado ainda); liberada a recusa 503, aparece o aviso com a mensagem da
 * API e o item, a aba, o percentual (33,3%) e o dado gravado voltam a ser os de antes.
 * Issue: #57
 * Atualizado no #49: um 503 agora é reenviado duas vezes antes do aviso (RN006, nova tentativa
 * automática); o DELETE recusado chega à API três vezes, e não mais uma.
 */
import { act, screen, within } from '@testing-library/react';
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
const PROFESSOR = mockRequirementId('Marrom', 5);
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

let db: MockDb;

function answerOf(requirementId: string) {
  const exam = db.exams.find((item) => item.student_id === HELENA)!;
  return db.answers.find(
    (item) => item.exam_id === exam.id && item.requirement_id === requirementId,
  );
}

function professor(mark: 'Certo' | 'Errado') {
  return screen.getByRole('button', { name: `${mark}: Professor` });
}

function theoryScore() {
  return screen.getByTestId('exam-scores').querySelector<HTMLElement>('[data-score="THEORY"]')!;
}

describe('desmarcação recusada (§ 6.4, RN006)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn006 mostra a desmarcação na hora e a desfaz com aviso quando a API recusa', async () => {
    let refuse!: () => void;
    const refused = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    let deletes = 0;
    server.use(
      http.delete(ANSWER_URL, async () => {
        deletes += 1;
        await refused;
        return HttpResponse.json({ message: BUSY }, { status: 503 });
      }),
    );
    const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    expect(professor('Certo')).toHaveAttribute('aria-pressed', 'true');

    // Resposta segura: o estado otimista fica visível, sem corrida com a recusa.
    await user.click(professor('Certo'));
    expect(professor('Certo')).toHaveAttribute('aria-pressed', 'false');
    expect(professor('Errado')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('tab', { name: /^Teórico 0\/3$/ })).toBeInTheDocument();
    expect(within(theoryScore()).getByText('0%')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(deletes).toBe(1);
    expect(answerOf(PROFESSOR)?.correct).toBe(true);

    await act(async () => {
      refuse();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(BUSY);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Não foi possível salvar a marcação de "Professor"',
    );
    expect(professor('Certo')).toHaveAttribute('aria-pressed', 'true');
    expect(professor('Errado')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('tab', { name: /^Teórico 1\/3$/ })).toBeInTheDocument();
    expect(within(theoryScore()).getByText('33,3%')).toBeInTheDocument();
    expect(answerOf(PROFESSOR)?.correct).toBe(true);
    // A primeira tentativa e as duas novas tentativas automáticas (#49).
    expect(deletes).toBe(3);
  });
});
