/**
 * qa-frontend coverage of card #52 (§ 6.7): the focus after "Tentar de novo" of a screen's
 * load (`useRetryFocus`), on the edges that `tests/regression/52-*.test.tsx` and
 * `useRetryFocus.test.tsx` leave out: a reload that ends in a 403 (no button), a reload that
 * waits for the network, a screen left in the middle of the reload, a change of event on the
 * exam day, the exam on the phone (summary bar) and across the 1024 px layout change, the slot
 * mark "the logo may have changed", two presses in a row, and the titles (`tabIndex={-1}`)
 * kept out of the Tab order. Also: a reload that ends in a 401, a background reload that brings
 * the data (no focus move), the exam day title kept while the event list loads, the notices of
 * the exam day and of the student list closed (by mouse, or with the focus already elsewhere),
 * and the exam title the screen now shares with `useReadOnlyFocus`.
 *
 * jsdom lacks the HTML "focus fixup" rule: in the browser, the focused button that becomes
 * disabled (Mantine's `loading`) loses the focus to the body. `emulateFocusFixup` does it here.
 * The reads are answered by the test (`answer`), with no real wait.
 */
import { focusManager, onlineManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { mediaMatches, resetViewport, setViewportWidth } from '../../viewport';
import { openAcademy } from '../academy/helpers';
import { PNG_BYTES, fileInput, imageFile, logoUrl, slotRegion } from '../academy/logoHelpers';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const RETRY = 'Tentar de novo';
const BELTS_ERROR = 'Não foi possível carregar as faixas';
const SENSEI_ERROR = 'Não foi possível saber quem é o sensei';
const EXAM_DAY = new Date(2026, 10, 2, 12);
const EXAM_DATE = new Date(2026, 10, 21, 9);

type Outcome = 'ok' | 'error' | 'forbidden' | 'unauthorized';

/**
 * The first GET of `url` fails (503); each one after waits until `answer` says whether it
 * brings the data (the simulated API answers), fails again (503), is refused (403) or finds
 * the session expired (the API Gateway 401).
 */
function failingReads(url: string) {
  const waiting: ((outcome: Outcome) => void)[] = [];
  let reads = 0;
  server.use(
    http.get(url, async () => {
      reads += 1;
      if (reads > 1) {
        const outcome = await new Promise<Outcome>((resolve) => {
          waiting.push(resolve);
        });
        if (outcome === 'ok') return undefined;
        if (outcome === 'forbidden') {
          return HttpResponse.json({ message: 'Acesso negado' }, { status: 403 });
        }
        if (outcome === 'unauthorized') {
          return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
        }
      }
      return HttpResponse.json({ message: BUSY }, { status: 503 });
    }),
  );
  return {
    count: () => reads,
    waiting: () => waiting.length,
    answer: async (outcome: Outcome) => {
      await waitFor(() => {
        expect(waiting.length).toBeGreaterThan(0);
      });
      waiting.shift()!(outcome);
    },
  };
}

/** The HTML focus fixup rule, which jsdom lacks (see the top of the file). */
function emulateFocusFixup(): () => void {
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement) || !active.disabled) return;
    const temp = document.createElement('div');
    temp.tabIndex = -1;
    document.body.append(temp);
    temp.focus();
    temp.remove();
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled'],
  });
  return () => {
    observer.disconnect();
  };
}

/** Where the focus is, in a short form for the failure message (`body` when lost). */
function focusedElement(): string {
  const active = document.activeElement;
  if (active === null || active === document.body) return 'body';
  const name = active.getAttribute('aria-label') ?? active.textContent.trim();
  return `${active.tagName.toLowerCase()} "${name.slice(0, 60)}"`;
}

/** Runs what is queued (a `setTimeout(0)` that moves the focus), with no real wait. */
async function flushQueued() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

/** `console.error` calls other than React's "not wrapped in act" (the harness' AuthProvider). */
function realErrors(calls: unknown[][]): unknown[][] {
  return calls.filter((call) => !String(call[0]).includes('not wrapped in act'));
}

function retryIn(error: string): HTMLButtonElement {
  const alert = screen.getByText(error).closest<HTMLElement>('[role="alert"]')!;
  return within(alert).getByRole<HTMLButtonElement>('button', { name: RETRY });
}

function mockApi(prepare?: (db: MockDb) => void) {
  const db = createMockDb({ includeShowcase: true });
  prepare?.(db);
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
}

