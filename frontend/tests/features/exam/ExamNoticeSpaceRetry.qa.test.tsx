/**
 * QA (#49, etapa 3): o espaço do aviso depois de "Tentar de novo" e de uma recusa nova dentro
 * de `DOUBLE_TAP_MS` (§ 6.4, § 6.7, RN006). O espaço guardado pelo toque some de vez quando o
 * aviso novo chega, nunca aparece junto com um aviso e não volta quando o aviso novo sai pelo
 * teclado.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, mockRequirementId } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);

function noticeSpace() {
  return document.querySelector<HTMLElement>('[data-notice-space]');
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function advanceUntil(done: () => boolean, step = 5, max = 400) {
  for (let i = 0; i < max && !done(); i += 1) await advance(step);
}

describe('espaço do aviso depois de "Tentar de novo" (§ 6.4, RN006, #49)', () => {
  let pararCalls = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    pararCalls = 0;
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
    server.use(
      http.put(ANSWER_URL, ({ params }) => {
        if (String(params.requirementId) !== PARAR) return undefined;
        pararCalls += 1;
        // O envio e os dois reenvios automáticos: 503 (passageira, com "Tentar de novo").
        // Depois de "Tentar de novo": 403 na hora (recusa final, aviso novo na janela).
        if (pararCalls <= 3) {
          return HttpResponse.json({ message: 'Serviço indisponível.' }, { status: 503 });
        }
        return HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rn006 a recusa nova logo após "Tentar de novo" tira o espaço de vez, sem piscar', async () => {
    await renderApp({ route: examPath(MOCK_EVENT_IDS.open, HELENA), signedInAs: 'examiner' });
    const certo = await screen.findByRole('button', { name: 'Certo: Parar' });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });
    fireEvent.click(certo, { detail: 1 });
    await advanceUntil(() => screen.queryByRole('alert') !== null, 20, 400);
    const first = screen.getByRole('alert');
    expect(pararCalls).toBe(3);
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 96 }),
    );

    // Nenhum commit pode ter o aviso e o espaço ao mesmo tempo.
    let together = false;
    const observer = new MutationObserver(() => {
      if (noticeSpace() !== null && screen.queryByRole('alert') !== null) together = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Toque em "Tentar de novo": o aviso sai e o espaço fica.
    fireEvent.click(within(first).getByRole('button', { name: 'Tentar de novo: Parar' }), {
      detail: 1,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(noticeSpace()).not.toBeNull();
    expect(noticeSpace()?.style.height).toBe('96px');

    // A recusa final chega dentro da janela: o aviso novo toma o lugar.
    await advanceUntil(() => screen.queryByRole('alert') !== null, 5, 60);
    const second = screen.getByRole('alert');
    expect(pararCalls).toBe(4);
    expect(noticeSpace()).toBeNull();

    // Sai pelo teclado ainda dentro da janela: nenhum espaço volta, nem depois.
    fireEvent.click(within(second).getByRole('button', { name: 'Fechar aviso' }), { detail: 0 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(noticeSpace()).toBeNull();
    await advance(600);
    expect(noticeSpace()).toBeNull();

    observer.disconnect();
    expect(together).toBe(false);
  });

  it('rn006 o aviso novo fechado por toque guarda o próprio espaço, que some depois da janela', async () => {
    await renderApp({ route: examPath(MOCK_EVENT_IDS.open, HELENA), signedInAs: 'examiner' });
    const certo = await screen.findByRole('button', { name: 'Certo: Parar' });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });
    fireEvent.click(certo, { detail: 1 });
    await advanceUntil(() => screen.queryByRole('alert') !== null, 20, 400);
    const first = screen.getByRole('alert');
    fireEvent.click(within(first).getByRole('button', { name: 'Tentar de novo: Parar' }), {
      detail: 1,
    });
    await advanceUntil(() => screen.queryByRole('alert') !== null, 5, 60);
    const second = screen.getByRole('alert');
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 72 }),
    );

    fireEvent.click(within(second).getByRole('button', { name: 'Fechar aviso' }), { detail: 1 });
    expect(noticeSpace()?.style.height).toBe('72px');
    await advance(450);
    expect(noticeSpace()).not.toBeNull();
    await advance(100);
    expect(noticeSpace()).toBeNull();
  });
});
