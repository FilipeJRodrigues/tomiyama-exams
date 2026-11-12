/**
 * Exam notices at the top of the student's profile (RN019, § 6.2, § 6.7): only for the guardian,
 * one "Exame de faixas dia dd/mm/aaaa" per item of `GET /students/{id}/exam-notices`, in the API
 * order, with its own loading and error states, apart from the form.
 *
 * Slow answers are held by the test (`hold`) and released by it: no real wait.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ExamNotice } from '../../../src/api/types';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp, type RenderAppOptions } from '../../render';
import { setViewportWidth } from '../../viewport';

/** Guardian's student, eligible: has the notice of the open event in the simulated API. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
/** Guardian's student, blocked: no notice. */
const BRUNO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e02';
/** Examiner's student (a guardian gets 404). */
const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';

const NOTICES_URL = `${TEST_API_URL}/students/:id/exam-notices`;
const AREA = 'Avisos de exame';
const LOADING = 'Verificando avisos de exame…';
const NOTICES_ERROR = 'Não foi possível carregar os avisos de exame';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const INTERNAL = 'Erro interno. Tente de novo.';
const NETWORK = 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.';
const RETRY = 'Tentar de novo';

function beltId(name: string): string {
  return mockBelts.find((belt) => belt.name === name)!.id;
}

/** A notice; by default a belt exam at the December event. */
function notice(overrides: Partial<ExamNotice> = {}): ExamNotice {
  return {
    event_id: 'evento-dezembro',
    event_name: 'Exame dezembro/2026',
    event_date: '2026-12-05',
    target_belt_id: beltId('Cinza/Azul'),
    target_belt_name: 'Cinza/Azul',
    kind: 'BELT',
    ...overrides,
  };
}

let db: MockDb;

/** The route answers these notices, as they are (the screen never reorders them). */
function answerNotices(notices: ExamNotice[]) {
  server.use(http.get(NOTICES_URL, () => HttpResponse.json(notices)));
}

/** Records every request to the notices route and lets the next handler answer it. */
function recordNotices(): Request[] {
  const requests: Request[] = [];
  server.use(
    http.get(NOTICES_URL, ({ request }) => {
      requests.push(request.clone());
      return undefined;
    }),
  );
  return requests;
}

