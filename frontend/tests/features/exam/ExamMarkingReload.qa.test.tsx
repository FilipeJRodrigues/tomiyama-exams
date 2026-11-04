/**
 * qa-frontend, card #49 (etapa 1, reteste): recarga do exame depois da última tentativa de
 * uma marcação que pode ter sido gravada (504, rede…), além de `ExamMarkingRetry.test.tsx`:
 * tentativas que se esgotam com outro aluno na tela, "Tentar de novo" depois da recarga que
 * já mostra o item salvo (marcar e desmarcar), foco da janela durante a espera, dois itens
 * recusados ao mesmo tempo, recarga que falha por rede e saída da tela durante a espera.
 *
 * Helena (evento aberto, faixa Marrom, exame em andamento): Teórico 1/3 marcado (Professor
 * certo; Parar e Nome do fundador não marcados), 33,3%.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { holdRetryWaits, retryWaits } from '../../retryWaits';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const FABIO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e06';
const HELENA_SHEET = `${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`;
const FABIO_SHEET = `${TEST_API_URL}/events/${OPEN}/exams/${FABIO}`;
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PROFESSOR = mockRequirementId('Marrom', 5);
const PARAR = mockRequirementId('Marrom', 6);
const FUNDADOR = mockRequirementId('Marrom', 7);
const TIMEOUT = 'Endpoint request timed out';

let db: MockDb;
let helenaReads = 0;
let fabioReads = 0;
/** Recusas 504 que ainda faltam por item; a primeira de cada série grava antes de recusar. */
let timeouts: Record<string, number> = {};
let landed = new Set<string>();
let writes: string[] = [];
let sheetDown = false;

function examOf(studentId: string) {
  return db.exams.find((exam) => exam.student_id === studentId)!;
}

/** Grava (ou apaga) a marcação na tabela, como se a resposta tivesse se perdido no gateway. */
function land(requirementId: string, correct: boolean | null) {
  const exam = examOf(HELENA);
  const template = db.answers.find((item) => item.exam_id === exam.id)!;
  db.answers = db.answers.filter(
    (item) => !(item.exam_id === exam.id && item.requirement_id === requirementId),
  );
  if (correct !== null) {
    db.answers.push({ ...template, requirement_id: requirementId, correct });
  }
}

function refuse(requirementId: string, correct: boolean | null) {
  const left = timeouts[requirementId] ?? 0;
  if (left === 0) return undefined;
  timeouts[requirementId] = left - 1;
  if (!landed.has(requirementId)) {
    landed.add(requirementId);
    land(requirementId, correct);
  }
  return HttpResponse.json({ message: TIMEOUT }, { status: 504 });
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
  db.exams.push({
    ...examOf(HELENA),
    id: '6f2c8d1e-4b3a-4c5d-9e6f-0201f2a3b4c9',
    student_id: FABIO,
  });
  helenaReads = 0;
  fabioReads = 0;
  timeouts = {};
  landed = new Set();
  writes = [];
  sheetDown = false;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.get(HELENA_SHEET, () => {
      helenaReads += 1;
      return sheetDown ? HttpResponse.error() : undefined;
    }),
    http.get(FABIO_SHEET, () => {
      fabioReads += 1;
      return undefined;
    }),
    http.put(ANSWER_URL, async ({ request, params }) => {
      const body = (await request.clone().json()) as { correct: boolean };
      const id = String(params.requirementId);
      writes.push(`PUT ${String(params.studentId)} ${id}`);
      if (params.studentId !== HELENA) return undefined;
      return refuse(id, body.correct);
    }),
    http.delete(ANSWER_URL, ({ params }) => {
      const id = String(params.requirementId);
      writes.push(`DELETE ${String(params.studentId)} ${id}`);
      if (params.studentId !== HELENA) return undefined;
      return refuse(id, null);
    }),
  );
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

function theoryScore() {
  return screen.getByTestId('exam-scores').querySelector<HTMLElement>('[data-score="THEORY"]')!;
}

async function waitAskedFor(index: number) {
  await waitFor(() => {
    expect(retryWaits).toHaveLength(index + 1);
  });
  return retryWaits[index]!;
}

async function settleAWhile() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

async function openHelena() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

