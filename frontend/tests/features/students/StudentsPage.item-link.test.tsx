/**
 * O item inteiro do aluno abre o aluno (§ 6.2, § 6.7; card #184): o cartão abaixo do `sm` e a
 * linha da tabela a partir dele. Técnica do link esticado (`StudentsPage.module.css`): o nome
 * continua o único link do item (uma parada de Tab por aluno, o leitor de tela lê só o nome,
 * Ctrl+clique e botão do meio abrem outra aba), e um `::after` dele cobre o item, que é o
 * bloco de contenção (`position: relative`). Nada de `onClick` nem `role="link"` no item.
 *
 * O jsdom não faz teste de acerto nem desenha pseudo-elementos: aqui, clicar num ponto do
 * cartão fora do nome não chega ao link. Estes testes conferem a estrutura e as regras de CSS
 * na tela montada (`tests/computedCss.ts`). O clique de verdade foi medido no Edge sem janela
 * (2026-11-19, Edge 157, nos dois temas): o `elementFromPoint` e o clique na idade, na
 * situação e no canto do item levam a `/alunos/{id}` a 390, 640 (zoom de 200%), 768 (também
 * com a tabela rolada até o fim) e 1280 px; o toque emulado no celular também. Ctrl+clique e
 * botão do meio abrem o aluno em outra aba, e a lista fica onde estava. Nenhuma largura ganhou
 * rolagem horizontal na página.
 */
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core';

import { BRAND_COLORS, COLOR_SCHEME_KEY, theme } from '../../../src/app/theme';
import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { Styles, expectContrast, hex, loadStyles, type Rgb } from '../../computedCss';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { resetViewport, setViewportWidth } from '../../viewport';

type Scheme = 'light' | 'dark';

const MIN_TEXT = 4.5;
const MIN_INDICATOR = 3;

/** The ring of the theme (`--app-focus-ring`): the blue of the logo / the yellow of the logo. */
const RING: Record<Scheme, string> = {
  light: BRAND_COLORS.blue.toLowerCase(),
  dark: BRAND_COLORS.yellow.toLowerCase(),
};

const colors = mergeMantineTheme(DEFAULT_THEME, theme).colors;

/** Hover of the table rows (Mantine's `--table-hover-color`: gray.1 / dark.5). */
const ROW_HOVER: Record<Scheme, string> = {
  light: colors.gray[1].toLowerCase(),
  dark: colors.dark[5].toLowerCase(),
};

const LAYOUTS = [
  { layout: 'cartões', width: 390 },
  { layout: 'cartões', width: 640 },
  { layout: 'tabela', width: 768 },
  { layout: 'tabela', width: 1280 },
] as const;

let db: MockDb;

function studentNames(): string[] {
  return db.students.map((item) => item.student.full_name);
}

function idOf(name: string): string {
  const found = db.students.find((item) => item.student.full_name === name);
  if (!found) throw new Error(`Aluno ${name} fora da base simulada.`);
  return found.student.id;
}

/** The student items on the screen: the cards (`li`) or the body rows (`tr`). */
async function studentItems(layout: 'cartões' | 'tabela'): Promise<HTMLElement[]> {
  if (layout === 'cartões') {
    const list = await screen.findByRole('list', { name: 'Alunos' });
    return within(list).getAllByRole('listitem');
  }
  const table = await screen.findByRole('table', { name: 'Alunos' });
  return within(table).getAllByRole('row').slice(1);
}

function onlyLink(item: HTMLElement): HTMLAnchorElement {
  const links = within(item).getAllByRole('link');
  expect(links).toHaveLength(1);
  return links[0] as HTMLAnchorElement;
}

/** The value of a declaration that wins on the element (or its pseudo-element), resolved. */
function value(styles: Styles, element: Element, prop: string, pseudo?: '::after'): string | null {
  const winner = styles.declared(element, [prop], pseudo ? { pseudo } : {});
  return winner === null ? null : styles.resolve(element, winner.value);
}

