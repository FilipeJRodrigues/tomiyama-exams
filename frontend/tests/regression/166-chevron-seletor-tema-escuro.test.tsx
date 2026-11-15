/**
 * Erro: no tema escuro (o padrão da primeira visita desde o #166), a seta dos seletores
 * (`NativeSelect`: "Faixa" e "Tipo" em Requisitos, "Evento" no Dia do exame) sai em dark.3
 * `#696969` sobre o fundo do campo `#2A2A2A` (dark.6): 2,61:1. É o que mostra que o campo
 * abre uma lista. A paleta `dark` agora é do tema (`theme.ts`), que trata o dark.3 só como
 * placeholder; o Mantine pinta a seta com ele (`--_combobox-chevron-color`).
 * Esperado: indicador com pelo menos 3:1 contra o fundo do campo, nos dois temas (§ 6.7;
 * skill `tomiyama-design`, "Contraste conferido nos dois temas"). No claro, gray.6 sobre
 * branco dá 3,32:1 e já passa.
 * Issue: #166
 *
 * Medido na tela montada, com a regra que vence a cascata (`tests/computedCss.ts`): vale
 * qualquer correção (tom da paleta, `--combobox-chevron-color` no tema, CSS do app).
 */
import { screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { COLOR_SCHEME_KEY } from '../../src/app/theme';
import { Styles, expectContrast, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';

type Scheme = 'light' | 'dark';

const MIN_INDICATOR = 3;

const SCREENS = [
  { route: paths.requirements, title: 'Requisitos', selects: ['Faixa', 'Tipo'] },
  { route: paths.examDay, title: 'Dia do exame', selects: ['Evento'] },
] as const;

beforeAll(loadStyles);

describe.each<Scheme>(['light', 'dark'])('seta dos seletores no tema %s (#166)', (scheme) => {
  beforeEach(() => {
    installMockApi();
    window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  });

  it.each(SCREENS)('$title: seta com pelo menos 3:1 sobre o campo', async (target) => {
    await renderApp({ route: target.route, signedInAs: 'examiner' });
    await screen.findByRole('heading', { name: target.title, level: 1 });
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
    for (const label of target.selects) {
      const select = await screen.findByRole('combobox', { name: label }, { timeout: 10000 });
      const chevron = select
        .closest('.mantine-Input-wrapper')
        ?.querySelector('.mantine-ComboboxChevron-chevron');
      if (!chevron) throw new Error(`O seletor "${label}" deveria ter a seta.`);
      const styles = await Styles.now();
      // The arrow is drawn inside the field, over the field's own background.
      expectContrast(
        `seta do seletor "${label}" sobre o campo`,
        styles.textColor(chevron),
        styles.background(select),
        MIN_INDICATOR,
      );
    }
  });
});
