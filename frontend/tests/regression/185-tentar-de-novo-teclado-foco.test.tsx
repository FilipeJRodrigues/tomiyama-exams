/**
 * Erro: só pelo teclado, o examinador marca "Parar" (Space) e a API recusa por um instante
 * (503). No aviso, ele aciona "Tentar de novo" com Enter; a marcação é salva, o foco vai para o
 * "Certo: Parar" e, depois da espera, "Parar" vai para o fim de Vocabulário e Vocabulário,
 * completa, vai para o fim da aba. O foco fica no "Certo: Parar", agora no fim da aba, e não
 * vai para o primeiro item em aberto: "Tentar de novo" avisa a fila como marcação de ponteiro
 * (`marked(failure.itemId, false)` em `ExamPage`), qualquer que seja a tecla ou o toque que o
 * acionou.
 * Esperado: o item foi marcado pelo teclado (a marcação e o reenvio) e mudou de lugar, então o
 * foco vai para o primeiro botão do primeiro item em aberto, como numa marcação pelo teclado sem
 * recusa (decisão 4 do responsável, 2026-11-19; § 6.4 "Fila", teclado e leitor de tela; § 6.7).
 * Issue: #185
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const OPEN = MOCK_EVENT_IDS.open;
/** Helena (Marrom, exam in progress): Vocabulário — Parar não marcado, Professor certo. */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const FOUNDER_NAME = 'Nome do fundador do Judô';

function itemOrder(): string[] {
  return screen
    .getAllByRole('group', { name: /^Marcação: / })
    .map((group) => group.getAttribute('aria-label')!.replace('Marcação: ', ''));
}

beforeEach(() => {
  server.use(
    ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
  );
});

it('rn006 "Tentar de novo" with the keyboard sends the focus on to the first open item', async () => {
  let busy = true;
  server.use(
    http.put(ANSWER_URL, () =>
      busy ? HttpResponse.json({ message: 'Serviço indisponível' }, { status: 503 }) : undefined,
    ),
  );
  const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });

  // Space on the focused Certo: a click with `detail` 0.
  const parar = screen.getByRole('button', { name: 'Certo: Parar' });
  act(() => {
    parar.focus();
  });
  fireEvent.click(parar, { detail: 0 });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Serviço indisponível');

  busy = false;
  act(() => {
    within(alert)
      .getByRole('button', { name: /^Tentar de novo/ })
      .focus();
  });
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Certo: Parar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  await waitFor(
    () => {
      expect(itemOrder()).toEqual([FOUNDER_NAME, 'Professor', 'Parar']);
    },
    { timeout: 3000 },
  );
  await waitFor(() => {
    expect(screen.getByRole('button', { name: `Certo: ${FOUNDER_NAME}` })).toHaveFocus();
  });
});
