/**
 * Erro: a borda dos campos de texto e dos seletores sem foco (filtros das telas e campos
 * dos diálogos) é #ced4da sobre #ffffff no tema claro (1,49:1) e #424242 sobre #242424 no
 * tema escuro (1,54:1). A borda é o que mostra onde o campo está.
 * Esperado: pelo menos 3:1 entre a borda do campo e o fundo em volta dele (a página e o
 * diálogo), nos dois temas (§ 6.7). A mudança vale para o app inteiro.
 * Issue: #65
 *
 * O teste mede o resultado na tela montada (a borda que vence a cascata no campo e o fundo
 * pintado em volta), com `tests/computedCss.ts`: vale qualquer forma de correção (`--input-bd`
 * pelo tema, `cssVariablesResolver`, CSS do app). Campos de texto: `TextInput`; seletores:
 * `NativeSelect`.
 */
import { act, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { COLOR_SCHEME_KEY } from '../../src/app/theme';
import { Styles, expectContrast, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';

type Scheme = 'light' | 'dark';

const SCHEME_LABEL: Record<Scheme, string> = { light: 'claro', dark: 'escuro' };

const MIN_BORDER = 3;

async function open(route: string, title: string, scheme: Scheme) {
  window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  const rendered = await renderApp({ route, signedInAs: 'examiner' });
  await screen.findByRole('heading', { name: title, level: 1 });
  expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
  return rendered;
}

/** The dialog of a new requirement: text fields and selects over the dialog's background. */
async function openRequirementDialog(scheme: Scheme): Promise<HTMLElement> {
  const { user } = await open(paths.requirements, 'Requisitos', scheme);
  await user.click(await screen.findByRole('button', { name: 'Novo requisito' }));
  return screen.findByRole('dialog', { name: 'Novo requisito' });
}

/** Border of the field without focus against what is painted around the field. */
async function expectVisibleBorder(field: HTMLElement, name: string, around: string) {
  expect(field).toBeEnabled();
  // The focused border is another color (and another requirement): measure it at rest.
  act(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  expect(field).not.toHaveFocus();
  const styles = await Styles.now();
  const outside = field.closest<HTMLElement>('.mantine-Input-wrapper')?.parentElement;
  if (!outside) throw new Error(`O campo "${name}" deveria ser um Input do Mantine.`);
  expectContrast(
    `borda do campo "${name}" sobre ${around}`,
    styles.borderColor(field),
    styles.background(outside),
    MIN_BORDER,
  );
}

describe.each<Scheme>(['light', 'dark'])(
  '#65 contraste da borda dos campos no tema %s (§ 6.7)',
  (scheme) => {
    const theme = `no tema ${SCHEME_LABEL[scheme]}`;

    beforeAll(loadStyles);

    beforeEach(() => {
      installMockApi();
    });

    it('campo de texto sobre o fundo da página', async () => {
      await open(paths.studentNew, 'Novo aluno', scheme);
      // The form comes after the belts load.
      const field = await screen.findByRole('textbox', { name: /^Nome/ });
      expect(field.tagName).toBe('INPUT');
      await expectVisibleBorder(field, 'Nome', `o fundo da página ${theme}`);
    });

    it('seletor de filtro sobre o fundo da página', async () => {
      await open(paths.requirements, 'Requisitos', scheme);
      for (const name of ['Faixa', 'Tipo']) {
        const field = await screen.findByRole('combobox', { name });
        expect(field.tagName).toBe('SELECT');
        await expectVisibleBorder(field, name, `o fundo da página ${theme}`);
      }
    });

    it('campo de texto sobre o fundo do diálogo', async () => {
      const dialog = await openRequirementDialog(scheme);
      const field = within(dialog).getByRole('textbox', { name: /^Categoria/ });
      expect(field.tagName).toBe('INPUT');
      const styles = await Styles.now();
      expect(dialog.contains(styles.backgroundOwner(field.parentElement ?? field))).toBe(true);
      await expectVisibleBorder(field, 'Categoria', `o fundo do diálogo ${theme}`);
    });

    it('seletor sobre o fundo do diálogo', async () => {
      const dialog = await openRequirementDialog(scheme);
      for (const name of [/^Faixa/, /^Tipo/]) {
        const field = within(dialog).getByRole('combobox', { name });
        expect(field.tagName).toBe('SELECT');
        await expectVisibleBorder(field, name.source.slice(1), `o fundo do diálogo ${theme}`);
      }
    });
  },
);
