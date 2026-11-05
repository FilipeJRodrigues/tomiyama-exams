/**
 * Erro: ao fechar o diálogo "Aprovar exame" (§ 6.4, RN008) com "Cancelar", o foco às vezes
 * fica perdido na página em vez de voltar ao botão que abriu o diálogo (ou ao "Decidir" da
 * barra, quando a tela virou celular). Foi o que fez oscilar, sob carga, o caso "rn008 opened
 * in the column, turned into the phone bar…" de `ExamStep3.qa.test.tsx` (5 s esperando o foco).
 * Causa: o Mantine chama `onExitTransitionEnd` (`flow.dialogClosed`) antes de tirar o diálogo
 * da tela; `giveFocusBack` (`useDecisionFlow.ts`) espera um `setTimeout(0)` e chama
 * `focusIfLost` sem dizer que o diálogo está saindo. Se esse temporizador dispara antes de o
 * React desenhar o fechamento (o React desenha pelo agendador dele, que sob carga fica para a
 * volta seguinte do laço), o foco ainda está no "Cancelar", conectado, e não conta como
 * perdido; logo depois o diálogo some e o foco cai na página.
 * Esperado: o foco volta ao mesmo botão (ou ao da nova disposição) seja qual for a ordem entre
 * o temporizador e o desenho do fechamento (§ 6.7). Vale também para o painel "Decidir o exame"
 * do celular (`panelClosed`, mesmo `giveFocusBack`). As outras telas já dizem `leaving: [diálogo]`
 * ao `focusIfLost` (faixas, eventos, requisitos, logo).
 * Issue: #63
 *
 * Como o teste força a ordem ruim, sem espera real: depois do "Cancelar", todo `setTimeout(0)`
 * pedido de dentro de outro temporizador (o fim da animação de saída do Mantine) roda numa
 * microtarefa, antes do desenho do React. É a ordem que a máquina carregada produz às vezes.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { mediaMatches, setViewportWidth } from '../viewport';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

type Listener = (event: { matches: boolean; media: string }) => void;
let listeners: { query: string; listener: Listener }[] = [];
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalSetTimeout = Object.getOwnPropertyDescriptor(window, 'setTimeout');
const realSetTimeout = window.setTimeout.bind(window);

/**
 * From now on, a `setTimeout(0)` asked for while another timer runs (Mantine's end of the exit
 * transition calls `onExitTransitionEnd` there) runs in a microtask: before React draws the
 * closing. Every other timer is untouched.
 */
function zeroTimersBeforeTheClosingRenders() {
  let insideTimer = 0;
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof handler !== 'function') return realSetTimeout(handler, ms, ...args);
    const callback = handler as (...values: unknown[]) => void;
    if (!ms && insideTimer > 0) {
      queueMicrotask(() => {
        callback(...args);
      });
      return 0;
    }
    return realSetTimeout(
      (...values: unknown[]) => {
        insideTimer += 1;
        try {
          callback(...values);
        } finally {
          insideTimer -= 1;
        }
      },
      ms,
      ...args,
    );
  }) as typeof window.setTimeout;
}

function resizeTo(width: number) {
  setViewportWidth(width);
  act(() => {
    for (const { query, listener } of listeners) {
      listener({ matches: mediaMatches(query), media: query });
    }
  });
}

function decisionArea(layout: 'column' | 'bar'): HTMLElement {
  const area = document.querySelector<HTMLElement>(`[data-decision-area="${layout}"]`);
  if (area === null) throw new Error(`A área de decisão "${layout}" deveria estar na tela.`);
  return area;
}

async function openApproveDialog() {
  setViewportWidth(1280);
  const { user } = await renderApp({
    route: examPath(MOCK_EVENT_IDS.open, HELENA),
    signedInAs: 'examiner',
  });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  const approve = await within(decisionArea('column')).findByRole('button', { name: 'Aprovar' });
  await user.click(approve);
  const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
  return { user, approve, modal };
}

describe('decision dialog, focus back whatever the order of timer and closing (§ 6.7, RN008, #63)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    const db = createMockDb({ includeShowcase: true });
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    listeners = [];
    window.matchMedia = ((query: string) => ({
      matches: mediaMatches(query),
      media: query,
      onchange: null,
      addListener: (listener: Listener) => {
        listeners.push({ query, listener });
      },
      removeListener: () => undefined,
      addEventListener: (_type: string, listener: Listener) => {
        listeners.push({ query, listener });
      },
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    if (originalSetTimeout) Object.defineProperty(window, 'setTimeout', originalSetTimeout);
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    vi.useRealTimers();
  });

  it('rn008 Cancelar gives the focus back to "Aprovar" in the column', async () => {
    const { user, approve, modal } = await openApproveDialog();

    zeroTimersBeforeTheClosingRenders();
    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(approve).toHaveFocus();
    });
  });

  it('rn008 turned into the phone bar: Cancelar gives the focus to "Decidir"', async () => {
    const { user, modal } = await openApproveDialog();
    resizeTo(390);

    zeroTimersBeforeTheClosingRenders();
    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const decide = within(decisionArea('bar')).getByRole('button', { name: 'Decidir' });
    await waitFor(() => {
      expect(decide).toHaveFocus();
    });
  });

  it('rn008 the phone panel closed with Esc gives the focus back to "Decidir"', async () => {
    setViewportWidth(390);
    const { user } = await renderApp({
      route: examPath(MOCK_EVENT_IDS.open, HELENA),
      signedInAs: 'examiner',
    });
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    const decide = await within(decisionArea('bar')).findByRole('button', { name: 'Decidir' });
    await user.click(decide);
    await screen.findByRole('dialog', { name: 'Decidir o exame' });

    zeroTimersBeforeTheClosingRenders();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(decide).toHaveFocus();
    });
  });
});
