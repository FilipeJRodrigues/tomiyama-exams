/**
 * Erro: o examinador marca "Parar" e, ainda na espera de ~1 s, marca "Nome do fundador do
 * Judô"; a API recusa a segunda marcação (503, servidor ocupado) e o item volta sem marcação,
 * com o aviso. Na troca, Vocabulário (completa) vai para o fim da aba e Histórico sobe, e a
 * região ao vivo da fila (`queue-live`) diz "Nome do fundador do Judô desmarcado, movido para
 * os itens em aberto de Histórico." O item nunca teve marcação: o examinador não o desmarcou,
 * a marcação dele foi recusada (e o aviso já disse isso). O item recusado entra no anúncio
 * porque continua na lista de marcações do examinador (`marked` em `useMarkQueue`) e mudou de
 * lugar junto com a categoria dele (`moveAnnouncement`).
 * Esperado: a região ao vivo fala só dos itens que este examinador marcou (decisão 4 do
 * responsável, 2026-11-19; § 6.4 "Fila"): anuncia "Parar" e a categoria que foi para o fim, e
 * não diz que o item da marcação recusada foi desmarcado (§ 6.7: o que se ouve é o que a tela
 * mostra).
 * Issue: #185
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { MOVE_DELAY_MS } from '../../src/features/exam/markQueue';
import { MOCK_EVENT_IDS, createMockDb, mockRequirementId, type MockDb } from '../../src/mocks/data';
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

let db: MockDb;

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
  db = createMockDb({ includeShowcase: true });
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
});

afterEach(() => {
  vi.useRealTimers();
});

it('rn006 does not announce as unmarked an item whose mark was refused', async () => {
  server.use(
    http.put(ANSWER_URL, ({ params }) =>
      String(params.requirementId) === FOUNDER
        ? HttpResponse.json({ message: 'Serviço indisponível' }, { status: 503 })
        : undefined,
    ),
  );
  await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  const live = screen.getByTestId('queue-live');

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });
  tap('Certo: Parar');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  tap(`Certo: ${FOUNDER_NAME}`);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOVE_DELAY_MS * 2);
  });

  expect(screen.getByRole('alert')).toHaveTextContent(
    `Não foi possível salvar a marcação de "${FOUNDER_NAME}"`,
  );
  expect(screen.getByRole('button', { name: `Certo: ${FOUNDER_NAME}` })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  // Parar was saved: Vocabulário, complete, went to the end of the tab.
  expect(itemOrder()).toEqual([FOUNDER_NAME, 'Professor', 'Parar']);
  expect(live).toHaveTextContent('Parar marcado como certo, movido para o fim de Vocabulário.');
  expect(live).not.toHaveTextContent('desmarcado');
  expect(live).toHaveTextContent(
    /^Parar marcado como certo, movido para o fim de Vocabulário\. Categoria Vocabulário completa, movida para o fim da aba\.$/,
  );
});
