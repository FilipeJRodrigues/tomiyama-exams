/**
 * § 6.4 / § 6.7, RN008 (#63, QA): the focus after the decision dialog or the phone panel
 * closes, with the give-back timer running before React draws the closing (the order a loaded
 * machine gives at times), on the paths the regression `63-foco-decisao-timer-antes-do-
 * fechamento` leaves out: Esc and "Fechar" of the dialog, a refusal that swaps the buttons,
 * the dialog opened from the panel, the decision saved, the screen turning into the column,
 * and opening the dialog or the panel again right after closing.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { mediaMatches, setViewportWidth } from '../../viewport';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const DECISION_URL = `${TEST_API_URL}/events/:id/exams/:studentId/decision`;

type Listener = (event: { matches: boolean; media: string }) => void;
let listeners: { query: string; listener: Listener }[] = [];
let db: MockDb;
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalSetTimeout = Object.getOwnPropertyDescriptor(window, 'setTimeout');
const realSetTimeout = window.setTimeout.bind(window);

/**
 * From now on, a `setTimeout(0)` asked for while another timer runs (Mantine's end of the exit
 * transition calls `onExitTransitionEnd` there) runs in a microtask: before React draws the
 * closing. Every other timer is untouched. Same as the regression of #63.
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

function summary() {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

async function openHelena(width: number) {
  setViewportWidth(width);
  const rendered = await renderApp({
    route: examPath(MOCK_EVENT_IDS.open, HELENA),
    signedInAs: 'examiner',
  });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

async function noDialogInTheDom() {
  await waitFor(() => {
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
}

/** One more turn of the timers: every give-back asked for so far has run. */
async function timersSettle() {
  await act(async () => {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  });
}

