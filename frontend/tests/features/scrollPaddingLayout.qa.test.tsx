/**
 * Cobertura do #102 (§ 6.7): desde o #102 o desconto do cabeçalho fixo (`scroll-padding-top`
 * na raiz) é definido uma vez, pelo `AppLayout`. Aqui, o que a regressão
 * `102-foco-escondido-sob-cabecalho-demais-telas.test.tsx` deixa de fora: os estados de
 * carregando, erro ("Tentar de novo") e "não encontrado" de Alunos, Dia do exame, Academia e
 * do exame, a página não encontrada, a área só de examinadores vista pelo responsável, o fim
 * de sessão por 401 e a entrada de novo, e o valor ao longo da navegação (nunca fica vazio
 * sob o cabeçalho, e o desconto de baixo, da barra de resumo do exame, nunca vaza).
 *
 * jsdom não faz layout nem rola a página: o teste confere o valor na raiz do documento; a
 * medição do foco é a do navegador real.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath, paths, studentPath } from '../../src/app/navigation';
import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { HEADER_SCROLL_PADDING } from '../../src/features/exam/focus';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { TEST_API_URL, installMockApi, server } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

/** Aluno do examinador nos dados simulados. */
const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';
/** Aluna com exame no evento aberto dos dados de demonstração. */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

/** `api`: a leitura de que a tela depende para sair do "carregando". */
const SCREENS = [
  { name: 'Alunos', route: paths.students, api: '/students' },
  { name: 'Novo aluno', route: paths.studentNew, api: '/belts' },
  { name: 'Editar aluno', route: studentPath(CARLA), api: `/students/${CARLA}` },
  { name: 'Dia do exame', route: paths.examDay, api: '/events' },
  { name: 'Academia', route: paths.academy, api: '/settings' },
  {
    name: 'Exame do aluno',
    route: examPath(MOCK_EVENT_IDS.open, HELENA),
    api: `/events/${MOCK_EVENT_IDS.open}/exams/${HELENA}`,
  },
] as const;

function rootStyle(): CSSStyleDeclaration {
  return document.documentElement.style;
}

/** Every value the root `style` attribute had since `start`, the current one included. */
function watchRootStyle() {
  const seen: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) seen.push(record.oldValue ?? '');
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
    attributeOldValue: true,
  });
  return {
    values(): string[] {
      for (const record of observer.takeRecords()) seen.push(record.oldValue ?? '');
      return [...seen, document.documentElement.getAttribute('style') ?? ''];
    },
    stop() {
      observer.disconnect();
    },
  };
}

describe('#102 desconto do cabeçalho fixo em todos os estados das telas (§ 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    const db = createMockDb({ includeShowcase: true, senseiId: MOCK_USER_IDS.examiner });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    setViewportWidth(1280);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(SCREENS)('$name: vale com erro de carga ("Tentar de novo")', async (screenCase) => {
    server.use(
      http.get(`${TEST_API_URL}${screenCase.api}`, () =>
        HttpResponse.json({ message: 'Sistema ocupado no momento.' }, { status: 503 }),
      ),
    );
    await renderApp({ route: screenCase.route, signedInAs: 'examiner' });

    const retry = await screen.findByRole('button', { name: 'Tentar de novo' }, { timeout: 10000 });
    expect(retry).toBeInTheDocument();
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
  });

  it.each(SCREENS)('$name: vale enquanto a tela carrega', async (screenCase) => {
    server.use(http.get(`${TEST_API_URL}${screenCase.api}`, () => new Promise<never>(() => {})));
    await renderApp({ route: screenCase.route, signedInAs: 'examiner' });

    expect((await screen.findAllByRole('status'))[0]).toHaveTextContent(/^Carregando/);
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
  });

  it('vale em "Aluno não encontrado" (404)', async () => {
    await renderApp({ route: studentPath(UNKNOWN), signedInAs: 'examiner' });

    await screen.findByRole('heading', { name: 'Aluno não encontrado', level: 1 });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
  });

  it('vale no exame de um evento que não existe (404)', async () => {
    await renderApp({ route: examPath(UNKNOWN, HELENA), signedInAs: 'examiner' });

    await screen.findByText('Evento não encontrado', {}, { timeout: 10000 });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
    expect(rootStyle().scrollPaddingBottom).toBe('');
  });

  it('vale na página não encontrada', async () => {
    await renderApp({ route: '/endereco-que-nao-existe', signedInAs: 'examiner' });

    await screen.findByRole('heading', { name: 'Página não encontrada', level: 1 });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
  });

  it.each([paths.examDay, paths.academy, paths.belts])(
    'responsável em %s: vale no aviso "Esta área é dos examinadores"',
    async (route) => {
      await renderApp({ route, signedInAs: 'guardian' });

      await screen.findByRole('heading', { name: 'Esta área é dos examinadores', level: 1 });
      expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
    },
  );

  it.each([390, 1280])('responsável em Alunos, a %i px: vale', async (width) => {
    setViewportWidth(width);
    await renderApp({ route: paths.students, signedInAs: 'guardian' });

    await screen.findByRole('link', { name: 'Novo aluno' });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
    expect(rootStyle().scrollPaddingBottom).toBe('');
  });
});

