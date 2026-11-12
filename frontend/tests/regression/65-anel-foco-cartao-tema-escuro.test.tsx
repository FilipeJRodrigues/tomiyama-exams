/**
 * Erro: no tema escuro, nas listas em cartões das telas do § 6.5 (390 px e zoom de 200%), o
 * anel de foco dos botões do cartão ("Editar", "Excluir") é #1971c2 sobre o fundo do cartão
 * #2e2e2e: 2,70:1.
 * Esperado: foco visível (§ 6.7), com pelo menos 3:1 entre o anel de foco e o fundo em que
 * ele é desenhado, nos dois temas, sem tirar o texto dos botões preenchidos dos 4,5:1.
 * Issue: #65
 *
 * O teste mede o resultado na tela montada (regra que vence a cascata no botão com foco e
 * fundo do cartão em volta), com `tests/computedCss.ts`: vale qualquer forma de correção
 * (cor do anel separada da cor primária, outro fundo no cartão, CSS do app, tema). Clarear
 * a cor primária não serve: o texto branco dos botões preenchidos cairia abaixo de 4,5:1, e
 * os guardas abaixo pegam isso.
 */
import { act, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { COLOR_SCHEME_KEY } from '../../src/app/theme';
import { Styles, expectContrast, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

type Scheme = 'light' | 'dark';

const SCHEME_LABEL: Record<Scheme, string> = { light: 'claro', dark: 'escuro' };

const SCREENS = [
  { route: paths.belts, title: 'Faixas' },
  { route: paths.requirements, title: 'Requisitos' },
  { route: paths.events, title: 'Eventos' },
] as const;

const MIN_FOCUS_RING = 3;
const MIN_TEXT = 4.5;

async function open(route: string, title: string, scheme: Scheme) {
  window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  setViewportWidth(390);
  await renderApp({ route, signedInAs: 'examiner' });
  await screen.findByRole('heading', { name: title, level: 1 });
  expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
}

async function firstCard(): Promise<HTMLElement> {
  // The list comes after one or two requests; leave room for a loaded machine.
  const [item] = await screen.findAllByRole('listitem', {}, { timeout: 10000 });
  const card = item?.closest<HTMLElement>('.mantine-Card-root');
  if (!card) throw new Error('A lista em cartões deveria estar na tela a 390 px.');
  return card;
}

/** Focus ring of the control against what is painted around it. */
async function expectVisibleRing(control: HTMLElement, where: string) {
  act(() => {
    control.focus();
  });
  expect(control).toHaveFocus();
  const styles = await Styles.now();
  const around = control.parentElement ?? control;
  expectContrast(
    `anel de foco de "${control.textContent}" sobre ${where}`,
    styles.focusRingColor(control),
    styles.background(around),
    MIN_FOCUS_RING,
  );
}

async function expectRingsOnCard() {
  const card = await firstCard();
  const controls = [
    ...within(card).queryAllByRole('button'),
    ...within(card).queryAllByRole('link'),
  ];
  expect(controls.length).toBeGreaterThan(0);
  // Against whatever is painted behind the controls (today the card's own background), so
  // a correction may change the ring or the card.
  for (const control of controls) {
    await expectVisibleRing(control, 'o fundo do cartão');
  }
}

describe('#65 contraste do anel de foco nos cartões (§ 6.5, § 6.7)', () => {
  beforeAll(loadStyles);

  beforeEach(() => {
    installMockApi();
  });

  describe('tema escuro', () => {
    it.each(SCREENS)(
      '$route: anel de foco dos botões do cartão com pelo menos 3:1',
      async ({ route, title }) => {
        await open(route, title, 'dark');
        await expectRingsOnCard();
      },
    );
  });

  // Guardas: passam hoje e têm de continuar passando depois da correção.
  describe('guardas', () => {
    it.each(SCREENS)(
      'tema claro, $route: anel de foco dos botões do cartão com pelo menos 3:1',
      async ({ route, title }) => {
        await open(route, title, 'light');
        await expectRingsOnCard();
      },
    );

    it.each<Scheme>(['light', 'dark'])(
      'tema %s: anel de foco de "Novo evento" sobre o fundo da página com pelo menos 3:1',
      async (scheme) => {
        await open(paths.events, 'Eventos', scheme);
        await expectVisibleRing(
          screen.getByRole('button', { name: 'Novo evento' }),
          `o fundo da página no tema ${SCHEME_LABEL[scheme]}`,
        );
      },
    );

    it.each<Scheme>(['light', 'dark'])(
      'tema %s: texto do botão preenchido "Novo evento" com pelo menos 4,5:1',
      async (scheme) => {
        await open(paths.events, 'Eventos', scheme);
        const button = screen.getByRole('button', { name: 'Novo evento' });
        const styles = await Styles.now();
        // Filled: the button paints its own background.
        expect(styles.backgroundOwner(button)).toBe(button);
        expectContrast(
          `texto do botão preenchido no tema ${SCHEME_LABEL[scheme]}`,
          styles.textColor(button),
          styles.background(button),
          MIN_TEXT,
        );
      },
    );
  });
});
