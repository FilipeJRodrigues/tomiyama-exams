/**
 * Erro: quando a leitura dos dados de uma tela falha, o aviso de erro (`LoadError` de
 * `screenStates.tsx`, e o `ErrorState` da lista de alunos, que é uma cópia dele) mostra o botão
 * "Tentar de novo". Ao acioná-lo pelo teclado, o botão fica desabilitado enquanto recarrega (o
 * navegador tira o foco dele e o põe no `body`) e some quando os dados chegam: o foco fica no
 * `body` e quem usa teclado ou leitor de tela volta para o topo da página. Se a recarga falha
 * de novo, o botão volta, mas o foco continua no `body`.
 * Esperado (§ 6.7, regra única `focusIfLost`): se a recarga traz os dados, o foco vai para o
 * título da tela (no exame, o título do exame ou a área de decisão do resumo); se falha de
 * novo, o foco vai para o "Tentar de novo" que volta. Um foco que o usuário pôs em outro lugar
 * enquanto a tela recarregava fica onde está.
 * Issue: #52 (achado no QA do #26, etapa 2)
 *
 * Telas: Dia do exame (eventos e alunos do evento), Exame do aluno (o exame e "quem é o
 * sensei" da decisão), lista, criação e edição de aluno, Faixas, Requisitos (faixas e
 * requisitos), Eventos e Academia (dados e examinadores do admin master).
 *
 * jsdom não aplica a regra de "focus fixup" do HTML: no navegador, o botão com foco que fica
 * desabilitado (o `loading` do Mantine) perde o foco para o `body`. `emulateFocusFixup` faz o
 * mesmo aqui. As leituras são respondidas pelo teste (`answer`), sem espera de tempo real.
 *
 * Os testes "foco em outro lugar não é roubado" são a guarda da correção: passam no código
 * atual, que nunca move o foco, e precisam continuar passando depois dela.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const OPEN = MOCK_EVENT_IDS.open;
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const RETRY = 'Tentar de novo';

const EXAM_DAY = new Date(2026, 10, 2, 12);
const EXAM_DATE = new Date(2026, 10, 21, 9);

interface Case {
  screen: string;
  route: string;
  signedInAs: 'examiner' | 'guardian' | 'master';
  /** The GET that fails when the screen opens. */
  url: string;
  /** Title of the load error. */
  error: string;
  /** The page title (`h1`) once the data is on screen. */
  title: string;
  /** The exam summary: the decision area may take the focus instead of the title. */
  summaryCounts?: boolean;
  now?: Date;
  prepare?: (db: MockDb) => void;
}

const CASES: Case[] = [
  {
    screen: 'Dia do exame, eventos',
    route: '/dia-do-exame',
    signedInAs: 'examiner',
    url: `${TEST_API_URL}/events`,
    error: 'Não foi possível carregar os eventos',
    title: 'Dia do exame',
    now: EXAM_DAY,
  },
  {
    screen: 'Dia do exame, alunos do evento',
    route: '/dia-do-exame',
    signedInAs: 'examiner',
    url: `${TEST_API_URL}/students`,
    error: 'Não foi possível carregar os alunos',
    title: 'Dia do exame',
    now: EXAM_DAY,
  },
  {
    screen: 'Exame do aluno',
    route: examPath(OPEN, HELENA),
    signedInAs: 'examiner',
    url: `${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`,
    error: 'Não foi possível carregar o exame',
    title: 'Helena Prado',
    now: EXAM_DATE,
  },
  {
    screen: 'Exame do aluno, decisão (quem é o sensei)',
    route: examPath(OPEN, HELENA),
    signedInAs: 'examiner',
    url: `${TEST_API_URL}/settings`,
    error: 'Não foi possível saber quem é o sensei',
    title: 'Helena Prado',
    summaryCounts: true,
    now: EXAM_DATE,
    prepare: (db) => {
      db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    },
  },
  {
    screen: 'Lista de alunos',
    route: '/alunos',
    signedInAs: 'guardian',
    url: `${TEST_API_URL}/students`,
    error: 'Não foi possível carregar os alunos',
    title: 'Alunos',
  },
  {
    screen: 'Novo aluno',
    route: '/alunos/novo',
    signedInAs: 'guardian',
    url: `${TEST_API_URL}/belts`,
    error: 'Não foi possível carregar as faixas',
    title: 'Novo aluno',
  },
  {
    screen: 'Editar aluno, o aluno',
    route: `/alunos/${ANA}`,
    signedInAs: 'guardian',
    url: `${TEST_API_URL}/students/${ANA}`,
    error: 'Não foi possível carregar o aluno',
    title: 'Editar aluno',
  },
  {
    screen: 'Editar aluno, as faixas',
    route: `/alunos/${ANA}`,
    signedInAs: 'guardian',
    url: `${TEST_API_URL}/belts`,
    error: 'Não foi possível carregar as faixas',
    title: 'Editar aluno',
  },
  {
    screen: 'Faixas',
    route: '/faixas',
    signedInAs: 'examiner',
    url: `${TEST_API_URL}/belts`,
    error: 'Não foi possível carregar as faixas',
    title: 'Faixas',
  },
  {
    screen: 'Requisitos, as faixas',
    route: '/requisitos',
    signedInAs: 'examiner',
    url: `${TEST_API_URL}/belts`,
    error: 'Não foi possível carregar as faixas',
    title: 'Requisitos',
  },
  {
    screen: 'Requisitos, os requisitos',
    route: '/requisitos',
    signedInAs: 'examiner',
    url: `${TEST_API_URL}/requirements`,
    error: 'Não foi possível carregar os requisitos',
    title: 'Requisitos',
  },
  {
    screen: 'Eventos',
    route: '/eventos',
    signedInAs: 'examiner',
    url: `${TEST_API_URL}/events`,
    error: 'Não foi possível carregar os eventos',
    title: 'Eventos',
  },
  {
    screen: 'Academia, os dados',
    route: '/academia',
    signedInAs: 'examiner',
    url: `${TEST_API_URL}/settings`,
    error: 'Não foi possível carregar os dados da academia',
    title: 'Academia',
  },
  {
    screen: 'Academia, os examinadores (admin master)',
    route: '/academia',
    signedInAs: 'master',
    url: `${TEST_API_URL}/examiners`,
    error: 'Não foi possível carregar os examinadores',
    title: 'Academia',
  },
];

