/**
 * Erro: o examinador marca "Parar" e, ainda na espera de ~1 s, marca "Nome do fundador do
 * Judô"; a API recusa a segunda marcação (503, servidor ocupado) e o item volta sem marcação,
 * com o aviso. Na troca, Vocabulário (completa) vai para o fim da aba e Histórico sobe, e a
 * região ao vivo da fila (`queue-live`) diz "Nome do fundador do Judô desmarcado, movido para
 * os itens em aberto de Histórico." O item nunca teve marcação: o examinador não o desmarcou,
 * a marcação dele foi recusada (e o aviso já disse isso). O item recusado entra no anúncio
 * porque continua na lista de marcações do examinador (`marked` em `useMarkQueue`) e mudou de
 * lugar junto com a categoria dele (`moveAnnouncement`).
 * Esperado: a região ao vivo fala só dos itens que este examinador marcou e cuja marcação
 * ficou (decisão 4 do responsável, 2026-11-19; § 6.4 "Fila"): anuncia "Parar" e a categoria
 * que foi para o fim, e nunca diz que o item da marcação recusada foi desmarcado (§ 6.7: o que
 * se ouve é o que a tela mostra). Enquanto o aviso está aberto, a lista inteira fica parada e
 * nada é anunciado; a troca e o anúncio acontecem quando o aviso fecha (decisão do master de
 * 2026-11-19 sobre a falha 4 do reteste; § 6.4 "Fila", tempo). Esta versão confere o anúncio
 * no fechamento do aviso; a primeira o conferia com o aviso aberto, antes dessa decisão.
 * Issue: #185
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
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

function pressed(name: string): string | null {
  return screen.getByRole('button', { name }).getAttribute('aria-pressed');
}

/** A finger tap: the button takes the focus and the click has `detail` 1. */
function tap(target: HTMLElement) {
  act(() => {
    target.focus();
  });
  fireEvent.click(target, { detail: 1 });
}

/** `ms` go by on the clock: timers due run, and the answers of the API come back meanwhile. */
async function passes(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
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
  tap(screen.getByRole('button', { name: 'Certo: Parar' }));
  await passes(200);
  tap(screen.getByRole('button', { name: `Certo: ${FOUNDER_NAME}` }));
  await passes(MOVE_DELAY_MS * 2);
  // The last try of the founder is sent at the end of that time: its refusal, and the reload
  // after it (a 503 may have been saved), come back while the clock goes on in steps.
  for (let step = 0; step < 100 && screen.queryByRole('alert') === null; step += 1) {
    await passes(10);
  }
  await passes(100);

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(`Não foi possível salvar a marcação de "${FOUNDER_NAME}"`);
  expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe('false');
  expect(pressed('Certo: Parar')).toBe('true');
  // The refused mark is never said to be unmarked, not even while its notice is open.
  expect(live).not.toHaveTextContent('desmarcado');
  // The notice is open: the whole list waits for it, and nothing is announced yet.
  expect(itemOrder()).toEqual(['Parar', 'Professor', FOUNDER_NAME]);
  expect(live).toBeEmptyDOMElement();

  // The notice closes: Vocabulário (complete) goes to the end of the tab and Histórico, with
  // the item of the refused mark, comes up. Only Parar and its category are announced.
  tap(within(alert).getByRole('button', { name: 'Fechar aviso' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(itemOrder()).toEqual([FOUNDER_NAME, 'Professor', 'Parar']);
  expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe('false');
  expect(live).not.toHaveTextContent('desmarcado');
  expect(live).toHaveTextContent(
    /^Parar marcado como certo, movido para o fim de Vocabulário\. Categoria Vocabulário completa, movida para o fim da aba\.$/,
  );
});
