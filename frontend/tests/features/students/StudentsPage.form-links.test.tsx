/**
 * Ways from the students list (§ 6.2) to the form: "Novo aluno" for every profile and the
 * student name on the cards (narrow layout).
 */
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';

describe('students list links to the form (§ 6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['examiner', 'guardian'] as const)(
    '"Novo aluno" opens the empty form for the %s',
    async (role) => {
      const { user, router } = await renderApp({ route: '/alunos', signedInAs: role });
      await screen.findByRole('table', { name: 'Alunos' });
      await user.click(screen.getByRole('link', { name: 'Novo aluno' }));
      expect(router.state.location.pathname).toBe('/alunos/novo');
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Novo aluno' }),
      ).toBeInTheDocument();
    },
  );

  it('offers "Novo aluno" on the empty list too', async () => {
    server.use(http.get(`${TEST_API_URL}/students`, () => HttpResponse.json([])));
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    expect(await screen.findByText('Nenhum aluno cadastrado.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Novo aluno' })).toHaveAttribute(
      'href',
      '/alunos/novo',
    );
  });

  it('keeps "Novo aluno" when the list fails to load', async () => {
    server.use(
      http.get(`${TEST_API_URL}/students`, () =>
        HttpResponse.json({ message: 'Requisição inválida' }, { status: 400 }),
      ),
    );
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    await screen.findByRole('alert');
    expect(screen.getByRole('link', { name: 'Novo aluno' })).toBeInTheDocument();
  });

  it.each([390, 640])('the card name opens the edit form at %i px', async (width) => {
    setViewportWidth(width);
    const { user, router } = await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const list = await screen.findByRole('list', { name: 'Alunos' });
    const links = within(list).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Ana Souza', 'Bruno Souza']);

    await user.click(within(list).getByRole('link', { name: 'Ana Souza' }));
    expect(router.state.location.pathname).toBe(`/alunos/${ANA}`);
    expect(await screen.findByLabelText(/^Nome/)).toHaveValue('Ana Souza');
  });

  it('keeps the student name out of the URL and the router state', async () => {
    setViewportWidth(390);
    const { user, router } = await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const list = await screen.findByRole('list', { name: 'Alunos' });
    await user.click(within(list).getByRole('link', { name: 'Ana Souza' }));
    await screen.findByLabelText(/^Nome/);
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await screen.findByRole('status');
    const { pathname, search } = router.state.location;
    const state: unknown = router.state.location.state;
    expect(`${pathname}${search}${JSON.stringify(state)}`).not.toMatch(/Ana|Souza/);
    expect(window.localStorage.length).toBe(0);
  });
});
