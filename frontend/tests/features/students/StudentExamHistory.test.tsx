/**
 * "Histórico de exames" in the edit form (RN018, § 6.7): only for examiners, in the order of
 * `GET /students/{id}/exams`, with the exam texts and who decided as on the exam screen
 * (§ 6.4), and its own loading, empty and error states, apart from the form.
 *
 * Slow answers are held by the test (`hold`) and released by it: no real wait.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AcademySettings, StudentHistoryEntry } from '../../../src/api/types';
import { examPath } from '../../../src/app/navigation';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { MOCK_EVENT_IDS, createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

/** Guardian's student without exams. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
/** Examiner's inactive student; earned her stripe at the closed event. */
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
/** Guardian's student with an exam at the closed event. */
const GABRIEL = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07';
const { open: OPEN, closed: CLOSED } = MOCK_EVENT_IDS;

const HISTORY_URL = `${TEST_API_URL}/students/:id/exams`;
const EXAMINERS_URL = `${TEST_API_URL}/examiners`;
const SETTINGS_URL = `${TEST_API_URL}/settings`;
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const HISTORY_ERROR = 'Não foi possível carregar o histórico';
const RETRY = 'Tentar de novo';

function beltId(name: string): string {
  return mockBelts.find((belt) => belt.name === name)!.id;
}

/** An exam of the history; by default a failed belt exam decided by the simulated examiner. */
function entry(overrides: Partial<StudentHistoryEntry> = {}): StudentHistoryEntry {
  return {
    event_id: 'evento-setembro',
    event_name: 'Exame setembro/2027',
    exam_date: '2027-09-25',
    target_belt_id: beltId('Azul'),
    target_belt_name: 'Azul',
    kind: 'BELT',
    status: 'FAILED',
    decided_by_id: MOCK_USER_IDS.examiner,
    decided_at: '2027-09-25T15:00:00+00:00',
    notes: null,
    created_at: '2027-09-25T12:00:00+00:00',
    source: {
      belt_id: beltId('Cinza/Azul'),
      belt_name: 'Cinza/Azul',
      belt_since: '2027-03-20',
      stripes: 0,
    },
    ...overrides,
  };
}

const IN_PROGRESS: Partial<StudentHistoryEntry> = {
  status: 'IN_PROGRESS',
  decided_by_id: null,
  decided_at: null,
  notes: null,
};

let db: MockDb;

/** The history answers these entries, as they are (the screen never reorders them). */
function answerHistory(entries: StudentHistoryEntry[]) {
  server.use(http.get(HISTORY_URL, () => HttpResponse.json(entries)));
}

/** Records every request to `url` and lets the next handler answer it. */
function recordRequests(url: string): Request[] {
  const requests: Request[] = [];
  server.use(
    http.get(url, ({ request }) => {
      requests.push(request.clone());
      return undefined;
    }),
  );
  return requests;
}

/** Holds every GET of `url` until the test releases it; then the next handler answers. */
function hold(url: string) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(url, async () => {
      await gate;
      return undefined;
    }),
  );
  return {
    release: async () => {
      await act(async () => {
        release();
        await Promise.resolve();
      });
    },
  };
}

function busy() {
  return HttpResponse.json({ message: BUSY }, { status: 503 });
}

async function openEdit(id: string, role: 'examiner' | 'guardian' = 'examiner') {
  const result = await renderApp({ route: `/alunos/${id}`, signedInAs: role });
  await screen.findByRole('combobox', { name: /^Faixa atual/ });
  return result;
}

function section(): HTMLElement {
  return screen.getByRole('region', { name: 'Histórico de exames' });
}

async function historyTable(): Promise<HTMLElement> {
  return within(await screen.findByRole('region', { name: 'Histórico de exames' })).findByRole(
    'table',
    { name: 'Histórico de exames' },
  );
}

/** The body rows, each as the text of its cells. */
function tableRows(table: HTMLElement): string[][] {
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent.trim()),
  );
}

function rowOf(table: HTMLElement, eventName: string): HTMLElement {
  return within(table).getByRole('rowheader', { name: eventName }).closest('tr')!;
}