function senseiIsTheExaminer(db: MockDb) {
  db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
}

async function openBeltsWithLoadError() {
  mockApi();
  const reads = failingReads(`${TEST_API_URL}/belts`);
  const rendered = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
  await screen.findByText(BELTS_ERROR);
  return { ...rendered, reads };
}

function beltsTitle(): HTMLElement {
  return screen.getByRole('heading', { level: 1, name: 'Faixas' });
}

let stopFixup: () => void = () => undefined;

beforeEach(() => {
  stopFixup = emulateFocusFixup();
});

afterEach(() => {
  stopFixup();
  onlineManager.setOnline(true);
  resetViewport();
  vi.useRealTimers();
});

describe('403 on the screen load', () => {
  it('Faixas: a reload that ends in "Sem permissão" (no button) gives the focus to the title', async () => {
    const { user, reads } = await openBeltsWithLoadError();

    retryIn(BELTS_ERROR).focus();
    await user.keyboard('{Enter}');
    await reads.answer('forbidden');

    expect(await screen.findByText('Sem permissão')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RETRY })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(beltsTitle()).toHaveFocus();
    });
  });

  it('student list (guardian): a 403 says "Sem permissão" with the API message and no button', async () => {
    mockApi();
    server.use(
      http.get(`${TEST_API_URL}/students`, () =>
        HttpResponse.json({ message: 'Acesso negado' }, { status: 403 }),
      ),
    );
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });

    const alert = (await screen.findByText('Sem permissão')).closest<HTMLElement>(
      '[role="alert"]',
    )!;
    expect(alert).toHaveTextContent('Acesso negado');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Não foi possível carregar os alunos')).not.toBeInTheDocument();
  });
});

describe('a reload that waits for the network (paused)', () => {
  it('Faixas: the focus waits for the network and the data, then goes to the title', async () => {
    const { user, reads } = await openBeltsWithLoadError();
    act(() => {
      onlineManager.setOnline(false);
    });

    retryIn(BELTS_ERROR).focus();
    await user.keyboard('{Enter}');
    await flushQueued();
    expect(beltsTitle()).not.toHaveFocus();
    expect(reads.count()).toBe(1);

    act(() => {
      onlineManager.setOnline(true);
    });
    await reads.answer('ok');
    expect(await screen.findByRole('table', { name: 'Faixas' })).toBeInTheDocument();
    await waitFor(() => {
      expect(beltsTitle()).toHaveFocus();
    });
  });

  it('Faixas: a focus put on "Sair" while offline stays there when the data comes', async () => {
    const { user, reads } = await openBeltsWithLoadError();
    act(() => {
      onlineManager.setOnline(false);
    });

    retryIn(BELTS_ERROR).focus();
    await user.keyboard('{Enter}');
    await flushQueued();
    screen.getByRole('button', { name: 'Sair' }).focus();
    act(() => {
      onlineManager.setOnline(true);
    });
    await reads.answer('ok');
    expect(await screen.findByRole('table', { name: 'Faixas' })).toBeInTheDocument();
    await flushQueued();

    expect(focusedElement()).toBe('button "Sair"');
  });
});

