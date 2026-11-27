/**
 * Certo/Errado, Aprovar/Reprovar e o botão que confirma a decisão cheios (#166, etapa 4; skill
 * `tomiyama-design`, "Certo / Errado (§ 6.4)" e "Decisão"), na tela do exame do aluno e nos dois
 * temas, com a regra que vence a cascata em cada botão (`tests/computedCss.ts`):
 *
 * - Escolhido, decisão e confirmação: verde `#237A36` (Certo, Aprovar) e vermelho do logo
 *   `#D62211` (Errado, Reprovar), cheios nos dois temas, com texto e ícone brancos a 4,5:1 ou
 *   mais, em repouso e em hover (tom 9 de cada cor); o botão que confirma só tem o texto.
 * - Borda de 2 px: no escuro, clara (`#C9C9C9`), a 3:1 ou mais do cartão em volta (o verde dá
 *   2,67:1 e o vermelho 2,80:1 ali); no claro, transparente, e o que aparece nela é o próprio
 *   preenchimento, a 3:1 ou mais do cartão branco.
 * - Não escolhido: `default`, com a borda de controle de 2 px a 3:1 ou mais do cartão e do fundo
 *   do botão em hover.
 * - Anel de foco: a cor do tema, a 3:1 ou mais do que está em volta, 2 px fora do botão (sobre o
 *   cartão, não sobre o preenchimento).
 * - O que não muda: `aria-pressed`, ícone cheio no escolhido e vazado no outro, 44 px de altura,
 *   104 px de largura mínima e a mesma caixa (borda, recuo, fonte) nos dois estados; o estado
 *   desabilitado e o carregando do botão que confirma; exame somente leitura em texto com ícone.
 *
 * Helena (evento aberto, exame da Marrom em andamento): Professor marcado como Certo; Parar não
 * marcado. O examinador simulado é o sensei nos testes da decisão.
 */
import {
  DEFAULT_THEME,
  mergeMantineTheme,
  type MantineColorsTuple,
  type MantineTheme,
} from '@mantine/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { BRAND_COLORS, COLOR_SCHEME_KEY, theme } from '../../../src/app/theme';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { Styles, expectContrast, hex, loadStyles, type Rgb } from '../../computedCss';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

type Scheme = 'light' | 'dark';

const SCHEMES: readonly Scheme[] = ['light', 'dark'];
const MIN_TEXT = 4.5;
const MIN_INDICATOR = 3;

const { open: OPEN, closed: CLOSED } = MOCK_EVENT_IDS;
const HELENA = { id: '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08', name: 'Helena Prado' };
const ELIDA = { id: '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05', name: 'Élida Ramos' };
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const DECISION_URL = `${TEST_API_URL}/events/:id/exams/:studentId/decision`;

const appTheme: MantineTheme = mergeMantineTheme(DEFAULT_THEME, theme);

function shades(name: string): MantineColorsTuple {
  const tuple = appTheme.colors[name];
  if (!tuple) throw new Error(`Cor fora do tema: ${name}`);
  return tuple;
}

type Verdict = 'positive' | 'negative';

/** Fill at rest and on hover (tone 9, Mantine's `filled-hover`), the same in both schemes. */
const FILL: Record<Verdict, { rest: string; hover: string }> = {
  positive: { rest: BRAND_COLORS.green.toLowerCase(), hover: shades('green')[9].toLowerCase() },
  negative: { rest: BRAND_COLORS.red.toLowerCase(), hover: shades('red')[9].toLowerCase() },
};

const WHITE = '#ffffff';
/** Cards, dialogs and drawers. */
const SURFACE: Record<Scheme, string> = { light: WHITE, dark: '#2a2a2a' };
/** The light border of the filled buttons in the dark scheme: the main text color, dark.0. */
const LIGHT_BORDER = shades('dark')[0].toLowerCase();
const CONTROL_BORDER: Record<Scheme, string> = { light: '#737b83', dark: '#8f8f8f' };
const RING: Record<Scheme, string> = {
  light: BRAND_COLORS.blue.toLowerCase(),
  dark: BRAND_COLORS.yellow.toLowerCase(),
};

