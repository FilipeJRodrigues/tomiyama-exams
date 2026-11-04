/**
 * Erro: depois de salvar um aluno, a lista de alunos mostra o aviso "Alterações salvas." (que
 * chega pelo `location.state`) com o botão "Fechar aviso". Ao fechar o aviso pelo teclado
 * (Enter no botão), o botão some junto com o aviso e o foco cai no `body`: quem usa teclado ou
 * leitor de tela volta para o topo da página.
 * Esperado: o foco vai para o título da tela ("Alunos"), pela regra única de foco
 * (`focusIfLost`), como nas telas Faixas, Eventos, Requisitos e Academia (§ 6.2, § 6.7).
 * Issue: #52
 */
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const TITLE = 'Alunos';

/** Where the focus is, in a short form for the failure message (`body` when lost). */
function focusedElement(): string {
  const active = document.activeElement;
  if (active === null || active === document.body) return 'body';
  const name = active.getAttribute('aria-label') ?? active.textContent.trim();
  return `${active.tagName.toLowerCase()} "${name}"`;
}

beforeEach(() => {
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
});

it('aviso "Alterações salvas." da lista: ao fechar, o foco vai para o título', async () => {
  const { user, router } = await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
  expect(await screen.findByLabelText(/^Nome/)).toHaveValue('Ana Souza');
  await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

  const notice = (await screen.findByText('Alterações salvas.')).closest<HTMLElement>(
    '[role="status"]',
  )!;
  expect(router.state.location.pathname).toBe('/alunos');
  await screen.findByRole('table', { name: 'Alunos' });

  within(notice).getByRole('button', { name: 'Fechar aviso' }).focus();
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(screen.queryByText('Alterações salvas.')).not.toBeInTheDocument();
  });

  await waitFor(
    () => {
      expect(focusedElement()).toBe(`h1 "${TITLE}"`);
      expect(screen.getByRole('heading', { level: 1, name: TITLE })).toHaveFocus();
    },
    { timeout: 1500 },
  );
});
