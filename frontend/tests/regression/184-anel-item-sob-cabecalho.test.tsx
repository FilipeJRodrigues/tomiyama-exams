/**
 * Erro: ao voltar pela lista de alunos com Shift+Tab, o anel de foco do item (cartão ou linha,
 * card #184) fica em parte sob o cabeçalho fixo de 60 px. O navegador rola até o nome, que é o
 * elemento com foco, e o deixa logo abaixo do desconto da página (`scroll-padding-top`: o
 * cabeçalho + 10 px). O anel é desenhado no item, que começa acima do nome, e a parte de cima
 * some sob o cabeçalho. Medido no Edge 157 sem janela (2026-11-19), nos dois temas:
 * - cartão a 390 e a 640 px (zoom de 200%), com o nome do cartão anterior meio sob o
 *   cabeçalho: 11,9 px escondidos, a linha de cima do anel e os cantos;
 * - linha da tabela a 768 px ("Davi Oliveira": a situação ocupa várias linhas e o nome fica no
 *   meio da linha): 32,9 px da linha e do anel sob o cabeçalho;
 * - a 1280 px: 1,1 px da linha de cima do anel.
 * Esperado: o anel contorna o item inteiro e não fica cortado (critério do card #184; § 6.7,
 * foco visível), também sob o cabeçalho fixo, como no #65 e no #102.
 * Issue: #184
 *
 * O jsdom não faz layout nem rola a página. Por isso o teste confere a causa, como os do #65
 * e do #102. Vale uma das duas saídas:
 * - CSS: a sobra que o navegador deixa acima do nome ao rolar até ele cobre o cabeçalho e a
 *   parte do item acima do nome.
 *   - A sobra é o `scroll-padding-top` da página mais o `scroll-margin-top` do nome.
 *   - A parte de cima do item é o anel por fora, a borda e o espaçamento do item e de quem
 *     fica entre ele e o nome.
 *   - Na linha, a célula do nome precisa ficar no alto: no meio de uma linha alta, a parte de
 *     cima cresce com a altura da linha, e nenhuma sobra fixa a cobre.
 *   - A conta usa só as caixas, sem o entrelinha do texto, então é um mínimo. A medida de
 *     verdade é a do navegador.
 * - Script: ao receber o foco, a tela rola o próprio item (`scrollIntoView` no item).
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { Styles, loadStyles } from '../computedCss';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { resetViewport, setViewportWidth } from '../viewport';

/** Height of the fixed header (`AppLayout`: `header={{ height: 60 }}`). */
const HEADER = 60;

/** jsdom has no font size: Mantine's 1rem is 16 px, with `--mantine-scale` 1. */
const REM = 16;

const LAYOUTS = [
  { layout: 'cartões', width: 390 },
  { layout: 'cartões', width: 640 },
  { layout: 'tabela', width: 768 },
  { layout: 'tabela', width: 1280 },
] as const;

/** Top-level tokens of a CSS value, split on spaces outside parentheses. */
function tokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value.trim()) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out;
}

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem)?$/;