/** Holds every GET of the notices until the test releases it; then the next handler answers. */
function holdNotices() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(NOTICES_URL, async () => {
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

function failure(status: number, message: string) {
  return HttpResponse.json({ message }, { status });
}

async function openEdit(id: string, signedInAs: RenderAppOptions['signedInAs'] = 'guardian') {
  const result = await renderApp({ route: `/alunos/${id}`, signedInAs });
  await screen.findByRole('combobox', { name: /^Faixa atual/ });
  return result;
}

function area(): HTMLElement {
  return screen.getByRole('region', { name: AREA });
}

async function findNotes(): Promise<HTMLElement[]> {
  return within(await screen.findByRole('region', { name: AREA })).findAllByRole('note');
}

/** The route was asked `count` times and the answer is on the screen. */
async function settled(requests: Request[], count = 1) {
  await waitFor(() => {
    expect(requests).toHaveLength(count);
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();
  });
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

describe('avisos de exame: o que o responsável vê (RN019)', () => {
  it('rn019 shows the guardian the notice of the open event, from the simulated API', async () => {
    const requests = recordNotices();
    await openEdit(ANA);
    const notes = await findNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveAccessibleName('Exame de faixas dia 21/11/2026');
    // The sentence of RN019 is on the screen alone and whole.
    expect(screen.getByText('Exame de faixas dia 21/11/2026')).toBeInTheDocument();
    expect(within(notes[0]!).getByText('Exame novembro/2026 · Faixa Cinza/Azul')).toBeVisible();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/students/${ANA}/exam-notices`,
    ]);
  });

  it('rn019 shows one notice per event, in the order the API sends, without sorting it again', async () => {
    answerNotices([
      notice({ event_id: 'b', event_name: 'Exame março/2027', event_date: '2027-03-20' }),
      notice({ event_id: 'a', event_name: 'Exame dezembro/2026', event_date: '2026-12-05' }),
    ]);
    await openEdit(ANA);
    const notes = await findNotes();
    expect(notes.map((note) => note.getAttribute('aria-labelledby'))).not.toContain(null);
    expect(notes.map((note) => within(note).getByText(/^Exame de faixas dia/).textContent)).toEqual(
      ['Exame de faixas dia 20/03/2027', 'Exame de faixas dia 05/12/2026'],
    );
  });

  it.each([
    ['2026-12-05', '05/12/2026'],
    ['2027-01-01', '01/01/2027'],
    ['2028-02-29', '29/02/2028'],
  ])('writes the date %s of the API as %s, the same calendar day', async (iso, shown) => {
    answerNotices([notice({ event_date: iso })]);
    await openEdit(ANA);
    await findNotes();
    expect(screen.getByText(`Exame de faixas dia ${shown}`)).toBeInTheDocument();
  });

  it('names the event and the target of a belt exam and of a stripe exam', async () => {
    answerNotices([
      notice({ event_id: 'faixa' }),
      notice({
        event_id: 'grau',
        event_name: 'Exame março/2027',
        event_date: '2027-03-20',
        kind: 'STRIPE',
        target_belt_id: beltId('Roxa'),
        target_belt_name: 'Roxa',
      }),
    ]);
    await openEdit(ANA);
    const [belt, stripe] = await findNotes();
    expect(within(belt!).getByText('Exame dezembro/2026 · Faixa Cinza/Azul')).toBeInTheDocument();
    expect(within(stripe!).getByText('Exame março/2027 · Grau (rumo à Roxa)')).toBeInTheDocument();
    // The sentence of RN019 is the same for both kinds.
    expect(within(stripe!).getByText('Exame de faixas dia 20/03/2027')).toBeInTheDocument();
  });

  it('rn019 only informs: no button, no link and no field in the notices', async () => {
    await openEdit(ANA);
    await findNotes();
    const region = within(area());
    expect(region.queryByRole('button')).not.toBeInTheDocument();
    expect(region.queryByRole('link')).not.toBeInTheDocument();
    expect(region.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('is a standing note with a decorative icon, never an alert or a status', async () => {
    await openEdit(ANA);
    const [note] = await findNotes();
    expect(note!.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(area()).toHaveAttribute('aria-busy', 'false');
  });

  it('comes right below the page title and before the form', async () => {
    await openEdit(ANA);
    await findNotes();
    const title = screen.getByRole('heading', { level: 1, name: 'Editar aluno' });
    const form = screen.getByRole('form', { name: 'Editar aluno' });
    expect(title.compareDocumentPosition(area())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(area().compareDocumentPosition(form)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // No heading of its own: the page keeps a single title.
    expect(within(screen.getByRole('main')).getAllByRole('heading')).toEqual([title]);
  });
});

describe('avisos de exame: sem aviso', () => {
  it('shows nothing at all for a student without notices (simulated API)', async () => {
    const requests = recordNotices();
    await openEdit(BRUNO);
    await settled(requests);
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Exame de faixas/)).not.toBeInTheDocument();
    expect(screen.queryByText(/aviso/i)).not.toBeInTheDocument();
  });

  it('leaves nothing between the title and the form when the API answers []', async () => {
    answerNotices([]);
    // Installed last, so it sees the request before the answer above.
    const requests = recordNotices();
    await openEdit(ANA);
    await settled(requests);
    const title = screen.getByRole('heading', { level: 1, name: 'Editar aluno' });
    expect(title.nextElementSibling).toContainElement(
      screen.getByRole('form', { name: 'Editar aluno' }),
    );
  });
});

describe('avisos de exame: quem não vê (RN019)', () => {
  it.each([
    ['an examiner', 'examiner', 'mock-examiner-2'],
    ['the admin master', 'master', 'mock-examiner-2'],
    ['the sensei', 'examiner', MOCK_USER_IDS.examiner],
  ] as const)('rn019 %s sees no notice and never asks for them', async (_who, role, senseiId) => {
    db.settings.sensei_user_id = senseiId;
    const requests = recordNotices();
    await openEdit(ANA, role);
    // The history is the last read of the examiner's profile: by then nothing else is asked.
    expect(
      await within(screen.getByRole('region', { name: 'Histórico de exames' })).findByText(
        'Nenhum exame registrado.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();
    expect(screen.queryByText(/Exame de faixas/)).not.toBeInTheDocument();
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('rn019 an examiner who saves the student still asks for no notice', async () => {
    const requests = recordNotices();
    const { user } = await openEdit(ANA, 'examiner');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("never asks for the notices of a student that is not found (someone else's: 404)", async () => {
    const requests = recordNotices();
    await renderApp({ route: `/alunos/${CARLA}`, signedInAs: 'guardian' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Aluno não encontrado' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();
    expect(screen.queryByText(NOTICES_ERROR)).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('asks only once the student is on the screen, not while it loads', async () => {
    let releaseStudent: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseStudent = resolve;
    });
    server.use(
      http.get(`${TEST_API_URL}/students/${ANA}`, async () => {
        await gate;
        return undefined;
      }),
    );
    const requests = recordNotices();
    await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando aluno…');
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
    releaseStudent();
    expect(await findNotes()).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it('the page to create a student has no notices and asks for none', async () => {
    const requests = recordNotices();
    await renderApp({ route: '/alunos/novo', signedInAs: 'guardian' });
    await screen.findByRole('combobox', { name: /^Faixa atual/ });
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });
});

describe('avisos de exame: estados da área', () => {
  it('shows a discreet loading line while the form is already usable, without taking the focus', async () => {
    const notices = holdNotices();
    const { user } = await openEdit(ANA);
    expect(within(area()).getByText(LOADING)).toBeVisible();
    expect(area()).toHaveAttribute('aria-busy', 'true');
    // Not a status: the status of the page is the form's.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    const name = screen.getByRole('textbox', { name: /^Nome/ });
    await user.clear(name);
    await user.paste('Ana Souza Lima');
    await notices.release();

    expect(await findNotes()).toHaveLength(1);
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();
    // What was typed stays, and so does the focus.
    expect(name).toHaveValue('Ana Souza Lima');
    expect(name).toHaveFocus();
  });

  it.each([
    ['a 503', () => failure(503, BUSY), BUSY],
    ['a 500', () => failure(500, INTERNAL), INTERNAL],
    ['a network failure', () => HttpResponse.error(), NETWORK],
  ])(
    'shows the message of %s with "Tentar de novo", which reads only the notices again',
    async (_what, fail, message) => {
      let reads = 0;
      server.use(
        http.get(NOTICES_URL, () => {
          reads += 1;
          return reads === 1 ? fail() : undefined;
        }),
      );
      const others: string[] = [];
      const { user } = await openEdit(ANA);
      const alert = await within(area()).findByRole('alert');
      expect(alert).toHaveTextContent(NOTICES_ERROR);
      expect(alert).toHaveTextContent(message);
      // From here on, every request that is not for the notices.
      server.use(
        http.all(`${TEST_API_URL}/*`, ({ request }) => {
          if (!request.url.endsWith('/exam-notices')) others.push(request.url);
          return undefined;
        }),
      );

      await user.click(within(alert).getByRole('button', { name: RETRY }));

      expect(await findNotes()).toHaveLength(1);
      expect(within(area()).queryByRole('alert')).not.toBeInTheDocument();
      expect(reads).toBe(2);
      expect(others).toEqual([]);
    },
  );

  it('keeps the form working with the notices in error, and the error stays in the area', async () => {
    server.use(http.get(NOTICES_URL, () => failure(503, BUSY)));
    const { user, router } = await openEdit(ANA);
    const alert = await within(area()).findByRole('alert');
    expect(screen.getAllByRole('alert')).toEqual([alert]);
    expect(screen.getByRole('heading', { level: 1, name: 'Editar aluno' })).toBeInTheDocument();

    const name = screen.getByRole('textbox', { name: /^Nome/ });
    await user.clear(name);
    await user.paste('Ana Souza Lima');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/alunos');
    expect(db.students.find((item) => item.student.id === ANA)?.student.full_name).toBe(
      'Ana Souza Lima',
    );
  });

  it('shows the API message of a 404 of the notices in the area, as the history does', async () => {
    server.use(http.get(NOTICES_URL, () => failure(404, 'Aluno não encontrado')));
    await openEdit(ANA);
    const alert = await within(area()).findByRole('alert');
    expect(alert).toHaveTextContent(NOTICES_ERROR);
    expect(alert).toHaveTextContent('Aluno não encontrado');
    // The profile itself is still the form: its own 404 is the one that replaces the page.
    expect(screen.getByRole('heading', { level: 1, name: 'Editar aluno' })).toBeInTheDocument();
  });

  it('shows "Sem permissão" without a retry on a 403', async () => {
    server.use(http.get(NOTICES_URL, () => failure(403, 'Esta área é dos responsáveis')));
    await openEdit(ANA);
    const alert = await within(area()).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos responsáveis');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the notices on the screen when a reload in the background fails', async () => {
    let fail = false;
    server.use(http.get(NOTICES_URL, () => (fail ? failure(503, BUSY) : undefined)));
    const { queryClient } = await openEdit(ANA);
    await findNotes();
    fail = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['student', ANA, 'exam-notices'] });
    });
    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('foco depois de "Tentar de novo" (§ 6.7)', () => {
    // The teardown returned by `beforeEach` stops it after each test.
    beforeEach(() => emulateFocusFixup());

    /**
     * The first GET fails; each one after waits for `answer`: `'notices'` lets the simulated
     * API answer, `'none'` answers `[]` and `'fail'` fails again.
     */
    function failingNotices() {
      type Outcome = 'notices' | 'none' | 'fail';
      const waiting: ((outcome: Outcome) => void)[] = [];
      let reads = 0;
      server.use(
        http.get(NOTICES_URL, async () => {
          reads += 1;
          if (reads > 1) {
            const outcome = await new Promise<Outcome>((resolve) => {
              waiting.push(resolve);
            });
            if (outcome === 'notices') return undefined;
            if (outcome === 'none') return HttpResponse.json([]);
          }
          return failure(503, BUSY);
        }),
      );
      return {
        answer: async (outcome: Outcome) => {
          await waitFor(() => {
            expect(waiting.length).toBeGreaterThan(0);
          });
          await act(async () => {
            waiting.shift()!(outcome);
            await Promise.resolve();
          });
        },
      };
    }

    async function pressRetry(user: Awaited<ReturnType<typeof renderApp>>['user']) {
      const alert = await within(area()).findByRole('alert');
      within(alert).getByRole('button', { name: RETRY }).focus();
      await user.keyboard('{Enter}');
    }

    it('the notices come: the focus goes to the notices area', async () => {
      const reads = failingNotices();
      const { user } = await openEdit(ANA);
      await pressRetry(user);
      await reads.answer('notices');
      expect(await findNotes()).toHaveLength(1);
      await waitFor(() => {
        expect(area()).toHaveFocus();
      });
    });

    it('no notice comes: the area leaves and the focus goes to the page title', async () => {
      const reads = failingNotices();
      const { user } = await openEdit(ANA);
      await pressRetry(user);
      await reads.answer('none');
      await waitFor(() => {
        expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'Editar aluno' })).toHaveFocus();
      });
    });

    it('it fails again: the focus goes to the new "Tentar de novo"', async () => {
      const reads = failingNotices();
      const { user } = await openEdit(ANA);
      await pressRetry(user);
      await reads.answer('fail');
      await waitFor(() => {
        const alert = within(area()).getByRole('alert');
        expect(within(alert).getByRole('button', { name: RETRY })).toHaveFocus();
      });
    });

    it('a focus the user put on the form stays there', async () => {
      const reads = failingNotices();
      const { user } = await openEdit(ANA);
      await pressRetry(user);
      const name = screen.getByRole('textbox', { name: /^Nome/ });
      name.focus();
      await reads.answer('notices');
      await findNotes();
      expect(name).toHaveFocus();
    });
  });
});