let db: MockDb;

function installApi() {
  db = createMockDb({ includeShowcase: true });
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
}

async function openExam(scheme: Scheme, width = 1280, eventId: string = OPEN, student = HELENA) {
  window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  setViewportWidth(width);
  const rendered = await renderApp({
    route: examPath(eventId, student.id),
    signedInAs: 'examiner',
  });
  await screen.findByRole('heading', { level: 1, name: student.name });
  expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
  return rendered;
}

function button(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

function summary(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

/** `#abc` as `#aabbcc`, the way `hex()` writes a color. */
function expand(color: string): string {
  return color.toLowerCase().replace(/^#(\w)(\w)(\w)$/, '#$1$1$2$2$3$3');
}

/** `2px`, `0.125rem` or Mantine's `calc(0.125rem * 1)`, in px. */
function toPx(value: string): number {
  const text = value.replace(/\s+/g, ' ').trim();
  const px = /^(-?[\d.]+)px$/.exec(text);
  if (px) return Number(px[1]);
  const rem = /^(-?[\d.]+)rem$/.exec(text);
  if (rem) return Number(rem[1]) * 16;
  const scaled = /^calc\((-?[\d.]+)rem \* ([\d.]+)\)$/.exec(text);
  if (scaled) return Number(scaled[1]) * 16 * Number(scaled[2]);
  throw new Error(`Medida não reconhecida: "${value}"`);
}

/** Width of the border that wins on the element (the `border` shorthand or `border-width`). */
function borderWidthPx(styles: Styles, target: Element): number {
  const winner = styles.declared(target, ['border', 'border-width']);
  if (winner === null) throw new Error('O botão não tem borda nas folhas de estilo.');
  const value = styles.resolve(target, winner.value);
  // The first token of the shorthand, spaces inside `calc()` included.
  const width = winner.prop === 'border' ? value.split(/\s+(?![^(]*\))/)[0] : value;
  return toPx(width ?? '');
}

function borderValue(styles: Styles, target: Element): string {
  const winner = styles.declared(target, ['border', 'border-color']);
  if (winner === null) throw new Error('O botão não tem borda nas folhas de estilo.');
  return styles.resolve(target, winner.value);
}

/**
 * What shows in the border box: the border color, or the button's own background under a
 * transparent border (the background is painted under the border, `background-clip` left at
 * its initial `border-box`).
 */
function borderShown(styles: Styles, target: HTMLElement): Rgb {
  if (/\btransparent\b/.test(borderValue(styles, target))) {
    expect(styles.declared(target, ['background-clip'])).toBeNull();
    return styles.background(target);
  }
  return styles.borderColor(target);
}

/** What is painted around the button: the card, the dialog or the drawer. */
function around(styles: Styles, target: HTMLElement): Rgb {
  return styles.background(target.parentElement ?? target);
}

function icon(target: HTMLElement): SVGElement {
  const found = target.querySelector('svg');
  if (!(found instanceof SVGElement)) throw new Error('O botão não tem ícone.');
  return found;
}

/**
 * A filled verdict button, measured at rest and on hover. `withIcon`: Certo/Errado and
 * Aprovar/Reprovar have one; the confirm button of the dialog has only its text.
 */
async function expectFilled(
  target: HTMLElement,
  verdict: Verdict,
  scheme: Scheme,
  what: string,
  withIcon = true,
) {
  for (const hovered of [false, true]) {
    const state = hovered ? 'hover' : 'rest';
    const styles = await Styles.now(hovered ? { hover: target } : {});
    const fill = styles.background(target);
    const text = styles.textColor(target);
    const card = around(styles, target);
    const label = `${what}${hovered ? ' em hover' : ''}, tema ${scheme}`;
    expect(hex(fill), label).toBe(FILL[verdict][state]);
    expect(hex(text), label).toBe(WHITE);
    if (withIcon) expect(hex(styles.textColor(icon(target))), label).toBe(WHITE);
    else expect(target.querySelector('svg'), label).toBeNull();
    expectContrast(`texto de ${label}`, text, fill, MIN_TEXT);
    expect(hex(card), label).toBe(SURFACE[scheme]);
    // The border: 2 px, light in the dark scheme, the fill itself in the light one.
    expect(borderWidthPx(styles, target), label).toBe(2);
    if (scheme === 'dark') expect(hex(styles.borderColor(target)), label).toBe(LIGHT_BORDER);
    else expect(borderValue(styles, target), label).toMatch(/\btransparent\b/);
    expectContrast(
      `borda de ${label} contra o cartão`,
      borderShown(styles, target),
      card,
      MIN_INDICATOR,
    );
  }
}

/** The focus ring: the color of the scheme, on what is around the button, 2 px off it. */
async function expectFocusRing(target: HTMLElement, scheme: Scheme, what: string) {
  act(() => {
    target.focus();
  });
  expect(target).toHaveFocus();
  const styles = await Styles.now();
  const ring = styles.focusRingColor(target);
  expect(hex(ring), what).toBe(RING[scheme]);
  expectContrast(
    `anel de foco de ${what}, tema ${scheme}`,
    ring,
    around(styles, target),
    MIN_INDICATOR,
  );
  const offset = styles.declared(target, ['outline-offset']);
  if (offset === null) throw new Error('O anel de foco não tem outline-offset.');
  expect(toPx(styles.resolve(target, offset.value)), what).toBeGreaterThanOrEqual(2);
}

/** What sets the size of a button: the same chosen or not, so the list never moves. */
async function box(target: HTMLElement) {
  const styles = await Styles.now();
  return {
    border: borderWidthPx(styles, target),
    height: styles.resolve(target, 'var(--button-height)'),
    paddingX: styles.resolve(target, 'var(--button-padding-x)'),
    withLeftSection: target.hasAttribute('data-with-left-section'),
    fontWeight: styles.declared(target, ['font-weight'])?.value,
    minHeight: target.style.minHeight,
    minWidth: target.style.minWidth,
    iconSize: icon(target).getAttribute('width'),
  };
}

beforeAll(loadStyles);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
  installApi();
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each<Scheme>(SCHEMES)('Certo / Errado no tema %s (§ 6.4, #166)', (scheme) => {
  it('rn006 Certo escolhido: verde cheio, texto e ícone brancos, borda de 2 px', async () => {
    await openExam(scheme);
    const certo = button('Certo: Professor');
    expect(certo).toHaveAttribute('aria-pressed', 'true');
    expect(certo).toHaveAttribute('data-variant', 'filled');
    await expectFilled(certo, 'positive', scheme, '"Certo" escolhido');
  });

  it('rn006 Errado escolhido: vermelho do logo cheio, texto e ícone brancos, borda de 2 px', async () => {
    const { user } = await openExam(scheme);
    await user.click(button('Errado: Parar'));
    const errado = button('Errado: Parar');
    expect(errado).toHaveAttribute('aria-pressed', 'true');
    expect(errado).toHaveAttribute('data-variant', 'filled');
    await expectFilled(errado, 'negative', scheme, '"Errado" escolhido');
  });

  it('rn006 não escolhido: default, com a borda de controle de 2 px a 3:1 ou mais', async () => {
    await openExam(scheme);
    for (const name of ['Certo: Parar', 'Errado: Parar', 'Errado: Professor']) {
      const target = button(name);
      expect(target).toHaveAttribute('aria-pressed', 'false');
      expect(target).toHaveAttribute('data-variant', 'default');
      for (const hovered of [false, true]) {
        const styles = await Styles.now(hovered ? { hover: target } : {});
        const label = `"${name}" não escolhido${hovered ? ' em hover' : ''}, tema ${scheme}`;
        const border = styles.borderColor(target);
        expect(hex(border), label).toBe(CONTROL_BORDER[scheme]);
        expect(borderWidthPx(styles, target), label).toBe(2);
        expectContrast(
          `borda de ${label} contra o cartão`,
          border,
          around(styles, target),
          MIN_INDICATOR,
        );
        // Inside the border, the background of the button (its hover color on hover).
        expectContrast(
          `borda de ${label} contra o botão`,
          border,
          styles.background(target),
          MIN_INDICATOR,
        );
        const text = styles.textColor(target);
        expectContrast(`texto de ${label}`, text, styles.background(target), MIN_TEXT);
      }
    }
  });

  it('anel de foco a 3:1 ou mais, no escolhido e no não escolhido', async () => {
    const { user } = await openExam(scheme);
    await expectFocusRing(button('Certo: Professor'), scheme, '"Certo" escolhido');
    await expectFocusRing(button('Errado: Professor'), scheme, '"Errado" não escolhido');
    await user.click(button('Errado: Parar'));
    await expectFocusRing(button('Errado: Parar'), scheme, '"Errado" escolhido');
  });
});

describe('Certo / Errado: o que não muda (§ 6.4, #166)', () => {
  it('rn006 aria-pressed e ícone cheio só no escolhido, vazado no outro', async () => {
    const { user } = await openExam('dark');
    const group = screen.getByRole('group', { name: 'Marcação: Parar' });
    const certo = within(group).getByRole('button', { name: 'Certo: Parar' });
    const errado = within(group).getByRole('button', { name: 'Errado: Parar' });
    expect(icon(certo).classList).toContain('tabler-icon-circle-check');
    expect(icon(errado).classList).toContain('tabler-icon-circle-x');

    await user.click(certo);
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'false');
    expect(icon(button('Certo: Parar')).classList).toContain('tabler-icon-circle-check-filled');
    expect(icon(button('Errado: Parar')).classList).toContain('tabler-icon-circle-x');

    await user.click(button('Errado: Parar'));
    expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
    expect(icon(button('Errado: Parar')).classList).toContain('tabler-icon-circle-x-filled');
    expect(icon(button('Certo: Parar')).classList).toContain('tabler-icon-circle-check');
    expect(icon(button('Certo: Parar')).classList).not.toContain('tabler-icon-circle-check-filled');
  });

  it.each(SCHEMES)(
    'rn006 a mesma caixa escolhido ou não (borda de 2 px, 44 px, 104 px), tema %s',
    async (scheme) => {
      const { user } = await openExam(scheme);
      // Certo: Professor is chosen, Parar is not.
      const unchosen = await box(button('Certo: Parar'));
      expect(unchosen).toMatchObject({ border: 2, minHeight: '44px', minWidth: '104px' });
      expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'true');
      expect(await box(button('Certo: Professor'))).toEqual(unchosen);
      // Marking keeps the box of the same button.
      await user.click(button('Certo: Parar'));
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(await box(button('Certo: Parar'))).toEqual(unchosen);

      // Errado: Demonstrar saudação ajoelhado is chosen, Osoto gari is not.
      await user.click(screen.getByRole('tab', { name: /^Prático/ }));
      const wrongUnchosen = await box(button('Errado: Osoto gari'));
      expect(wrongUnchosen).toEqual(unchosen);
      const chosen = button('Errado: Demonstrar saudação ajoelhado');
      expect(chosen).toHaveAttribute('aria-pressed', 'true');
      expect(await box(chosen)).toEqual(wrongUnchosen);
    },
  );

  it('o nome acessível continua "Certo: <item>" e "Errado: <item>"', async () => {
    const { user } = await openExam('light');
    await user.click(screen.getByRole('tab', { name: /^Prático/ }));
    const group = screen.getByRole('group', { name: 'Marcação: Osoto gari' });
    expect(within(group).getByRole('button', { name: 'Certo: Osoto gari' })).toHaveTextContent(
      /^Certo$/,
    );
    expect(within(group).getByRole('button', { name: 'Errado: Osoto gari' })).toHaveTextContent(
      /^Errado$/,
    );
  });

  it('rn016 evento encerrado: marcações em texto com ícone, sem botão desabilitado', async () => {
    await openExam('dark', 1280, CLOSED, ELIDA);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-item]').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: /^(Certo|Errado): / })).not.toBeInTheDocument();
    for (const item of document.querySelectorAll<HTMLElement>('[data-item]')) {
      expect(within(item).queryByRole('button')).not.toBeInTheDocument();
      const mark = item.querySelector('[data-mark]');
      expect(mark?.querySelector('svg')).not.toBeNull();
      expect(mark).toHaveTextContent(/^(Certo|Errado|Não marcado)$/);
    }
  });
});

