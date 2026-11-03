/**
 * Regressão do card #24 (§ 6.4, § 6.7): o foco cai na página quando o layout do exame muda.
 *
 * Observado: com o foco num botão "Certo" de um item, no "Aprovar" da coluna do notebook ou no
 * "Decidir" da barra do celular, cruzar a largura de 1024 px (girar o tablet, dar zoom de 200%
 * no notebook) remonta a lista de itens e a área de decisão, e `document.activeElement` vira o
 * body: quem usa teclado ou leitor de tela perde o lugar no exame.
 *
 * Esperado: o foco continua no mesmo botão do item ("Certo: …"), e o foco que estava na área
 * de decisão vai para a área de decisão do novo layout (barra ou coluna), nunca para o body.
 *
 * O stub de `matchMedia` do setup não avisa mudanças; aqui os ouvintes são guardados e
 * chamados, como o navegador faz quando a largura muda.
 */
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { examPath } from '../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { mediaMatches, setViewportWidth } from '../viewport';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

type Listener = (event: { matches: boolean; media: string }) => void;
let listeners: { query: string; listener: Listener }[] = [];
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

function stubMatchMedia() {
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
}

/** The window width changes: every media query listener hears it. */
function resizeTo(width: number) {
  setViewportWidth(width);
  act(() => {
    for (const { query, listener } of listeners) {
      listener({ matches: mediaMatches(query), media: query });
    }
  });
}

async function openExam() {
  const rendered = await renderApp({
    route: examPath(MOCK_EVENT_IDS.open, HELENA),
    signedInAs: 'examiner',
  });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

function decisionArea(layout: 'column' | 'bar'): HTMLElement {
  const area = document.querySelector<HTMLElement>(`[data-decision-area="${layout}"]`);
  if (area === null) throw new Error(`A área de decisão "${layout}" deveria estar na tela.`);
  return area;
}

/** Leave time for any late focus move (effects, timers of zero). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

describe('#24 foco na troca de layout do exame (§ 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    const db = createMockDb({ includeShowcase: true });
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    stubMatchMedia();
  });

  afterEach(() => {
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    vi.useRealTimers();
  });

  it('keeps the focus on the same Certo button when the notebook turns into a phone', async () => {
    await openExam();
    const [certo] = screen.getAllByRole('button', { name: /^Certo: / });
    if (certo === undefined) throw new Error('O exame deveria ter um botão Certo.');
    const name = certo.getAttribute('aria-label') ?? '';
    expect(name).not.toBe('');
    act(() => {
      certo.focus();
    });
    expect(certo).toHaveFocus();

    resizeTo(390);
    await settle();

    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('button', { name })).toHaveFocus();
  });

  it('moves the focus from Aprovar of the column to the phone bar, not to the page', async () => {
    await openExam();
    const column = screen.getByRole('complementary', { name: 'Resumo do exame' });
    const approve = await within(column).findByRole('button', { name: 'Aprovar' });
    act(() => {
      approve.focus();
    });
    expect(approve).toHaveFocus();

    resizeTo(390);
    await settle();

    expect(document.activeElement).not.toBe(document.body);
    expect(decisionArea('bar').contains(document.activeElement)).toBe(true);
  });

  it('moves the focus from Decidir of the bar to the notebook column, not to the page', async () => {
    setViewportWidth(390);
    await openExam();
    const decide = await within(decisionArea('bar')).findByRole('button', {
      name: /Decidir/,
    });
    act(() => {
      decide.focus();
    });
    expect(decide).toHaveFocus();

    resizeTo(1280);
    await settle();

    expect(document.activeElement).not.toBe(document.body);
    expect(decisionArea('column').contains(document.activeElement)).toBe(true);
  });
});
