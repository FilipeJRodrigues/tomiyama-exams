/**
 * QA do card #109 (RN019, § 6.2, § 6.7): bordas dos avisos de exame no perfil do aluno que os
 * testes do agente não cobrem: resposta com campos fora do contrato, troca de aluno na mesma
 * tela, gravação com a leitura dos avisos em voo ou em erro, releitura em segundo plano e
 * sessão ausente.
 *
 * Respostas lentas são seguradas pelo teste (`gate`) e soltas por ele: nenhuma espera real.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

/** Guardian's student, eligible: one notice in the simulated API. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
/** Guardian's student, blocked: no notice. */
const BRUNO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e02';

const NOTICES_URL = `${TEST_API_URL}/students/:id/exam-notices`;
const AREA = 'Avisos de exame';
const LOADING = 'Verificando avisos de exame…';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

const CINZA_AZUL = mockBelts.find((belt) => belt.name === 'Cinza/Azul')!.id;

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evento-dezembro',
    event_name: 'Exame dezembro/2026',
    event_date: '2026-12-05',
    target_belt_id: CINZA_AZUL,
    target_belt_name: 'Cinza/Azul',
    kind: 'BELT',
    ...overrides,
  };
}

function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    promise,
    release: async () => {
      await act(async () => {
        open();
        await Promise.resolve();
      });
    },
  };
}

function recordNotices(): string[] {
  const paths: string[] = [];
  server.use(
    http.get(NOTICES_URL, ({ request }) => {
      paths.push(new URL(request.url).pathname);
      return undefined;
    }),
  );
  return paths;
}

async function openEdit(id: string) {
  const result = await renderApp({ route: `/alunos/${id}`, signedInAs: 'guardian' });
  await screen.findByRole('combobox', { name: /^Faixa atual/ });
  return result;
}

async function findNotes(): Promise<HTMLElement[]> {
  return within(await screen.findByRole('region', { name: AREA })).findAllByRole('note');
}

let db: MockDb;

beforeEach(() => {
  db = createMockDb({ includeShowcase: true });
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('avisos de exame (qa #109): campos fora do contrato não derrubam o formulário', () => {
  it.each([
    [
      'sem target_belt_name',
      item({ target_belt_name: undefined }),
      /Exame dezembro\/2026 · Faixa —/,
    ],
    ['com target_belt_name nulo (faixa excluída)', item({ target_belt_name: null }), /· Faixa —/],
    ['com kind desconhecido', item({ kind: 'OUTRO' }), /Exame dezembro\/2026 · /],
    ['com data inválida', item({ event_date: '2026-02-30' }), /Exame dezembro\/2026 · Faixa/],
    ['com data ausente', item({ event_date: '' }), /Exame dezembro\/2026 · Faixa/],
  ])('item %s: o aviso aparece e o formulário continua', async (_what, notice, detail) => {
    server.use(http.get(NOTICES_URL, () => HttpResponse.json([notice])));
    await openEdit(ANA);
    const [note] = await findNotes();
    expect(within(note!).getByText(detail)).toBeInTheDocument();
    expect(within(note!).getByText(/^Exame de faixas dia /)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Editar aluno' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar alterações' })).toBeEnabled();
  });

  it('nunca mostra "undefined", "null" nem "Invalid Date" num aviso incompleto', async () => {
    server.use(
      http.get(NOTICES_URL, () =>
        HttpResponse.json([
          item({ event_id: 'a', target_belt_name: undefined, kind: 'OUTRO' }),
          item({ event_id: 'b', target_belt_name: null, event_date: 'x' }),
        ]),
      ),
    );
    await openEdit(ANA);
    await findNotes();
    const text = screen.getByRole('region', { name: AREA }).textContent;
    expect(text).not.toMatch(/undefined|null|Invalid|NaN/);
  });
});

