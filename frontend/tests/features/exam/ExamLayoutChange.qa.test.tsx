/**
 * § 6.4 / § 6.7, step 3: crossing 1024 px (turning the tablet, 200% zoom) with the phone panel
 * or the confirmation dialog open, with "Decidido por …" focused, and the scroll padding the
 * exam screen sets on the page. QA cases beyond the layout regression of #24.
 *
 * The `matchMedia` stub of the setup does not report changes; here the listeners are kept and
 * called, as the browser does when the width changes.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { examPath } from '../../../src/app/navigation';
import { HEADER_SCROLL_PADDING } from '../../../src/features/exam/focus';
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

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
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

function rootStyle() {
  return document.documentElement.style;
}

describe('exam layout change, QA cases (§ 6.7)', () => {
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

  it('rn008 the phone panel closes when the screen turns into the column, and stays closed', async () => {
    setViewportWidth(390);
    const { user } = await openExam();
    await user.click(await within(decisionArea('bar')).findByRole('button', { name: 'Decidir' }));
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    act(() => {
      within(panel).getByRole('button', { name: 'Aprovar' }).focus();
    });

    resizeTo(1280);
    await settle();

    expect(screen.queryByRole('dialog', { name: 'Decidir o exame' })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(within(decisionArea('column')).getByRole('button', { name: 'Aprovar' })).toHaveFocus();

    // Back to the phone: the panel does not come back on its own.
    resizeTo(390);
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Decidir o exame' })).not.toBeInTheDocument();
    expect(within(decisionArea('bar')).getByRole('button', { name: 'Decidir' })).toHaveFocus();
    expect(within(decisionArea('bar')).getByRole('button', { name: 'Decidir' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('rn008 the dialog opened from the panel stays open across the change and Cancelar keeps the focus on the screen', async () => {
    setViewportWidth(390);
    const { user } = await openExam();
    await user.click(await within(decisionArea('bar')).findByRole('button', { name: 'Decidir' }));
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    await user.click(within(panel).getByRole('button', { name: 'Aprovar' }));
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });

    resizeTo(1280);
    await settle();

    expect(screen.getByRole('dialog', { name: 'Aprovar exame' })).toBe(modal);
    expect(modal.contains(document.activeElement)).toBe(true);
    await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await settle();
    expect(document.activeElement).not.toBe(document.body);
    expect(decisionArea('column').contains(document.activeElement)).toBe(true);
  });

  it('rn010 a focused "Decidido por …" follows the change of layout', async () => {
    Object.assign(
      db.exams.find((exam) => exam.student_id === HELENA)!,
      {
        status: 'APPROVED',
        decided_by_id: MOCK_USER_IDS.examiner,
        decided_at: '2026-11-21T12:00:00+00:00',
      },
    );
    await openExam();
    const decided = await within(decisionArea('column')).findByText('Decidido por Sensei Simulado');
    const slot = decided.closest<HTMLElement>('[data-slot="decision"]');
    if (slot === null) throw new Error('"Decidido por" deveria estar num bloco focável.');
    act(() => {
      slot.focus();
    });

    resizeTo(390);
    await settle();

    const barSlot = decisionArea('bar').querySelector('[data-slot="decision"]');
    expect(barSlot).not.toBeNull();
    expect(barSlot).toHaveFocus();
  });

  it('sets the scroll padding on the phone, drops the bottom one on the notebook, and leaves only the header one on Dia do exame', async () => {
    setViewportWidth(390);
    const { user, router } = await openExam();
    await waitFor(() => {
      expect(rootStyle().scrollPaddingTop).not.toBe('');
    });
    expect(rootStyle().scrollPaddingBottom).not.toBe('');

    resizeTo(1280);
    await settle();
    expect(rootStyle().scrollPaddingTop).not.toBe('');
    expect(rootStyle().scrollPaddingBottom).toBe('');

    resizeTo(390);
    await settle();
    expect(rootStyle().scrollPaddingBottom).not.toBe('');

    const trail = within(screen.getByRole('navigation', { name: 'Caminho' }));
    const [dayLink] = trail.getAllByRole('link');
    if (dayLink === undefined) throw new Error('O caminho deveria ter um link para o dia.');
    await user.click(dayLink);
    await waitFor(() => {
      expect(router.state.location.pathname).not.toBe(examPath(MOCK_EVENT_IDS.open, HELENA));
    });
    await settle();
    // #102: the header one is the layout's and stays on every screen under the header.
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
    expect(rootStyle().scrollPaddingBottom).toBe('');
  });
});
