/**
 * § 6.4 / § 6.7 (RN006), card #49 step 3: the notice of a refused mark.
 *
 * - Each refusal is a new alert, read out again even with the same text as the last one; the
 *   same refusal is never put on the page twice; the focus is never taken, and a newer notice
 *   that replaces one with the focus keeps it on the same button.
 * - After a network failure or a 504 the mark may have been saved: the notice says it could
 *   not be confirmed (it may show next to the item with the mark). A refusal that wrote
 *   nothing (503, 403…) keeps "Não foi possível salvar".
 * - A pointer tap on "Fechar aviso" or "Tentar de novo" keeps the space of the notice for
 *   `DOUBLE_TAP_MS`, so the second tap of a double tap does not land on what moved up.
 *
 * Helena (open event, exam in progress): Parar and Nome do fundador do Judô não marcados.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { DOUBLE_TAP_MS } from '../../../src/features/exam/markClickGuard';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const FOUNDER = mockRequirementId('Marrom', 7);
const FOUNDER_NAME = 'Nome do fundador do Judô';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const FORBIDDEN = 'Esta área é dos examinadores';
const NETWORK = 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.';
const MAYBE_SAVED_RETRY = 'Ela pode ter sido salva; confira o item ou toque em Tentar de novo.';
const MAYBE_SAVED = 'Ela pode ter sido salva; confira o item.';

/** How the API answers the next mark of an item; `gate…` waits for `openGate()` first. */
type Outcome = 'busy' | 'forbidden' | 'timeout' | 'network' | 'gate' | 'gateBusy' | 'gateForbidden';

const GATED: Partial<Record<Outcome, Outcome | undefined>> = {
  gate: undefined,
  gateBusy: 'busy',
  gateForbidden: 'forbidden',
};

let db: MockDb;
let outcomes: Record<string, Outcome[]> = {};
let gates: (() => void)[] = [];

function openGate() {
  const gate = gates.shift();
  if (gate === undefined) throw new Error('Nenhuma marcação está esperando.');
  gate();
}

async function answer(outcome: Outcome | undefined): Promise<Response | undefined> {
  if (outcome !== undefined && outcome in GATED) {
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    return answer(GATED[outcome]);
  }
  if (outcome === undefined) return undefined;
  if (outcome === 'network') return HttpResponse.error();
  if (outcome === 'timeout') {
    return HttpResponse.json({ message: 'Endpoint request timed out' }, { status: 504 });
  }
  const [status, message] = outcome === 'busy' ? [503, BUSY] : [403, FORBIDDEN];
  return HttpResponse.json({ message }, { status });
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
  outcomes = {};
  gates = [];
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.put(ANSWER_URL, ({ params }) => answer(outcomes[String(params.requirementId)]?.shift())),
  );
}

async function openHelena() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

function noticeSpace() {
  return document.querySelector<HTMLElement>('[data-notice-space]');
}

/** A new alert, other than `previous`, once it is on the page. */
async function nextAlert(previous: HTMLElement) {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    const current = screen.getByRole('alert');
    expect(current).not.toBe(previous);
    found = current;
  });
  return found!;
}

