/**
 * Telas de entrada com a marca (#166, etapa 3), nas etapas seguintes de cada fluxo, que usam o
 * mesmo `AuthCard` e que o `auth-brand-area.test.tsx` não abre: a confirmação do e-mail do
 * cadastro, a nova senha da recuperação e a nova senha do primeiro acesso (§ 6.1). Em cada
 * uma, nos dois temas:
 *
 * - o fundo azul da marca no `main` (o único), com o logo "Academia Tomiyama", "Tomiyama" e
 *   "Área de exames" acima do cartão;
 * - o único `h1` é o título da etapa, dentro do cartão, na fonte de títulos (`PageTitle`);
 * - nada focável fora do cartão;
 * - nas etapas com `focusTitle`, o foco vai para o título.
 *
 * E, ao entrar, a área logada deixa o azul: o fundo da página por trás (`:root:has(.screen)`)
 * volta a ser o do tema.
 */
import { screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { BRAND_COLORS, COLOR_SCHEME_KEY, DISPLAY_FONT_FAMILY } from '../../src/app/theme';
import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_TEMPORARY_PASSWORD } from '../../src/auth/mockConstants';
import { Styles, hex, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp, type RenderAppResult } from '../render';

type Scheme = 'light' | 'dark';

const BLUE = BRAND_COLORS.blue.toLowerCase();
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

interface Step {
  name: string;
  title: string;
  focusTitle: boolean;
  reach: () => Promise<RenderAppResult>;
}

const STEPS: Step[] = [
  {
    name: 'confirmação do e-mail do cadastro',
    title: 'Confirme seu e-mail',
    focusTitle: true,
    reach: async () => {
      const app = await renderApp({ route: paths.signUp, auth: createMockAuth(null) });
      await app.user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
      await app.user.type(screen.getByLabelText(/^Senha/), 'senha-forte-1');
      await app.user.type(screen.getByLabelText(/^Confirme a senha/), 'senha-forte-1');
      await app.user.click(screen.getByRole('button', { name: 'Criar conta' }));
      return app;
    },
  },
  {
    name: 'nova senha da recuperação',
    title: 'Crie uma nova senha',
    focusTitle: true,
    reach: async () => {
      const app = await renderApp({ route: paths.forgotPassword });
      await app.user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
      await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
      return app;
    },
  },
  {
    name: 'nova senha do primeiro acesso',
    title: 'Defina uma nova senha',
    focusTitle: false,
    reach: async () => {
      const app = await renderApp({ route: paths.login });
      await app.user.type(await screen.findByLabelText(/^E-mail/), 'novo@example.com');
      await app.user.type(screen.getByLabelText(/^Senha/), MOCK_TEMPORARY_PASSWORD);
      await app.user.click(screen.getByRole('button', { name: 'Entrar' }));
      return app;
    },
  },
];

beforeAll(loadStyles);

describe.each<Scheme>(['dark', 'light'])(
  'etapas das telas de entrada, tema %s (#166)',
  (scheme) => {
    beforeEach(() => {
      installMockApi();
      window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
    });

    it.each(STEPS)(
      '$name: marca sobre o azul, um h1 no cartão, nada focável fora',
      async (step) => {
        await step.reach();
        const title = await screen.findByRole('heading', { level: 1, name: step.title });
        const main = screen.getByRole('main');
        expect(screen.getAllByRole('main')).toEqual([main]);
        expect(screen.getAllByRole('heading', { level: 1 })).toEqual([title]);

        const card = title.closest('.mantine-Paper-root');
        if (!(card instanceof HTMLElement)) throw new Error('O título deveria estar no cartão.');
        const logo = within(main).getByRole('img', { name: 'Academia Tomiyama' });
        for (const brand of [
          logo,
          within(main).getByText('Tomiyama'),
          within(main).getByText('Área de exames'),
        ]) {
          expect(card.contains(brand)).toBe(false);
        }
        expect([...main.querySelectorAll(FOCUSABLE)].filter((el) => !card.contains(el))).toEqual(
          [],
        );
        if (step.focusTitle) expect(title).toHaveFocus();

        const styles = await Styles.now();
        expect(hex(styles.background(main))).toBe(BLUE);
        expect(styles.backgroundOwner(logo)).toBe(main);
        expect(styles.declared(title, ['font-family'])?.value).toBe('var(--app-font-display)');
        expect(styles.resolve(title, 'var(--app-font-display)')).toBe(DISPLAY_FONT_FAMILY);
      },
    );

    it('ao entrar, o fundo da página por trás deixa o azul das telas de entrada', async () => {
      const { user } = await renderApp({ route: paths.login });
      let styles = await Styles.now();
      expect(hex(styles.background(document.documentElement))).toBe(BLUE);

      await user.type(await screen.findByLabelText(/^E-mail/), 'examinador@example.com');
      await user.type(screen.getByLabelText(/^Senha/), 'senha-teste');
      await user.click(screen.getByRole('button', { name: 'Entrar' }));
      await screen.findByRole('heading', { level: 1, name: 'Alunos' });

      styles = await Styles.now();
      expect(hex(styles.background(document.documentElement))).not.toBe(BLUE);
    });
  },
);
