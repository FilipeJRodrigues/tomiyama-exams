/**
 * Erro: a 390 px e no zoom de 200% (640 px), o filtro "Filtrar alunos" do Dia do exame é um
 * `SegmentedControl` vertical. Com a pílula da etapa 1b (`radius="xl"`), o trilho tem cantos
 * de 32 px e `overflow: hidden`, mas cada item tem só uns 28 px de altura, e o raio dele cai
 * para uns 14 px. Os arcos deixam de ser concêntricos: o anel de foco do primeiro item
 * ("Todos") é cortado nos cantos de cima pelo arco do trilho, e o do último ("Presentes"),
 * nos de baixo (no navegador, o anel some numa faixa de uns 4 px em cada canto). Com o raio
 * `md` de antes, o anel do mesmo item ficava inteiro.
 * Esperado: o anel de foco de qualquer item fica inteiro dentro do trilho e acompanha a
 * pílula (§ 6.7, foco visível; critério da etapa 1b: "anel de foco visível e acompanhando a
 * pílula", inclusive nos segmentados; skill `tomiyama-design`, `components.md`).
 * Issue: #166
 *
 * Geometria lida da cascata (`tests/computedCss.ts`): raio, padding e `overflow` do trilho;
 * raio, padding, fonte e altura mínima do item; largura e afastamento do anel. O jsdom não faz
 * layout, então a altura do item vem do CSS (padding + fonte × altura de linha, ou a altura
 * mínima, se houver), como o navegador calcula para uma linha de texto. Vale qualquer
 * correção: outro raio no segmentado vertical, item mais alto, anel por dentro do item ou um
 * trilho que não recorte (`overflow` visível).
 */
import { screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { Styles, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

/** Anti-aliasing: a quarter of a pixel outside the arc does not show. */
const TOLERANCE = 0.25;

/** Split at spaces outside parentheses: `calc(1rem * 1) calc(2rem * 1)` → two tokens. */
function tokens(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value.trim()) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && /\s/.test(char)) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** `calc(calc(2rem * 1) - 4px)`, `0.875rem`, `3px`, `0` → px (only + - * / of rem and px). */
function px(value: string): number {
  const parts = value.replace(/calc\(/g, '(').match(/[\d.]+(?:rem|px)?|[-+*/()]|\S/g);
  if (!parts) throw new Error(`Valor não reconhecido: "${value}"`);
  let at = 0;
  const fail = (): never => {
    throw new Error(`Valor não reconhecido: "${value}"`);
  };
  const number = (): number => {
    const part = parts[at] ?? fail();
    at += 1;
    if (part === '(') {
      const inner = sum();
      if (parts[at] !== ')') fail();
      at += 1;
      return inner;
    }
    if (part === '-') return -number();
    const match = /^([\d.]+)(rem|px)?$/.exec(part) ?? fail();
    return Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
  };
  const product = (): number => {
    let result = number();
    while (parts[at] === '*' || parts[at] === '/') {
      const operator = parts[at];
      at += 1;
      result = operator === '*' ? result * number() : result / number();
    }
    return result;
  };
  const sum = (): number => {
    let result = product();
    while (parts[at] === '+' || parts[at] === '-') {
      const operator = parts[at];
      at += 1;
      result = operator === '+' ? result + product() : result - product();
    }
    return result;
  };
  const result = sum();
  if (at !== parts.length) fail();
  return result;
}

function declaredPx(styles: Styles, element: Element, props: string[], fallback?: number): number {
  const winner = styles.declared(element, props);
  if (winner === null) {
    if (fallback === undefined) throw new Error(`Sem ${props.join('/')} nas folhas de estilo.`);
    return fallback;
  }
  const first = tokens(styles.resolve(element, winner.value))[0] ?? '0';
  return px(first);
}

/** A property that inherits (`line-height`): on the element or on its nearest ancestor. */
function inherited(styles: Styles, element: Element, prop: string): string {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const winner = styles.declared(current, [prop]);
    if (winner) return styles.resolve(current, winner.value);
  }
  throw new Error(`Nenhum ${prop} nas folhas de estilo.`);
}

interface Geometry {
  /** Radius of the track's clip at the corner (after the browser scales it down). */
  trackRadius: number;
  /** Distance from the track's corner to the center of the item's corner arc. */
  center: number;
  /** Radius of the outer edge of the focus ring around that arc. */
  ringRadius: number;
}

/** The point of the ring's outer edge that lies farthest outside the track's corner, if any. */
function worstOutside({ trackRadius: r, center: c, ringRadius: rho }: Geometry): number {
  const outside = (x: number, y: number): number => {
    if (x < 0 || y < 0) return Math.max(-x, -y);
    if (x >= r || y >= r) return 0;
    return Math.max(0, Math.hypot(x - r, y - r) - r);
  };
  let worst = 0;
  // The arc of the ring at the corner…
  for (let degrees = 0; degrees <= 90; degrees += 0.5) {
    const angle = (degrees * Math.PI) / 180;
    worst = Math.max(worst, outside(c - rho * Math.cos(angle), c - rho * Math.sin(angle)));
  }
  // …and its straight edges, until they leave the corner of the track.
  for (let along = c; along <= Math.max(c, r) + 1; along += 0.25) {
    worst = Math.max(worst, outside(along, c - rho), outside(c - rho, along));
  }
  return worst;
}

beforeAll(loadStyles);

describe('anel de foco do filtro vertical do Dia do exame (#166, § 6.7)', () => {
  beforeEach(() => {
    installMockApi();
  });

  it.each([390, 640])(
    'a %i px, o anel do item focado fica inteiro dentro do trilho',
    async (width) => {
      setViewportWidth(width);
      await renderApp({ route: paths.examDay, signedInAs: 'examiner' });
      const filters = await screen.findByRole('radiogroup', { name: 'Filtrar alunos' });
      const track = filters.closest('.mantine-SegmentedControl-root') ?? filters;
      expect(track).toHaveAttribute('data-orientation', 'vertical');

      const radios = within(filters).getAllByRole('radio');
      const first = radios[0];
      if (!first) throw new Error('O filtro deveria ter itens.');
      const item = first.nextElementSibling;
      if (!(item instanceof HTMLElement))
        throw new Error('O item do filtro deveria estar na tela.');
      first.focus();
      expect(first).toHaveFocus();
      const styles = await Styles.now();

      // A track that does not clip cannot cut the ring.
      const overflow = styles.declared(track, ['overflow', 'overflow-y', 'overflow-x']);
      const clips = overflow !== null && /hidden|clip/.test(styles.resolve(track, overflow.value));
      if (!clips) return;

      // The ring is drawn (its color is checked by the focus-ring tests).
      styles.focusRingColor(item);
      const ringWidth = declaredPx(styles, item, ['outline', 'outline-width']);
      const ringOffset = declaredPx(styles, item, ['outline-offset'], 0);

      const fontSize = declaredPx(styles, item, ['font-size']);
      const lineHeightText = inherited(styles, item, 'line-height');
      const lineHeight = /^[\d.]+$/.test(lineHeightText)
        ? Number(lineHeightText) * fontSize
        : px(lineHeightText);
      const paddingBlock = declaredPx(styles, item, ['padding', 'padding-top', 'padding-block']);
      const minHeight = declaredPx(styles, item, ['min-height', 'height'], 0);
      const itemHeight = Math.max(minHeight, 2 * paddingBlock + lineHeight);

      const trackPadding = declaredPx(styles, track, ['padding', 'padding-top', 'padding-block']);
      const trackHeight = radios.length * itemHeight + 2 * trackPadding;
      // Full width on the phone: the track and the items are much wider than tall.
      const trackRadius = Math.min(declaredPx(styles, track, ['border-radius']), trackHeight / 2);
      const itemRadius = Math.min(declaredPx(styles, item, ['border-radius']), itemHeight / 2);

      const geometry: Geometry = {
        trackRadius,
        center: trackPadding + itemRadius,
        ringRadius: itemRadius + ringOffset + ringWidth,
      };
      const outside = worstOutside(geometry);
      const text = (n: number) => n.toFixed(1).replace('.', ',');
      if (outside > TOLERANCE) {
        throw new Error(
          `O anel de foco de "${first.getAttribute('value') ?? ''}" sai ${text(outside)} px do ` +
            `trilho no canto: trilho com raio de ${text(trackRadius)} px e padding de ` +
            `${text(trackPadding)} px; item de ${text(itemHeight)} px de altura com raio de ` +
            `${text(itemRadius)} px; anel de ${text(ringWidth)} px a ${text(ringOffset)} px do ` +
            `item. O trilho recorta (overflow), então o anel é cortado no canto (§ 6.7).`,
        );
      }
      expect(outside).toBeLessThanOrEqual(TOLERANCE);
    },
  );
});