describe('avisos de exame (qa #109): troca de aluno na mesma tela', () => {
  it('de um aluno com aviso para outro sem aviso: o aviso do primeiro some já na carga', async () => {
    const student = gate();
    const paths = recordNotices();
    const { router } = await openEdit(ANA);
    expect(await findNotes()).toHaveLength(1);

    server.use(
      http.get(`${TEST_API_URL}/students/${BRUNO}`, async () => {
        await student.promise;
        return undefined;
      }),
    );
    await act(async () => {
      await router.navigate(`/alunos/${BRUNO}`);
    });
    // While Bruno loads: nothing of Ana on the screen. Bruno's notices are asked together with
    // him (once, for his own id), and nothing of the area shows before his form does.
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando aluno…');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Exame de faixas/)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(paths).toEqual([`/students/${ANA}/exam-notices`, `/students/${BRUNO}/exam-notices`]);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Carregando aluno…');
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Exame de faixas/)).not.toBeInTheDocument();
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();

    await student.release();
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /^Nome/ })).toHaveValue('Bruno Souza');
      expect(screen.queryByText(LOADING)).not.toBeInTheDocument();
    });
    // The form came: Bruno's notices are not asked a second time, and Ana's never show here.
    expect(paths).toEqual([`/students/${ANA}/exam-notices`, `/students/${BRUNO}/exam-notices`]);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Exame de faixas/)).not.toBeInTheDocument();
  });

  it('com os dois alunos já em cache: nunca mostra o aviso de um no perfil do outro', async () => {
    const notices = gate();
    const { router } = await openEdit(BRUNO);
    await act(async () => {
      await router.navigate(`/alunos/${ANA}`);
    });
    expect(await findNotes()).toHaveLength(1);

    // Back to Bruno, already cached, with his notices held: Ana's notice must not stay.
    server.use(
      http.get(NOTICES_URL, async () => {
        await notices.promise;
        return undefined;
      }),
    );
    await act(async () => {
      await router.navigate(`/alunos/${BRUNO}`);
    });
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /^Nome/ })).toHaveValue('Bruno Souza');
    });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Exame de faixas/)).not.toBeInTheDocument();
    await notices.release();
    await waitFor(() => {
      expect(screen.queryByText(LOADING)).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});