/**
 * The HTML focus fixup rule, which jsdom lacks: the focused button that becomes disabled loses
 * the focus to the body (as in `tests/regression/52-foco-perdido-tentar-de-novo-telas.test.tsx`).
 */
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

beforeEach(() => {
  db = createMockDb({ includeShowcase: true });
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
});

describe('histórico de exames: quem vê (RN018)', () => {
  it('rn018 shows the examiner the student exams, most recent first, from the simulated API', async () => {
    // Élida also present at the open event: the history has her two exams.
    db.exams.push({
      ...db.exams.find((exam) => exam.student_id === ELIDA)!,
      id: 'exame-aberto-elida',
      event_id: OPEN,
      status: 'IN_PROGRESS',
      decided_by_id: null,
      decided_at: null,
      created_at: '2026-11-02T12:00:00+00:00',
    });
    await openEdit(ELIDA);
    const table = await historyTable();
    expect(tableRows(table).map((cells) => cells.slice(0, 4))).toEqual([
      ['21/11/2026', 'Exame novembro/2026', 'Grau na faixa Verde (rumo à Roxa)', 'Em andamento'],
      ['01/03/2026', 'Exame março/2026', 'Grau na faixa Verde (rumo à Roxa)', 'Aprovado'],
    ]);
  });

  it('keeps the order the API sends, without sorting it again', async () => {
    answerHistory([
      entry({ event_id: 'b', event_name: 'Exame março/2026', exam_date: '2026-03-01' }),
      entry({ event_id: 'a', event_name: 'Exame novembro/2026', exam_date: '2026-11-21' }),
      entry({ event_id: 'c', event_name: 'Exame junho/2026', exam_date: '2026-06-13' }),
    ]);
    await openEdit(ELIDA);
    const table = await historyTable();
    expect(tableRows(table).map((cells) => cells[1])).toEqual([
      'Exame março/2026',
      'Exame novembro/2026',
      'Exame junho/2026',
    ]);
  });

  it('rn018 hides the section from a guardian and never asks for the history', async () => {
    const history = recordRequests(HISTORY_URL);
    const examiners = recordRequests(EXAMINERS_URL);
    const settings = recordRequests(SETTINGS_URL);
    await openEdit(GABRIEL, 'guardian');
    expect(screen.getByRole('textbox', { name: /^Nome/ })).toHaveValue('Gabriel Costa');
    expect(screen.queryByRole('heading', { name: 'Histórico de exames' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Carregando histórico/)).not.toBeInTheDocument();
    expect(history).toHaveLength(0);
    // The names of who decided are examiner-only routes too.
    expect(examiners).toHaveLength(0);
    expect(settings).toHaveLength(0);
  });

  it('asks for the history once, with the student id', async () => {
    const history = recordRequests(HISTORY_URL);
    await openEdit(ELIDA);
    await historyTable();
    expect(history.map((request) => new URL(request.url).pathname)).toEqual([
      `/students/${ELIDA}/exams`,
    ]);
  });

  it('shows no section when the student is not found (404)', async () => {
    await renderApp({ route: '/alunos/nao-existe', signedInAs: 'examiner' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Aluno não encontrado' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Histórico de exames' })).not.toBeInTheDocument();
    expect(screen.queryByText(HISTORY_ERROR)).not.toBeInTheDocument();
  });
});

