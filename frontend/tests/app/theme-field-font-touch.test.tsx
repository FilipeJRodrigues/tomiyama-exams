/**
 * Texto dos campos numa tela de toque (#191; § 6.7): o Safari do iOS amplia a página quando o
 * foco vai para um campo com texto abaixo de 16 px. A regra de `a11y.css` (`any-pointer:
 * coarse`) leva o campo a pelo menos 16 px só numa tela de toque:
 * - com mouse (o padrão dos testes, sem toque), os campos continuam no `sm` do Mantine, 14 px;
 * - com toque, o `sm` vai a 16 px e um tamanho maior escolhido de propósito não encolhe.
 *
 * As telas montadas ficam em `tests/regression/191-zoom-campos-tela-de-toque.test.tsx`.
 */
import { MantineProvider, NativeSelect, PasswordInput, TextInput, Textarea } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { mantineProviderProps } from '../../src/app/theme';
import { Styles, loadStyles } from '../computedCss';
import { setTouchScreen } from '../viewport';

type Size = 'sm' | 'md' | 'lg';

/** Every kind of field of the app; the label finds the element that takes the focus. */
const FIELDS = [
  {
    name: 'TextInput',
    label: 'E-mail',
    render: (size?: Size) => <TextInput label="E-mail" type="email" size={size} />,
  },
  {
    name: 'PasswordInput',
    label: 'Senha',
    render: (size?: Size) => <PasswordInput label="Senha" size={size} />,
  },
  {
    name: 'NativeSelect',
    label: 'Faixa',
    render: (size?: Size) => <NativeSelect label="Faixa" data={['Branca', 'Cinza']} size={size} />,
  },
  {
    name: 'Textarea',
    label: 'Observação',
    render: (size?: Size) => <Textarea label="Observação" size={size} />,
  },
] as const;

function renderInTheme(children: ReactNode) {
  render(<MantineProvider {...mantineProviderProps}>{children}</MantineProvider>);
}

async function fontSizeOf(label: string): Promise<number> {
  const field = screen.getByLabelText(label);
  const styles = await Styles.now();
  return styles.fontSizePx(field);
}

beforeAll(loadStyles);

describe('#191 texto dos campos com mouse (desktop, sem toque)', () => {
  it.each(FIELDS)('$name continua com 14 px', async (field) => {
    renderInTheme(field.render());
    expect(await fontSizeOf(field.label)).toBe(14);
  });
});

describe('#191 texto dos campos numa tela de toque (§ 6.7)', () => {
  it.each(FIELDS)('$name no tamanho padrão vai a 16 px', async (field) => {
    setTouchScreen(true);
    renderInTheme(field.render());
    expect(await fontSizeOf(field.label)).toBe(16);
  });

  it.each(FIELDS)('$name com size="lg" não encolhe: fica com 18 px', async (field) => {
    setTouchScreen(true);
    renderInTheme(field.render('lg'));
    expect(await fontSizeOf(field.label)).toBe(18);
  });

  it.each(FIELDS)('$name com size="md" fica com 16 px', async (field) => {
    setTouchScreen(true);
    renderInTheme(field.render('md'));
    expect(await fontSizeOf(field.label)).toBe(16);
  });
});