describe('avisos de exame (qa #109): a área e o aluno que já falhou (reteste)', () => {
  /** Examiner's student: the guardian gets 404 for the student and for the notices. */
  const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';

  it('o aluno já carregado falha numa releitura em segundo plano: a área continua, e é relida na volta seguinte', async () => {
    let failing = false;
    server.use(
      http.get(`${TEST_API_URL}/students/${ANA}`, () =>
        failing ? HttpResponse.json({ message: BUSY }, { status: 503 }) : undefined,
      ),
    );
    const paths = recordNotices();
    const { queryClient } = await openEdit(ANA);
    await findNotes();
    expect(paths).toHaveLength(1);

    // The student is on the screen and its reload fails: an error in the cache, with data.
    failing = true;
    for (let round = 1; round <= 2; round += 1) {
      await act(async () => {
        window.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(paths).toHaveLength(1 + round);
        expect(queryClient.isFetching()).toBe(0);
      });
      const state = queryClient.getQueryState(['student', ANA]);
      expect(state?.status).toBe('error');
      expect(state?.errorUpdatedAt).toBeGreaterThan(0);
      expect(state?.data).toBeDefined();
      // Still the form with its notice: the old error of the student does not take the area out.
      expect(screen.getByRole('form', { name: 'Editar aluno' })).toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: AREA })).getAllByRole('note')).toHaveLength(
        1,
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }
  });

  it('de um aluno não encontrado para outro do responsável, na mesma tela: os avisos do segundo são pedidos junto com ele', async () => {
    const student = gate();
    const paths = recordNotices();
    const { router } = await renderApp({ route: `/alunos/${CARLA}`, signedInAs: 'guardian' });
    await screen.findByRole('heading', { level: 1, name: 'Aluno não encontrado' });
    await waitFor(() => {
      expect(paths).toEqual([`/students/${CARLA}/exam-notices`]);
    });

    server.use(
      http.get(`${TEST_API_URL}/students/${ANA}`, async () => {
        await student.promise;
        return undefined;
      }),
    );
    await act(async () => {
      await router.navigate(`/alunos/${ANA}`);
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando aluno…');
    // Asked while Ana still loads: the failure of the other student does not hold her area back.
    await waitFor(() => {
      expect(paths).toEqual([`/students/${CARLA}/exam-notices`, `/students/${ANA}/exam-notices`]);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Carregando aluno…');
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();

    await student.release();
    expect(await findNotes()).toHaveLength(1);
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();
    expect(paths).toHaveLength(2);
  });

  it('de um aluno do responsável para um não encontrado: nada do aviso do primeiro, e uma só leitura dos avisos do segundo', async () => {
    const paths = recordNotices();
    const { router, queryClient } = await openEdit(ANA);
    await findNotes();
    await act(async () => {
      await router.navigate(`/alunos/${CARLA}`);
    });
    await screen.findByRole('heading', { level: 1, name: 'Aluno não encontrado' });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Exame de faixas/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(paths).toEqual([`/students/${ANA}/exam-notices`, `/students/${CARLA}/exam-notices`]);
  });

  it.each(['/alunos/', '/alunos//'])(
    'a rota %s (sem id) não pede aluno nem avisos de id vazio',
    async (route) => {
      const asked: string[] = [];
      server.use(
        http.all(`${TEST_API_URL}/*`, ({ request }) => {
          asked.push(new URL(request.url).pathname);
          return undefined;
        }),
      );
      const { queryClient } = await renderApp({ route, signedInAs: 'guardian' });
      await waitFor(() => {
        expect(asked.length).toBeGreaterThan(0);
        expect(queryClient.isFetching()).toBe(0);
      });
      expect(asked.filter((path) => path.includes('exam-notices'))).toEqual([]);
      expect(asked.filter((path) => /\/students\/(\/|$)/.test(path))).toEqual([]);
    },
  );

  it('rn019 o examinador não pede os avisos nem enquanto o aluno carrega', async () => {
    const student = gate();
    server.use(
      http.get(`${TEST_API_URL}/students/${ANA}`, async () => {
        await student.promise;
        return undefined;
      }),
    );
    const paths = recordNotices();
    const { queryClient } = await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'examiner' });
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando aluno…');
    expect(queryClient.getQueryState(['student', ANA, 'exam-notices'])).toBeUndefined();
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();

    await student.release();
    await screen.findByRole('combobox', { name: /^Faixa atual/ });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(paths).toEqual([]);
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();
  });

  it('aluno e avisos falham na primeira carga; o "Tentar de novo" do aluno traz o formulário e os avisos são relidos e mostrados', async () => {
    let studentFailing = true;
    let noticesFailing = true;
    server.use(
      http.get(`${TEST_API_URL}/students/${ANA}`, () =>
        studentFailing ? HttpResponse.json({ message: BUSY }, { status: 503 }) : undefined,
      ),
      http.get(`${TEST_API_URL}/students/${ANA}/exam-notices`, () =>
        noticesFailing ? HttpResponse.json({ message: BUSY }, { status: 503 }) : undefined,
      ),
    );
    const { user, queryClient } = await renderApp({
      route: `/alunos/${ANA}`,
      signedInAs: 'guardian',
    });
    const retry = await screen.findByRole('button', { name: 'Tentar de novo' });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(queryClient.getQueryState(['student', ANA, 'exam-notices'])?.status).toBe('error');
    // Only the error of the student: the area of a student that failed is not on the screen.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();

    studentFailing = false;
    noticesFailing = false;
    await user.click(retry);
    await screen.findByRole('combobox', { name: /^Faixa atual/ });
    expect(await findNotes()).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('avisos de exame (qa #109): gravar com a leitura dos avisos em voo ou em erro', () => {
  it('grava e vai para a lista com a primeira leitura dos avisos ainda sem resposta', async () => {
    const notices = gate();
    server.use(
      http.get(NOTICES_URL, async () => {
        await notices.promise;
        return undefined;
      }),
    );
    const { user, router } = await openEdit(ANA);
    expect(screen.getByText(LOADING)).toBeInTheDocument();
    // From here on: the sign-in of the test harness is over.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/alunos');

    // The held answer comes with the profile already gone: nothing of it on the list.
    await notices.release();
    expect(screen.queryByText(/Exame de faixas/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
  });

  it('a releitura depois de gravar falha com a tela já na lista: nenhum erro tardio', async () => {
    let reads = 0;
    const second = gate();
    server.use(
      http.get(NOTICES_URL, async () => {
        reads += 1;
        if (reads === 1) return undefined;
        await second.promise;
        return HttpResponse.json({ message: BUSY }, { status: 503 });
      }),
    );
    const { user } = await openEdit(ANA);
    await findNotes();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByText('Alterações salvas.')).toBeInTheDocument();
    await second.release();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(BUSY)).not.toBeInTheDocument();
    expect(screen.getByText('Alterações salvas.')).toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
  });

  it('o envio recusado pela API (400) deixa os avisos na tela e não os lê de novo', async () => {
    const paths = recordNotices();
    server.use(
      http.put(`${TEST_API_URL}/students/${ANA}`, () =>
        HttpResponse.json({ message: 'Nome é obrigatório' }, { status: 400 }),
      ),
    );
    const { user } = await openEdit(ANA);
    await findNotes();
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByText('Nome é obrigatório')).toBeInTheDocument();
    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(paths).toHaveLength(1);
  });
});

describe('avisos de exame (qa #109): releitura em segundo plano', () => {
  it('a janela volta ao foco: os avisos são lidos de novo sem apagar o que foi digitado', async () => {
    const paths = recordNotices();
    const { user } = await openEdit(ANA);
    await findNotes();
    const name = screen.getByRole('textbox', { name: /^Nome/ });
    await user.clear(name);
    await user.paste('Ana Souza Lima');

    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(paths).toHaveLength(2);
    });
    expect(name).toHaveValue('Ana Souza Lima');
    expect(name).toHaveFocus();
    expect(screen.getAllByRole('note')).toHaveLength(1);
    // The reload in the background never shows the loading line again.
    expect(screen.queryByText(LOADING)).not.toBeInTheDocument();
  });

  it('o evento é encerrado: a releitura traz [] e a área some, com o foco do campo mantido', async () => {
    let empty = false;
    server.use(http.get(NOTICES_URL, () => (empty ? HttpResponse.json([]) : undefined)));
    const { queryClient } = await openEdit(ANA);
    await findNotes();
    const name = screen.getByRole('textbox', { name: /^Nome/ });
    name.focus();
    empty = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['student', ANA, 'exam-notices'] });
    });
    expect(screen.queryByRole('region', { name: AREA })).not.toBeInTheDocument();
    expect(name).toHaveFocus();
  });
});

