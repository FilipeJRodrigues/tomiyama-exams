/**
 * Barlow Condensed nos títulos de página (#166, etapa 1b; skill `tomiyama-design`,
 * `typography.md`), medida na cascata que o navegador recebe (`tests/computedCss.ts`).
 *
 * - `--app-font-display` vem do tema, com a reserva `'Arial Narrow', sans-serif`.
 * - Só os títulos de página (`PageTitle`) usam a fonte, com peso 600 (o único arquivo
 *   carregado), sem caixa alta, sem `letter-spacing` e quebrando linha em vez de cortar: o
 *   `h1` de cada tela e os `h2` de seção ("Dados da academia", "Logos", "Histórico de exames",
 *   "Resumo").
 * - Ficam na fonte do sistema: títulos de cartão de lista (nome do aluno, do evento, da faixa,
 *   descrição do requisito), subtítulos `h3`–`h6`, títulos de diálogo e o título do cabeçalho
 *   (este muda na etapa 2, com o logo).
 * - A fonte vem do próprio site: `main.tsx` importa só `latin-600` do
 *   `@fontsource/barlow-condensed`, e nada vem do Google Fonts (LGPD).
 */
import { MantineProvider, Modal } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import indexHtml from '../../index.html?raw';
import packageJson from '../../package.json?raw';
import { examPath, paths, studentPath } from '../../src/app/navigation';
import { PageTitle } from '../../src/app/PageTitle';
import {
  DISPLAY_FONT_FAMILY,
  DISPLAY_FONT_WEIGHT,
  cssVariablesResolver,
  theme,
} from '../../src/app/theme';
import main from '../../src/main.tsx?raw';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { Styles, loadStyles } from '../computedCss';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

const STACK = "'Barlow Condensed', 'Arial Narrow', sans-serif";

/** Examiner's student with exams in the history. */
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
/** Present at the open event, exam in progress. */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

const noop = () => undefined;

function renderInTheme(children: ReactNode) {
  return render(
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
      {children}
    </MantineProvider>,
  );
}

/** A property that inherits: the value on the element or on its nearest ancestor. */
function inherited(styles: Styles, target: Element, prop: string): string | null {
  for (let current: Element | null = target; current; current = current.parentElement) {
    const winner = styles.declared(current, [prop]);
    if (winner) return styles.resolve(current, winner.value);
  }
  return null;
}

function fontFamily(styles: Styles, target: Element): string {
  const family = inherited(styles, target, 'font-family');
  if (family === null) throw new Error('Nenhuma font-family nas folhas de estilo.');
  return family;
}

function usesDisplayFont(styles: Styles, heading: Element): boolean {
  return fontFamily(styles, heading).includes('Barlow Condensed');
}

/** A page title: the display font at 600, sentence case, no letter spacing, never cut. */
function expectPageTitle(styles: Styles, heading: HTMLElement): void {
  expect(fontFamily(styles, heading)).toBe(STACK);
  expect(inherited(styles, heading, 'font-weight')).toBe(String(DISPLAY_FONT_WEIGHT));
  expect(inherited(styles, heading, 'text-transform') ?? 'none').toBe('none');
  expect(inherited(styles, heading, 'letter-spacing') ?? 'normal').toBe('normal');
  expect(styles.declared(heading, ['overflow-wrap'])?.value).toBe('anywhere');
  expect(heading).not.toHaveAttribute('data-line-clamp');
}

/** Text of the headings in the main area that use the display font, in page order. */
async function displayHeadings(): Promise<string[]> {
  const styles = await Styles.now();
  return within(screen.getByRole('main'))
    .getAllByRole('heading')
    .filter((heading) => usesDisplayFont(styles, heading))
    .map((heading) => heading.textContent.trim());
}

beforeAll(loadStyles);