describe('notice of a refused mark (§ 6.4, § 6.7, RN006, #49)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('read out once per refusal', () => {
    it('rn006 a new refusal with the same text is a new alert, without taking the focus', async () => {
      outcomes[PARAR] = ['forbidden', 'forbidden'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const first = await screen.findByRole('alert');
      expect(first).toHaveTextContent(FORBIDDEN);

      await user.click(button('Certo: Parar'));
      const second = await nextAlert(first);

      expect(first).not.toBeInTheDocument();
      expect(second).toHaveTextContent('Não foi possível salvar a marcação de "Parar"');
      expect(second).toHaveTextContent(FORBIDDEN);
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(button('Certo: Parar')).toHaveFocus();
    });

    it('rn006 a refusal of another item with the same text is a new alert too', async () => {
      outcomes[PARAR] = ['forbidden'];
      outcomes[FOUNDER] = ['forbidden'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const first = await screen.findByRole('alert');

      await user.click(button(`Certo: ${FOUNDER_NAME}`));
      const second = await nextAlert(first);

      expect(second).toHaveTextContent(`Não foi possível salvar a marcação de "${FOUNDER_NAME}"`);
      expect(button(`Certo: ${FOUNDER_NAME}`)).toHaveFocus();
    });

    it('rn006 the same refusal stays the same alert while the screen changes around it', async () => {
      outcomes[PARAR] = ['busy', 'busy', 'busy', 'gate'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const alert = await screen.findByRole('alert');
      expect(within(alert).getByRole('button', { name: 'Tentar de novo: Parar' })).toBeVisible();

      // Another item saved: the screen renders again, the notice is the same one.
      await user.click(button(`Certo: ${FOUNDER_NAME}`));
      await waitFor(() => {
        expect(button(`Certo: ${FOUNDER_NAME}`)).toHaveAttribute('aria-pressed', 'true');
      });
      expect(screen.getByRole('alert')).toBe(alert);

      // A new click on Parar takes "Tentar de novo" away from the same notice.
      await user.click(button('Errado: Parar'));
      await waitFor(() => {
        expect(gates).toHaveLength(1);
      });
      expect(screen.getByRole('alert')).toBe(alert);
      expect(within(alert).queryByRole('button', { name: /Tentar de novo/ })).toBeNull();

      act(() => {
        openGate();
      });
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
    });

    it('rn006 a newer notice keeps the focus on "Fechar aviso" when the old one had it', async () => {
      outcomes[FOUNDER] = ['gateForbidden'];
      outcomes[PARAR] = ['forbidden'];
      const { user } = await openHelena();
      await user.click(button(`Certo: ${FOUNDER_NAME}`));
      await waitFor(() => {
        expect(gates).toHaveLength(1);
      });
      await user.click(button('Certo: Parar'));
      const first = await screen.findByRole('alert');
      act(() => {
        within(first).getByRole('button', { name: 'Fechar aviso' }).focus();
      });

      // The founder's mark was held; now it is refused for good.
      act(() => {
        openGate();
      });
      const second = await nextAlert(first);

      expect(second).toHaveTextContent(`Não foi possível salvar a marcação de "${FOUNDER_NAME}"`);
      expect(within(second).getByRole('button', { name: 'Fechar aviso' })).toHaveFocus();
    });

    it('rn006 a newer notice keeps the focus on "Tentar de novo" when the old one had it', async () => {
      outcomes[FOUNDER] = ['gateBusy', 'busy', 'busy'];
      outcomes[PARAR] = ['busy', 'busy', 'busy'];
      const { user } = await openHelena();
      await user.click(button(`Certo: ${FOUNDER_NAME}`));
      await waitFor(() => {
        expect(gates).toHaveLength(1);
      });
      await user.click(button('Certo: Parar'));
      const first = await screen.findByRole('alert');
      act(() => {
        within(first).getByRole('button', { name: 'Tentar de novo: Parar' }).focus();
      });

      act(() => {
        openGate();
      });
      const second = await nextAlert(first);

      expect(
        within(second).getByRole('button', { name: `Tentar de novo: ${FOUNDER_NAME}` }),
      ).toHaveFocus();
    });
  });

  describe('a mark that may have been saved', () => {
    it('rn006 after three network failures it says the mark could not be confirmed', async () => {
      outcomes[PARAR] = ['network', 'network', 'network', 'gate'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível confirmar a marcação de "Parar"');
      expect(alert).toHaveTextContent(NETWORK);
      expect(alert).toHaveTextContent(MAYBE_SAVED_RETRY);
      expect(alert).not.toHaveTextContent('Não foi possível salvar');

      // A new click takes "Tentar de novo" away: the text no longer points at it.
      await user.click(button('Errado: Parar'));
      await waitFor(() => {
        expect(within(alert).queryByRole('button', { name: /Tentar de novo/ })).toBeNull();
      });
      expect(alert).toHaveTextContent(MAYBE_SAVED);
      expect(alert).not.toHaveTextContent('Tentar de novo');
      act(() => {
        openGate();
      });
    });

    it('rn006 a 504 earlier in the series also makes it unsure', async () => {
      outcomes[PARAR] = ['timeout', 'busy', 'busy'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível confirmar a marcação de "Parar"');
      expect(alert).toHaveTextContent(BUSY);
      expect(alert).toHaveTextContent(MAYBE_SAVED_RETRY);
    });

    it('rn006 three 503 wrote nothing: "Não foi possível salvar"', async () => {
      outcomes[PARAR] = ['busy', 'busy', 'busy'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível salvar a marcação de "Parar"');
      expect(alert).not.toHaveTextContent('pode ter sido salva');
    });

    it('rn006 a final refusal after a 504 keeps "Não foi possível salvar"', async () => {
      outcomes[PARAR] = ['timeout', 'forbidden'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível salvar a marcação de "Parar"');
      expect(alert).toHaveTextContent(FORBIDDEN);
      expect(alert).not.toHaveTextContent('pode ter sido salva');
    });
  });

  describe('space of the notice after a tap', () => {
    /** The notice on the page, measured as `height` px, with the timers under control. */
    async function noticeOf(height: number) {
      const alert = await screen.findByRole('alert');
      vi.spyOn(alert, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ x: 0, y: 0, width: 600, height }),
      );
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });
      return alert;
    }

    it('rn006 a tap on "Fechar aviso" keeps the space for the double tap window', async () => {
      outcomes[PARAR] = ['forbidden'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const alert = await noticeOf(96);

      fireEvent.click(within(alert).getByRole('button', { name: 'Fechar aviso' }), { detail: 1 });

      expect(alert).not.toBeInTheDocument();
      const space = noticeSpace();
      expect(space).not.toBeNull();
      expect(space).toHaveStyle({ height: '96px' });
      expect(space).toHaveAttribute('aria-hidden', 'true');
      expect(space).toBeEmptyDOMElement();
      act(() => {
        vi.advanceTimersByTime(DOUBLE_TAP_MS - 1);
      });
      expect(noticeSpace()).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(noticeSpace()).toBeNull();
    });

    it('rn006 a tap on "Tentar de novo" keeps the space too', async () => {
      outcomes[PARAR] = ['busy', 'busy', 'busy', 'gate'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const alert = await noticeOf(140);

      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo: Parar' }), {
        detail: 1,
      });

      expect(alert).not.toBeInTheDocument();
      expect(noticeSpace()).toHaveStyle({ height: '140px' });
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      act(() => {
        vi.advanceTimersByTime(DOUBLE_TAP_MS);
      });
      expect(noticeSpace()).toBeNull();
      vi.useRealTimers();
      await waitFor(() => {
        expect(gates).toHaveLength(1);
      });
      act(() => {
        openGate();
      });
    });

    it('rn006 the keyboard closes it without keeping the space', async () => {
      outcomes[PARAR] = ['forbidden'];
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const alert = await screen.findByRole('alert');
      act(() => {
        within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
      });

      await user.keyboard('{Enter}');

      expect(alert).not.toBeInTheDocument();
      expect(noticeSpace()).toBeNull();
      expect(button('Certo: Parar')).toHaveFocus();
    });
  });
});