describe('two presses in a row', () => {
  it('Faixas: fails again (focus on the button), Enter once more and the data comes: the title', async () => {
    const { user, reads } = await openBeltsWithLoadError();

    retryIn(BELTS_ERROR).focus();
    await user.keyboard('{Enter}');
    await reads.answer('error');
    await waitFor(() => {
      expect(retryIn(BELTS_ERROR)).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    await reads.answer('ok');

    await waitFor(() => {
      expect(beltsTitle()).toHaveFocus();
    });
  });
});

describe('the screen goes away during the reload', () => {
  it('Faixas → Eventos before the reload ends: no error and the Eventos title takes no focus', async () => {
    const { user, reads, router } = await openBeltsWithLoadError();
    const errors = vi.spyOn(console, 'error');
    try {
      retryIn(BELTS_ERROR).focus();
      await user.keyboard('{Enter}');
      await act(async () => {
        await router.navigate('/eventos');
      });
      const eventsTitle = await screen.findByRole('heading', { level: 1, name: 'Eventos' });
      await reads.answer('ok');
      await flushQueued();

      expect(eventsTitle).not.toHaveFocus();
      expect(realErrors(errors.mock.calls)).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('a reload that ends in a 401 (session expired)', () => {
  it('Faixas: the session ends, the login screen shows and nothing breaks', async () => {
    const { user, reads } = await openBeltsWithLoadError();
    const errors = vi.spyOn(console, 'error');
    try {
      retryIn(BELTS_ERROR).focus();
      await user.keyboard('{Enter}');
      await reads.answer('unauthorized');

      expect(await screen.findByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
      await flushQueued();
      expect(screen.queryByRole('heading', { level: 1, name: 'Faixas' })).not.toBeInTheDocument();
      expect(realErrors(errors.mock.calls)).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('only a reload asked by the button moves the focus', () => {
  afterEach(() => {
    // Unmounted first: back to "focused", the screen of this test would read everything again
    // and the late read would reach the next test's handlers.
    cleanup();
    focusManager.setFocused(undefined);
  });

  it('Faixas: the first load fails and a reload in the background brings the data: the focus stays put', async () => {
    const { reads } = await openBeltsWithLoadError();
    (document.activeElement as HTMLElement | null)?.blur();

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await reads.answer('ok');
    expect(await screen.findByRole('table', { name: 'Faixas' })).toBeInTheDocument();
    await flushQueued();

    expect(focusedElement()).toBe('body');
  });
});

describe('exam day: the event changes while the list reloads', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: EXAM_DAY });
  });

  it('the focus stays on the event picker; the reload of the old event does not move it', async () => {
    mockApi();
    const reads = failingReads(`${TEST_API_URL}/students`);
    const { user } = await renderApp({ route: '/dia-do-exame', signedInAs: 'examiner' });
    await screen.findByText('Não foi possível carregar os alunos');

    retryIn('Não foi possível carregar os alunos').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(reads.waiting()).toBe(1);
    });
    const picker = screen.getByRole('combobox', { name: 'Evento' });
    picker.focus();
    fireEvent.change(picker, { target: { value: MOCK_EVENT_IDS.closed } });
    // The old event's read, then the new event's.
    await reads.answer('ok');
    await reads.answer('ok');
    await flushQueued();

    expect(screen.getByRole('combobox', { name: 'Evento' })).toHaveFocus();
  });
});

describe('exam day: the events come back', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: EXAM_DAY });
  });

  it('the focus goes to the title and stays there while the list of the event loads', async () => {
    mockApi();
    const reads = failingReads(`${TEST_API_URL}/events`);
    const { user } = await renderApp({ route: '/dia-do-exame', signedInAs: 'examiner' });
    await screen.findByText('Não foi possível carregar os eventos');

    retryIn('Não foi possível carregar os eventos').focus();
    await user.keyboard('{Enter}');
    await reads.answer('ok');
    const title = screen.getByRole('heading', { level: 1, name: 'Dia do exame' });
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
    expect(await screen.findByRole('table', { name: 'Alunos do evento' })).toBeInTheDocument();
    await flushQueued();

    expect(focusedElement()).toBe('h1 "Dia do exame"');
  });
});

describe('notices closed: the focus the user moved is not taken', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: EXAM_DAY });
  });

  it('exam day: "Presença … confirmada." closed and the focus already in the search stays there', async () => {
    mockApi();
    const { user } = await renderApp({ route: '/dia-do-exame', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos do evento' });
    const row = within(table).getByRole('rowheader', { name: 'Ana Souza' }).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Confirmar presença de Ana Souza' }));
    const notice = (
      await screen.findByText('Presença de Ana Souza confirmada.')
    ).closest<HTMLElement>('[role="status"]')!;
    const close = within(notice).getByRole('button', { name: 'Fechar aviso' });
    const search = screen.getByRole('searchbox', { name: 'Buscar por nome' });

    close.focus();
    act(() => {
      close.click();
    });
    // Before the queued focus move runs, the user is already in the search.
    search.focus();
    await flushQueued();

    expect(screen.queryByText('Presença de Ana Souza confirmada.')).not.toBeInTheDocument();
    expect(search).toHaveFocus();
  });

  it('exam day: the notice closed with the mouse also gives the focus to the title', async () => {
    mockApi();
    const { user } = await renderApp({ route: '/dia-do-exame', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos do evento' });
    const row = within(table).getByRole('rowheader', { name: 'Ana Souza' }).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Confirmar presença de Ana Souza' }));
    const notice = (
      await screen.findByText('Presença de Ana Souza confirmada.')
    ).closest<HTMLElement>('[role="status"]')!;

    await user.click(within(notice).getByRole('button', { name: 'Fechar aviso' }));
    await flushQueued();

    expect(screen.getByRole('heading', { level: 1, name: 'Dia do exame' })).toHaveFocus();
  });

  it('student list: "Alterações salvas." closed and the focus already on "Novo aluno" stays there', async () => {
    mockApi();
    const { user } = await renderApp({
      route: '/alunos/7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01',
      signedInAs: 'guardian',
    });
    expect(await screen.findByLabelText(/^Nome/)).toHaveValue('Ana Souza');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    const notice = (await screen.findByText('Alterações salvas.')).closest<HTMLElement>(
      '[role="status"]',
    )!;
    await screen.findByRole('table', { name: 'Alunos' });
    const close = within(notice).getByRole('button', { name: 'Fechar aviso' });
    const newStudent = screen.getByRole('link', { name: 'Novo aluno' });

    close.focus();
    act(() => {
      close.click();
    });
    newStudent.focus();
    await flushQueued();

    expect(screen.queryByText('Alterações salvas.')).not.toBeInTheDocument();
    expect(newStudent).toHaveFocus();
  });
});

describe('exam: the title the screen shares after the reload (useReadOnlyFocus)', () => {
  let db: MockDb;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: EXAM_DATE });
  });

  afterEach(() => {
    // Unmounted first: back to "focused", the screen of this test would read everything again
    // and the late read would reach the next test's handlers.
    cleanup();
    focusManager.setFocused(undefined);
  });

  it('the exam comes back, then turns read-only on a reload: the focus goes to the exam title', async () => {
    mockApi((prepared) => {
      db = prepared;
    });
    const reads = failingReads(`${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`);
    const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
    await screen.findByText('Não foi possível carregar o exame');

    retryIn('Não foi possível carregar o exame').focus();
    await user.keyboard('{Enter}');
    await reads.answer('ok');
    const title = await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    await waitFor(() => {
      expect(title).toHaveFocus();
    });

    // Decided on another device; the focus is lost when the reload makes the exam read-only.
    Object.assign(
      db.exams.find((exam) => exam.student_id === HELENA)!,
      {
        status: 'APPROVED',
        decided_by_id: MOCK_USER_IDS.examiner,
        decided_at: '2026-11-21T12:00:00+00:00',
      },
    );
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await reads.answer('ok');
    const summary = screen.getByRole('complementary', { name: 'Resumo do exame' });
    await within(summary).findByText(/Decidido por/);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Helena Prado' }),
        `foco em ${focusedElement()}`,
      ).toHaveFocus();
    });
  });
});