type Outcome = 'ok' | 'error';

/**
 * The first GET of `url` fails (503); each one after waits until `answer` says whether it
 * brings the data (the simulated API answers) or fails again.
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
      }
      return HttpResponse.json({ message: BUSY }, { status: 503 });
    }),
  );
  return {
    answer: async (outcome: Outcome) => {
      await waitFor(() => {
        expect(waiting.length).toBeGreaterThan(0);
      });
      waiting.shift()!(outcome);
    },
  };
}

/**
 * The HTML focus fixup rule, which jsdom lacks: the focused button that becomes disabled loses
 * the focus to the body. jsdom ignores `blur()` on a disabled button, so a throwaway element
 * takes the focus and is removed.
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

/** Where the focus is, in a short form for the failure message (`body` when lost). */
function focusedElement(): string {
  const active = document.activeElement;
  if (active === null || active === document.body) return 'body';
  const name = active.getAttribute('aria-label') ?? active.textContent.trim();
  return `${active.tagName.toLowerCase()} "${name}"`;
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

function loadError(error: string): HTMLElement {
  return screen.getByText(error).closest<HTMLElement>('[role="alert"]')!;
}

function retryButton(error: string): HTMLButtonElement {
  return within(loadError(error)).getByRole<HTMLButtonElement>('button', { name: RETRY });
}

function summary(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

async function openWithLoadError(item: Case) {
  const db = createMockDb({ includeShowcase: true });
  item.prepare?.(db);
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  const reads = failingReads(item.url);
  const rendered = await renderApp({ route: item.route, signedInAs: item.signedInAs });
  expect(await screen.findByText(item.error)).toBeInTheDocument();
  expect(loadError(item.error)).toHaveTextContent(BUSY);
  return { ...rendered, reads };
}

/** "Tentar de novo" pressed with the keyboard (focus on it, Enter). */
async function retryWithKeyboard(item: Case, user: Awaited<ReturnType<typeof renderApp>>['user']) {
  retryButton(item.error).focus();
  await user.keyboard('{Enter}');
}

async function dataOnScreen(item: Case) {
  await waitFor(() => {
    expect(screen.queryByText(item.error)).not.toBeInTheDocument();
  });
  expect(await screen.findByRole('heading', { level: 1, name: item.title })).toBeInTheDocument();
}

describe('foco depois de "Tentar de novo" da carga da tela (§ 6.7)', () => {
  let stopFixup: () => void = () => undefined;

  beforeEach(() => {
    stopFixup = emulateFocusFixup();
  });

  afterEach(() => {
    stopFixup();
    vi.useRealTimers();
  });

  describe.each(CASES)('$screen', (item) => {
    beforeEach(() => {
      if (item.now) vi.useFakeTimers({ toFake: ['Date'], now: item.now });
    });

    it('a recarga traz os dados: o foco vai para o título da tela, não fica no body', async () => {
      const { user, reads } = await openWithLoadError(item);

      await retryWithKeyboard(item, user);
      await reads.answer('ok');
      await dataOnScreen(item);

      await waitFor(
        () => {
          const active = document.activeElement;
          const title = screen.getByRole('heading', { level: 1, name: item.title });
          const inSummary = item.summaryCounts === true && summary().contains(active);
          expect(
            active === title || inSummary,
            `foco em ${focusedElement()}, esperado no h1 "${item.title}"${
              item.summaryCounts ? ' ou na área de decisão do resumo' : ''
            }`,
          ).toBe(true);
        },
        { timeout: 1500 },
      );
    });

    it('a recarga falha de novo: o foco vai para o novo "Tentar de novo"', async () => {
      const { user, reads } = await openWithLoadError(item);

      await retryWithKeyboard(item, user);
      await reads.answer('error');
      await waitFor(() => {
        expect(retryButton(item.error)).toBeEnabled();
      });

      await waitFor(
        () => {
          expect(focusedElement()).toBe(`button "${RETRY}"`);
          expect(retryButton(item.error)).toHaveFocus();
        },
        { timeout: 1500 },
      );
    });

    it('guarda: o foco posto em outro lugar durante a recarga não é roubado', async () => {
      const { user, reads } = await openWithLoadError(item);
      const signOut = screen.getByRole('button', { name: 'Sair' });

      // Fails again while the user went to "Sair".
      await retryWithKeyboard(item, user);
      signOut.focus();
      await reads.answer('error');
      await waitFor(() => {
        expect(retryButton(item.error)).toBeEnabled();
      });
      await flushQueued();
      expect(focusedElement()).toBe('button "Sair"');

      // Pressed again without moving the focus; this time the data comes.
      fireEvent.click(retryButton(item.error));
      await reads.answer('ok');
      await dataOnScreen(item);
      await flushQueued();
      expect(focusedElement()).toBe('button "Sair"');
    });
  });
});
