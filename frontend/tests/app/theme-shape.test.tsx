/**
 * Forma dos componentes (#166, etapa 1b; skill `tomiyama-design`, `components.md`), medida na
 * cascata que o navegador recebe (`tests/computedCss.ts`): o CSS do Mantine, o `a11y.css` e as
 * variáveis do tema.
 *
 * - Pílula (`xl`): `Button`, `ActionIcon`, `Badge` e `SegmentedControl` horizontal. O
 *   `SegmentedControl` vertical (o filtro do Dia do exame abaixo de 768 px) fica com `lg`: na
 *   pílula, o trilho cortava o anel de foco do primeiro e do último item (§ 6.7; regressão
 *   `tests/regression/166-anel-foco-segmentado-vertical-cortado.test.tsx`).
 * - `lg` (16 px): `Paper`, `Card`, `Modal` e `Drawer`, e os painéis das telas (o de "Dados da
 *   faixa" passava `radius="sm"`). O diálogo em tela cheia (celular) continua sem raio, e um
 *   raio explícito (a barra do resumo, presa às bordas da tela) continua valendo. A gaveta
 *   arredonda só os cantos do lado de fora; os do lado preso à borda da tela ficam retos (no
 *   Edge, arredondados ali, mostravam a camada escura atrás).
 * - `md`: os campos.
 * - Botões em negrito (700), inclusive o rótulo.
 * - O anel de foco dos botões e dos `ActionIcon` continua com o afastamento do Mantine (2 px),
 *   para acompanhar a pílula sem colar na borda (§ 6.7).
 */
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Drawer,
  MantineProvider,
  Modal,
  NativeSelect,
  NumberInput,
  Paper,
  PasswordInput,
  SegmentedControl,
  Select,
  TextInput,
  Textarea,
  type MantineSize,
} from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { cssVariablesResolver, theme } from '../../src/app/theme';
import { BeltFixedData } from '../../src/features/belts/BeltFixedData';
import { mockBelts } from '../../src/mocks/data';
import { Styles, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

type Scheme = 'light' | 'dark';

const SCHEMES: readonly Scheme[] = ['light', 'dark'];

const noop = () => undefined;

function renderInTheme(scheme: Scheme, children: ReactNode) {
  return render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      forceColorScheme={scheme}
    >
      {children}
    </MantineProvider>,
  );
}

function element(found: Element | null | undefined, what: string): HTMLElement {
  if (!(found instanceof HTMLElement)) throw new Error(`${what} deveria estar na tela.`);
  return found;
}

/** `calc(2rem * 1)`, `8px` or `0` (what the resolved radius looks like) in px. */
function toPx(value: string): number {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '0') return 0;
  const px = /^(-?[\d.]+)px$/.exec(text);
  if (px) return Number(px[1]);
  const rem = /^(-?[\d.]+)rem$/.exec(text);
  if (rem) return Number(rem[1]) * 16;
  const scaled = /^calc\((-?[\d.]+)rem \* ([\d.]+)\)$/.exec(text);
  if (scaled) return Number(scaled[1]) * 16 * Number(scaled[2]);
  throw new Error(`Raio não reconhecido: "${value}"`);
}

/** The `border-radius` that wins on the element, in px. */
function radiusOf(styles: Styles, target: Element): number {
  const winner = styles.declared(target, ['border-radius']);
  if (winner === null) throw new Error('O elemento não tem border-radius nas folhas de estilo.');
  return toPx(styles.resolve(target, winner.value));
}

/** A size of the theme's radius scale, in px. */
function themeRadius(styles: Styles, target: Element, size: MantineSize): number {
  return toPx(styles.resolve(target, `var(--mantine-radius-${size})`));
}

/** The corners in the order of the `border-radius` shorthand. */
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

type Corner = (typeof CORNERS)[number];

/** Logical longhand of each corner, in a left-to-right page. */
const LOGICAL_CORNER: Record<Corner, string> = {
  'top-left': 'border-start-start-radius',
  'top-right': 'border-start-end-radius',
  'bottom-right': 'border-end-end-radius',
  'bottom-left': 'border-end-start-radius',
};

/** Split at spaces outside parentheses: `calc(1rem * 1) 0` → two tokens. */
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

