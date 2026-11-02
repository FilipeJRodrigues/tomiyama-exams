/**
 * Erro: na lista de alunos a 1280 e a 768 px (tabela), o nome do aluno é texto puro: não há
 * caminho da lista para o formulário de edição (`/alunos/{id}`). Só os cartões (390 px e
 * zoom de 200%) têm o nome como link.
 * Esperado: na tabela, o nome de cada aluno (cabeçalho da linha) é um link para
 * `/alunos/{id}`, que abre o formulário de edição; a região rolável continua focável e os
 * links dos nomes são os únicos controles focáveis dentro dela (§ 6.2, § 6.7).
 * Issue: -
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { resetViewport, setViewportWidth } from '../viewport';

let db: MockDb;

describe('tabela de alunos leva ao formulário de edição (§ 6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetViewport();
  });

  it.each([1280, 768])('a %i px o nome de cada aluno é link para /alunos/{id}', async (width) => {
    setViewportWidth(width);
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos' });

    const visible = db.students.map((item) => item.student);
    expect(visible.length).toBeGreaterThan(0);
    for (const student of visible) {
      const header = within(table).getByRole('rowheader', { name: student.full_name });
      const link = within(header).getByRole('link', { name: student.full_name });
      expect(link).toHaveAttribute('href', `/alunos/${student.id}`);
    }
  });

  it('a 1280 px clicar no nome abre o formulário do aluno', async () => {
    const ana = db.students.find((item) => item.student.full_name === 'Ana Souza')!.student;
    const { user, router } = await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const table = await screen.findByRole('table', { name: 'Alunos' });

    await user.click(within(table).getByRole('link', { name: 'Ana Souza' }));

    expect(router.state.location.pathname).toBe(`/alunos/${ana.id}`);
    expect(await screen.findByRole('heading', { name: 'Editar aluno' })).toBeInTheDocument();
  });

  it('a 768 px o link do nome é alcançado por Tab dentro da região rolável', async () => {
    setViewportWidth(768);
    const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await screen.findByRole('table', { name: 'Alunos' });
    const region = screen.getByRole('region', { name: 'Lista de alunos' });

    let reachedLink = false;
    for (let i = 0; i < 30 && !reachedLink; i++) {
      await user.tab();
      const active = document.activeElement;
      reachedLink =
        active instanceof HTMLAnchorElement &&
        region.contains(active) &&
        /^\/alunos\/[0-9a-f-]{36}$/.test(active.getAttribute('href') ?? '');
    }
    expect(reachedLink).toBe(true);
  });
});
