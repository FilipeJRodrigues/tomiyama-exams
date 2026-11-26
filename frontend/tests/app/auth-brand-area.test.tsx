/**
 * Telas de entrada com a marca (#166, etapa 3; skill `tomiyama-design`, `components.md`,
 * "Áreas de marca (azul)" e "Telas de entrada", e `logo.md`; § 6.7), medidas na tela montada
 * (`tests/computedCss.ts`), nos dois temas, no login, no cadastro e na recuperação de senha:
 *
 * - o azul da marca (`--app-brand-bg`, #0A265F nos dois temas) na tela inteira: o `main`, que
 *   continua sendo o landmark, com altura mínima da janela (nunca altura fixa, para o centro
 *   vertical não cortar o topo numa janela baixa) e o fundo da página por trás também azul;
 * - acima do cartão, centralizados: o logo de 320 px com o texto alternativo "Academia
 *   Tomiyama", 1:1 e `object-fit: contain`, exibido com 160 px (96 px abaixo do `sm` e numa
 *   janela baixa, até 45em); "Tomiyama" na fonte de títulos, em branco; "Área de exames" no
 *   texto secundário claro (#C5CEE6). Nenhum dos dois é título: o único `h1` é o do cartão, e
 *   o "Tomiyama Exams" de antes saiu;
 * - o título do cartão é um `PageTitle` (`typography.md`): a fonte de títulos
 *   (`--app-font-display`, peso 600) no tamanho de um `h2`, sem caixa alta, quebrando linha;
 * - o cartão: na superfície do tema, raio `lg`, com borda (no escuro, a borda de controle,
 *   porque o cartão carvão some no azul); o botão principal na cor principal; o erro dentro
 *   do cartão;
 * - sobre o azul, só branco, amarelo ou o secundário claro, com 4,5:1; anel de foco amarelo
 *   (3:1) em qualquer coisa focável fora do cartão (hoje não há nenhuma); dentro do cartão, o
 *   anel do tema.
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';
import { act, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import {
  BRAND_COLORS,
  COLOR_SCHEME_KEY,
  DISPLAY_FONT_FAMILY,
  DISPLAY_FONT_WEIGHT,
  contrastRatio,
  cssVariablesResolver,
  theme,
} from '../../src/app/theme';
import { Styles, expectContrast, hex, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';
import { setViewportHeight, setViewportWidth } from '../viewport';

type Scheme = 'light' | 'dark';

const MIN_TEXT = 4.5;
const MIN_INDICATOR = 3;

const appTheme: MantineTheme = mergeMantineTheme(DEFAULT_THEME, theme);

const BLUE = BRAND_COLORS.blue.toLowerCase();
const YELLOW = BRAND_COLORS.yellow.toLowerCase();
const WHITE = '#ffffff';
const SECONDARY = '#c5cee6';
const SURFACE: Record<Scheme, string> = { light: WHITE, dark: '#2a2a2a' };
/** The page color of the theme (`--mantine-color-body`): dark.7 and white. */
const PAGE: Record<Scheme, string> = { light: WHITE, dark: appTheme.colors.dark[7].toLowerCase() };
/** The real primary color: filled button and focus ring inside the card. */
const PRIMARY: Record<Scheme, string> = { light: BLUE, dark: YELLOW };
/** Border of the card: Mantine's gray.3 on the white card; the control border on charcoal. */
const CARD_BORDER: Record<Scheme, string> = {
  light: appTheme.colors.gray[3].toLowerCase(),
  dark: '#8f8f8f',
};

const SCREENS = [
  { name: 'login', route: paths.login, title: 'Entrar' },
  { name: 'cadastro', route: paths.signUp, title: 'Cadastre-se' },
  { name: 'recuperação de senha', route: paths.forgotPassword, title: 'Recuperar senha' },
] as const;

type EntryScreen = (typeof SCREENS)[number];

/** A property that inherits: the value on the element or on its nearest ancestor. */
function inherited(styles: Styles, target: Element, prop: string): string | null {
  for (let current: Element | null = target; current; current = current.parentElement) {
    const winner = styles.declared(current, [prop]);
    if (winner) return styles.resolve(current, winner.value);
  }
  return null;
}

