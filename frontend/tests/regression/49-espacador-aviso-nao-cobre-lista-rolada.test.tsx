/**
 * Erro: o aviso de marcação recusada é `position: sticky` (fica preso no topo da tela enquanto
 * o examinador rola a lista), mas o espaçador que guarda o lugar dele depois de um toque em
 * "Fechar aviso" ou "Tentar de novo" é um `div` comum, no fluxo da página. Com a lista
 * rolada (o caso comum: o examinador marca itens mais abaixo), o lugar do espaçador fica lá
 * em cima, fora da tela, e a faixa onde o aviso aparecia passa a mostrar os itens que
 * estavam por baixo dele: o segundo toque do duplo toque cai num Certo/Errado que o
 * examinador não mirou, justamente o que o espaçador devia evitar.
 * Esperado: durante `DOUBLE_TAP_MS`, o espaçador ocupa o mesmo lugar na tela que o aviso
 * ocupava, rolada ou não a lista: mesmo `position` (sticky), mesmo `top` e a mesma camada
 * (`zIndex`) do aviso, para receber o toque por cima dos botões dos itens (os botões do
 * Mantine têm `position: relative`). Continua `aria-hidden` e com a altura do aviso (§ 6.4,
 * § 6.7, RN006).
 * Issue: #49 (etapa 3, item 5)
 *
 * jsdom não tem layout: o teste compara o posicionamento declarado do espaçador com o do
 * aviso que ele substitui.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { DOUBLE_TAP_MS } from '../../src/features/exam/markClickGuard';
import { MOCK_EVENT_IDS, createMockDb, mockRequirementId } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);

function noticeSpace() {
  return document.querySelector<HTMLElement>('[data-notice-space]');
}

describe('espaço do aviso de marcação recusada com a lista rolada (§ 6.4, RN006, #49)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
    server.use(
      http.put(ANSWER_URL, ({ params }) =>
        String(params.requirementId) === PARAR
          ? HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 })
          : undefined,
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rn006 o espaçador fica no mesmo lugar da tela que o aviso fechado com um toque', async () => {
    const { user } = await renderApp({
      route: examPath(MOCK_EVENT_IDS.open, HELENA),
      signedInAs: 'examiner',
    });
    await user.click(await screen.findByRole('button', { name: 'Certo: Parar' }));
    const alert = await screen.findByRole('alert');
    vi.spyOn(alert, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 320, height: 120 }),
    );
    const notice = window.getComputedStyle(alert);
    const placed = { position: notice.position, top: notice.top, zIndex: notice.zIndex };
    // O aviso fica preso no topo da tela enquanto a lista rola.
    expect(placed.position).toBe('sticky');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });

    fireEvent.click(within(alert).getByRole('button', { name: 'Fechar aviso' }), { detail: 1 });

    const space = noticeSpace();
    expect(space).not.toBeNull();
    expect(space).toHaveAttribute('aria-hidden', 'true');
    expect(space).toHaveStyle({ height: '120px' });
    const kept = window.getComputedStyle(space!);
    expect({ position: kept.position, top: kept.top, zIndex: kept.zIndex }).toEqual(placed);

    act(() => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS);
    });
    expect(noticeSpace()).toBeNull();
  });
});
