/**
 * Erro: nas telas de Alunos (lista, "Novo aluno" e "Editar aluno"), Dia do exame e Academia,
 * ao andar pelo teclado com Tab ou Shift+Tab, o controle que recebe o foco fica sob o
 * cabeçalho fixo de 60 px. Essas telas não definem `scroll-padding-top` na página, então o
 * navegador rola o alvo do foco até a borda de cima da janela, que o cabeçalho cobre. É o
 * mesmo erro do #65, que corrigiu só Faixas, Requisitos e Eventos; na tela de exame, que
 * define o valor, não acontece.
 * Esperado: foco sempre visível (§ 6.7): enquanto uma dessas telas está aberta, a página tem
 * `scroll-padding-top` que desconta o cabeçalho fixo; ao trocar de tela pelo menu ou voltar
 * do exame o desconto continua, e ao sair para a tela de entrada (sem cabeçalho fixo) volta
 * a ''.
 * Issue: #102
 *
 * jsdom não faz layout nem rola a página, então o teste confere a causa (o valor na raiz do
 * documento), como o teste do #65; a medição do foco é a do navegador real.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { examPath, paths, studentPath } from '../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { TEST_API_URL, installMockApi, server } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

/** Aluno do examinador nos dados simulados. */
const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';
/** Aluna com exame no evento aberto dos dados de demonstração. */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

/** `ready`: o que mostra que a tela terminou de carregar. */
const SCREENS = [
  {
    name: 'Alunos',
    route: paths.students,
    title: 'Alunos',
    ready: () => screen.findByRole('link', { name: 'Novo aluno' }),
  },
  {
    name: 'Novo aluno',
    route: paths.studentNew,
    title: 'Novo aluno',
    ready: () => screen.findByRole('button', { name: 'Cadastrar aluno' }),
  },
  {
    name: 'Editar aluno',
    route: studentPath(CARLA),
    title: 'Editar aluno',
    ready: () => screen.findByRole('button', { name: 'Salvar alterações' }),
  },
  {
    name: 'Dia do exame',
    route: paths.examDay,
    title: 'Dia do exame',
    ready: () => screen.findByRole('heading', { name: 'Dia do exame', level: 1 }),
  },
  {
    name: 'Academia',
    route: paths.academy,
    title: 'Academia',
    ready: () => screen.findByRole('button', { name: 'Salvar' }),
  },
] as const;

/** 1280: desktop. 390: celular, e o que o desktop mostra com zoom de 200% ou mais. */
const WIDTHS = [1280, 390] as const;

function rootStyle(): CSSStyleDeclaration {
  return document.documentElement.style;
}

function scrollPaddingTop(): string {
  return rootStyle().scrollPaddingTop;
}

async function open(screenCase: (typeof SCREENS)[number], width: number) {
  setViewportWidth(width);
  const rendered = await renderApp({ route: screenCase.route, signedInAs: 'examiner' });
  await screen.findByRole('heading', { name: screenCase.title, level: 1 });
  await screenCase.ready();
  return rendered;
}

/** The value is set when the screen mounts; a short wait is enough. */
async function expectHeaderDiscount(where: string) {
  await waitFor(
    () => {
      expect(
        scrollPaddingTop(),
        `${where}: scroll-padding-top da página é '${scrollPaddingTop()}'; ` +
          'sem ele o controle focado com Tab/Shift+Tab fica sob o cabeçalho fixo',
      ).not.toBe('');
    },
    { timeout: 1000 },
  );
}

