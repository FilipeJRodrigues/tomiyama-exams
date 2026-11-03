/**
 * Erro: no diálogo "Editar faixa" (§ 6.5), um clique duplo em "Salvar" (ou Enter duas
 * vezes num campo) envia dois `PUT /belts/{id}`. A trava do formulário depende de
 * `update.isPending`, que só chega ao componente na renderização seguinte; o segundo envio
 * passa antes dela.
 * Esperado: um único PUT por envio, como nos formulários de aluno (StudentEditPage usa uma
 * trava síncrona) e na confirmação de presença (rn005, clique duplo = uma requisição).
 * Issue: #25
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, delay } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const BELTS_URL = `${TEST_API_URL}/belts`;

function countPuts(): { count: number } {
  const counter = { count: 0 };
  server.use(
    http.put(`${BELTS_URL}/:id`, async () => {
      counter.count += 1;
      await delay(50);
      return undefined;
    }),
  );
  return counter;
}

async function openCinza(): Promise<{ user: UserEvent; dialog: HTMLElement }> {
  const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
  await screen.findByRole('table', { name: 'Faixas' });
  await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza' }));
  const dialog = await screen.findByRole('dialog', { name: 'Editar faixa Cinza' });
  return { user, dialog };
}

describe('faixas: envio duplo do diálogo de edição', () => {
  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  it('envia um só PUT com clique duplo em "Salvar"', async () => {
    const puts = countPuts();
    const { user, dialog } = await openCinza();
    await user.dblClick(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza salva.');
    expect(puts.count).toBe(1);
  });

  it('envia um só PUT com Enter duas vezes num campo', async () => {
    const puts = countPuts();
    const { user, dialog } = await openCinza();
    await user.click(within(dialog).getByLabelText(/^Nome/));
    await user.keyboard('{Enter}{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts.count).toBe(1);
  });
});
