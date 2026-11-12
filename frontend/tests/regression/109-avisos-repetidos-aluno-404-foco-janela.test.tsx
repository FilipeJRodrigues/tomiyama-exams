/**
 * Erro: no perfil de um aluno que responde 404 ao responsável ("Aluno não encontrado"), os
 * avisos de exame são pedidos de novo toda vez que a janela volta ao foco. A leitura do aluno
 * é refeita no foco (§ 6.4) e, enquanto ela está em voo, a página volta a "Carregando aluno…"
 * e monta outra vez a área de avisos, que relê a consulta em erro (`GET
 * /students/{id}/exam-notices` responde o mesmo 404). No Chromium, três voltas ao foco deram
 * três pedidos a mais. O teste do agente que dizia provar o contrário conferia a contagem
 * antes de a releitura do aluno começar.
 * Esperado: para um aluno que não é do responsável, os avisos são pedidos exatamente uma vez
 * (critério do card: "uma chamada, nenhuma repetição"); voltar à janela não os pede de novo.
 * Nada da área aparece em nenhum momento (isso já vale e continua conferido aqui).
 * Issue: #109
 */
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

/** Examiner's student: the guardian gets 404 for the student and for the notices. */
const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';
const NOTICES_KEY = ['student', CARLA, 'exam-notices'];
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

/**
 * Records the GETs of the student and of its notices; the simulated API answers them. From the
 * second read on, the student's answer waits for `release` (an answer that takes a moment, as
 * over a real network): no real wait.
 */
function record() {
  const calls = { student: 0, notices: 0 };
  let open: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  const release = async () => {
    await act(async () => {
      open();
      await Promise.resolve();
    });
  };
  server.use(
    http.get(`${TEST_API_URL}/students/${CARLA}`, async () => {
      calls.student += 1;
      if (calls.student > 1) await held;
      return undefined;
    }),
    http.get(`${TEST_API_URL}/students/${CARLA}/exam-notices`, () => {
      calls.notices += 1;
      return undefined;
    }),
  );
  return { calls, release };
}

function expectNothingOfTheNotices() {
  expect(screen.queryByRole('region', { name: 'Avisos de exame' })).not.toBeInTheDocument();
  expect(screen.queryByText(/avisos de exame/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
}

beforeEach(() => {
  server.use(
    ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
  );
});

describe('avisos de exame: aluno que responde 404 (rn019, rn013)', () => {
  it.each([
    ['o mesmo 404 (API simulada)', null],
    ['503', () => HttpResponse.json({ message: BUSY }, { status: 503 })],
  ])(
    'rn019 a janela volta ao foco em "Aluno não encontrado": os avisos (%s) não são pedidos de novo',
    async (_what, answer) => {
      if (answer) server.use(http.get(`${TEST_API_URL}/students/${CARLA}/exam-notices`, answer));
      const { calls, release } = record();
      const { queryClient } = await renderApp({
        route: `/alunos/${CARLA}`,
        signedInAs: 'guardian',
      });
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Aluno não encontrado' }),
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(queryClient.isFetching()).toBe(0);
      });
      expect(queryClient.getQueryState(NOTICES_KEY)?.status).toBe('error');
      expect(calls).toEqual({ student: 1, notices: 1 });

      // The window comes back to the focus: the student is read again (§ 6.4).
      await act(async () => {
        window.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      // While that read is on its way the page is back to loading the student.
      expect(await screen.findByRole('status')).toHaveTextContent('Carregando aluno…');
      expect(calls.student).toBe(2);
      expectNothingOfTheNotices();
      await release();
      // Wait for every read to be over, not only for the event to be handled.
      await waitFor(() => {
        expect(queryClient.isFetching()).toBe(0);
      });
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Aluno não encontrado' }),
      ).toBeInTheDocument();
      expectNothingOfTheNotices();

      expect(calls.notices).toBe(1);
    },
  );
});
