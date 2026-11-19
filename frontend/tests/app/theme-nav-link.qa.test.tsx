/**
 * Cobertura do qa-frontend na etapa 2 do #166 (skill `tomiyama-design`, `components.md`,
 * "Cabeçalho e menu lateral"; § 6.7), além de `theme-nav-link.test.tsx`:
 *
 * - o item ativo pelo `active` do Mantine (`data-active`, sem `aria-current`) tem o mesmo
 *   visual do ativo pela rota: cor principal, negrito, barra e nenhum fundo próprio;
 * - um `NavLink` com `color` próprio fica com as cores do Mantine (fundo `light`), e a barra e
 *   o texto continuam legíveis sobre ele, em repouso e em hover (hoje nenhum existe no app);
 * - rotas filhas acendem o item do pai ("Alunos" em `/alunos/novo`, "Dia do exame" no exame
 *   do aluno), sempre um único item ativo, e o responsável vê o mesmo visual em "Alunos".
 *
 * No Edge (1280, 640 e 390 px, nos dois temas) o que se mediu foi o mesmo: ativo 11,73:1 no
 * menu e 9,16:1 no hover (amarelo), 14,43:1 e 13,69:1 (azul), barra de 4 px, rótulo no mesmo
 * lugar dos outros itens e anel de foco de 2 px a 2 px do item, sem recorte.
 */
import { MantineProvider, NavLink } from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import { render, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { examPath, paths } from '../../src/app/navigation';
import { BRAND_COLORS, COLOR_SCHEME_KEY, mantineProviderProps } from '../../src/app/theme';
import { MOCK_EVENT_IDS } from '../../src/mocks/data';
import { Styles, expectContrast, hex, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';

type Scheme = 'light' | 'dark';

/** Present at the open event (mock data). */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

const PRIMARY: Record<Scheme, string> = {
  light: BRAND_COLORS.blue.toLowerCase(),
  dark: BRAND_COLORS.yellow.toLowerCase(),
};

/** A property that inherits: the value on the element or on its nearest ancestor. */
function inherited(styles: Styles, target: Element, prop: string): string | null {
  for (let current: Element | null = target; current; current = current.parentElement) {
    const winner = styles.declared(current, [prop]);
    if (winner) return styles.resolve(current, winner.value);
  }
  return null;
}

/** Width in px and color of the bar on the left edge, or null when there is none. */
function leftBar(styles: Styles, item: Element): { width: number; color: string } | null {
  const winner = styles.declared(item, ['border-inline-start', 'border-left']);
  if (winner === null) return null;
  const value = styles.resolve(item, winner.value);
  if (/^(0|none)\b/.test(value)) return null;
  const rem = /([\d.]+)rem/.exec(value);
  const color = /#[0-9a-f]{6}\b/i.exec(value);
  if (!rem || !color) throw new Error(`Barra não reconhecida: "${value}"`);
  return { width: Number(rem[1]) * 16, color: color[0].toLowerCase() };
}

function rgbOf(color: string): readonly [number, number, number] {
  const digits = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!digits) throw new Error(`Cor não reconhecida: ${color}`);
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
}

function label(item: HTMLElement): HTMLElement {
  const found = item.querySelector('.mantine-NavLink-label');
  if (!(found instanceof HTMLElement)) throw new Error('O item deveria ter o rótulo.');
  return found;
}

function renderMenu() {
  return render(
    <MantineProvider {...mantineProviderProps}>
      <nav aria-label="Menu de teste">
        <NavLink
          href="#ativo"
          label="Ativo pelo Mantine"
          active
          leftSection={<IconUsers size={20} aria-hidden />}
        />
        <NavLink href="#outro" label="Outro" leftSection={<IconUsers size={20} aria-hidden />} />
        <NavLink
          href="#cor"
          label="Com cor própria"
          color="red"
          active
          leftSection={<IconUsers size={20} aria-hidden />}
        />
      </nav>
    </MantineProvider>,
  );
}

beforeAll(loadStyles);

describe.each<Scheme>(['light', 'dark'])('NavLink fora da rota, tema %s (#166)', (scheme) => {
  beforeEach(() => {
    window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  });

  it('`active` do Mantine: cor principal, negrito, barra e nenhum fundo próprio', async () => {
    renderMenu();
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
    const item = screen.getByRole('link', { name: 'Ativo pelo Mantine' });
    expect(item).toHaveAttribute('data-active');
    expect(item).not.toHaveAttribute('aria-current');
    const styles = await Styles.now();
    expect(hex(styles.textColor(label(item)))).toBe(PRIMARY[scheme]);
    expect(inherited(styles, label(item), 'font-weight')).toBe('700');
    expect(styles.backgroundOwner(item)).not.toBe(item);
    const bar = leftBar(styles, item);
    expect(bar?.color).toBe(PRIMARY[scheme]);
    expect(bar?.width).toBe(4);

    const other = screen.getByRole('link', { name: 'Outro' });
    const atRest = hex(styles.background(item));
    const otherHover = (await Styles.now({ hover: other })).background(other);
    const hovered = await Styles.now({ hover: item });
    // The hover shows (it is not the background at rest) and is the one of the other items.
    expect(hex(otherHover)).not.toBe(atRest);
    expect(hex(hovered.background(item))).toBe(hex(otherHover));
    expectContrast(
      'texto do ativo (Mantine) em hover',
      hovered.textColor(label(item)),
      hovered.background(item),
      4.5,
    );
  });

  it('`color` próprio: fundo do Mantine, e texto e barra legíveis sobre ele', async () => {
    renderMenu();
    const item = screen.getByRole('link', { name: 'Com cor própria' });
    const backgrounds: string[] = [];
    for (const hover of [undefined, item]) {
      const styles = await Styles.now(hover ? { hover } : {});
      const background = styles.background(item);
      backgrounds.push(hex(background));
      const what = hover ? 'em hover' : 'em repouso';
      expect(styles.backgroundOwner(item), `fundo próprio ${what}`).toBe(item);
      expectContrast(`texto ${what}`, styles.textColor(label(item)), background, 4.5);
      const bar = leftBar(styles, item);
      expect(bar?.width).toBe(4);
      expectContrast(`barra ${what}`, rgbOf(bar?.color ?? ''), background, 3);
    }
    // Mantine's `light` background at rest and its darker tone on hover.
    expect(backgrounds[1]).not.toBe(backgrounds[0]);
  });
});

describe('item ativo nas rotas filhas e no perfil responsável (#166)', () => {
  beforeEach(() => {
    installMockApi();
    window.localStorage.setItem(COLOR_SCHEME_KEY, 'dark');
  });

  it.each([
    ['examiner', paths.studentNew, 'Alunos'],
    ['examiner', examPath(MOCK_EVENT_IDS.open, HELENA), 'Dia do exame'],
    ['guardian', paths.students, 'Alunos'],
  ] as const)('%s em %s: só "%s" ativo, com barra e negrito', async (role, route, name) => {
    await renderApp({ route, signedInAs: role });
    const nav = await screen.findByRole('navigation', { name: 'Menu principal' });
    await screen.findByRole('heading', { level: 1 });
    const current = within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent)).toEqual([name]);
    const item = current[0] as HTMLElement;
    const styles = await Styles.now();
    expect(hex(styles.textColor(label(item)))).toBe(PRIMARY.dark);
    expect(inherited(styles, label(item), 'font-weight')).toBe('700');
    expect(leftBar(styles, item)?.color).toBe(PRIMARY.dark);
  });
});
