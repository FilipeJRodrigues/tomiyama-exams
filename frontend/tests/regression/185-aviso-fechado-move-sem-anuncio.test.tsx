/**
 * Erro: o examinador marca "Parar" e a resposta da API se perde (rede), mas a marcação foi
 * salva. O aviso "Não foi possível confirmar a marcação" fica aberto e, como decidido, o item
 * fica parado enquanto ele está aberto. Ao fechar o aviso, "Parar" vai para o fim de
 * Vocabulário e Vocabulário, completa, vai para o fim da aba, mas a região ao vivo da fila
 * (`queue-live`) fica muda: a espera acabou com o aviso aberto e a lista de itens marcados
 * pelo examinador foi descartada sem a troca (`useMarkQueue`, ramo "nothing moved"). Quem usa
 * leitor de tela fica com o foco no "Certo: Parar", agora no fim da aba, sem saber que ele mudou
 * de lugar.
 * Esperado: a marcação é deste examinador (foi salva); quando o item muda de lugar, ao fechar o
 * aviso, a mudança é anunciada como numa troca normal (§ 6.4 "Fila", teclado e leitor de tela;
 * decisão 4 do responsável, 2026-11-19: região ao vivo só para os itens que este examinador
 * marcou; § 6.7).
 * Issue: #185
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { MOVE_DELAY_MS } from '../../src/features/exam/markQueue';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const OPEN = MOCK_EVENT_IDS.open;
/** Helena (Marrom, exam in progress): Vocabulário — Professor certo, Parar não marcado. */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const FOUNDER_NAME = 'Nome do fundador do Judô';

let db: MockDb;

function helenaExam() {
  return db.exams.find((exam) => exam.student_id === HELENA)!;
}

function itemOrder(): string[] {
  return screen
    .getAllByRole('group', { name: /^Marcação: / })
    .map((group) => group.getAttribute('aria-label')!.replace('Marcação: ', ''));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
  db = createMockDb({ includeShowcase: true });
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
});

afterEach(() => {
  vi.useRealTimers();
});

it('rn006 announces the move of a saved mark when its notice closes', async () => {
  // The API saves the mark, but the answer never comes back (network).
  server.use(
    http.put(ANSWER_URL, ({ params }) => {
      const requirementId = String(params.requirementId);
      const saved = db.answers.some(
        (item) => item.exam_id === helenaExam().id && item.requirement_id === requirementId,
      );
      if (!saved) {
        db.answers.push({
          exam_id: helenaExam().id,
          requirement_id: requirementId,
          correct: true,
          marked_by: 'mock-examiner',
          marked_at: '2026-11-21T13:40:00+00:00',
        });
      }
      return HttpResponse.error();
    }),
  );
  const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  const live = screen.getByTestId('queue-live');

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });
  const parar = screen.getByRole('button', { name: 'Certo: Parar' });
  act(() => {
    parar.focus();
  });
  fireEvent.click(parar, { detail: 1 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOVE_DELAY_MS * 2);
  });
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Não foi possível confirmar a marcação de "Parar"');
  // The reload shows it saved; it stays where the examiner left it while the notice is open.
  expect(screen.getByRole('button', { name: 'Certo: Parar' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(itemOrder()).toEqual(['Parar', 'Professor', FOUNDER_NAME]);
  expect(live).toBeEmptyDOMElement();

  vi.useRealTimers();
  act(() => {
    within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
  });
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(itemOrder()).toEqual([FOUNDER_NAME, 'Professor', 'Parar']);
  expect(live).toHaveTextContent('Parar marcado como certo, movido para o fim de Vocabulário.');
  expect(live).toHaveTextContent('Categoria Vocabulário completa, movida para o fim da aba.');
});