describe('recarga depois da última tentativa (qa, § 6.4, RN006, RN007)', () => {
  let consoleError = vi.spyOn(console, 'error');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
    consoleError = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    // Nenhum erro de React além do aviso de `act(...)` do ambiente de teste.
    const errors = consoleError.mock.calls.filter(
      (args: unknown[]) => !String(args[0]).includes('not wrapped in act'),
    );
    expect(errors).toEqual([]);
    consoleError.mockRestore();
    vi.useRealTimers();
  });

  it('rn006 tentativas da Helena esgotam com o Fábio na tela: o Fábio não recarrega nem recebe aviso; a Helena volta com o estado da API e o aviso', async () => {
    holdRetryWaits();
    timeouts = { [PARAR]: 3 };
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    const first = await waitAskedFor(0);

    await user.click(await screen.findByRole('link', { name: 'Anterior: Fábio Lima' }));
    await screen.findByRole('heading', { level: 1, name: 'Fábio Lima' });
    await settleAWhile();
    const fabio = fabioReads;

    act(() => {
      first.release();
    });
    const second = await waitAskedFor(1);
    act(() => {
      second.release();
    });
    await waitFor(() => {
      expect(writes.filter((write) => write === `PUT ${HELENA} ${PARAR}`)).toHaveLength(3);
    });
    await settleAWhile();

    expect(fabioReads).toBe(fabio);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(writes.some((write) => write.includes(FABIO))).toBe(false);

    await user.click(await screen.findByRole('link', { name: 'Próximo: Helena Prado' }));
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    await waitFor(() => {
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível salvar a marcação de "Parar"');
    expect(within(alert).getByRole('button', { name: 'Tentar de novo: Parar' })).toBeVisible();
  });

  it('rn006 "Tentar de novo" depois da recarga que já mostra o item salvo: reenvio idempotente, aviso some', async () => {
    timeouts = { [PARAR]: 3 };
    const { user } = await openHelena();
    const reads = helenaReads;
    await user.click(button('Certo: Parar'));
    await waitFor(() => {
      expect(helenaReads).toBe(reads + 1);
    });
    await waitFor(() => {
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });

    await user.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Tentar de novo: Parar' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(writes.filter((write) => write === `PUT ${HELENA} ${PARAR}`)).toHaveLength(4);
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    await settleAWhile();
    expect(helenaReads).toBe(reads + 1);
  });

  it('rn006 desmarcar com 504 que apagou: recarga mostra não marcado e "Tentar de novo" desmarca de novo sem erro', async () => {
    timeouts = { [PROFESSOR]: 3 };
    const { user } = await openHelena();
    const reads = helenaReads;
    expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'true');
    await user.click(button('Certo: Professor'));
    await waitFor(() => {
      expect(helenaReads).toBe(reads + 1);
    });
    await waitFor(() => {
      expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'false');
    });
    expect(screen.getByRole('tab', { name: /^Teórico 0\/3$/ })).toBeInTheDocument();
    expect(within(theoryScore()).getByText('0%')).toBeInTheDocument();

    await user.click(
      within(screen.getByRole('alert')).getByRole('button', {
        name: 'Tentar de novo: Professor',
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(writes.filter((write) => write === `DELETE ${HELENA} ${PROFESSOR}`)).toHaveLength(4);
    expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'false');
  });

  it('rn006 foco da janela durante a espera e 504 no fim: uma recarga só, depois de tudo', async () => {
    holdRetryWaits();
    timeouts = { [PARAR]: 3 };
    const { user } = await openHelena();
    const reads = helenaReads;
    await user.click(button('Certo: Parar'));
    const first = await waitAskedFor(0);
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await settleAWhile();
    expect(helenaReads).toBe(reads);

    act(() => {
      first.release();
    });
    const second = await waitAskedFor(1);
    act(() => {
      second.release();
    });
    await screen.findByRole('alert');
    await waitFor(() => {
      expect(helenaReads).toBe(reads + 1);
    });
    await settleAWhile();
    expect(helenaReads).toBe(reads + 1);
    expect(screen.getByRole('button', { name: 'Tentar de novo: Parar' })).toBeInTheDocument();
  });

  it('rn006 dois itens recusados por 504 ao mesmo tempo: uma recarga só, com o resumo da API', async () => {
    timeouts = { [PARAR]: 3, [FUNDADOR]: 3 };
    const { user } = await openHelena();
    const reads = helenaReads;
    await user.click(button('Certo: Parar'));
    await user.click(button('Errado: Nome do fundador do Judô'));
    await waitFor(() => {
      expect(writes).toHaveLength(6);
    });
    await waitFor(() => {
      expect(helenaReads).toBe(reads + 1);
    });
    await settleAWhile();
    expect(helenaReads).toBe(reads + 1);
    // As duas primeiras tentativas gravaram: Teórico 3/3, 2 certos de 3.
    await waitFor(() => {
      expect(button('Errado: Nome do fundador do Judô')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('rn006 a recarga depois da última tentativa falha por rede: a ficha e o aviso ficam', async () => {
    timeouts = { [PARAR]: 3 };
    const { user } = await openHelena();
    const reads = helenaReads;
    sheetDown = true;
    await user.click(button('Certo: Parar'));
    await waitFor(() => {
      expect(helenaReads).toBeGreaterThan(reads);
    });
    await settleAWhile();
    expect(screen.queryByText('Não foi possível carregar o exame')).not.toBeInTheDocument();
    expect(button('Certo: Parar')).toBeInTheDocument();
    expect(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Tentar de novo: Parar' }),
    ).toBeInTheDocument();
  });

  it('rn006 sair da tela na espera depois de um 504 que gravou: ao voltar, a ficha vem da API', async () => {
    holdRetryWaits();
    timeouts = { [PARAR]: 1 };
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    const first = await waitAskedFor(0);

    await user.click(
      within(screen.getByRole('navigation', { name: 'Caminho' })).getByRole('link', {
        name: 'Dia do exame',
      }),
    );
    await waitFor(() => {
      expect(first.aborted).toBe(true);
    });
    await settleAWhile();
    expect(writes).toHaveLength(1);

    await user.click(await screen.findByRole('link', { name: /Helena Prado/ }));
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    await waitFor(() => {
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