describe.each<Scheme>(SCHEMES)('Aprovar / Reprovar no tema %s (§ 6.4, #166)', (scheme) => {
  beforeEach(() => {
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
  });

  it('rn008 no resumo (1280 px): verde e vermelho do logo cheios, com a borda de 2 px', async () => {
    await openExam(scheme);
    const group = await within(summary()).findByRole('group', { name: 'Decisão do sensei' });
    const approve = await within(group).findByRole('button', { name: 'Aprovar' });
    const fail = within(group).getByRole('button', { name: 'Reprovar' });
    expect(approve).toHaveStyle({ minHeight: '44px' });
    expect(fail).toHaveStyle({ minHeight: '44px' });
    await expectFilled(approve, 'positive', scheme, '"Aprovar" no resumo');
    await expectFilled(fail, 'negative', scheme, '"Reprovar" no resumo');
    await expectFocusRing(approve, scheme, '"Aprovar" no resumo');
    await expectFocusRing(fail, scheme, '"Reprovar" no resumo');
  });

  it('rn008 na gaveta "Decidir o exame" (390 px): as mesmas cores e borda', async () => {
    const { user } = await openExam(scheme, 390);
    await user.click(await within(summary()).findByRole('button', { name: 'Decidir' }));
    const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    const approve = within(panel).getByRole('button', { name: 'Aprovar' });
    const fail = within(panel).getByRole('button', { name: 'Reprovar' });
    await expectFilled(approve, 'positive', scheme, '"Aprovar" na gaveta');
    await expectFilled(fail, 'negative', scheme, '"Reprovar" na gaveta');
    await expectFocusRing(fail, scheme, '"Reprovar" na gaveta');
  });

  it.each<[string, Verdict]>([
    ['Aprovar', 'positive'],
    ['Reprovar', 'negative'],
  ])(
    'rn008 o botão que confirma "%s" no diálogo repete a cor da decisão',
    async (name, verdict) => {
      const { user } = await openExam(scheme);
      await user.click(await within(summary()).findByRole('button', { name }));
      const modal = await screen.findByRole('dialog', { name: `${name} exame` });
      const confirm = within(modal).getByRole('button', { name });
      expect(confirm).toBeEnabled();
      expect(confirm).toHaveStyle({ minHeight: '44px' });
      await expectFilled(confirm, verdict, scheme, `"${name}" do diálogo`, false);
      await expectFocusRing(confirm, scheme, `"${name}" do diálogo`);
    },
  );

  it('rn010 desabilitado enquanto as marcações salvam: como antes, com a mesma borda de 2 px', async () => {
    const held: (() => void)[] = [];
    server.use(
      http.put(
        ANSWER_URL,
        () =>
          new Promise<undefined>((resolve) => {
            held.push(() => {
              resolve(undefined);
            });
          }),
      ),
    );
    const { user } = await openExam(scheme);
    await user.click(button('Certo: Parar'));
    await user.click(await within(summary()).findByRole('button', { name: 'Aprovar' }));
    const modal = await screen.findByRole('dialog', { name: 'Aprovar exame' });
    const confirm = within(modal).getByRole('button', { name: 'Aprovar' });
    expect(confirm).toBeDisabled();
    expect(modal).toHaveTextContent('Aguardando as marcações serem salvas…');
    let styles = await Styles.now();
    // Mantine's disabled look, as before: its gray background and text, a transparent border;
    // only the width stays at 2 px, so the button keeps its size when it turns on.
    const disabled = (name: string) => styles.resolve(confirm, `var(${name})`).toLowerCase();
    expect(hex(styles.background(confirm))).toBe(expand(disabled('--mantine-color-disabled')));
    expect(hex(styles.textColor(confirm))).toBe(expand(disabled('--mantine-color-disabled-color')));
    expect(borderValue(styles, confirm)).toMatch(/\btransparent\b/);
    expect(borderWidthPx(styles, confirm)).toBe(2);

    await waitFor(() => {
      expect(held).toHaveLength(1);
    });
    await act(async () => {
      held[0]!();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });
    styles = await Styles.now();
    expect(borderWidthPx(styles, confirm)).toBe(2);
    await expectFilled(confirm, 'positive', scheme, '"Aprovar" do diálogo depois de salvar', false);
  });

  it('rn008 carregando enquanto a decisão vai: a cor e a borda continuam', async () => {
    const releases: (() => void)[] = [];
    server.use(
      http.post(DECISION_URL, async () => {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return undefined;
      }),
    );
    const { user } = await openExam(scheme);
    await user.click(await within(summary()).findByRole('button', { name: 'Reprovar' }));
    const modal = await screen.findByRole('dialog', { name: 'Reprovar exame' });
    const confirm = within(modal).getByRole('button', { name: 'Reprovar' });
    await user.click(confirm);
    await waitFor(() => {
      expect(confirm).toHaveAttribute('data-loading');
    });
    const styles = await Styles.now();
    expect(hex(styles.background(confirm))).toBe(FILL.negative.rest);
    expect(borderWidthPx(styles, confirm)).toBe(2);
    if (scheme === 'dark') expect(hex(styles.borderColor(confirm))).toBe(LIGHT_BORDER);
    act(() => {
      for (const release of releases) release();
    });
  });
});