describe('#102 foco escondido sob o cabeçalho fixo em Alunos, Dia do exame e Academia (§ 6.7)', () => {
  beforeEach(() => {
    installMockApi();
  });

  describe.each(SCREENS)('$name ($route)', (screenCase) => {
    it.each(WIDTHS)(
      'a página desconta o cabeçalho fixo ao rolar até o foco, a %i px',
      async (width) => {
        await open(screenCase, width);

        await expectHeaderDiscount(`${screenCase.name} a ${width} px`);
      },
    );

    // Guarda: passa hoje e tem de continuar passando depois da correção.
    it('ao sair para a tela de entrada, o scroll-padding-top da página volta a vazio', async () => {
      const { user } = await open(screenCase, 1280);

      await user.click(screen.getByRole('button', { name: 'Sair' }));
      await screen.findByRole('heading', { name: 'Entrar' });

      await waitFor(() => {
        expect(scrollPaddingTop()).toBe('');
      });
      expect(rootStyle().scrollPaddingBottom).toBe('');
    });
  });

  // The cleanup of the screen left behind must not take away the value of the next one.
  it('o desconto continua ao trocar de tela pelo menu, vindo de uma tela que já o define', async () => {
    setViewportWidth(1280);
    const { user } = await renderApp({ route: paths.belts, signedInAs: 'examiner' });
    await screen.findByRole('heading', { name: 'Faixas', level: 1 });
    await expectHeaderDiscount('Faixas');
    const menu = within(screen.getByRole('navigation', { name: 'Menu principal' }));

    for (const title of ['Alunos', 'Dia do exame', 'Academia', 'Faixas']) {
      await user.click(menu.getByRole('link', { name: title }));
      await screen.findByRole('heading', { name: title, level: 1 });
      await expectHeaderDiscount(`${title}, vindo pelo menu`);
    }
  });

  // Guarda: passa hoje e tem de continuar passando depois da correção.
  it('ao ir de uma tela corrigida aqui para outra que já define o desconto, o valor é o da tela nova', async () => {
    setViewportWidth(1280);
    const { user } = await renderApp({ route: paths.academy, signedInAs: 'examiner' });
    await screen.findByRole('heading', { name: 'Academia', level: 1 });
    const menu = within(screen.getByRole('navigation', { name: 'Menu principal' }));

    await user.click(menu.getByRole('link', { name: 'Requisitos' }));
    await screen.findByRole('heading', { name: 'Requisitos', level: 1 });

    await waitFor(() => {
      expect(scrollPaddingTop()).not.toBe('');
    });
    expect(rootStyle().scrollPaddingBottom).toBe('');
  });
});

describe('#102 ao voltar do exame para Dia do exame (§ 6.4, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    const db = createMockDb({ includeShowcase: true, senseiId: MOCK_USER_IDS.examiner });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    setViewportWidth(390);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function openExam() {
    const route = examPath(MOCK_EVENT_IDS.open, HELENA);
    const rendered = await renderApp({ route, signedInAs: 'examiner' });
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    // On the phone the exam screen sets both edges: the header and the summary bar.
    await waitFor(() => {
      expect(rootStyle().scrollPaddingBottom).not.toBe('');
    });
    expect(scrollPaddingTop()).not.toBe('');
    return rendered;
  }

  async function leaveExamByTrail() {
    const { user, router } = await openExam();
    const trail = within(screen.getByRole('navigation', { name: 'Caminho' }));
    const [dayLink] = trail.getAllByRole('link');
    if (dayLink === undefined) throw new Error('O caminho deveria ter um link para o dia.');
    await user.click(dayLink);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.examDay);
    });
    await screen.findByRole('heading', { name: 'Dia do exame', level: 1 });
  }

  it('o desconto do cabeçalho continua em Dia do exame', async () => {
    await leaveExamByTrail();

    await expectHeaderDiscount('Dia do exame, vindo do exame');
  });

  // Guarda: passa hoje e tem de continuar passando depois da correção.
  it('o desconto de baixo, da barra de resumo do exame, não vaza para Dia do exame', async () => {
    await leaveExamByTrail();

    await waitFor(() => {
      expect(rootStyle().scrollPaddingBottom).toBe('');
    });
  });

  // Guarda: passa hoje e tem de continuar passando depois da correção. O exame limpa o que
  // definiu na página: fora do cabeçalho fixo não sobra desconto nenhum.
  it('ao sair do exame para a tela de entrada, os dois descontos voltam a vazio', async () => {
    const { user } = await openExam();

    await user.click(screen.getByRole('button', { name: 'Sair' }));
    await screen.findByRole('heading', { name: 'Entrar' });

    await waitFor(() => {
      expect(scrollPaddingTop()).toBe('');
    });
    expect(rootStyle().scrollPaddingBottom).toBe('');
  });
});