describe('exam on the phone (390 px, summary bar)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: EXAM_DATE });
    setViewportWidth(390);
  });

  it('"quem é o sensei" loads again: the focus goes to the decision area of the bar', async () => {
    mockApi(senseiIsTheExaminer);
    const reads = failingReads(`${TEST_API_URL}/settings`);
    const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
    await screen.findByText(SENSEI_ERROR);
    const summary = screen.getByRole('complementary', { name: 'Resumo do exame' });
    expect(summary.querySelector('[data-decision-area="bar"]')).not.toBeNull();

    retryIn(SENSEI_ERROR).focus();
    await user.keyboard('{Enter}');
    await reads.answer('ok');
    expect(await within(summary).findByRole('button', { name: 'Decidir' })).toBeInTheDocument();

    await waitFor(() => {
      expect(
        summary.contains(document.activeElement),
        `foco em ${focusedElement()}, esperado na barra`,
      ).toBe(true);
    });
  });

  it('"quem é o sensei" fails again: the focus goes to the new "Tentar de novo" of the bar', async () => {
    mockApi(senseiIsTheExaminer);
    const reads = failingReads(`${TEST_API_URL}/settings`);
    const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
    await screen.findByText(SENSEI_ERROR);

    retryIn(SENSEI_ERROR).focus();
    await user.keyboard('{Enter}');
    await reads.answer('error');

    await waitFor(() => {
      expect(retryIn(SENSEI_ERROR)).toHaveFocus();
    });
  });

  it('the exam loads again: the focus goes to the exam title', async () => {
    mockApi();
    const reads = failingReads(`${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`);
    const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
    await screen.findByText('Não foi possível carregar o exame');

    retryIn('Não foi possível carregar o exame').focus();
    await user.keyboard('{Enter}');
    await reads.answer('ok');

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Helena Prado' })).toHaveFocus();
    });
  });
});

