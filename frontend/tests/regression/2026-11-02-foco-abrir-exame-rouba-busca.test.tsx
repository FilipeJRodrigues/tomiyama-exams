/**
 * Erro: depois de confirmar a presença de Ana Souza, o link "Abrir exame de Ana Souza"
 * puxava o foco toda vez que a linha voltava a ser montada (enquanto o aviso "Presença de
 * Ana Souza confirmada." estava na tela). Ao digitar na busca um texto sem resultado e
 * apagar, ou ao trocar de filtro (Bloqueados → Presentes), o foco saltava para o link e as
 * teclas seguintes iam parar nele: digitar "zz", Backspace, Backspace, "an" deixava "z" na
 * busca.
 * Esperado: o foco vai para "Abrir exame" só logo após a confirmação; depois disso fica
 * onde o usuário está (§ 6.3, teclado em § 6.7).
 * Issue: (nenhuma; QA da tela Dia do exame, 2026-11-02)
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';

function rowOf(table: HTMLElement, name: string): HTMLElement {
  return within(table).getByRole('rowheader', { name }).closest('tr')!;
}

async function confirmAna() {
  const rendered = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
  const table = await screen.findByRole('table', { name: LIST });
  await rendered.user.click(
    within(rowOf(table, 'Ana Souza')).getByRole('button', {
      name: 'Confirmar presença de Ana Souza',
    }),
  );
  await within(rowOf(table, 'Ana Souza')).findByRole('link', {
    name: 'Abrir exame de Ana Souza',
  });
  expect(screen.getByRole('status')).toHaveTextContent('Presença de Ana Souza confirmada.');
  return rendered;
}

describe('exam day: focus after a confirmation (§ 6.3, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn005 keeps the focus in the search when the list comes back', async () => {
    const { user } = await confirmAna();
    const search = screen.getByRole('searchbox', { name: 'Buscar por nome' });
    await user.click(search);
    await user.type(search, 'zz');
    expect(screen.getByText('Nenhum aluno encontrado.')).toBeInTheDocument();

    await user.type(search, '{Backspace}{Backspace}an');

    expect(search).toHaveFocus();
    expect(search).toHaveValue('an');
  });

  it('rn005 keeps the focus on the filter when the confirmed row shows up again', async () => {
    const { user } = await confirmAna();
    const filters = screen.getByRole('radiogroup', { name: 'Filtrar alunos' });
    await user.click(within(filters).getByRole('radio', { name: /^Bloqueados/ }));
    const present = within(filters).getByRole('radio', { name: /^Presentes/ });

    await user.click(present);

    expect(present).toHaveFocus();
  });
});