describe('#102 desconto do cabeçalho fixo no fim e no começo da sessão (§ 6.7)', () => {
  beforeEach(() => {
    installMockApi();
    setViewportWidth(1280);
  });

  it('sem sessão, a tela de entrada e a de cadastro não têm desconto', async () => {
    const { user } = await renderApp({ route: paths.students });

    await screen.findByRole('heading', { name: 'Entrar' });
    expect(rootStyle().scrollPaddingTop).toBe('');
    expect(rootStyle().scrollPaddingBottom).toBe('');

    await user.click(screen.getByRole('link', { name: 'Cadastre-se' }));
    await screen.findByLabelText(/Confirme a senha/);
    expect(rootStyle().scrollPaddingTop).toBe('');
  });

  it('sessão expirada (401 da API): o desconto sai com o cabeçalho', async () => {
    const { router, queryClient } = await renderApp({
      route: paths.students,
      signedInAs: 'examiner',
    });
    await screen.findByRole('link', { name: 'Novo aluno' });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);

    server.use(
      http.get(`${TEST_API_URL}/students`, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );
    await queryClient.refetchQueries();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.login);
    });
    await screen.findByRole('heading', { name: 'Entrar' });
    await waitFor(() => {
      expect(rootStyle().scrollPaddingTop).toBe('');
    });
    expect(rootStyle().scrollPaddingBottom).toBe('');
  });

  it('"Sair" e entrar de novo com outro perfil: o desconto sai e volta', async () => {
    const { user } = await renderApp({ route: paths.academy, signedInAs: 'examiner' });
    await screen.findByRole('heading', { name: 'Academia', level: 1 });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);

    await user.click(screen.getByRole('button', { name: 'Sair' }));
    await screen.findByRole('heading', { name: 'Entrar' });
    await waitFor(() => {
      expect(rootStyle().scrollPaddingTop).toBe('');
    });

    await user.type(await screen.findByLabelText(/E-mail/), 'mae@example.com');
    await user.type(screen.getByLabelText(/^Senha/), 'qualquer');
    await user.click(screen.getByRole('radio', { name: 'Responsável' }));
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    await screen.findByRole('button', { name: 'Sair' });
    await waitFor(() => {
      expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
    });
    expect(rootStyle().scrollPaddingBottom).toBe('');
  });
});

describe('#102 desconto do cabeçalho fixo ao longo da navegação (§ 6.4, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    const db = createMockDb({ includeShowcase: true, senseiId: MOCK_USER_IDS.examiner });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pelo menu, por todas as telas: o valor nunca muda nem fica vazio', async () => {
    setViewportWidth(1280);
    const { user } = await renderApp({ route: paths.students, signedInAs: 'examiner' });
    await screen.findByRole('heading', { name: 'Alunos', level: 1 });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
    const watch = watchRootStyle();
    const menu = within(screen.getByRole('navigation', { name: 'Menu principal' }));

    const titles = [
      'Dia do exame',
      'Faixas',
      'Academia',
      'Requisitos',
      'Alunos',
      'Eventos',
      'Dia do exame',
      'Alunos',
    ];
    for (const title of titles) {
      await user.click(menu.getByRole('link', { name: title }));
      await screen.findByRole('heading', { name: title, level: 1 });
      expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
      expect(rootStyle().scrollPaddingBottom).toBe('');
    }

    // No screen cleared and set it again on the way: the attribute was never without it.
    for (const value of watch.values()) expect(value).toContain('scroll-padding-top');
    watch.stop();
  });

  it('no celular, exame → Dia do exame → exame → Alunos: o de cima fica, o de baixo é só do exame', async () => {
    setViewportWidth(390);
    const { user, router } = await renderApp({
      route: examPath(MOCK_EVENT_IDS.open, HELENA),
      signedInAs: 'examiner',
    });
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    await waitFor(() => {
      expect(rootStyle().scrollPaddingBottom).not.toBe('');
    });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);
    const watch = watchRootStyle();

    const [dayLink] = within(screen.getByRole('navigation', { name: 'Caminho' })).getAllByRole(
      'link',
    );
    if (dayLink === undefined) throw new Error('O caminho deveria ter um link para o dia.');
    await user.click(dayLink);
    await screen.findByRole('heading', { name: 'Dia do exame', level: 1 });
    await waitFor(() => {
      expect(rootStyle().scrollPaddingBottom).toBe('');
    });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);

    // Back to the exam by the history, as the browser's back button does.
    await router.navigate(-1);
    await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    await waitFor(() => {
      expect(rootStyle().scrollPaddingBottom).not.toBe('');
    });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);

    await router.navigate(paths.students);
    await screen.findByRole('heading', { name: 'Alunos', level: 1 });
    await waitFor(() => {
      expect(rootStyle().scrollPaddingBottom).toBe('');
    });
    expect(rootStyle().scrollPaddingTop).toBe(HEADER_SCROLL_PADDING);

    for (const value of watch.values()) expect(value).toContain('scroll-padding-top');
    watch.stop();
  });
});
