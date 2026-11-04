/**
 * qa-frontend, card #49 (etapa 1): cobertura da nova tentativa automática da marcação e do
 * "Tentar de novo" (§ 6.4, RN006, RN007) além de `ExamMarkingRetry.test.tsx`: StrictMode,
 * saída com a requisição em voo, troca de aluno com as tentativas esgotando, outro item
 * marcado durante a espera, exame decidido com o aviso aberto, clique manual com o reenvio em
 * voo e o filtro "Só não marcados". O aviso de um exame apagado pela recusa de outro está em
 * `tests/regression/49-aviso-outro-exame-apaga-aviso-atual.test.tsx`.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProviders } from '../../../src/app/AppProviders';
import { examPath } from '../../../src/app/navigation';
import { createQueryClient } from '../../../src/app/queryClient';
import { createRoutes } from '../../../src/app/routes';
import { createMockAuth } from '../../../src/auth/mockAuth';
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
const SHEET_URL = `${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`;
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const FUNDADOR = mockRequirementId('Marrom', 7);
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

type Outcome = 'busy' | 'forbidden' | 'gate' | 'gateBusy';

let db: MockDb;
let outcomes: Outcome[] = [];
let writes: string[] = [];
let sheetReads = 0;
let openGate: (() => void) | null = null;

function examOf(studentId: string) {
  return db.exams.find((exam) => exam.student_id === studentId)!;
}

function answerOf(requirementId: string, studentId = HELENA) {
  return db.answers.find(
    (item) => item.exam_id === examOf(studentId).id && item.requirement_id === requirementId,
  );
}

function nameOf(id: unknown): string {
  if (id === HELENA) return 'Helena';
  if (id === FABIO) return 'Fábio';
  if (id === PARAR) return 'Parar';
  if (id === FUNDADOR) return 'Fundador';
  return String(id);
}

async function answer(outcome: Outcome | undefined) {
  if (outcome === undefined) return undefined;
  if (outcome === 'gate' || outcome === 'gateBusy') {
    await new Promise<void>((resolve) => {
      openGate = resolve;
    });
    if (outcome === 'gate') return undefined;
    return HttpResponse.json({ message: BUSY }, { status: 503 });
  }
  if (outcome === 'busy') return HttpResponse.json({ message: BUSY }, { status: 503 });
  return HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 });
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
  db.exams.push({
    ...examOf(HELENA),
    id: '6f2c8d1e-4b3a-4c5d-9e6f-0201f2a3b4c9',
    student_id: FABIO,
  });
  outcomes = [];
  writes = [];
  sheetReads = 0;
  openGate = null;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.get(SHEET_URL, () => {
      sheetReads += 1;
      return undefined;
    }),
    http.put(ANSWER_URL, async ({ request, params }) => {
      const body = (await request.clone().json()) as { correct: boolean };
      writes.push(
        `PUT ${nameOf(params.studentId)} ${nameOf(params.requirementId)} ${String(body.correct)}`,
      );
      return answer(outcomes.shift());
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

describe('qa #49: nova tentativa da marcação (§ 6.4, RN006)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn006 em StrictMode (como no main.tsx) reenvia após 503 e oferece "Tentar de novo"', async () => {
    const auth = createMockAuth(window.sessionStorage);
    await auth.signIn({ email: 'examiner@example.com', password: 'senha-teste', role: 'examiner' });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const router = createMemoryRouter(createRoutes({ useMocks: true }), {
      initialEntries: [examPath(OPEN, HELENA)],
    });
    const user = userEvent.setup({ delay: null });
    render(
      <StrictMode>
        <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
          <RouterProvider router={router} />
        </AppProviders>
      </StrictMode>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });

    outcomes = ['busy'];
    await user.click(button('Certo: Parar'));
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(true);
    });
    expect(writes).toEqual(['PUT Helena Parar true', 'PUT Helena Parar true']);
    await waitFor(() => {
      expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    });

    outcomes = ['busy', 'busy', 'busy'];
    await user.click(button('Certo: Nome do fundador do Judô'));
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('button', { name: 'Tentar de novo: Nome do fundador do Judô' }),
    ).toBeInTheDocument();
    expect(button('Certo: Nome do fundador do Judô')).toHaveAttribute('aria-pressed', 'false');
  });

  it('rn006 a requisição em voo recusada (503) depois de sair da tela não é reenviada', async () => {
    outcomes = ['gateBusy'];
    const { user, unmount } = await openHelena();
    await user.click(button('Certo: Parar'));
    await waitFor(() => {
      expect(openGate).not.toBeNull();
    });
    const errors = vi.spyOn(console, 'error');
    unmount();
    // A requisição em voo devolve 503 depois da saída.
    openGate!();
    await settleAWhile();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect(writes).toEqual(['PUT Helena Parar true']);
    expect(retryWaits.every((wait) => wait.aborted)).toBe(true);
    expect(answerOf(PARAR)).toBeUndefined();
  });

  it('rn006 esgotar as tentativas de Helena em Fábio: nada em Fábio; de volta a Helena, "Tentar de novo" grava em Helena', async () => {
    holdRetryWaits();
    outcomes = ['busy', 'busy', 'busy'];
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    const first = await waitAskedFor(0);

    await user.click(await screen.findByRole('link', { name: 'Anterior: Fábio Lima' }));
    await screen.findByRole('heading', { level: 1, name: 'Fábio Lima' });
    const errors = vi.spyOn(console, 'error');
    act(() => {
      first.release();
    });
    const second = await waitAskedFor(1);
    act(() => {
      second.release();
    });
    await waitFor(() => {
      expect(writes).toHaveLength(3);
    });
    await settleAWhile();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();

    await user.click(await screen.findByRole('link', { name: 'Próximo: Helena Prado' }));
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }));
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(true);
    });
    expect(answerOf(PARAR, FABIO)).toBeUndefined();
    expect(writes.at(-1)).toBe('PUT Helena Parar true');
    await waitFor(() => {
      expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    });
  });

  it('rn006 outro item marcado durante a espera: resumo certo no fim (RN007)', async () => {
    holdRetryWaits();
    outcomes = ['busy'];
    const { user } = await openHelena();
    const reads = sheetReads;
    await user.click(button('Certo: Parar'));
    const wait = await waitAskedFor(0);
    await user.click(button('Errado: Nome do fundador do Judô'));
    await waitFor(() => {
      expect(answerOf(FUNDADOR)?.correct).toBe(false);
    });
    // Parar ainda espera: a recarga não vem antes.
    await settleAWhile();
    expect(sheetReads).toBe(reads);
    expect(screen.getByRole('tab', { name: /^Teórico 3\/3$/ })).toBeInTheDocument();

    act(() => {
      wait.release();
    });
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(true);
    });
    await waitFor(() => {
      expect(sheetReads).toBe(reads + 1);
    });
    await waitFor(() => {
      expect(within(theoryScore()).getByText('marcados 3 de 3')).toBeInTheDocument();
    });
    expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rn006 exame decidido enquanto o aviso está aberto: "Tentar de novo" some', async () => {
    outcomes = ['busy', 'busy', 'busy'];
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }),
    ).toBeInTheDocument();

    Object.assign(examOf(HELENA), { status: 'APPROVED' });
    const reads = sheetReads;
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(sheetReads).toBeGreaterThan(reads);
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Tentar de novo/ })).not.toBeInTheDocument();
    });
  });

  it('rn006 clique manual com o reenvio de "Tentar de novo" em voo: um envio por vez, vale o clique', async () => {
    outcomes = ['busy', 'busy', 'busy', 'gate'];
    const { user } = await openHelena();
    await user.click(button('Certo: Parar'));
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }));
    await waitFor(() => {
      expect(openGate).not.toBeNull();
    });
    await user.click(button('Errado: Parar'));
    await settleAWhile();
    expect(writes).toHaveLength(4);
    act(() => {
      openGate!();
    });
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(false);
    });
    expect(writes.slice(3)).toEqual(['PUT Helena Parar true', 'PUT Helena Parar false']);
    await waitFor(() => {
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rn006 com "Só não marcados", o item de "Tentar de novo" fica na lista depois de salvo', async () => {
    outcomes = ['busy', 'busy', 'busy'];
    const { user } = await openHelena();
    await user.click(screen.getByRole('switch', { name: /Só não marcados/ }));
    await user.click(button('Certo: Parar'));
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }));
    expect(button('Certo: Parar')).toHaveFocus();
    await waitFor(() => {
      expect(answerOf(PARAR)?.correct).toBe(true);
    });
    await settleAWhile();
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
  });
});
