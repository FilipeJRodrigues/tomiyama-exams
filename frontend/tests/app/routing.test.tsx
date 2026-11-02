import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderApp } from '../render';

describe('protected routes', () => {
  it('send a signed-out user to the login', async () => {
    const { router } = await renderApp({ route: '/faixas' });
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/entrar');
    // The original path travels in router state, never in the URL.
    expect(router.state.location.search).toBe('');
  });

  it('open the students list from the root', async () => {
    const { router } = await renderApp({ route: '/', signedInAs: 'examiner' });
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/alunos');
  });

  it('tell a guardian that examiner areas are not theirs', async () => {
    const { user, router } = await renderApp({ route: '/faixas', signedInAs: 'guardian' });
    expect(
      await screen.findByRole('heading', { name: 'Esta área é dos examinadores' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Meus alunos' }));
    expect(router.state.location.pathname).toBe('/alunos');
  });

  it('show examiner areas to examiners', async () => {
    await renderApp({ route: '/dia-do-exame', signedInAs: 'examiner' });
    expect(
      await screen.findByRole('heading', { name: 'Dia do exame', level: 1 }),
    ).toBeInTheDocument();
  });

  it('show a not-found page for unknown paths', async () => {
    await renderApp({ route: '/nao-existe', signedInAs: 'examiner' });
    expect(
      await screen.findByRole('heading', { name: 'Página não encontrada' }),
    ).toBeInTheDocument();
  });
});
