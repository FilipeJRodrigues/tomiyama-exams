/**
 * Seta dos seletores no tema Tomiyama (#166; § 6.7, indicadores com 3:1): a seta faz parte do
 * controle e usa a borda de controle (`#737B83` no claro, 4,29:1 sobre o campo branco;
 * `#8F8F8F` no escuro, 4,43:1 sobre o campo `#2A2A2A`), pelo `ComboboxChevron.extend` do tema.
 * O Mantine a pintaria em dark.3 (`#696969`, 2,61:1 no escuro), o tom do placeholder.
 *
 * Vale para todo seletor com a mesma seta: `NativeSelect` (o que as telas usam hoje),
 * `Select` e `MultiSelect`. Com erro, a seta continua na cor de erro do Mantine, como a borda.
 * As telas montadas ficam em `tests/regression/166-chevron-seletor-tema-escuro.test.tsx`.
 */
import { MantineProvider, MultiSelect, NativeSelect, Select } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { mantineProviderProps } from '../../src/app/theme';
import { Styles, expectContrast, hex, loadStyles } from '../computedCss';

type Scheme = 'light' | 'dark';

const MIN_INDICATOR = 3;
const CONTROL_BORDER: Record<Scheme, string> = { light: '#737b83', dark: '#8f8f8f' };
/** `--mantine-color-error` of the theme: the red of the logo / red.4. */
const ERROR: Record<Scheme, string> = { light: '#d62211', dark: '#ff8577' };

const OPTIONS = ['Branca', 'Cinza', 'Azul'];

function renderInTheme(scheme: Scheme, children: ReactNode) {
  render(
    <MantineProvider {...mantineProviderProps} forceColorScheme={scheme}>
      {children}
    </MantineProvider>,
  );
  expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
}

/** The arrow and the field it is drawn on, from the label of the control. */
function chevronOf(label: string): { chevron: Element; field: Element } {
  // From the <label>: Select and MultiSelect also name their list of options with it.
  const wrapper = screen
    .getByText(label, { selector: 'label' })
    .closest('.mantine-InputWrapper-root')
    ?.querySelector('.mantine-Input-wrapper');
  const chevron = wrapper?.querySelector('.mantine-ComboboxChevron-chevron');
  const field = wrapper?.querySelector('.mantine-Input-input');
  if (!chevron || !field) throw new Error(`O seletor "${label}" deveria ter a seta e o campo.`);
  return { chevron, field };
}

const SELECTS = [
  {
    name: 'NativeSelect',
    render: (error?: string) => <NativeSelect label="Faixa" data={OPTIONS} error={error} />,
  },
  {
    name: 'Select',
    render: (error?: string) => <Select label="Faixa" data={OPTIONS} error={error} />,
  },
  {
    name: 'MultiSelect',
    render: (error?: string) => <MultiSelect label="Faixa" data={OPTIONS} error={error} />,
  },
] as const;

beforeAll(loadStyles);

describe.each<Scheme>(['light', 'dark'])('seta dos seletores no tema %s (#166)', (scheme) => {
  it.each(SELECTS)('$name: seta na borda de controle, com 3:1 sobre o campo', async (target) => {
    renderInTheme(scheme, target.render());
    const { chevron, field } = chevronOf('Faixa');
    const styles = await Styles.now();
    const color = styles.textColor(chevron);
    expect(hex(color)).toBe(CONTROL_BORDER[scheme]);
    expectContrast(`seta do ${target.name}`, color, styles.background(field), MIN_INDICATOR);
  });

  it.each(SELECTS)('$name com erro: seta na cor de erro', async (target) => {
    renderInTheme(scheme, target.render('Escolha a faixa.'));
    const { chevron } = chevronOf('Faixa');
    const styles = await Styles.now();
    expect(hex(styles.textColor(chevron))).toBe(ERROR[scheme]);
  });
});
