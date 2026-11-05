/**
 * Erro: na tela "Exame do aluno" (§ 6.4), o examinador marca "Certo: Parar" na Helena e a API
 * responde 503; durante a espera da nova tentativa automática ele vai para o Fábio (aluno
 * anterior) e marca "Certo: Parar" lá, recusado em definitivo (403): o aviso vermelho do Fábio
 * aparece. Quando as novas tentativas da Helena também são recusadas (503, 503), o aviso do
 * Fábio some da tela do Fábio sem o examinador fechá-lo. O hook `useExamMarking` guarda um só
 * aviso para todos os exames, e a recusa final da Helena substitui o do Fábio.
 * Esperado: o aviso de uma marcação recusada fica na tela do exame dele até ser fechado ou
 * substituído por outra recusa do mesmo exame (RN006, "em erro, volta e avisa"); a recusa de
 * outro exame, que agora pode chegar segundos depois da troca de aluno por causa das novas
 * tentativas, não aparece nem apaga nada no exame atual. Voltando à Helena, o aviso dela
 * (com "Tentar de novo") continua lá.
 * Issue: #49
 */
import type { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryKeys } from '../../src/api/queries';
import { examPath } from '../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { holdRetryWaits, retryWaits } from '../retryWaits';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const FABIO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e06';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const FORBIDDEN = 'Esta área é dos examinadores';

let db: MockDb;
/** Respostas das próximas marcações, em ordem: 503 ou 403. */
let outcomes: (503 | 403)[] = [];
let writes: string[] = [];

async function waitAskedFor(index: number) {
  await waitFor(() => {
    expect(retryWaits).toHaveLength(index + 1);
  });
  return retryWaits[index]!;
}

/**
 * Espera, sem tempo real, a recusa final da Helena terminar na tela: depois de guardar o aviso
 * dela, a tela pede a releitura do exame dela (marca a consulta como desatualizada), na mesma
 * volta em que guarda o aviso.
 */
function helenaRefusalEnded(queryClient: QueryClient): Promise<void> {
  const invalidated = () =>
    queryClient.getQueryState(queryKeys.examSheet(OPEN, HELENA))?.isInvalidated === true;
  return new Promise((resolve) => {
    if (invalidated()) {
      resolve();
      return;
    }
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (!invalidated()) return;
      unsubscribe();
      resolve();
    });
  });
}

describe('aviso de recusa por exame (§ 6.4, RN006)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    const helena = db.exams.find((exam) => exam.student_id === HELENA)!;
    db.exams.push({ ...helena, id: '6f2c8d1e-4b3a-4c5d-9e6f-0201f2a3b4c9', student_id: FABIO });
    outcomes = [];
    writes = [];
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    server.use(
      http.put(ANSWER_URL, ({ params }) => {
        writes.push(String(params.studentId));
        const status = outcomes.shift();
        if (status === undefined) return undefined;
        return HttpResponse.json({ message: status === 503 ? BUSY : FORBIDDEN }, { status });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn006 a recusa final de outro exame não apaga o aviso do exame na tela', async () => {
    holdRetryWaits();
    outcomes = [503];
    const { user, queryClient } = await renderApp({
      route: examPath(OPEN, HELENA),
      signedInAs: 'examiner',
    });
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));
    const first = await waitAskedFor(0);

    // Durante a espera, vai para o Fábio e tem uma marcação recusada lá.
    await user.click(await screen.findByRole('link', { name: 'Anterior: Fábio Lima' }));
    await screen.findByRole('heading', { level: 1, name: 'Fábio Lima' });
    outcomes = [403];
    await user.click(await screen.findByRole('button', { name: 'Certo: Parar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(FORBIDDEN);

    // As novas tentativas da Helena se esgotam com o Fábio na tela.
    outcomes = [503, 503];
    act(() => {
      first.release();
    });
    const second = await waitAskedFor(1);
    act(() => {
      second.release();
    });
    await waitFor(() => {
      expect(writes).toEqual([HELENA, FABIO, HELENA, HELENA]);
    });
    await act(async () => {
      await helenaRefusalEnded(queryClient);
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Fábio Lima' })).toBeInTheDocument();
    const fabioAlert = screen.getByRole('alert');
    expect(fabioAlert).toHaveTextContent(FORBIDDEN);
    expect(fabioAlert).not.toHaveTextContent(BUSY);

    // De volta à Helena, o aviso dela está lá, com "Tentar de novo".
    await user.click(await screen.findByRole('link', { name: 'Próximo: Helena Prado' }));
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    const helenaAlert = await screen.findByRole('alert');
    expect(helenaAlert).toHaveTextContent(BUSY);
    expect(
      within(helenaAlert).getByRole('button', { name: 'Tentar de novo: Parar' }),
    ).toBeInTheDocument();
  });
});