describe('exam: the layout changes while "quem é o sensei" reloads', () => {
  type Listener = (event: { matches: boolean; media: string }) => void;
  let listeners: { query: string; listener: Listener }[] = [];
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: EXAM_DATE });
    // The `matchMedia` stub of the setup does not tell changes: here the listeners hear them.
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
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  });

  function resizeTo(width: number) {
    setViewportWidth(width);
    act(() => {
      for (const { query, listener } of listeners) {
        listener({ matches: mediaMatches(query), media: query });
      }
    });
  }

  it.each([
    { from: 1280, to: 390, action: 'Decidir' },
    { from: 390, to: 1280, action: 'Aprovar' },
  ])('$from → $to px: the focus ends in the summary, not on the body', async (item) => {
    setViewportWidth(item.from);
    mockApi(senseiIsTheExaminer);
    const reads = failingReads(`${TEST_API_URL}/settings`);
    const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
    await screen.findByText(SENSEI_ERROR);

    retryIn(SENSEI_ERROR).focus();
    await user.keyboard('{Enter}');
    resizeTo(item.to);
    await reads.answer('ok');
    const summary = screen.getByRole('complementary', { name: 'Resumo do exame' });
    await within(summary).findByRole('button', { name: item.action });
    await flushQueued();

    expect(summary.contains(document.activeElement), `foco em ${focusedElement()}`).toBe(true);
  });
});

describe('academy logo slot with the mark "the logo may have changed" (#26)', () => {
  it('"Tentar de novo" and the read brings the logo sent: the focus goes to "Trocar"', async () => {
    mockApi();
    const waiting: ((ok: boolean) => void)[] = [];
    let held = false;
    server.use(
      http.get(logoUrl('primary'), async () => {
        if (!held) return undefined;
        const ok = await new Promise<boolean>((resolve) => {
          waiting.push(resolve);
        });
        return ok ? undefined : HttpResponse.json({ message: BUSY }, { status: 503 });
      }),
    );
    const answer = async (ok: boolean) => {
      await waitFor(() => {
        expect(waiting.length).toBeGreaterThan(0);
      });
      waiting.shift()!(ok);
    };
    const { user } = await openAcademy();
    const slot = slotRegion('primary');
    await within(slot).findByText('Nenhum logo');
    // The read after the upload fails: the mark is on and the slot shows the read error.
    held = true;
    await user.upload(fileInput('primary'), imageFile(PNG_BYTES, 'logo.png', 'image/png'));
    await answer(false);
    await within(slot).findByText('Não foi possível carregar o logo principal');
    await waitFor(() => {
      expect(within(slot).getByRole('button', { name: RETRY })).toHaveFocus();
    });

    await user.keyboard('{Enter}');
    await answer(true);
    const replace = await within(slot).findByRole('button', { name: 'Trocar logo principal' });

    expect(within(slot).getByText('Logo principal salvo.')).toBeInTheDocument();
    await waitFor(() => {
      expect(replace, `foco em ${focusedElement()}`).toHaveFocus();
    });
  });
});

describe('page titles that take the focus stay out of the Tab order', () => {
  const pages: { route: string; as: 'examiner' | 'guardian'; title: string; now?: Date }[] = [
    { route: '/alunos', as: 'guardian', title: 'Alunos' },
    { route: '/alunos/novo', as: 'guardian', title: 'Novo aluno' },
    { route: '/dia-do-exame', as: 'examiner', title: 'Dia do exame', now: EXAM_DAY },
    { route: examPath(OPEN, HELENA), as: 'examiner', title: 'Helena Prado', now: EXAM_DATE },
  ];

  it.each(pages)('$route', async ({ route, as, title, now }) => {
    if (now) vi.useFakeTimers({ toFake: ['Date'], now });
    mockApi();
    const { user } = await renderApp({ route, signedInAs: as });
    const heading = await screen.findByRole('heading', { level: 1, name: title });
    expect(heading).toHaveAttribute('tabindex', '-1');
    await flushQueued();
    (document.activeElement as HTMLElement | null)?.blur();

    const reached: number[] = [];
    for (let step = 0; step < 60; step += 1) {
      await user.tab();
      if (document.activeElement?.tagName === 'H1') reached.push(step);
    }
    expect(reached).toEqual([]);
  });
});