describe('avisos de exame: depois de salvar ou excluir o aluno', () => {
  it('rn019 reads the notices again after the guardian saves the student', async () => {
    const requests = recordNotices();
    const { user } = await openEdit(ANA);
    await findNotes();
    expect(requests).toHaveLength(1);

    await user.clear(screen.getByLabelText(/^Nascimento/));
    await user.type(screen.getByLabelText(/^Nascimento/), '2018-05-11');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();

    // The save itself asks again, before the page leaves for the list.
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests.every((request) => request.url.endsWith(`/students/${ANA}/exam-notices`))).toBe(
      true,
    );
  });

  it('forgets the notices of a deleted student', async () => {
    const { user, queryClient } = await openEdit(ANA);
    await findNotes();
    const key = ['student', ANA, 'exam-notices'];
    expect(queryClient.getQueryData(key)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Excluir aluno' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir aluno' });
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(await screen.findByText('Aluno excluído.')).toBeInTheDocument();
    await waitFor(() => {
      expect(queryClient.getQueryState(key)).toBeUndefined();
    });
  });
});

describe('avisos de exame: notebook e celular (§ 6.7)', () => {
  const LONG_NAME = `Exame ${'extraordinário'.repeat(5)} de dezembro`;

  it.each([1280, 768, 390, 320])(
    'keeps the notice, the form and both actions at %i px',
    async (width) => {
      setViewportWidth(width);
      answerNotices([notice({ event_name: LONG_NAME })]);
      await openEdit(ANA);
      const [note] = await findNotes();
      expect(within(note!).getByText('Exame de faixas dia 05/12/2026')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Salvar alterações' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Excluir aluno' })).toBeVisible();
    },
  );

  it('a long event name wraps instead of being cut or widening the page', async () => {
    answerNotices([notice({ event_name: LONG_NAME })]);
    await openEdit(ANA);
    const [note] = await findNotes();
    const detail = within(note!).getByText(`${LONG_NAME} · Faixa Cinza/Azul`);
    expect(detail).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(detail.style.whiteSpace).toBe('');
    expect(detail.style.textOverflow).toBe('');
  });
});
