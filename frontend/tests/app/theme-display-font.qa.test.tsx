/**
 * Cobertura do qa-frontend na etapa 1b do #166 (skill `tomiyama-design`, `typography.md`;
 * § 6.7), além de `theme-display-font.test.tsx`:
 *
 * - a 390 px, os títulos dos cartões das listas do Dia do exame (nome do aluno), de Eventos
 *   (nome do evento) e de Requisitos (descrição) ficam na fonte do sistema, e só o `h1` da
 *   tela usa a Barlow Condensed;
 * - o título da gaveta "Decidir o exame" (um `Drawer`) fica na fonte do sistema;
 * - a linha que leva o título da tela e um selo ou um botão (o nome do aluno e o resultado no
 *   exame; "Alunos", "Eventos" e "Requisitos" com o botão de novo) quebra (`flex-wrap: wrap`),
 *   e o título não tem `nowrap`, corte nem reticências: no celular e no zoom de 200%, um nome
 *   longo desce o selo para a linha de baixo e quebra entre palavras, em vez de ser espremido
 *   letra a letra ao lado dele. No Edge, a 320, 390 e 640 px, foi o que se viu.
 */
import { Drawer, MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { examPath, paths } from '../../src/app/navigation';
import { cssVariablesResolver, theme } from '../../src/app/theme';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { Styles, loadStyles } from '../computedCss';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

/** Present at the open event, exam in progress. */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

const noop = () => undefined;

/** A property that inherits: the value on the element or on its nearest ancestor. */
function inherited(styles: Styles, target: Element, prop: string): string | null {
  for (let current: Element | null = target; current; current = current.parentElement) {
    const winner = styles.declared(current, [prop]);
    if (winner) return styles.resolve(current, winner.value);
  }
  return null;
}

function usesDisplayFont(styles: Styles, heading: Element): boolean {
  return (inherited(styles, heading, 'font-family') ?? '').includes('Barlow Condensed');
}

/** Text of the headings in the main area that use the display font, in page order. */
function displayHeadings(styles: Styles): string[] {
  return within(screen.getByRole('main'))
    .getAllByRole('heading')
    .filter((heading) => usesDisplayFont(styles, heading))
    .map((heading) => heading.textContent.trim());
}

/** The row of the title wraps, and the title itself is never kept on one cut line. */
function expectWrappingTitleRow(styles: Styles, title: HTMLElement): void {
  const row = title.parentElement;
  if (!row) throw new Error('O título deveria estar numa linha.');
  const wrap = styles.declared(row, ['flex-wrap', 'flex-flow']);
  expect(wrap && styles.resolve(row, wrap.value)).toMatch(/\bwrap\b/);
  expect(inherited(styles, title, 'white-space') ?? 'normal').not.toMatch(/nowrap|pre/);
  expect(styles.declared(title, ['text-overflow'])?.value ?? 'clip').not.toBe('ellipsis');
  expect(styles.declared(title, ['overflow-wrap'])?.value).toBe('anywhere');
  expect(title).not.toHaveAttribute('data-line-clamp');
}

beforeAll(loadStyles);

describe('fonte de títulos fora dos cartões e das gavetas (#166, qa)', () => {
  beforeEach(() => {
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  it.each([
    [paths.examDay, 'Dia do exame', 'Alunos do evento'],
    [paths.events, 'Eventos', 'Eventos'],
    [paths.requirements, 'Requisitos', null],
  ] as const)(
    '%s a 390 px: os títulos dos cartões ficam na fonte do sistema',
    async (route, h1, listName) => {
      setViewportWidth(390);
      await renderApp({ route, signedInAs: 'examiner' });
      await screen.findByRole('heading', { level: 1, name: h1 });
      const lists = listName
        ? [await screen.findByRole('list', { name: listName })]
        : await within(screen.getByRole('main')).findAllByRole('list');
      const styles = await Styles.now();
      const cardTitles = lists.flatMap((list) => within(list).queryAllByRole('heading'));
      expect(cardTitles.length).toBeGreaterThan(0);
      for (const cardTitle of cardTitles) {
        expect(usesDisplayFont(styles, cardTitle)).toBe(false);
      }
      expect(displayHeadings(styles)).toEqual([h1]);
    },
  );

  it('título da gaveta ("Decidir o exame") fica na fonte do sistema', async () => {
    render(
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
        <Drawer opened onClose={noop} title="Decidir o exame" position="bottom">
          Conteúdo
        </Drawer>
      </MantineProvider>,
    );
    await screen.findByRole('dialog', { name: 'Decidir o exame' });
    const title = screen.getByRole('heading', { name: 'Decidir o exame' });
    const styles = await Styles.now();
    expect(usesDisplayFont(styles, title)).toBe(false);
  });
});

describe('título de página numa linha com selo ou botão (#166, § 6.7, qa)', () => {
  beforeEach(() => {
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  it.each([390, 640])('exame do aluno a %i px: nome e resultado quebram linha', async (width) => {
    setViewportWidth(width);
    await renderApp({ route: examPath(MOCK_EVENT_IDS.open, HELENA), signedInAs: 'examiner' });
    const title = await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
    const row = title.parentElement;
    expect(row?.querySelector('.mantine-Badge-root')).not.toBeNull();
    const styles = await Styles.now();
    expectWrappingTitleRow(styles, title);
  });

  it.each([
    [paths.students, 'Alunos', 'Novo aluno'],
    [paths.events, 'Eventos', 'Novo evento'],
    [paths.requirements, 'Requisitos', 'Novo requisito'],
  ] as const)('%s a 390 px: título e "%s" quebram linha', async (route, h1, action) => {
    setViewportWidth(390);
    await renderApp({ route, signedInAs: 'examiner' });
    const title = await screen.findByRole('heading', { level: 1, name: h1 });
    const row = title.parentElement;
    if (!row) throw new Error('O título deveria estar numa linha.');
    await within(row).findByText(action);
    const styles = await Styles.now();
    expectWrappingTitleRow(styles, title);
  });
});