describe('fonte de títulos no tema (#166)', () => {
  it('--app-font-display com a Barlow Condensed e a reserva', async () => {
    expect(DISPLAY_FONT_FAMILY).toBe(STACK);
    expect(DISPLAY_FONT_WEIGHT).toBe(600);
    renderInTheme(<PageTitle order={1}>Alunos</PageTitle>);
    const styles = await Styles.now();
    expect(styles.resolve(document.documentElement, 'var(--app-font-display)')).toBe(STACK);
  });

  it.each([1, 2] as const)(
    'PageTitle de ordem %i na fonte de títulos, com peso 600',
    async (order) => {
      renderInTheme(<PageTitle order={order}>Dados da academia</PageTitle>);
      const heading = screen.getByRole('heading', { level: order, name: 'Dados da academia' });
      const styles = await Styles.now();
      expectPageTitle(styles, heading);
    },
  );

  it('título de diálogo (h2 do Modal) fica na fonte do sistema', async () => {
    renderInTheme(
      <Modal opened onClose={noop} title="Editar faixa Branca">
        Conteúdo
      </Modal>,
    );
    await screen.findByRole('dialog', { name: 'Editar faixa Branca' });
    const title = screen.getByRole('heading', { name: 'Editar faixa Branca' });
    const styles = await Styles.now();
    expect(usesDisplayFont(styles, title)).toBe(false);
  });
});

