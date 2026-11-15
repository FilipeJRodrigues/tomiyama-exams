/**
 * Links sempre sublinhados (#166; § 6.7, estado nunca só por cor; skill `tomiyama-design`,
 * `components.md`, "Links"). No meio de uma frase, a cor do link fica perto do texto em volta
 * (azul `#0A265F` sobre o texto preto, 1,46:1; amarelo `#FEF37B` sobre o texto `#C9C9C9`,
 * 1,44:1): sem o sublinhado em repouso, o link só se distingue pela cor. O padrão vem do
 * `Anchor.extend` do tema, para todo `Anchor`; o menu lateral (`NavLink`) não muda, porque já
 * marca o item ativo com a barra e o negrito.
 *
 * Medido na tela montada, com a regra que vence a cascata (`tests/computedCss.ts`), sem hover.
 */
import { screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { examPath, paths } from '../../src/app/navigation';
import { COLOR_SCHEME_KEY } from '../../src/app/theme';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { Styles, loadStyles } from '../computedCss';
import { installMockApi, server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

type Scheme = 'light' | 'dark';

/** A student of the showcase data, present in the closed event. */
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';

/** The `text-decoration` that wins the cascade on the element, at rest. */
async function decoration(element: Element): Promise<string> {
  const styles = await Styles.now();
  const winner = styles.declared(element, ['text-decoration', 'text-decoration-line']);
  if (winner === null) throw new Error('Nenhum text-decoration nas folhas de estilo.');
  return styles.resolve(element, winner.value);
}

async function expectUnderlined(link: HTMLElement): Promise<void> {
  expect(await decoration(link), `link "${link.textContent}" sublinhado em repouso`).toMatch(
    /\bunderline\b/,
  );
}

beforeAll(loadStyles);

describe.each<Scheme>(['light', 'dark'])('links sublinhados no tema %s (#166)', (scheme) => {
  beforeEach(() => {
    installMockApi();
    window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  });

  it('entrar: "Cadastre-se" no meio da frase e "Esqueci minha senha"', async () => {
    await renderApp({ route: paths.login });
    await screen.findByRole('heading', { name: 'Entrar', level: 1 });
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
    await expectUnderlined(screen.getByRole('link', { name: 'Cadastre-se' }));
    await expectUnderlined(screen.getByRole('link', { name: 'Esqueci minha senha' }));
  });

  it('cadastro: "Entrar" no meio da frase', async () => {
    await renderApp({ route: paths.signUp });
    await screen.findByRole('heading', { name: 'Cadastre-se', level: 1 });
    await expectUnderlined(screen.getByRole('link', { name: 'Entrar' }));
  });

  it('área dos examinadores aberta pelo responsável: "Meus alunos"', async () => {
    await renderApp({ route: paths.requirements, signedInAs: 'guardian' });
    await screen.findByRole('heading', { name: 'Esta área é dos examinadores', level: 1 });
    await expectUnderlined(screen.getByRole('link', { name: 'Meus alunos' }));
  });

  it('exame do aluno: "Dia do exame" na trilha; o menu lateral fica sem sublinhado', async () => {
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
    await renderApp({
      route: examPath(MOCK_EVENT_IDS.closed, ELIDA),
      signedInAs: 'examiner',
    });
    await screen.findByRole('heading', { name: 'Élida Ramos', level: 1 });
    const trail = screen.getByRole('navigation', { name: 'Caminho' });
    await expectUnderlined(within(trail).getByRole('link', { name: 'Dia do exame' }));

    // NavLink, not Anchor: the active item is marked by the bar and the bold text.
    const menu = screen.getByRole('navigation', { name: 'Menu principal' });
    const item = within(menu).getByRole('link', { name: 'Dia do exame' });
    expect(item).not.toHaveAttribute('data-underline');
    expect(await decoration(item)).not.toMatch(/\bunderline\b/);
  });
});
