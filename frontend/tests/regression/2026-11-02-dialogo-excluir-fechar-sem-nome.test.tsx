/**
 * Erro: no diálogo "Excluir aluno" (`Modal` do Mantine), o botão de fechar (o "X" no
 * canto) é alcançado por Tab, mas não tem nome acessível: o leitor de tela anuncia só
 * "botão". O `Modal` não recebe `closeButtonProps={{ 'aria-label': … }}`.
 * Esperado: todo controle alcançável por Tab tem rótulo em pt-BR (§ 6.7), por exemplo
 * "Fechar"; ou o diálogo não tem o "X" e fecha por "Cancelar" e `Esc`.
 * Issue: -
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

/** Guardian's student without exams. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';

describe('diálogo de exclusão de aluno (§ 6.2, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('todo botão do diálogo tem nome acessível', async () => {
    const { user } = await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
    await user.click(await screen.findByRole('button', { name: 'Excluir aluno' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir aluno' });

    const unnamed = within(dialog)
      .getAllByRole('button')
      .filter((button) => !button.getAttribute('aria-label') && !button.textContent.trim());
    expect(unnamed.map((button) => button.className)).toEqual([]);
  });
});