/**
 * Radius of each corner (top-left, top-right, bottom-right, bottom-left) in px: for each one,
 * whatever wins the cascade among the shorthand and that corner's longhands. Only the
 * horizontal radius of the shorthand (before a `/`).
 */
function cornersOf(styles: Styles, target: Element): number[] {
  return CORNERS.map((corner, index) => {
    const winner = styles.declared(target, [
      'border-radius',
      `border-${corner}-radius`,
      LOGICAL_CORNER[corner],
    ]);
    if (winner === null) throw new Error(`O elemento não tem raio no canto ${corner}.`);
    const values = tokens(styles.resolve(target, winner.value));
    if (winner.prop !== 'border-radius') return toPx(values[0] ?? '');
    const slash = values.indexOf('/');
    const horizontal = slash === -1 ? values : values.slice(0, slash);
    const [a = '', b = a, c = a, d = b] = horizontal;
    return toPx([a, b, c, d][index] ?? '');
  });
}

/** A property that inherits (`font-weight`): the value on the element or its nearest ancestor. */
function inherited(styles: Styles, target: Element, prop: string): string {
  for (let current: Element | null = target; current; current = current.parentElement) {
    const winner = styles.declared(current, [prop]);
    if (winner) return styles.resolve(current, winner.value);
  }
  throw new Error(`Nenhum ${prop} nas folhas de estilo.`);
}

beforeAll(loadStyles);

describe('escala de raios do tema (#166)', () => {
  it('xl é a pílula, lg tem 16 px e md, dos campos, é menor que os dois', async () => {
    renderInTheme('dark', <Paper>Cartão</Paper>);
    const styles = await Styles.now();
    const root = document.documentElement;
    expect(themeRadius(styles, root, 'lg')).toBe(16);
    expect(themeRadius(styles, root, 'xl')).toBe(32);
    expect(themeRadius(styles, root, 'md')).toBe(8);
  });
});

