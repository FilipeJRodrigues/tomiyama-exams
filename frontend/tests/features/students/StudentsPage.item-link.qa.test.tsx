/**
 * Cobertura do qa-frontend no card #184 (o item inteiro do aluno abre o aluno, § 6.2): o que
 * `StudentsPage.item-link.test.tsx` não confere.
 *
 * - Nada dentro do item cria camada própria sobre a área esticada do nome. Um elemento com
 *   `opacity` abaixo de 1, `transform`, `filter`, `will-change`, `isolation`, `mix-blend-mode`
 *   ou `contain: paint` é pintado na mesma camada do `::after` posicionado. Se vier depois do
 *   nome, fica por cima dele e engole o clique naquele ponto, mesmo sem `position`.
 * - O responsável vê a mesma lista, só com os próprios alunos: um link por aluno, com a mesma
 *   área esticada.
 *
 * O clique de verdade foi medido no Edge 157 sem janela (2026-11-19):
 * - teste de acerto numa grade de pontos de cada item, nos dois temas, a 390, 640 (zoom de
 *   200%), 768 (também com a tabela rolada até o fim) e 1280 px: 0 erros em 2.988 pontos;
 * - fica de fora só a borda de 1 px do cartão;
 * - com o perfil de responsável, a 390 e a 1280 px: 0 erros.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Styles, loadStyles } from '../../computedCss';
import { installMockApi } from '../../msw-server';
import { renderApp } from '../../render';
import { resetViewport, setViewportWidth } from '../../viewport';

const LAYOUTS = [
  { layout: 'cartões', width: 390 },
  { layout: 'tabela', width: 1280 },
] as const;

/** Properties that put an element in the layer of the positioned `::after` (or above it). */
const LAYER_PROPS = [
  'opacity',
  'transform',
  'translate',
  'rotate',
  'scale',
  'filter',
  'backdrop-filter',
  'will-change',
  'isolation',
  'mix-blend-mode',
  'contain',
  'z-index',
] as const;

/** Whether the winning value of the property makes a layer of its own. */
function makesLayer(prop: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  switch (prop) {
    case 'opacity':
      return Number.parseFloat(v) < 1 || v.endsWith('%');
    case 'isolation':
      return v === 'isolate';
    case 'mix-blend-mode':
      return v !== 'normal';
    case 'contain':
      return /paint|layout|strict|content/.test(v);
    case 'will-change':
      return /opacity|transform|translate|rotate|scale|filter/.test(v);
    case 'z-index':
      // Only counts on a positioned element, which the other test already rules out.
      return false;
    default:
      return v !== 'none' && v !== 'auto' && v !== 'initial' && v !== 'unset';
  }
}

async function studentItems(layout: 'cartões' | 'tabela'): Promise<HTMLElement[]> {
  if (layout === 'cartões') {
    const list = await screen.findByRole('list', { name: 'Alunos' });
    return within(list).getAllByRole('listitem');
  }
  const table = await screen.findByRole('table', { name: 'Alunos' });
  return within(table).getAllByRole('row').slice(1);
}

describe('item inteiro do aluno abre o aluno: cobertura do QA (#184, § 6.2)', () => {
  beforeAll(loadStyles);

  afterEach(() => {
    resetViewport();
  });

  describe.each(LAYOUTS)('$layout a $width px', ({ layout, width }) => {
    it('nada dentro do item cria camada sobre a área esticada do nome', async () => {
      installMockApi();
      setViewportWidth(width);
      await renderApp({ route: '/alunos', signedInAs: 'examiner' });
      await screen.findByRole('heading', { name: 'Alunos', level: 1 });
      const items = await studentItems(layout);
      expect(items.length).toBeGreaterThan(0);
      const styles = await Styles.now();
      for (const item of items) {
        const name = within(item).getByRole('link').textContent.trim();
        for (const element of item.querySelectorAll('*')) {
          for (const prop of LAYER_PROPS) {
            const winner = styles.declared(element, [prop]);
            if (winner === null) continue;
            const value = styles.resolve(element, winner.value);
            expect(
              makesLayer(prop, value),
              `<${element.tagName.toLowerCase()}> no item de ${name}: ${prop}: ${value}`,
            ).toBe(false);
          }
        }
      }
    });

    it('o responsável vê só os próprios alunos, cada um com um link e a área esticada', async () => {
      installMockApi();
      setViewportWidth(width);
      await renderApp({ route: '/alunos', signedInAs: 'guardian' });
      await screen.findByRole('heading', { name: 'Alunos', level: 1 });
      const items = await studentItems(layout);
      expect(items.length).toBeGreaterThan(0);
      const styles = await Styles.now();
      for (const item of items) {
        const links = within(item).getAllByRole('link');
        expect(links).toHaveLength(1);
        const link = links[0]!;
        expect(link).toHaveAttribute('href', expect.stringMatching(/^\/alunos\/[^/]+$/));
        expect(link).toHaveAccessibleName(link.textContent.trim());
        expect(item).not.toHaveAttribute('role');
        expect(item).not.toHaveAttribute('tabindex');
        expect(styles.declared(link, ['position'], { pseudo: '::after' })?.value).toBe('absolute');
        expect(styles.declared(link, ['inset'], { pseudo: '::after' })?.value).toBe('0');
        expect(styles.declared(item, ['position'])?.value).toBe('relative');
      }
    });
  });
});