/** A length in CSS px (`calc(10rem * 1)`, `160px`). */
function lengthPx(styles: Styles, target: Element, prop: string): number {
  const winner = styles.declared(target, [prop]);
  if (!winner) throw new Error(`Sem ${prop} nas folhas de estilo.`);
  const value = styles.resolve(target, winner.value);
  const rem = /([\d.]+)rem/.exec(value);
  if (rem) return Number(rem[1]) * 16;
  const px = /([\d.]+)px/.exec(value);
  if (px) return Number(px[1]);
  throw new Error(`Medida não reconhecida: ${prop}: ${value}`);
}

function element(found: Element | null | undefined, what: string): HTMLElement {
  if (!(found instanceof HTMLElement)) throw new Error(`${what} deveria estar na tela.`);
  return found;
}

interface Parts {
  main: HTMLElement;
  card: HTMLElement;
  title: HTMLElement;
  logo: HTMLElement;
  name: HTMLElement;
  area: HTMLElement;
}

async function open(entry: EntryScreen): Promise<Parts> {
  await renderApp({ route: entry.route });
  const title = await screen.findByRole('heading', { level: 1, name: entry.title });
  const main = screen.getByRole('main');
  return {
    main,
    title,
    card: element(title.closest('.mantine-Paper-root'), 'O cartão'),
    logo: within(main).getByRole('img', { name: 'Academia Tomiyama' }),
    name: within(main).getByText('Tomiyama'),
    area: within(main).getByText('Área de exames'),
  };
}

