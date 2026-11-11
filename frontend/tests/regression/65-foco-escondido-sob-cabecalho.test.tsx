/**
 * Erro: nas telas do § 6.5 (Faixas, Requisitos, Eventos), ao voltar pelo teclado com
 * Shift+Tab, o controle que recebe o foco fica inteiro sob o cabeçalho fixo: em /requisitos
 * (1280 e 768 px) o botão focado some atrás do cabeçalho, e em /eventos com zoom de 200%
 * acontece o mesmo com "Novo evento". Essas telas não definem `scroll-padding-top` na
 * página, então o navegador rola o alvo do foco até a borda de cima da janela, que o
 * cabeçalho cobre. Na tela de exame, que define o valor, não acontece.
 * Esperado: foco sempre visível (§ 6.7): enquanto uma dessas telas está aberta, a página tem
 * `scroll-padding-top` que desconta o cabeçalho fixo; ao sair da tela, o valor volta a ''
 * (a tela de entrada não tem cabeçalho fixo, e `ExamLayoutChange.qa.test.tsx` espera '' ao
 * sair do exame).
 * Issue: #65
 *
 * jsdom não faz layout nem rola a página, então o teste confere a causa (o valor na raiz do
 * documento), como o teste da tela de exame; a medição do foco é a do navegador real.
 */
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

const SCREENS = [
  { route: paths.belts, title: 'Faixas' },
  { route: paths.requirements, title: 'Requisitos' },
  { route: paths.events, title: 'Eventos' },
] as const;

/** 1280: desktop. 390: celular, e o que o desktop mostra com zoom de 200% ou mais. */
const WIDTHS = [1280, 390] as const;

function scrollPaddingTop(): string {
  return document.documentElement.style.scrollPaddingTop;
}

async function open(route: string, title: string, width: number) {
  setViewportWidth(width);
  const rendered = await renderApp({ route, signedInAs: 'examiner' });
  await screen.findByRole('heading', { name: title, level: 1 });
  return rendered;
}

describe('#65 foco escondido sob o cabeçalho fixo (§ 6.5, § 6.7)', () => {
  beforeEach(() => {
    installMockApi();
  });

  describe.each(SCREENS)('$route', ({ route, title }) => {
    it.each(WIDTHS)(
      'a página desconta o cabeçalho fixo ao rolar até o foco, a %i px',
      async (width) => {
        await open(route, title, width);

        // The value is set when the screen mounts; a short wait is enough.
        await waitFor(
          () => {
            expect(
              scrollPaddingTop(),
              `${route} a ${width} px: scroll-padding-top da página é '${scrollPaddingTop()}'; ` +
                'sem ele o controle focado com Shift+Tab fica sob o cabeçalho fixo',
            ).not.toBe('');
          },
          { timeout: 1000 },
        );
      },
    );

    // Guarda: passa hoje e tem de continuar passando depois da correção.
    it('ao sair da tela, o scroll-padding-top da página volta a vazio', async () => {
      const { user } = await open(route, title, 1280);

      await user.click(screen.getByRole('button', { name: 'Sair' }));
      await screen.findByRole('heading', { name: 'Entrar' });

      await waitFor(() => {
        expect(scrollPaddingTop()).toBe('');
      });
    });
  });
});
