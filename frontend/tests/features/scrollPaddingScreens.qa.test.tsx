/**
 * Cobertura do #65 (§ 6.5, § 6.7): o desconto do cabeçalho fixo (`scroll-padding-top` na
 * raiz) de Faixas, Requisitos e Eventos vale em todos os estados da tela, não só com a
 * lista carregada, e acompanha a navegação: continua ao trocar entre essas telas pelo menu
 * e continua em Alunos (#102).
 *
 * `65-foco-escondido-sob-cabecalho.test.tsx` confere a tela carregada e a saída pelo "Sair".
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { TEST_API_URL, installMockApi, server } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

const SCREENS = [
  { route: paths.belts, title: 'Faixas', api: '/belts' },
  { route: paths.requirements, title: 'Requisitos', api: '/belts' },
  { route: paths.events, title: 'Eventos', api: '/events' },
] as const;

function scrollPaddingTop(): string {
  return document.documentElement.style.scrollPaddingTop;
}

describe('#65 desconto do cabeçalho fixo nos estados e na navegação (§ 6.5, § 6.7)', () => {
  beforeEach(() => {
    installMockApi();
    setViewportWidth(1280);
  });

  it.each(SCREENS)('$route: vale com erro de carga ("Tentar de novo")', async (screenCase) => {
    server.use(
      http.get(`${TEST_API_URL}${screenCase.api}`, () =>
        HttpResponse.json({ message: 'Sistema ocupado no momento.' }, { status: 503 }),
      ),
    );
    await renderApp({ route: screenCase.route, signedInAs: 'examiner' });

    const alert = await screen.findByRole('alert', {}, { timeout: 10000 });
    expect(within(alert).getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
    expect(scrollPaddingTop()).not.toBe('');
  });

  it.each(SCREENS)('$route: vale enquanto a tela carrega', async (screenCase) => {
    server.use(http.get(`${TEST_API_URL}${screenCase.api}`, () => new Promise<never>(() => {})));
    await renderApp({ route: screenCase.route, signedInAs: 'examiner' });

    expect(await screen.findByRole('status')).toHaveTextContent(/^Carregando/);
    expect(scrollPaddingTop()).not.toBe('');
  });

  it('continua ao trocar entre as três telas pelo menu e continua em Alunos', async () => {
    const { user } = await renderApp({ route: paths.requirements, signedInAs: 'examiner' });
    await screen.findByRole('heading', { name: 'Requisitos', level: 1 });
    await waitFor(() => {
      expect(scrollPaddingTop()).not.toBe('');
    });
    const value = scrollPaddingTop();

    for (const title of ['Eventos', 'Faixas', 'Requisitos']) {
      await user.click(screen.getByRole('link', { name: title }));
      await screen.findByRole('heading', { name: title, level: 1 });
      expect(scrollPaddingTop()).toBe(value);
    }

    await user.click(screen.getByRole('link', { name: 'Alunos' }));
    await screen.findByRole('heading', { name: 'Alunos', level: 1 });
    await waitFor(() => {
      expect(scrollPaddingTop()).toBe(value);
    });
  });
});
