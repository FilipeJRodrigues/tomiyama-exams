/**
 * Forma dos componentes (#166, etapa 1b; skill `tomiyama-design`, `components.md`), medida na
 * cascata que o navegador recebe (`tests/computedCss.ts`): o CSS do Mantine, o `a11y.css` e as
 * variáveis do tema.
 *
 * - Pílula (`xl`): `Button`, `ActionIcon`, `Badge` e `SegmentedControl`.
 * - `lg` (16 px): `Paper`, `Card`, `Modal` e `Drawer`, e os painéis das telas (o de "Dados da
 *   faixa" passava `radius="sm"`). O diálogo em tela cheia (celular) continua sem raio, e um
 *   raio explícito (a barra do resumo, presa às bordas da tela) continua valendo.
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

import { cssVariablesResolver, theme } from '../../src/app/theme';
import { BeltFixedData } from '../../src/features/belts/BeltFixedData';
import { mockBelts } from '../../src/mocks/data';
import { Styles, loadStyles } from '../computedCss';

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

  it.each(['horizontal', 'vertical'] as const)('SegmentedControl %s', async (orientation) => {
    renderInTheme(
      scheme,
      <SegmentedControl
        aria-label="Filtrar alunos"
        orientation={orientation}
        data={['Todos', 'Presentes']}
      />,
    );
    const root = element(document.querySelector('.mantine-SegmentedControl-root'), 'O seletor');
    const styles = await Styles.now();
    expect(radiusOf(styles, root)).toBe(themeRadius(styles, root, 'xl'));
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

  it.each(['bottom', 'left'] as const)('Drawer (%s)', async (position) => {
    renderInTheme(
      scheme,
      <Drawer opened onClose={noop} title="Decidir o exame" position={position}>
        Conteúdo da gaveta
      </Drawer>,
    );
    const drawer = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    const styles = await Styles.now();
    expect(radiusOf(styles, drawer)).toBe(16);
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
