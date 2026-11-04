/**
 * § 6.4 / § 6.7 (RN008), card #49 step 3: the confirmation dialog is open and the screen
 * crosses 1024 px (turning the tablet, 200% zoom). The button that opened it went away with
 * the old layout; closing the dialog gives the focus to the same choice in the layout on the
 * screen (Aprovar/Reprovar in the column, "Decidir" in the phone bar), not to the container
 * of the decision area (one Tab more).
 *
 * The `matchMedia` stub of the setup does not report changes; here the listeners are kept and
 * called, as the browser does when the width changes.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { examPath } from '../../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { mediaMatches, setViewportWidth } from '../../viewport';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

type Listener = (event: { matches: boolean; media: string }) => void;
let listeners: { query: string; listener: Listener }[] = [];
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
let db: MockDb;

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

describe('focus after the dialog when the layout changed under it (§ 6.7, #49)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    stubMatchMedia();
  });

  afterEach(() => {
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    vi.useRealTimers();
  });

  it.each([
    ['Aprovar', 'Aprovar exame'],
    ['Reprovar', 'Reprovar exame'],
  ])(
    'rn008 dialog opened by %s in the phone panel, screen turned into the column: Cancelar gives the focus to the same button of the column',
    async (choice, dialogName) => {
      setViewportWidth(390);
      const { user } = await openExam();
      await user.click(await within(decisionArea('bar')).findByRole('button', { name: 'Decidir' }));
      const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
      await user.click(within(panel).getByRole('button', { name: choice }));
      const modal = await screen.findByRole('dialog', { name: dialogName });

      resizeTo(1280);
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Decidir o exame' })).not.toBeInTheDocument();
      });
      await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));

      const same = within(decisionArea('column')).getByRole('button', { name: choice });
      await waitFor(() => {
        expect(same).toHaveFocus();
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it('rn008 dialog opened in the column, screen turned into the phone bar: Esc gives the focus to "Decidir"', async () => {
    setViewportWidth(1280);
    const { user } = await openExam();
    await user.click(
      await within(decisionArea('column')).findByRole('button', { name: 'Reprovar' }),
    );
    await screen.findByRole('dialog', { name: 'Reprovar exame' });

    resizeTo(390);
    await user.keyboard('{Escape}');

    const decide = within(decisionArea('bar')).getByRole('button', { name: 'Decidir' });
    await waitFor(() => {
      expect(decide).toHaveFocus();
    });
    expect(decide).toHaveAttribute('aria-expanded', 'false');
  });

  it('rn008 without a change of layout the opener itself takes the focus back', async () => {
    setViewportWidth(1280);
    const { user } = await openExam();
    const opener = await within(decisionArea('column')).findByRole('button', {
      name: 'Reprovar',
    });
    await user.click(opener);
    await screen.findByRole('dialog', { name: 'Reprovar exame' });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });
});