describe('histórico de exames: textos de cada exame', () => {
  it('names the exam as the exam screen: belt, stripe with and without its belt', async () => {
    answerHistory([
      entry({ event_id: 'faixa' }),
      entry({
        event_id: 'grau',
        event_name: 'Exame novembro/2026',
        kind: 'STRIPE',
        target_belt_name: 'Marrom',
        source: {
          belt_id: beltId('Roxa'),
          belt_name: 'Roxa',
          belt_since: '2025-06-30',
          stripes: 3,
        },
      }),
      entry({
        event_id: 'grau-sem-origem',
        event_name: 'Exame junho/2026',
        kind: 'STRIPE',
        target_belt_name: 'Verde',
        source: null,
      }),
    ]);
    await openEdit(ELIDA);
    const table = await historyTable();
    expect(tableRows(table).map((cells) => cells[2])).toEqual([
      'Faixa Azul',
      'Grau na faixa Roxa (rumo à Marrom)',
      'Grau (rumo à Verde)',
    ]);
  });

  it('falls back when the target belt or the event no longer exist', async () => {
    answerHistory([
      entry({ event_id: 'sem-faixa', event_name: 'Exame março/2026', target_belt_name: null }),
      entry({
        event_id: 'sem-faixa-grau',
        event_name: 'Exame junho/2026',
        kind: 'STRIPE',
        target_belt_name: null,
      }),
      entry({ event_id: 'sem-evento', event_name: null, exam_date: null }),
    ]);
    await openEdit(ELIDA);
    const table = await historyTable();
    expect(tableRows(table).map((cells) => cells.slice(0, 3))).toEqual([
      ['25/09/2027', 'Exame março/2026', 'Faixa —'],
      ['25/09/2027', 'Exame junho/2026', 'Grau'],
      ['—', 'Evento não encontrado', 'Faixa Azul'],
    ]);
  });

  it('writes the status out with an icon, never by color alone', async () => {
    answerHistory([
      entry({ event_id: 'a', event_name: 'Exame A', status: 'APPROVED' }),
      entry({ event_id: 'b', event_name: 'Exame B', status: 'FAILED' }),
      entry({ event_id: 'c', event_name: 'Exame C', ...IN_PROGRESS }),
    ]);
    await openEdit(ELIDA);
    const table = await historyTable();
    const expected: [string, string, string][] = [
      ['Exame A', 'APPROVED', 'Aprovado'],
      ['Exame B', 'FAILED', 'Reprovado'],
      ['Exame C', 'IN_PROGRESS', 'Em andamento'],
    ];
    for (const [name, status, text] of expected) {
      const cell = rowOf(table, name).querySelector<HTMLElement>(`[data-status="${status}"]`)!;
      expect(cell).toHaveTextContent(text);
      // The icon is decoration: the text alone says the status.
      expect(cell.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('shows the note of the decision, and nothing about a decision in progress', async () => {
    answerHistory([
      entry({ event_id: 'a', event_name: 'Exame A', notes: 'Treinar as quedas' }),
      entry({ event_id: 'b', event_name: 'Exame B', ...IN_PROGRESS }),
    ]);
    await openEdit(ELIDA);
    const table = await historyTable();
    expect(
      within(rowOf(table, 'Exame A')).getByText('Observação: Treinar as quedas'),
    ).toBeInTheDocument();
    const inProgress = rowOf(table, 'Exame B');
    expect(within(inProgress).queryByText(/Decidido/)).not.toBeInTheDocument();
    expect(within(inProgress).queryByText(/Observação/)).not.toBeInTheDocument();
  });

  it("the simulated API sends the note of Gabriel's decided exam", async () => {
    await openEdit(GABRIEL);
    const table = await historyTable();
    expect(
      within(rowOf(table, 'Exame março/2026')).getByText('Observação: Bom equilíbrio nas quedas'),
    ).toBeInTheDocument();
  });
});

describe('histórico de exames: quem decidiu e quando (RN008)', () => {
  it('rn008 names an active examiner and the day of the decision in the local time zone', async () => {
    // 01:30 UTC is still 25/09 in UTC-3.
    answerHistory([entry({ decided_at: '2027-09-26T01:30:00+00:00' })]);
    await openEdit(ELIDA);
    const row = rowOf(await historyTable(), 'Exame setembro/2027');
    expect(await within(row).findByText('Decidido por Sensei Simulado')).toBeInTheDocument();
    expect(within(row).getByText('em 25/09/2027')).toBeInTheDocument();
  });

  it('rn008 names the sensei of the settings who is no longer an active examiner', async () => {
    const settings: AcademySettings = {
      academy_name: 'Academia Simulada de Judô',
      sensei_user_id: 'sensei-antigo',
      certificate_city: null,
      created_at: null,
      updated_at: null,
      sensei: {
        id: 'sensei-antigo',
        email: 'antigo@example.com',
        name: 'Sensei Antigo',
        active: false,
      },
    };
    server.use(http.get(SETTINGS_URL, () => HttpResponse.json(settings)));
    answerHistory([entry({ decided_by_id: 'sensei-antigo' })]);
    await openEdit(ELIDA);
    const row = rowOf(await historyTable(), 'Exame setembro/2027');
    expect(await within(row).findByText('Decidido por Sensei Antigo')).toBeInTheDocument();
  });

  it('rn008 says when nobody names who decided', async () => {
    answerHistory([entry({ decided_by_id: 'quem-saiu' })]);
    await openEdit(ELIDA);
    const row = rowOf(await historyTable(), 'Exame setembro/2027');
    expect(
      await within(row).findByText('Decidido por um examinador que não está mais ativo'),
    ).toBeInTheDocument();
  });

  it('says only "Decidido" while the names load', async () => {
    const examiners = hold(EXAMINERS_URL);
    answerHistory([entry()]);
    await openEdit(ELIDA);
    const row = rowOf(await historyTable(), 'Exame setembro/2027');
    expect(within(row).getByText('Decidido')).toBeInTheDocument();
    await examiners.release();
    expect(await within(row).findByText('Decidido por Sensei Simulado')).toBeInTheDocument();
  });

  it('shows the history when GET /examiners fails, without the name it would give', async () => {
    server.use(
      http.get(EXAMINERS_URL, () =>
        HttpResponse.json({ message: 'Erro interno. Tente de novo.' }, { status: 500 }),
      ),
    );
    answerHistory([
      entry({ event_id: 'a', event_name: 'Exame A' }),
      // The sensei of the settings (`mock-examiner-2`, no name): named by the settings.
      entry({ event_id: 'b', event_name: 'Exame B', decided_by_id: 'mock-examiner-2' }),
    ]);
    await openEdit(ELIDA);
    const table = await historyTable();
    expect(
      await within(rowOf(table, 'Exame B')).findByText('Decidido por examinadora@example.com'),
    ).toBeInTheDocument();
    // Not "não está mais ativo": without the examiners nobody knows.
    expect(within(rowOf(table, 'Exame A')).getByText('Decidido')).toBeInTheDocument();
    expect(screen.queryByText(/não está mais ativo/)).not.toBeInTheDocument();
    expect(within(section()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the history when GET /settings fails, naming the active examiners', async () => {
    server.use(http.get(SETTINGS_URL, busy));
    answerHistory([
      entry({ event_id: 'a', event_name: 'Exame A' }),
      entry({ event_id: 'b', event_name: 'Exame B', decided_by_id: 'quem-saiu' }),
    ]);
    await openEdit(ELIDA);
    const table = await historyTable();
    expect(
      await within(rowOf(table, 'Exame A')).findByText('Decidido por Sensei Simulado'),
    ).toBeInTheDocument();
    expect(within(rowOf(table, 'Exame B')).getByText('Decidido')).toBeInTheDocument();
    expect(within(section()).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('histórico de exames: "Abrir exame" (§ 6.4)', () => {
  it('opens the exam screen of that exam, with a name that says which one', async () => {
    const { user, router } = await openEdit(ELIDA);
    const table = await historyTable();
    const link = within(table).getByRole('link', {
      name: 'Abrir exame: Grau na faixa Verde (rumo à Roxa), Exame março/2026, 01/03/2026',
    });
    expect(link).toHaveAttribute('href', examPath(CLOSED, ELIDA));
    await user.click(link);
    expect(router.state.location.pathname).toBe(examPath(CLOSED, ELIDA));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Élida Ramos' }),
    ).toBeInTheDocument();
  });

  it('has no link for an exam whose event no longer exists', async () => {
    answerHistory([
      entry({ event_id: 'com-evento' }),
      entry({ event_id: 'sem-evento', event_name: null, exam_date: null }),
    ]);
    await openEdit(ELIDA);
    const table = await historyTable();
    expect(within(table).getAllByRole('link', { name: /^Abrir exame/ })).toHaveLength(1);
    expect(
      within(rowOf(table, 'Evento não encontrado')).queryByRole('link'),
    ).not.toBeInTheDocument();
    expect(within(rowOf(table, 'Exame setembro/2027')).getByRole('link')).toHaveAttribute(
      'href',
      examPath('com-evento', ELIDA),
    );
  });
});

describe('histórico de exames: estados da seção', () => {
  it('says so when the student has no exams', async () => {
    await openEdit(ANA);
    expect(await within(section()).findByText('Nenhum exame registrado.')).toBeInTheDocument();
    expect(within(section()).queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows its own loading state while the form is already usable', async () => {
    const history = hold(HISTORY_URL);
    const { user } = await openEdit(ELIDA);
    expect(within(section()).getByRole('status')).toHaveTextContent('Carregando histórico…');
    const name = screen.getByRole('textbox', { name: /^Nome/ });
    await user.clear(name);
    await user.paste('Élida Ramos Lima');
    expect(name).toHaveValue('Élida Ramos Lima');
    await history.release();
    expect(await historyTable()).toBeInTheDocument();
    expect(within(section()).queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the API message of a 503 with "Tentar de novo", which reloads it', async () => {
    let reads = 0;
    server.use(
      http.get(HISTORY_URL, () => {
        reads += 1;
        return reads === 1 ? busy() : undefined;
      }),
    );
    const { user } = await openEdit(ELIDA);
    const alert = await within(section()).findByRole('alert');
    expect(alert).toHaveTextContent(HISTORY_ERROR);
    expect(alert).toHaveTextContent(BUSY);
    await user.click(within(alert).getByRole('button', { name: RETRY }));
    expect(await historyTable()).toBeInTheDocument();
    expect(within(section()).queryByRole('alert')).not.toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it('shows "Sem permissão" without a retry on a 403', async () => {
    server.use(
      http.get(HISTORY_URL, () =>
        HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
      ),
    );
    await openEdit(ELIDA);
    const alert = await within(section()).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos examinadores');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the form working with the history in error, and the error stays in the section', async () => {
    server.use(http.get(HISTORY_URL, busy));
    const { user, router } = await openEdit(ELIDA);
    const alert = await within(section()).findByRole('alert');
    expect(alert).toHaveTextContent(BUSY);
    expect(screen.getByRole('heading', { level: 1, name: 'Editar aluno' })).toBeInTheDocument();
    // The only error on the screen is the history's.
    expect(screen.getAllByRole('alert')).toEqual([alert]);

    const name = screen.getByRole('textbox', { name: /^Nome/ });
    await user.clear(name);
    await user.paste('Élida Ramos Lima');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Alterações salvas.');
    expect(router.state.location.pathname).toBe('/alunos');
    expect(db.students.find((item) => item.student.id === ELIDA)?.student.full_name).toBe(
      'Élida Ramos Lima',
    );
  });

  describe('foco depois de "Tentar de novo" (§ 6.7)', () => {
    // The teardown returned by `beforeEach` stops it after each test.
    beforeEach(() => emulateFocusFixup());

    /** The first GET fails; each one after waits for `answer` to bring the data or fail again. */
    function failingHistory() {
      const waiting: ((ok: boolean) => void)[] = [];
      let reads = 0;
      server.use(
        http.get(HISTORY_URL, async () => {
          reads += 1;
          if (reads > 1) {
            const ok = await new Promise<boolean>((resolve) => {
              waiting.push(resolve);
            });
            if (ok) return undefined;
          }
          return busy();
        }),
      );
      return {
        answer: async (ok: boolean) => {
          await waitFor(() => {
            expect(waiting.length).toBeGreaterThan(0);
          });
          await act(async () => {
            waiting.shift()!(ok);
            await Promise.resolve();
          });
        },
      };
    }

    async function pressRetry(user: Awaited<ReturnType<typeof renderApp>>['user']) {
      const alert = await within(section()).findByRole('alert');
      within(alert).getByRole('button', { name: RETRY }).focus();
      await user.keyboard('{Enter}');
    }

    it('the history comes: the focus goes to the section title', async () => {
      const reads = failingHistory();
      const { user } = await openEdit(ELIDA);
      await pressRetry(user);
      await reads.answer(true);
      await historyTable();
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { level: 2, name: 'Histórico de exames' }),
        ).toHaveFocus();
      });
    });

    it('it fails again: the focus goes to the new "Tentar de novo"', async () => {
      const reads = failingHistory();
      const { user } = await openEdit(ELIDA);
      await pressRetry(user);
      await reads.answer(false);
      await waitFor(() => {
        const alert = within(section()).getByRole('alert');
        expect(within(alert).getByRole('button', { name: RETRY })).toHaveFocus();
      });
    });

    it('a focus the user put on the form stays there', async () => {
      const reads = failingHistory();
      const { user } = await openEdit(ELIDA);
      await pressRetry(user);
      const name = screen.getByRole('textbox', { name: /^Nome/ });
      name.focus();
      await reads.answer(true);
      await historyTable();
      expect(name).toHaveFocus();
    });
  });
});

describe('histórico de exames: notebook e celular (§ 6.7)', () => {
  it('is a table in its own scroll region on the notebook and the tablet', async () => {
    for (const width of [1280, 768]) {
      setViewportWidth(width);
      const { unmount } = await openEdit(ELIDA);
      const table = await historyTable();
      const region = screen.getByRole('region', { name: 'Lista de exames' });
      expect(region).toContainElement(table);
      expect(region).toHaveAttribute('tabindex', '0');
      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((th) => th.textContent),
      ).toEqual(['Data', 'Evento', 'Exame', 'Situação', 'Decisão', 'Ação']);
      unmount();
    }
  });

  it.each([390, 640])(
    'is a list of cards at %i px (phone, 200%% zoom), with every action',
    async (width) => {
      setViewportWidth(width);
      answerHistory([
        entry({ event_id: 'a', event_name: 'Exame setembro/2027', notes: 'Treinar as quedas' }),
        entry({ event_id: 'b', event_name: null, exam_date: null, ...IN_PROGRESS }),
      ]);
      await openEdit(ELIDA);
      const list = await within(section()).findByRole('list', { name: 'Histórico de exames' });
      expect(within(section()).queryByRole('table')).not.toBeInTheDocument();
      const [decided, noEvent] = within(list).getAllByRole('listitem');

      const card = within(decided!);
      expect(
        card.getByRole('heading', { level: 3, name: 'Exame setembro/2027' }),
      ).toBeInTheDocument();
      expect(card.getByText('25/09/2027')).toBeInTheDocument();
      expect(card.getByText('Faixa Azul')).toBeInTheDocument();
      expect(card.getByText('Reprovado')).toBeInTheDocument();
      expect(await card.findByText('Decidido por Sensei Simulado')).toBeInTheDocument();
      expect(card.getByText('em 25/09/2027')).toBeInTheDocument();
      expect(card.getByText('Treinar as quedas')).toBeInTheDocument();
      expect(card.getByRole('link', { name: /^Abrir exame: Faixa Azul/ })).toHaveAttribute(
        'href',
        examPath('a', ELIDA),
      );

      const other = within(noEvent!);
      expect(
        other.getByRole('heading', { level: 3, name: 'Evento não encontrado' }),
      ).toBeInTheDocument();
      expect(other.getByText('Em andamento')).toBeInTheDocument();
      expect(other.queryByText('Decisão')).not.toBeInTheDocument();
      expect(other.queryByRole('link')).not.toBeInTheDocument();
    },
  );

  it('keeps the heading order in the page: its title, the section, then each card', async () => {
    setViewportWidth(390);
    await openEdit(ELIDA);
    await within(section()).findByRole('list', { name: 'Histórico de exames' });
    const levels = within(screen.getByRole('main'))
      .getAllByRole('heading')
      .map((heading) => Number(heading.tagName.slice(1)));
    expect(levels).toEqual([1, 2, 3]);
  });
});
