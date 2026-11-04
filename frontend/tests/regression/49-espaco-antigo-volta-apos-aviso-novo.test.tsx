/**
 * Erro: o espaço do aviso fechado com um toque (`NoticeSpace`) fica guardado por
 * `DOUBLE_TAP_MS` no estado da tela, mesmo quando um aviso novo chega nesse intervalo e
 * ocupa o lugar. Se esse aviso novo sai pelo teclado (sem toque, que não guarda espaço) ainda
 * dentro do intervalo, o espaço antigo volta, com a altura do aviso antigo: a lista desce e
 * sobe de novo sem motivo, e, como o espaço agora é `sticky` com `zIndex` acima dos itens,
 * a faixa do aviso fica bloqueada para toques nos Certo/Errado que estão por baixo, sem
 * nenhum toque duplo a filtrar.
 * Esperado: um aviso novo toma o lugar de vez ("A newer notice takes the place at once");
 * quando ele sai pelo teclado, nenhum espaço fica, como em "the keyboard closes it without
 * keeping the space" (§ 6.4, § 6.7, RN006).
 * Issue: #49 (etapa 3, item 5)
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, mockRequirementId } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const FOUNDER = mockRequirementId('Marrom', 7);
const FOUNDER_NAME = 'Nome do fundador do Judô';
const FORBIDDEN = 'Esta área é dos examinadores';

function noticeSpace() {
  return document.querySelector<HTMLElement>('[data-notice-space]');
}

describe('espaço do aviso depois de um aviso novo (§ 6.4, RN006, #49)', () => {
  let releaseFounder: () => void = () => undefined;
  let founderWaiting = false;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    founderWaiting = false;
    const held = new Promise<void>((resolve) => {
      releaseFounder = resolve;
    });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
    server.use(
      http.put(ANSWER_URL, async ({ params }) => {
        const id = String(params.requirementId);
        if (id === FOUNDER) {
          // Segura até `releaseFounder` e recusa (403, recusa final).
          founderWaiting = true;
          await held;
        } else if (id !== PARAR) {
          return undefined;
        }
        return HttpResponse.json({ message: FORBIDDEN }, { status: 403 });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rn006 o aviso novo fechado pelo teclado dentro do intervalo não traz o espaço antigo', async () => {
    const { user } = await renderApp({
      route: examPath(MOCK_EVENT_IDS.open, HELENA),
      signedInAs: 'examiner',
    });
    // A marcação do fundador fica a caminho; a de Parar é recusada e mostra o aviso.
    await user.click(await screen.findByRole('button', { name: `Certo: ${FOUNDER_NAME}` }));
    await waitFor(() => {
      expect(founderWaiting).toBe(true);
    });
    await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));
    const first = await screen.findByRole('alert');
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 96 }),
    );
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });

    // Toque em "Fechar aviso": o espaço fica por `DOUBLE_TAP_MS`.
    fireEvent.click(within(first).getByRole('button', { name: 'Fechar aviso' }), { detail: 1 });
    expect(noticeSpace()).not.toBeNull();

    // Logo depois, a recusa do fundador traz um aviso novo, que toma o lugar.
    releaseFounder();
    for (let step = 0; step < 40 && screen.queryByRole('alert') === null; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
    }
    const second = screen.getByRole('alert');
    expect(second).toHaveTextContent(FOUNDER_NAME);
    expect(noticeSpace()).toBeNull();

    // O aviso novo sai pelo teclado (`detail` 0), ainda dentro do intervalo do primeiro.
    fireEvent.click(within(second).getByRole('button', { name: 'Fechar aviso' }), { detail: 0 });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(noticeSpace()).toBeNull();
  });
});
