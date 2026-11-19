/**
 * Erro: o examinador marca "Parar" e, ainda na espera de ~1 s, marca "Nome do fundador do
 * Judô" (o último item da aba); a API recusa a segunda marcação (503) e o aviso abre pedindo
 * para tentar de novo. Com o aviso ainda aberto, a troca leva Vocabulário (completa) para o fim
 * da aba, e o item do aviso sobe do 3º para o 1º lugar. O item fica na parte em aberto da
 * categoria dele (`FailurePin` em `useMarkQueue`), mas a categoria muda de lugar.
 * Esperado: "o item do aviso de erro fica onde está até o aviso fechar" (§ 6.4 "Fila", tempo;
 * decisão aceita "Espera da gravação", 2026-11-19): enquanto o aviso está aberto, o item dele
 * continua no mesmo lugar da tela; ao fechar o aviso, a ordem segue os dados.
 * Issue: #185
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { MOVE_DELAY_MS } from '../../src/features/exam/markQueue';
import { MOCK_EVENT_IDS, createMockDb, mockRequirementId } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const OPEN = MOCK_EVENT_IDS.open;
/**
 * Helena (Marrom, exam in progress): Vocabulário — Parar não marcado, Professor certo;
 * Histórico — Nome do fundador do Judô não marcado.
 */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const FOUNDER = mockRequirementId('Marrom', 7);
const FOUNDER_NAME = 'Nome do fundador do Judô';

function itemOrder(): string[] {
  return screen
    .getAllByRole('group', { name: /^Marcação: / })
    .map((group) => group.getAttribute('aria-label')!.replace('Marcação: ', ''));
}

/** A finger tap: the button takes the focus and the click has `detail` 1. */
function tap(name: string) {
  const target = screen.getByRole('button', { name });
  act(() => {
    target.focus();
  });
  fireEvent.click(target, { detail: 1 });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
  server.use(
    ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

it('rn006 keeps the item of the notice in its place on the screen until the notice closes', async () => {
  server.use(
    http.put(ANSWER_URL, ({ params }) =>
      String(params.requirementId) === FOUNDER
        ? HttpResponse.json({ message: 'Serviço indisponível' }, { status: 503 })
        : undefined,
    ),
  );
  const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  expect(itemOrder()).toEqual(['Parar', 'Professor', FOUNDER_NAME]);

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });
  tap('Certo: Parar');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  tap(`Certo: ${FOUNDER_NAME}`);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOVE_DELAY_MS * 2);
  });

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(`Não foi possível salvar a marcação de "${FOUNDER_NAME}"`);
  // The notice is open: its item is still the third one, where the examiner tapped it.
  expect(itemOrder().indexOf(FOUNDER_NAME)).toBe(2);

  vi.useRealTimers();
  await user.click(within(alert).getByRole('button', { name: 'Fechar aviso' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(itemOrder()).toEqual([FOUNDER_NAME, 'Professor', 'Parar']);
});