describe('títulos de página nas telas (#166)', () => {
  beforeEach(() => {
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  it('Alunos: o h1 na fonte de títulos e o título do cabeçalho na do sistema', async () => {
    await renderApp({ route: paths.students, signedInAs: 'examiner' });
    const title = await screen.findByRole('heading', { level: 1, name: 'Alunos' });
    await screen.findByRole('table');
    const styles = await Styles.now();
    expectPageTitle(styles, title);

    const banner = screen.getByRole('banner');
    const header = within(banner).getByRole('heading', { name: 'Tomiyama Exams' });
    expect(usesDisplayFont(styles, header)).toBe(false);
    expect(await displayHeadings()).toEqual(['Alunos']);
  });

  it('Alunos a 390 px: o nome do aluno no cartão da lista fica na fonte do sistema', async () => {
    setViewportWidth(390);
    await renderApp({ route: paths.students, signedInAs: 'examiner' });
    const list = await screen.findByRole('list', { name: 'Alunos' });
    const styles = await Styles.now();
    const cardTitles = within(list).getAllByRole('heading', { level: 2 });
    expect(cardTitles.length).toBeGreaterThan(0);
    for (const cardTitle of cardTitles) {
      expect(usesDisplayFont(styles, cardTitle)).toBe(false);
    }
    expect(await displayHeadings()).toEqual(['Alunos']);
  });

  it('Academia: o h1 e os h2 de seção na fonte de títulos; os h3 dos logos, não', async () => {
    await renderApp({ route: paths.academy, signedInAs: 'examiner' });
    await screen.findByRole('heading', { level: 3, name: 'Logo principal' });
    const styles = await Styles.now();
    expectPageTitle(styles, screen.getByRole('heading', { level: 1, name: 'Academia' }));
    expectPageTitle(styles, screen.getByRole('heading', { level: 2, name: 'Dados da academia' }));
    expectPageTitle(styles, screen.getByRole('heading', { level: 2, name: 'Logos' }));
    expect(await displayHeadings()).toEqual(['Academia', 'Dados da academia', 'Logos']);
  });

  it('Editar aluno a 390 px: h1 e "Histórico de exames"; os cartões do histórico, não', async () => {
    setViewportWidth(390);
    await renderApp({ route: studentPath(ELIDA), signedInAs: 'examiner' });
    const history = await screen.findByRole('list', { name: 'Histórico de exames' });
    const styles = await Styles.now();
    expectPageTitle(styles, screen.getByRole('heading', { level: 1, name: 'Editar aluno' }));
    expectPageTitle(styles, screen.getByRole('heading', { level: 2, name: 'Histórico de exames' }));
    const cardTitles = within(history).getAllByRole('heading', { level: 3 });
    expect(cardTitles.length).toBeGreaterThan(0);
    for (const cardTitle of cardTitles) {
      expect(usesDisplayFont(styles, cardTitle)).toBe(false);
    }
    expect(await displayHeadings()).toEqual(['Editar aluno', 'Histórico de exames']);
  });

  it('Exame do aluno: o nome (h1) e "Resumo"; as categorias (h3), não', async () => {
    await renderApp({ route: examPath(MOCK_EVENT_IDS.open, HELENA), signedInAs: 'examiner' });
    const title = await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    const summary = screen.getByRole('complementary', { name: 'Resumo do exame' });
    const styles = await Styles.now();
    expectPageTitle(styles, title);
    expectPageTitle(styles, within(summary).getByRole('heading', { level: 2, name: 'Resumo' }));
    const subtitles = within(screen.getByRole('main')).getAllByRole('heading', { level: 3 });
    expect(subtitles.length).toBeGreaterThan(0);
    for (const subtitle of subtitles) {
      expect(usesDisplayFont(styles, subtitle)).toBe(false);
    }
    expect(await displayHeadings()).toEqual(['Helena Prado', 'Resumo']);
  });

  it.each([
    [paths.examDay, 'Dia do exame'],
    [paths.belts, 'Faixas'],
    [paths.requirements, 'Requisitos'],
    [paths.events, 'Eventos'],
    [paths.studentNew, 'Novo aluno'],
  ])('%s: o h1 "%s" na fonte de títulos', async (route, name) => {
    await renderApp({ route, signedInAs: 'examiner' });
    const title = await screen.findByRole('heading', { level: 1, name });
    const styles = await Styles.now();
    expectPageTitle(styles, title);
  });

  it('Faixas a 390 px: o nome da faixa no cartão fica na fonte do sistema', async () => {
    setViewportWidth(390);
    await renderApp({ route: paths.belts, signedInAs: 'examiner' });
    const list = await screen.findByRole('list', { name: 'Faixas' });
    const styles = await Styles.now();
    const cardTitles = within(list).getAllByRole('heading', { level: 2 });
    expect(cardTitles.length).toBeGreaterThan(0);
    for (const cardTitle of cardTitles) {
      expect(usesDisplayFont(styles, cardTitle)).toBe(false);
    }
    expect(await displayHeadings()).toEqual(['Faixas']);
  });

  it('responsável numa tela de examinador: o aviso (h1) também é título de página', async () => {
    await renderApp({ route: paths.belts, signedInAs: 'guardian' });
    const title = await screen.findByRole('heading', {
      level: 1,
      name: 'Esta área é dos examinadores',
    });
    const styles = await Styles.now();
    expectPageTitle(styles, title);
  });
});

describe('a fonte vem do próprio site (#166, LGPD)', () => {
  const SOURCES = import.meta.glob<string>('../../src/**/*.{ts,tsx,css}', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('main.tsx importa só o latin-600 da Barlow Condensed', () => {
    const fonts = [...main.matchAll(/import\s+'(@fontsource[^']*)'/g)].map((match) => match[1]);
    expect(fonts).toEqual(['@fontsource/barlow-condensed/latin-600.css']);
  });

  it('nenhum outro arquivo do src importa fonte', () => {
    const found = Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith('/main.tsx'))
      .filter(([, source]) => /@fontsource|fonts\.(googleapis|gstatic)\.com/.test(source))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });

  it('nada do Google Fonts no index.html', () => {
    expect(indexHtml).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('a dependência está no package.json', () => {
    const manifest = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).toContain('@fontsource/barlow-condensed');
  });

  it('nenhum h1 fora do PageTitle, a não ser o das telas de entrada (etapa 3)', () => {
    const found = Object.entries(SOURCES)
      .filter(([, source]) => /<Title\b[^>]*\border=\{1\}/.test(source))
      .map(([path]) => path);
    expect(found).toEqual(['../../src/features/auth/AuthCard.tsx']);
  });
});