describe.each(SCHEMES)('pílula no tema %s (#166)', (scheme) => {
  it.each(['filled', 'default', 'light', 'outline', 'subtle'] as const)(
    'Button %s',
    async (variant) => {
      renderInTheme(scheme, <Button variant={variant}>Salvar</Button>);
      const button = screen.getByRole('button', { name: 'Salvar' });
      const styles = await Styles.now();
      expect(radiusOf(styles, button)).toBe(themeRadius(styles, button, 'xl'));
    },
  );

  it('Button como link', async () => {
    renderInTheme(
      scheme,
      <Button component="a" href="/dia-do-exame">
        Voltar ao Dia do exame
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Voltar ao Dia do exame' });
    const styles = await Styles.now();
    expect(radiusOf(styles, link)).toBe(themeRadius(styles, link, 'xl'));
  });

  it.each(['default', 'subtle', 'filled'] as const)('ActionIcon %s', async (variant) => {
    renderInTheme(
      scheme,
      <ActionIcon variant={variant} aria-label="Usar tema claro">
        ☀
      </ActionIcon>,
    );
    const icon = screen.getByRole('button', { name: 'Usar tema claro' });
    const styles = await Styles.now();
    expect(radiusOf(styles, icon)).toBe(themeRadius(styles, icon, 'xl'));
  });

  it.each(['light', 'filled', 'outline', 'dot'] as const)('Badge %s', async (variant) => {
    renderInTheme(scheme, <Badge variant={variant}>Dados simulados</Badge>);
    const badge = element(
      screen.getByText('Dados simulados').closest('.mantine-Badge-root'),
      'O selo',
    );
    const styles = await Styles.now();
    expect(radiusOf(styles, badge)).toBe(themeRadius(styles, badge, 'xl'));
    // The pill does not bring the uppercase back (§ 6).
    expect(badge.getAttribute('style') ?? '').toMatch(/text-transform:\s*none/);
  });

  it.each([
    ['horizontal', false],
    ['horizontal em largura total', true],
  ] as const)('SegmentedControl %s', async (_name, fullWidth) => {
    renderInTheme(
      scheme,
      <SegmentedControl
        aria-label="Filtrar alunos"
        orientation="horizontal"
        fullWidth={fullWidth}
        data={['Todos', 'Presentes']}
      />,
    );
    const root = element(document.querySelector('.mantine-SegmentedControl-root'), 'O seletor');
    const styles = await Styles.now();
    expect(radiusOf(styles, root)).toBe(themeRadius(styles, root, 'xl'));
  });
});

/*
 * § 6.7: no vertical, a pílula (32 px) é bem maior que a metade da altura de um item (uns
 * 14 px); o trilho recorta e cortava o anel de foco do primeiro e do último item. Com `lg`, o
 * trilho tem 16 px e os itens 12 px (16 menos os 4 px de padding do trilho): arcos
 * concêntricos e o anel inteiro. A geometria do anel é medida pela regressão
 * `166-anel-foco-segmentado-vertical-cortado`.
 */
describe.each(SCHEMES)('segmentado vertical no tema %s (#166, § 6.7)', (scheme) => {
  function track(): HTMLElement {
    return element(document.querySelector('.mantine-SegmentedControl-root'), 'O seletor');
  }

  it.each([false, true])('vertical com raio lg (fullWidth: %s)', async (fullWidth) => {
    renderInTheme(
      scheme,
      <SegmentedControl
        aria-label="Filtrar alunos"
        orientation="vertical"
        fullWidth={fullWidth}
        data={['Todos', 'Presentes', 'Ausentes']}
      />,
    );
    const root = track();
    expect(root).toHaveAttribute('data-orientation', 'vertical');
    const styles = await Styles.now();
    expect(radiusOf(styles, root)).toBe(themeRadius(styles, root, 'lg'));
    expect(radiusOf(styles, root)).toBe(16);
  });

  it('ao passar de horizontal para vertical (tela estreita) e de volta, o raio acompanha', async () => {
    const control = (orientation: 'horizontal' | 'vertical') => (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        forceColorScheme={scheme}
      >
        <SegmentedControl
          aria-label="Filtrar alunos"
          orientation={orientation}
          data={['Todos', 'Presentes']}
        />
      </MantineProvider>
    );
    const { rerender } = render(control('horizontal'));
    let styles = await Styles.now();
    expect(radiusOf(styles, track())).toBe(themeRadius(styles, track(), 'xl'));

    rerender(control('vertical'));
    styles = await Styles.now();
    expect(radiusOf(styles, track())).toBe(themeRadius(styles, track(), 'lg'));

    rerender(control('horizontal'));
    styles = await Styles.now();
    expect(radiusOf(styles, track())).toBe(themeRadius(styles, track(), 'xl'));
  });

  it('um raio explícito no vertical continua valendo', async () => {
    renderInTheme(
      scheme,
      <SegmentedControl
        aria-label="Filtrar alunos"
        orientation="vertical"
        radius="md"
        data={['Todos', 'Presentes']}
      />,
    );
    const styles = await Styles.now();
    expect(radiusOf(styles, track())).toBe(themeRadius(styles, track(), 'md'));
  });
});

describe('filtro "Filtrar alunos" do Dia do exame (#166, § 6.3, § 6.7)', () => {
  async function filterTrack(width: number): Promise<HTMLElement> {
    installMockApi();
    setViewportWidth(width);
    await renderApp({ route: paths.examDay, signedInAs: 'examiner' });
    const filters = await screen.findByRole('radiogroup', { name: 'Filtrar alunos' });
    return element(filters.closest('.mantine-SegmentedControl-root') ?? filters, 'O filtro');
  }

  it('no notebook (1280 px) é horizontal e em pílula', async () => {
    const root = await filterTrack(1280);
    expect(root).toHaveAttribute('data-orientation', 'horizontal');
    const styles = await Styles.now();
    expect(radiusOf(styles, root)).toBe(themeRadius(styles, root, 'xl'));
  });

  it.each([390, 640])('a %i px é vertical, com raio lg', async (width) => {
    const root = await filterTrack(width);
    expect(root).toHaveAttribute('data-orientation', 'vertical');
    const styles = await Styles.now();
    expect(radiusOf(styles, root)).toBe(themeRadius(styles, root, 'lg'));
  });
});

describe.each(SCHEMES)('raio lg das superfícies no tema %s (#166)', (scheme) => {
  it('Paper', async () => {
    renderInTheme(scheme, <Paper withBorder>Cartão</Paper>);
    const paper = element(screen.getByText('Cartão').closest('.mantine-Paper-root'), 'O Paper');
    const styles = await Styles.now();
    expect(radiusOf(styles, paper)).toBe(16);
  });

  it('Card', async () => {
    renderInTheme(scheme, <Card withBorder>Faixa Branca</Card>);
    const card = element(screen.getByText('Faixa Branca').closest('.mantine-Card-root'), 'O Card');
    const styles = await Styles.now();
    expect(radiusOf(styles, card)).toBe(16);
  });

  it('Modal', async () => {
    renderInTheme(
      scheme,
      <Modal opened onClose={noop} title="Editar faixa">
        Conteúdo do diálogo
      </Modal>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Editar faixa' });
    const styles = await Styles.now();
    expect(radiusOf(styles, dialog)).toBe(16);
  });

  it('Modal em tela cheia (celular) continua sem raio', async () => {
    renderInTheme(
      scheme,
      <Modal opened onClose={noop} title="Editar faixa" fullScreen>
        Conteúdo do diálogo
      </Modal>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Editar faixa' });
    const styles = await Styles.now();
    expect(radiusOf(styles, dialog)).toBe(0);
  });

  /*
   * The side held to the edge of the screen stays square, like the summary bar and the
   * full-screen dialog; `lg` only on the corners facing the page. Order: top-left, top-right,
   * bottom-right, bottom-left. `L` stands for `lg`.
   */
  const L = 16;
  it.each([
    ['bottom', 'os de cima', 'bottom', [L, L, 0, 0]],
    ['top', 'os de baixo', 'top', [0, 0, L, L]],
    ['left', 'os da direita', 'left', [0, L, L, 0]],
    ['right', 'os da esquerda', 'right', [L, 0, 0, L]],
    ['sem position, à esquerda', 'os da direita', undefined, [0, L, L, 0]],
  ] as const)(
    'Drawer (%s): lg só nos cantos de fora, %s; 0 nos presos à borda',
    async (_name, _outer, position, expected) => {
      renderInTheme(
        scheme,
        <Drawer opened onClose={noop} title="Decidir o exame" position={position}>
          Conteúdo da gaveta
        </Drawer>,
      );
      const drawer = await screen.findByRole('dialog', { name: 'Decidir o exame' });
      const styles = await Styles.now();
      expect(themeRadius(styles, drawer, 'lg')).toBe(L);
      expect(cornersOf(styles, drawer)).toEqual(expected);
    },
  );

  it('Drawer "Decidir o exame" com a altura do resumo do exame: cantos de cima lg, de baixo 0', async () => {
    // The same `styles` as `ExamSummary`: they add to the theme's, without undoing the corners.
    renderInTheme(
      scheme,
      <Drawer
        opened
        onClose={noop}
        title="Decidir o exame"
        position="bottom"
        styles={{ content: { height: 'auto', maxHeight: '90dvh' } }}
      >
        Conteúdo da gaveta
      </Drawer>,
    );
    const drawer = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    const styles = await Styles.now();
    expect(cornersOf(styles, drawer)).toEqual([L, L, 0, 0]);
  });

  it('Drawer com raio explícito: o raio dado nos cantos de fora', async () => {
    renderInTheme(
      scheme,
      <Drawer opened onClose={noop} title="Decidir o exame" position="bottom" radius="sm">
        Conteúdo da gaveta
      </Drawer>,
    );
    const drawer = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    const styles = await Styles.now();
    const sm = themeRadius(styles, drawer, 'sm');
    expect(sm).toBeGreaterThan(0);
    expect(cornersOf(styles, drawer)).toEqual([sm, sm, 0, 0]);
  });

  it('Drawer solto das bordas (offset): os quatro cantos lg', async () => {
    renderInTheme(
      scheme,
      <Drawer opened onClose={noop} title="Decidir o exame" position="bottom" offset={8}>
        Conteúdo da gaveta
      </Drawer>,
    );
    const drawer = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    const styles = await Styles.now();
    expect(cornersOf(styles, drawer)).toEqual([L, L, L, L]);
  });

  it('painel "Dados da faixa" do diálogo de faixa (antes radius="sm")', async () => {
    const [belt] = mockBelts;
    if (!belt) throw new Error('Os dados simulados deveriam ter faixas.');
    renderInTheme(scheme, <BeltFixedData belt={belt} />);
    const panel = screen.getByRole('region', { name: 'Dados da faixa' });
    const styles = await Styles.now();
    expect(radiusOf(styles, panel)).toBe(16);
  });

  it('um raio explícito continua valendo (barra do resumo presa às bordas)', async () => {
    renderInTheme(scheme, <Paper radius={0}>Resumo do exame</Paper>);
    const paper = element(
      screen.getByText('Resumo do exame').closest('.mantine-Paper-root'),
      'O Paper',
    );
    const styles = await Styles.now();
    expect(radiusOf(styles, paper)).toBe(0);
  });
});

describe.each(SCHEMES)('raio md dos campos no tema %s (#166)', (scheme) => {
  const fields: [string, ReactNode][] = [
    ['TextInput', <TextInput key="t" label="Nome" />],
    ['NativeSelect', <NativeSelect key="n" label="Faixa atual" data={['Branca', 'Cinza']} />],
    ['Select', <Select key="s" label="Sensei" data={['Sensei Simulado']} />],
    ['Textarea', <Textarea key="a" label="Observações" />],
    ['PasswordInput', <PasswordInput key="p" label="Senha" />],
    ['NumberInput', <NumberInput key="u" label="Idade mínima" />],
  ];

  it.each(fields)('%s', async (_name, field) => {
    renderInTheme(scheme, field);
    const box = element(document.querySelector('.mantine-Input-input'), 'A caixa do campo');
    const styles = await Styles.now();
    expect(radiusOf(styles, box)).toBe(8);
    expect(radiusOf(styles, box)).toBe(themeRadius(styles, box, 'md'));
  });
});

describe.each(SCHEMES)('botões em negrito no tema %s (#166)', (scheme) => {
  it.each(['filled', 'default', 'light', 'outline', 'subtle'] as const)(
    'Button %s: 700 no botão e no rótulo',
    async (variant) => {
      renderInTheme(scheme, <Button variant={variant}>Confirmar presença</Button>);
      const button = screen.getByRole('button', { name: 'Confirmar presença' });
      const label = element(button.querySelector('.mantine-Button-label'), 'O rótulo');
      const styles = await Styles.now();
      expect(inherited(styles, button, 'font-weight')).toBe('700');
      expect(inherited(styles, label, 'font-weight')).toBe('700');
    },
  );

  it('Button com ícone e carregando também', async () => {
    renderInTheme(
      scheme,
      <Button loading leftSection={<span aria-hidden>+</span>}>
        Salvar
      </Button>,
    );
    const button = element(document.querySelector('.mantine-Button-root'), 'O botão');
    const label = element(button.querySelector('.mantine-Button-label'), 'O rótulo');
    const styles = await Styles.now();
    expect(inherited(styles, label, 'font-weight')).toBe('700');
  });
});

describe.each(SCHEMES)('anel de foco na pílula no tema %s (§ 6.7)', (scheme) => {
  async function ringOffset(target: HTMLElement): Promise<number> {
    target.focus();
    expect(target).toHaveFocus();
    const styles = await Styles.now();
    // The ring is still drawn (its color is checked by the focus-ring tests).
    styles.focusRingColor(target);
    const offset = styles.declared(target, ['outline-offset']);
    if (offset === null) throw new Error('O anel de foco não tem outline-offset.');
    return toPx(styles.resolve(target, offset.value));
  }

  it('Button: o anel fica 2 px fora da pílula', async () => {
    renderInTheme(scheme, <Button variant="default">Sair</Button>);
    expect(await ringOffset(screen.getByRole('button', { name: 'Sair' }))).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('ActionIcon: o anel fica 2 px fora do círculo', async () => {
    renderInTheme(
      scheme,
      <ActionIcon variant="default" aria-label="Usar tema claro">
        ☀
      </ActionIcon>,
    );
    expect(
      await ringOffset(screen.getByRole('button', { name: 'Usar tema claro' })),
    ).toBeGreaterThanOrEqual(2);
  });
});