describe('avisos de exame (qa #109): sem sessão', () => {
  it('rn019 sem login, o perfil do aluno não pede os avisos', async () => {
    const paths = recordNotices();
    const { router } = await renderApp({ route: `/alunos/${ANA}` });
    await waitFor(() => {
      expect(router.state.location.pathname).not.toBe(`/alunos/${ANA}`);
    });
    expect(screen.queryByText(/Exame de faixas/)).not.toBeInTheDocument();
    expect(paths).toEqual([]);
  });
});

describe('avisos de exame (qa #109): LGPD', () => {
  it('nada dos avisos vai para o armazenamento local nem para o console', async () => {
    const logs = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    await openEdit(ANA);
    await findNotes();
    // The harness' own `act` warnings do not count: only what carries data of the student.
    const printed = logs
      .flatMap((log) => log.mock.calls.map((call) => call.map(String).join(' ')))
      .join(' | ');
    expect(printed).not.toMatch(/Exame novembro|Cinza\/Azul|Ana Souza|2026-11-21/);
    const stored = [window.localStorage, window.sessionStorage]
      .flatMap((storage) => Object.keys(storage).map((key) => storage.getItem(key) ?? ''))
      .join('\n');
    expect(stored).not.toMatch(/Exame novembro|exam-notices|Cinza\/Azul|Ana Souza/);
  });
});