function isPositioned(styles: Styles, element: Element): boolean {
  const position = value(styles, element, 'position');
  return position !== null && position !== 'static';
}

/** Elements that write text of their own (not only through their children). */
function textElements(item: HTMLElement): HTMLElement[] {
  return Array.from(item.querySelectorAll<HTMLElement>('*')).filter((element) =>
    Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
    ),
  );
}

async function open(width: number, scheme: Scheme = 'dark') {
  window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  setViewportWidth(width);
  const app = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
  await screen.findByRole('heading', { name: 'Alunos', level: 1 });
  expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
  return app;
}

describe('item inteiro do aluno abre o aluno (#184, § 6.2)', () => {
  beforeAll(loadStyles);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetViewport();
  });

  describe.each(LAYOUTS)('$layout a $width px', ({ layout, width }) => {
    it('um link por aluno, com o nome do aluno como nome acessível', async () => {
      await open(width);
      const items = await studentItems(layout);
      expect(items).toHaveLength(studentNames().length);

      const names = items.map((item) => {
        const link = onlyLink(item);
        const name = link.textContent.trim();
        expect(link).toHaveAccessibleName(name);
        expect(link).toHaveAttribute('href', `/alunos/${idOf(name)}`);
        return name;
      });
      expect([...names].sort()).toEqual([...studentNames()].sort());
    });

    it('o item não tem clique próprio: sem role, tabindex nem onclick, e só o nome navega', async () => {
      const { user, router } = await open(width);
      const items = await studentItems(layout);
      for (const item of items) {
        expect(item).not.toHaveAttribute('role');
        expect(item).not.toHaveAttribute('tabindex');
        expect(item).not.toHaveAttribute('onclick');
      }

      // No pseudo-element in jsdom: a click on the age reaches the item only, and nothing
      // there navigates. In the browser the stretched link is what takes it.
      const bruno = items.find((item) => onlyLink(item).textContent.trim() === 'Bruno Souza')!;
      await user.click(within(bruno).getByText('7 anos'));
      expect(router.state.location.pathname).toBe('/alunos');

      await user.click(within(bruno).getByRole('link', { name: 'Bruno Souza' }));
      expect(router.state.location.pathname).toBe(`/alunos/${idOf('Bruno Souza')}`);
    });

    it('a área de clique do nome cobre o item inteiro (link esticado)', async () => {
      await open(width);
      const items = await studentItems(layout);
      const styles = await Styles.now();
      for (const item of items) {
        const link = onlyLink(item);
        // The pseudo-element of the name: an empty box over the whole item, with the hand.
        expect(value(styles, link, 'content', '::after')).toMatch(/^(''|"")$/);
        expect(value(styles, link, 'position', '::after')).toBe('absolute');
        expect(value(styles, link, 'inset', '::after')).toBe('0');
        expect(value(styles, link, 'cursor', '::after')).toBe('pointer');
        // The item is its containing block: positioned, with nothing positioned in between
        // (the link included), which would shrink the area to that box.
        expect(value(styles, item, 'position')).toBe('relative');
        for (let el: Element | null = link; el && el !== item; el = el.parentElement) {
          expect(isPositioned(styles, el), `<${el.tagName.toLowerCase()}> posicionado`).toBe(false);
        }
        // Nothing else in the item is positioned, so nothing is painted over the area.
        for (const el of item.querySelectorAll('*')) {
          if (el === link) continue;
          expect(isPositioned(styles, el), `<${el.tagName.toLowerCase()}> posicionado`).toBe(false);
        }
      }
    });
  });

  describe.each<Scheme>(['light', 'dark'])('tema %s', (scheme) => {
    it('anel de foco em volta do cartão inteiro, fora da borda dele (§ 6.7)', async () => {
      await open(390, scheme);
      const [card] = await studentItems('cartões');
      const link = onlyLink(card!);

      // Not focused: no ring on the card (Mantine's Paper sets `outline: 0`).
      let styles = await Styles.now();
      expect(() => styles.focusRingColor(card!)).toThrow();

      act(() => {
        link.focus();
      });
      expect(link).toHaveFocus();
      styles = await Styles.now();
      const ring = styles.focusRingColor(card!);
      expect(hex(ring)).toBe(RING[scheme]);
      expect(value(styles, card!, 'outline')).toMatch(/^2px solid /);
      // Outside the card: the card clips what is inside it, not its own outline.
      expect(value(styles, card!, 'outline-offset')).not.toMatch(/^-/);
      expectContrast(
        'anel do cartão sobre a página',
        ring,
        styles.background(card!.parentElement!),
        MIN_INDICATOR,
      );
      expectContrast(
        'anel do cartão junto do cartão',
        ring,
        styles.background(card!),
        MIN_INDICATOR,
      );
      // The name keeps its own ring as well.
      expect(hex(styles.focusRingColor(link))).toBe(RING[scheme]);
    });

    it.each([768, 1280])(
      'anel de foco em volta da linha inteira, por dentro dela, a %i px (§ 6.7)',
      async (width) => {
        await open(width, scheme);
        const [row] = await studentItems('tabela');
        const link = onlyLink(row!);

        let styles = await Styles.now();
        expect(() => styles.focusRingColor(row!)).toThrow();

        act(() => {
          link.focus();
        });
        expect(link).toHaveFocus();
        styles = await Styles.now();
        const ring = styles.focusRingColor(row!);
        expect(hex(ring)).toBe(RING[scheme]);
        expect(value(styles, row!, 'outline')).toMatch(/^2px solid /);
        // Inside the row: the scroll container of the table would cut a ring outside it.
        expect(value(styles, row!, 'outline-offset')).toBe('-2px');
        expectContrast('anel da linha sobre a linha', ring, styles.background(row!), MIN_INDICATOR);

        const hovered = await Styles.now({ hover: row! });
        expectContrast(
          'anel da linha sobre a linha em hover',
          hovered.focusRingColor(row!),
          hovered.background(row!),
          MIN_INDICATOR,
        );
      },
    );

    it('hover do cartão: o fundo da linha em hover, com o texto a 4,5:1', async () => {
      await open(390, scheme);
      const cards = await studentItems('cartões');
      const rest = await Styles.now();
      const restBackground = hex(rest.background(cards[0]!));

      for (const card of cards) {
        const styles = await Styles.now({ hover: card });
        const background: Rgb = styles.background(card);
        expect(hex(background)).toBe(ROW_HOVER[scheme]);
        expect(hex(background)).not.toBe(restBackground);
        const name = onlyLink(card).textContent.trim();
        for (const element of textElements(card)) {
          expectContrast(
            `"${element.textContent.trim()}" de ${name} no cartão em hover`,
            styles.textColor(element),
            styles.background(element),
            MIN_TEXT,
          );
        }
        // Icons and the outline of the belt sample: indicators, 3:1.
        for (const icon of card.querySelectorAll('[data-status] svg')) {
          expectContrast(
            `ícone da situação de ${name}`,
            styles.textColor(icon),
            background,
            MIN_INDICATOR,
          );
        }
        for (const swatch of card.querySelectorAll('[data-testid="belt-swatch"]')) {
          expectContrast(
            `contorno da faixa de ${name}`,
            styles.borderColor(swatch),
            background,
            MIN_INDICATOR,
          );
        }
      }
    });

    it('hover da linha: continua o da tabela, com o texto a 4,5:1', async () => {
      await open(1280, scheme);
      const rows = await studentItems('tabela');
      for (const row of rows) {
        expect(row).toHaveAttribute('data-hover');
        const styles = await Styles.now({ hover: row });
        expect(hex(styles.background(row))).toBe(ROW_HOVER[scheme]);
        const name = onlyLink(row).textContent.trim();
        for (const element of textElements(row)) {
          expectContrast(
            `"${element.textContent.trim()}" de ${name} na linha em hover`,
            styles.textColor(element),
            styles.background(element),
            MIN_TEXT,
          );
        }
      }
    });
  });
});