/** Elements with their own text, outside the card. */
function textsOnTheBlue(main: HTMLElement, card: HTMLElement): HTMLElement[] {
  return [...main.querySelectorAll<HTMLElement>('*')].filter(
    (el) =>
      !card.contains(el) &&
      [...el.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
      ),
  );
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

beforeAll(loadStyles);

describe.each<Scheme>(['dark', 'light'])(
  'telas de entrada no tema %s (#166, etapa 3)',
  (scheme) => {
    beforeEach(() => {
      installMockApi();
      window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
    });

    describe.each(SCREENS)('$name', (entry) => {
      it('fundo azul da marca no main, pela variável, com altura mínima da janela', async () => {
        const { main, card, logo } = await open(entry);
        expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
        expect(screen.getAllByRole('main')).toEqual([main]);
        expect(main.contains(card) && main.contains(logo)).toBe(true);

        const styles = await Styles.now();
        expect(styles.declared(main, ['background-color', 'background'])?.value).toBe(
          'var(--app-brand-bg)',
        );
        expect(hex(styles.background(main))).toBe(BLUE);
        // Everything on the screen is painted by the main, not by the body behind it.
        expect(styles.backgroundOwner(logo)).toBe(main);
        expect(styles.backgroundOwner(card.parentElement ?? card)).toBe(main);
        // A minimum, never a fixed height: the page grows and scrolls with the content.
        expect(styles.declared(main, ['min-height'])?.value).toBe('100dvh');
        expect(
          styles.declared(main, ['height', 'max-height', 'overflow', 'overflow-y']),
        ).toBeNull();
        // The page canvas behind (the overscroll of iOS and macOS) is blue too.
        expect(hex(styles.background(document.documentElement))).toBe(BLUE);
      });

      it('logo de 320 px com o texto alternativo, 1:1, sem distorcer, com 160 px', async () => {
        const { logo } = await open(entry);
        expect(logo.tagName).toBe('IMG');
        expect(logo.getAttribute('src')).toMatch(/tomiyama-logo-320\.webp$/);
        expect(logo).toHaveAttribute('width', '160');
        expect(logo).toHaveAttribute('height', '160');
        const styles = await Styles.now();
        expect(lengthPx(styles, logo, 'width')).toBe(160);
        expect(lengthPx(styles, logo, 'height')).toBe(160);
        const fit = styles.declared(logo, ['object-fit']);
        expect(fit && styles.resolve(logo, fit.value)).toBe('contain');
      });

      it('"Tomiyama" e "Área de exames" acima do cartão, fora de qualquer título', async () => {
        const { main, card, title, logo, name, area } = await open(entry);
        for (const brand of [logo, name, area]) {
          expect(card.contains(brand)).toBe(false);
          expect(brand.closest('h1, h2, h3, h4, h5, h6, [role="heading"]')).toBeNull();
          expect(
            Boolean(brand.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
          ).toBe(true);
        }
        // The only h1 (and the first heading) is the title of the card.
        expect(screen.getAllByRole('heading', { level: 1 })).toEqual([title]);
        expect(within(main).getAllByRole('heading')[0]).toBe(title);
        expect(card.contains(title)).toBe(true);
        expect(screen.queryByText(/Tomiyama Exams/)).toBeNull();
        expect(document.body.textContent).not.toContain('Tomiyama Exams');
      });

      it('título do cartão, o único h1, na fonte de títulos, como o das outras telas', async () => {
        const { main, card, title } = await open(entry);
        expect(screen.getAllByRole('heading', { level: 1 })).toEqual([title]);
        expect(card.contains(title)).toBe(true);

        const styles = await Styles.now();
        // The PageTitle: the theme's variable and its single weight, at the size of an h2.
        expect(styles.declared(title, ['font-family'])?.value).toBe('var(--app-font-display)');
        expect(inherited(styles, title, 'font-family')).toBe(DISPLAY_FONT_FAMILY);
        expect(inherited(styles, title, 'font-weight')).toBe(String(DISPLAY_FONT_WEIGHT));
        expect(styles.declared(title, ['--title-fz'])?.value).toBe('var(--mantine-h2-font-size)');
        // Sentence case, no letter spacing, and it wraps instead of being cut (§ 6.7).
        expect(inherited(styles, title, 'text-transform') ?? 'none').toBe('none');
        expect(inherited(styles, title, 'letter-spacing') ?? 'normal').toBe('normal');
        expect(styles.declared(title, ['overflow-wrap'])?.value).toBe('anywhere');
        expect(title).not.toHaveAttribute('data-line-clamp');
        // No other heading on the screen takes the display font.
        const display = within(main)
          .getAllByRole('heading')
          .filter((heading) => inherited(styles, heading, 'font-family') === DISPLAY_FONT_FAMILY);
        expect(display).toEqual([title]);
      });

      it('marca centralizada sobre o cartão', async () => {
        const { name } = await open(entry);
        const brand = element(name.parentElement, 'O bloco da marca');
        const styles = await Styles.now();
        expect(inherited(styles, name, 'text-align')).toBe('center');
        expect(styles.declared(brand, ['align-items'])?.value).toBe('center');
        const column = element(brand.parentElement, 'A coluna');
        const margin = styles.declared(column, ['margin']);
        expect(margin && styles.resolve(column, margin.value)).toBe('auto');
      });

      it('"Tomiyama" na fonte de títulos, em branco; "Área de exames" no secundário claro', async () => {
        const { name, area } = await open(entry);
        const styles = await Styles.now();
        expect(inherited(styles, name, 'font-family')).toBe(DISPLAY_FONT_FAMILY);
        expect(inherited(styles, name, 'font-weight')).toBe(String(DISPLAY_FONT_WEIGHT));
        expect(inherited(styles, name, 'text-transform') ?? 'none').toBe('none');
        expect(inherited(styles, name, 'letter-spacing') ?? 'normal').toBe('normal');
        expect(hex(styles.textColor(name))).toBe(WHITE);

        expect(inherited(styles, area, 'font-family')).not.toBe(DISPLAY_FONT_FAMILY);
        expect(styles.declared(area, ['color'])?.value).toBe('var(--app-brand-text-secondary)');
        expect(hex(styles.textColor(area))).toBe(SECONDARY);
      });

      it('sobre o azul, só branco, amarelo ou o secundário claro, com 4,5:1', async () => {
        const { main, card } = await open(entry);
        const styles = await Styles.now();
        const texts = textsOnTheBlue(main, card);
        expect(texts.map((el) => el.textContent.trim())).toEqual(['Tomiyama', 'Área de exames']);
        for (const text of texts) {
          const color = styles.textColor(text);
          expect([WHITE, YELLOW, SECONDARY]).toContain(hex(color));
          expectContrast(
            `"${text.textContent.trim()}" sobre o azul`,
            color,
            styles.background(text),
            MIN_TEXT,
          );
        }
      });

      it('cartão na superfície, raio lg, com borda visível sobre o azul', async () => {
        const { main, card } = await open(entry);
        const styles = await Styles.now();
        expect(hex(styles.background(card))).toBe(SURFACE[scheme]);
        expect(card).toHaveAttribute('data-with-border');
        const radius = styles.declared(card, ['--paper-radius']);
        expect(radius?.value).toBe('var(--mantine-radius-lg)');
        const border = styles.borderColor(card);
        expect(hex(border)).toBe(CARD_BORDER[scheme]);
        expectContrast('borda do cartão sobre o azul', border, styles.background(main), 3);
      });

      it('nada focável fora do cartão', async () => {
        const { main, card } = await open(entry);
        const outside = [...main.querySelectorAll(FOCUSABLE)].filter((el) => !card.contains(el));
        expect(outside).toEqual([]);
      });
    });

    it('no escuro, a borda do cartão é a borda de controle; no claro, a do Paper', async () => {
      const { card } = await open(SCREENS[0]);
      const styles = await Styles.now();
      expect(styles.declared(card, ['--paper-border-color'])?.value).toBe(
        'var(--app-brand-card-border)',
      );
      expect(styles.resolve(card, 'var(--app-brand-card-border)')).toBe(
        scheme === 'dark'
          ? styles.resolve(card, 'var(--app-control-border)')
          : appTheme.colors.gray[3],
      );
    });

    it('body e html pintados pela variável da marca; a cor da página do tema continua (#190)', async () => {
      await open(SCREENS[0]);
      const styles = await Styles.now();
      // The color of the document that Safari shows past the page: the variable, no loose hex.
      for (const page of [document.body, document.documentElement]) {
        expect(styles.declared(page, ['background-color', 'background'])?.value).toBe(
          'var(--app-brand-bg)',
        );
      }
      expect(hex(styles.background(document.body))).toBe(BLUE);
      // Only the background changes: the page color of the theme (dark.7 / white) stays.
      const page = styles.resolve(document.body, 'var(--mantine-color-body)').toLowerCase();
      expect(page.replace(/^#(\w)(\w)(\w)$/, '#$1$1$2$2$3$3')).toBe(PAGE[scheme]);
    });

    it('botão principal na cor principal, com o anel de foco do tema dentro do cartão', async () => {
      const { card } = await open(SCREENS[0]);
      const button = within(card).getByRole('button', { name: 'Entrar' });
      const link = within(card).getByRole('link', { name: 'Esqueci minha senha' });
      let styles = await Styles.now();
      expect(hex(styles.background(button))).toBe(PRIMARY[scheme]);

      for (const control of [button, link]) {
        act(() => {
          control.focus();
        });
        expect(control).toHaveFocus();
        styles = await Styles.now();
        const ring = styles.focusRingColor(control);
        expect(hex(ring)).toBe(PRIMARY[scheme]);
        expectContrast(
          `anel de foco de "${control.textContent}" no cartão`,
          ring,
          styles.background(control.parentElement ?? control),
          MIN_INDICATOR,
        );
      }
    });

    it('um controle focável sobre o azul, fora do cartão, tem anel amarelo', async () => {
      const { main, name } = await open(SCREENS[0]);
      const brand = element(name.parentElement, 'O bloco da marca');
      // Nothing takes the focus there today; these stand for a future link on the blue.
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = 'Site da academia';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mantine-focus-auto';
      button.textContent = 'Ajuda';
      brand.append(link, button);

      for (const control of [link, button]) {
        act(() => {
          control.focus();
        });
        expect(control).toHaveFocus();
        const styles = await Styles.now();
        const ring = styles.focusRingColor(control);
        expect(hex(ring)).toBe(YELLOW);
        expectContrast(
          `anel de foco de "${control.textContent}" sobre o azul`,
          ring,
          styles.background(main),
          MIN_INDICATOR,
        );
      }
    });

    it('o erro aparece dentro do cartão, não sobre o azul', async () => {
      const { user } = await renderApp({ route: paths.login });
      const title = await screen.findByRole('heading', { level: 1, name: 'Entrar' });
      const card = element(title.closest('.mantine-Paper-root'), 'O cartão');
      await user.click(within(card).getByRole('button', { name: 'Entrar' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Informe o e-mail e a senha.');
      expect(card.contains(alert)).toBe(true);
    });
  },
);

describe('logo menor abaixo do sm e em janela baixa (#166, logo.md)', () => {
  beforeEach(installMockApi);

  async function logoAndName() {
    const { logo, name } = await open(SCREENS[0]);
    const styles = await Styles.now();
    const fontSize = styles.declared(name, ['--text-fz']);
    return {
      size: lengthPx(styles, logo, 'width'),
      height: lengthPx(styles, logo, 'height'),
      nameSize: fontSize && styles.resolve(name, fontSize.value),
      styles,
    };
  }

  it.each([
    [1280, 800, 160],
    [1536, 730, 160],
    [768, 1024, 160],
    [390, 844, 96],
    [320, 568, 96],
    [640, 400, 96], // 1280×800 at 200% zoom
    [1366, 650, 96], // notebook with the browser bars
    [1366, 720, 96],
    [844, 390, 96], // phone on its side
  ])('a %i×%i px: logo de %i px, 1:1', async (width, height, expected) => {
    setViewportWidth(width);
    setViewportHeight(height);
    const { size, height: logoHeight, nameSize, styles } = await logoAndName();
    expect(size).toBe(expected);
    expect(logoHeight).toBe(expected);
    // The name follows: the size of an h1 next to the large logo, of an h2 next to the small.
    const heading = expected === 160 ? 'h1' : 'h2';
    expect(nameSize).toBe(
      styles.resolve(document.documentElement, `var(--mantine-${heading}-font-size)`),
    );
  });
});

describe('cores sobre o azul das telas de entrada (#166, § 6.7)', () => {
  function variables(scheme: Scheme): Record<string, string> {
    const base = defaultCssVariablesResolver(appTheme);
    const app = cssVariablesResolver(appTheme);
    return { ...base.variables, ...base[scheme], ...app.variables, ...app[scheme] };
  }

  function resolve(value: string, vars: Record<string, string>, depth = 0): string {
    const match = /^var\((--[\w-]+)\)$/.exec(value.trim());
    if (!match) return value.trim();
    const name = match[1] ?? '';
    const next = vars[name];
    if (next === undefined || depth > 10) throw new Error(`Variável sem valor: ${name}`);
    return resolve(next, vars, depth + 1);
  }

  describe.each<Scheme>(['light', 'dark'])('tema %s', (scheme) => {
    const vars = variables(scheme);
    const r = (value: string) => resolve(value, vars);
    const blue = r('var(--app-brand-bg)');

    it('o fundo é o azul do logo, igual nos dois temas', () => {
      expect(blue).toBe(BRAND_COLORS.blue);
    });

    it.each<[string, string, number, number]>([
      // [what, color, minimum, ratio in the skill]
      ['texto branco', 'var(--app-brand-text)', MIN_TEXT, 14.43],
      ['texto secundário claro', 'var(--app-brand-text-secondary)', MIN_TEXT, 9.17],
      ['anel de foco amarelo', 'var(--app-brand-focus-ring)', MIN_INDICATOR, 11.8],
      ['borda do cartão', 'var(--app-brand-card-border)', MIN_INDICATOR, 3],
    ])('%s sobre o azul', (_what, color, minimum, skillRatio) => {
      const ratio = contrastRatio(r(color), blue);
      expect(ratio).toBeGreaterThanOrEqual(minimum);
      expect(ratio).toBeGreaterThanOrEqual(skillRatio - 0.01);
    });

    it('texto e anel nas cores da skill: branco, #C5CEE6 e o amarelo do logo', () => {
      expect(r('var(--app-brand-text)').toLowerCase()).toMatch(/^#(fff|ffffff)$/);
      expect(r('var(--app-brand-text-secondary)')).toBe('#C5CEE6');
      expect(r('var(--app-brand-focus-ring)')).toBe(BRAND_COLORS.yellow);
    });
  });

  it('no escuro, a borda do cartão é a borda de controle (4,46:1 sobre o azul)', () => {
    const vars = variables('dark');
    expect(resolve('var(--app-brand-card-border)', vars)).toBe(
      resolve('var(--app-control-border)', vars),
    );
    const ratio = contrastRatio(resolve('var(--app-brand-card-border)', vars), BRAND_COLORS.blue);
    expect(ratio).toBeGreaterThanOrEqual(4.46);
  });

  it('por que a borda: o cartão carvão e a borda padrão do Paper somem no azul', () => {
    // The charcoal card (1.01:1) and Mantine's dark border of the Paper, dark.4 (1.44:1).
    expect(contrastRatio(appTheme.colors.dark[6], BRAND_COLORS.blue)).toBeLessThan(3);
    expect(contrastRatio(appTheme.colors.dark[4], BRAND_COLORS.blue)).toBeLessThan(3);
  });

  it('por que nada vermelho no azul: o vermelho do logo dá 2,8:1 ali', () => {
    expect(contrastRatio(BRAND_COLORS.red, BRAND_COLORS.blue)).toBeLessThan(MIN_INDICATOR);
  });
});