/** A length in px: numbers in `px`/`rem` and `calc()` of them; anything else throws. */
function px(expression: string): number {
  const source = expression.replaceAll('calc(', '(');
  const parts = source.match(/-?(?:\d+\.?\d*|\.\d+)(?:px|rem)?|[()+\-*/]/g) ?? [];
  if (source.replace(/-?(?:\d+\.?\d*|\.\d+)(?:px|rem)?|[()+\-*/]|\s/g, '') !== '') {
    throw new Error(`Comprimento CSS não reconhecido: "${expression}"`);
  }
  let i = 0;
  const primary = (): number => {
    const part = parts[i++];
    if (part === '(') {
      const inner = sum();
      i += 1; // ')'
      return inner;
    }
    if (part === undefined || !NUMBER.test(part)) {
      throw new Error(`Comprimento CSS não reconhecido: "${expression}"`);
    }
    const n = Number.parseFloat(part);
    return part.endsWith('rem') ? n * REM : n;
  };
  const product = (): number => {
    let value = primary();
    while (parts[i] === '*' || parts[i] === '/') {
      const op = parts[i++];
      const right = primary();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (parts[i] === '+' || parts[i] === '-') {
      const op = parts[i++];
      const right = product();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  const result = sum();
  if (i !== parts.length) throw new Error(`Comprimento CSS não reconhecido: "${expression}"`);
  return result;
}

/** The first length among the tokens of the winning declaration (0 when none wins). */
function firstLength(styles: Styles, element: Element, props: readonly string[]): number {
  const winner = styles.declared(element, props);
  if (winner === null) return 0;
  for (const token of tokens(styles.resolve(element, winner.value))) {
    try {
      return px(token);
    } catch {
      // Not a length (`solid`, a color, `none`...): try the next token.
    }
  }
  return 0;
}

/** Margin, border and padding of the element above its content. */
function topBox(styles: Styles, element: Element): number {
  return (
    firstLength(styles, element, ['margin', 'margin-top', 'margin-block', 'margin-block-start']) +
    firstLength(styles, element, [
      'border',
      'border-top',
      'border-width',
      'border-top-width',
      'border-block',
      'border-block-start',
    ]) +
    firstLength(styles, element, ['padding', 'padding-top', 'padding-block', 'padding-block-start'])
  );
}

/** `vertical-align` of a table cell: `th`/`td` inherit the row's, and rows are `middle`. */
function cellAlign(styles: Styles, cell: Element): string {
  for (const element of [cell, cell.parentElement]) {
    if (!element) continue;
    const winner = styles.declared(element, ['vertical-align']);
    if (winner && winner.value.trim() !== 'inherit') return styles.resolve(element, winner.value);
  }
  return 'middle';
}

async function studentItems(layout: 'cartões' | 'tabela'): Promise<HTMLElement[]> {
  if (layout === 'cartões') {
    const list = await screen.findByRole('list', { name: 'Alunos' });
    return within(list).getAllByRole('listitem');
  }
  const table = await screen.findByRole('table', { name: 'Alunos' });
  return within(table).getAllByRole('row').slice(1);
}

describe('#184 anel do item sob o cabeçalho fixo ao voltar com Shift+Tab (§ 6.7)', () => {
  beforeAll(loadStyles);

  beforeEach(() => {
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetViewport();
  });

  describe.each(LAYOUTS)('$layout a $width px', ({ layout, width }) => {
    it('a sobra acima do nome com foco cobre o cabeçalho e a parte do item acima do nome', async () => {
      setViewportWidth(width);
      const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
      await screen.findByRole('heading', { name: 'Alunos', level: 1 });
      const items = await studentItems(layout);
      const item = items[1]!;
      const link = within(item).getByRole('link');
      const root = document.documentElement;
      await waitFor(() => {
        expect(root.style.scrollPaddingTop).not.toBe('');
      });

      // Script route: the screen scrolls the item itself when its name takes the focus.
      const scrolled: Element[] = [];
      vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
        this: HTMLElement,
      ) {
        scrolled.push(this);
      });
      act(() => {
        within(items[2]!).getByRole('link').focus();
      });
      await user.keyboard('{Shift>}{Tab}{/Shift}');
      expect(link).toHaveFocus();
      if (scrolled.includes(item)) return;

      // CSS route: what the browser keeps clear above the name when it scrolls to it.
      const styles = await Styles.now();
      const pagePadding = px(styles.resolve(root, root.style.scrollPaddingTop));
      const nameMargin = firstLength(styles, link, [
        'scroll-margin',
        'scroll-margin-top',
        'scroll-margin-block',
        'scroll-margin-block-start',
      ]);
      const room = pagePadding + nameMargin;

      // The part of the item above the name: the ring outside the item, then the boxes down
      // to the name.
      const ringWidth = firstLength(styles, item, ['outline', 'outline-width']);
      const ringOffset = firstLength(styles, item, ['outline-offset']);
      expect(ringWidth, 'o item com foco tem anel').toBeGreaterThan(0);
      let above = Math.max(0, ringWidth + ringOffset) + topBox(styles, item);
      for (let el = link.parentElement; el && el !== item; el = el.parentElement) {
        above += topBox(styles, el);
      }

      const cell = link.closest('th, td');
      if (cell) {
        const align = cellAlign(styles, cell);
        expect(
          ['top', 'baseline', 'text-top'],
          `a célula do nome fica com vertical-align: ${align}: numa linha alta (a situação em ` +
            'várias linhas, 768 px), a linha começa dezenas de px acima do nome, e o navegador só ' +
            `deixa ${room}px livres acima do nome ao rolar o foco: a parte de cima da linha e o ` +
            `anel ficam sob o cabeçalho de ${HEADER}px`,
        ).toContain(align);
      }

      expect(
        room,
        `acima do nome com foco o navegador deixa ${room}px livres (scroll-padding-top da ` +
          `página ${pagePadding}px + scroll-margin-top do nome ${nameMargin}px), mas o cabeçalho ` +
          `fixo tem ${HEADER}px e o item com o anel começa ${above}px acima do nome: ` +
          `${HEADER + above - room}px do anel ficam sob o cabeçalho`,
      ).toBeGreaterThanOrEqual(HEADER + above);
    });
  });
});