describe('um ponto só para a cor (#166)', () => {
  const sources = import.meta.glob<string>(
    [
      '../../../src/features/exam/verdictButton.ts',
      '../../../src/features/exam/ExamItems.tsx',
      '../../../src/features/exam/ExamDecision.tsx',
    ],
    { query: '?raw', import: 'default', eager: true },
  );

  /** The code of a file, without the comments (they quote the colors they measure). */
  function code(file: string): string {
    const found = Object.entries(sources).find(([path]) => path.endsWith(file));
    if (!found) throw new Error(`${file} fora da lista.`);
    return found[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  }

  it('nenhum hex fixo, nem as cores antigas, nos botões do exame', () => {
    expect(Object.keys(sources)).toHaveLength(3);
    for (const file of ['verdictButton.ts', 'ExamItems.tsx', 'ExamDecision.tsx']) {
      const text = code(file);
      expect(text.match(/#[0-9a-f]{3,8}\b/gi), file).toBeNull();
      expect(text, file).not.toMatch(/red\.9|default-border|-light-color\)`/);
      expect(text, file).not.toMatch(/variant="light"\s+color="(green|red)"/);
    }
  });

  it('Certo/Errado, Aprovar/Reprovar e a confirmação usam verdictButtonProps', () => {
    expect(code('ExamItems.tsx').match(/verdictButtonProps\(/g)).toHaveLength(1);
    expect(code('ExamDecision.tsx').match(/verdictButtonProps\(/g)).toHaveLength(3);
  });
});