describe('decision focus whatever the order of timer and closing, QA (§ 6.7, RN008, #63)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
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

  it('rn008 Esc on the dialog gives the focus back to "Aprovar"', async () => {
    const { user } = await openHelena(1280);
    const approve = await within(decisionArea('column')).findByRole('button', { name: 'Aprovar' });
    await user.click(approve);
    await screen.findByRole('dialog', { name: 'Aprovar exame' });

    zeroTimersBeforeTheClosingRenders();
    await user.keyboard('{Escape}');
    await noDialogInTheDom();

    await waitFor(() => {
      expect(approve).toHaveFocus();
    });
  });

  it('rn008 "Fechar" of the dialog gives the focus back to "Reprovar"', async () => {
    const { user } = await openHelena(1280);
    const fail = await within(decisionArea('column')).findByRole('button', { name: 'Reprovar' });
    await user.click(fail);
    const modal = await screen.findByRole('dialog', { name: 'Reprovar exame' });

    zeroTimersBeforeTheClosingRenders();
    await user.click(within(modal).getByRole('button', { name: 'Fechar' }));
    await noDialogInTheDom();

    await waitFor(() => {
      expect(fail).toHaveFocus();
    });
  });

  it('rn008 a 403 swaps the buttons: Cancelar gives the focus to the decision area', async () => {
    server.use(
      http.post(DECISION_URL, () => {
        db.settings.sensei_user_id = 'mock-examiner-2';
        return HttpResponse.json(
          { message: 'Somente o sensei pode decidir o exame' },
          { status: 403 },
        );
      }),
    );
    const { user } = await openHelena(1280);
    await user.click(
      await within(decisionArea('column')).findByRole('button', { name: 'Aprovar' }),
    );
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    await within(summary()).findByText('A decisão é do sensei examinadora@example.com');

    zeroTimersBeforeTheClosingRenders();
    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
    await noDialogInTheDom();

    await waitFor(() => {
      expect(decisionArea('column')).toHaveFocus();
    });
  });

  it('rn008 phone: the dialog opened from the panel, Cancelar gives the focus back to the panel button', async () => {
    const { user } = await openHelena(390);
    await user.click(await within(decisionArea('bar')).findByRole('button', { name: 'Decidir' }));
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    const approve = within(panel).getByRole('button', { name: 'Aprovar' });
    await user.click(approve);
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });

    zeroTimersBeforeTheClosingRenders();
    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Aprovar exame' })).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(approve).toHaveFocus();
    });
    expect(screen.getByRole('dialog', { name: 'Decidir o exame' })).toBeInTheDocument();
  });

  it('rn009 notebook: the decision saved keeps the focus on "Decidido por"', async () => {
    const { user } = await openHelena(1280);
    await user.click(
      await within(decisionArea('column')).findByRole('button', { name: 'Aprovar' }),
    );
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });

    zeroTimersBeforeTheClosingRenders();
    await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
    const decided = await within(decisionArea('column')).findByText('Decidido por Sensei Simulado');
    await noDialogInTheDom();
    await timersSettle();

    expect(decided.closest('[data-slot="decision"]')).toHaveFocus();
  });

  it('rn009 phone: the decision saved from the panel keeps the focus on "Decidido por" of the bar', async () => {
    const { user } = await openHelena(390);
    await user.click(await within(decisionArea('bar')).findByRole('button', { name: 'Decidir' }));
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    await user.click(within(panel).getByRole('button', { name: 'Reprovar' }));
    const modal = await screen.findByRole('dialog', { name: 'Reprovar exame' });

    zeroTimersBeforeTheClosingRenders();
    await user.click(within(modal).getByRole('button', { name: 'Reprovar' }));
    const decided = await within(decisionArea('bar')).findByText('Decidido por Sensei Simulado');
    await noDialogInTheDom();
    await timersSettle();

    expect(decided.closest('[data-slot="decision"]')).toHaveFocus();
  });

  it('rn008 opened in the phone panel, turned into the column: Esc gives the focus to the same button', async () => {
    const { user } = await openHelena(390);
    await user.click(await within(decisionArea('bar')).findByRole('button', { name: 'Decidir' }));
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    await user.click(within(panel).getByRole('button', { name: 'Reprovar' }));
    await screen.findByRole('dialog', { name: 'Reprovar exame' });
    resizeTo(1280);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Decidir o exame' })).not.toBeInTheDocument();
    });

    zeroTimersBeforeTheClosingRenders();
    await user.keyboard('{Escape}');
    await noDialogInTheDom();

    const same = within(decisionArea('column')).getByRole('button', { name: 'Reprovar' });
    await waitFor(() => {
      expect(same).toHaveFocus();
    });
  });

  it('rn008 the dialog opened again right after closing keeps its focus, and gives it back again', async () => {
    const { user } = await openHelena(1280);
    const approve = await within(decisionArea('column')).findByRole('button', { name: 'Aprovar' });
    await user.click(approve);
    let modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
    await noDialogInTheDom();

    // Again at once, before the timers settle.
    await user.click(approve);
    modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    const notes = within(modal).getByLabelText('Observação (opcional)');
    await waitFor(() => {
      expect(notes).toHaveFocus();
    });
    await timersSettle();
    expect(notes).toHaveFocus();
    // The new opening starts with an empty note.
    expect(notes).toHaveValue('');

    zeroTimersBeforeTheClosingRenders();
    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
    await noDialogInTheDom();
    await waitFor(() => {
      expect(approve).toHaveFocus();
    });
  });

  it('rn008 phone: the panel opened again right after Esc keeps its focus inside', async () => {
    const { user } = await openHelena(390);
    const decide = await within(decisionArea('bar')).findByRole('button', { name: 'Decidir' });
    await user.click(decide);
    await screen.findByRole('dialog', { name: 'Decidir o exame' });
    await user.keyboard('{Escape}');
    await noDialogInTheDom();

    await user.click(decide);
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    await waitFor(() => {
      expect(panel.contains(document.activeElement)).toBe(true);
    });
    await timersSettle();
    expect(panel.contains(document.activeElement)).toBe(true);

    zeroTimersBeforeTheClosingRenders();
    await user.keyboard('{Escape}');
    await noDialogInTheDom();
    await waitFor(() => {
      expect(decide).toHaveFocus();
    });
  });
});
