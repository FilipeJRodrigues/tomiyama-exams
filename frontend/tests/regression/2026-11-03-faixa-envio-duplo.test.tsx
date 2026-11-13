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
import { http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const BELTS_URL = `${TEST_API_URL}/belts`;

/** Counts the PUTs; they wait, on their way, until the test calls `release`. */
function countPuts(): { count: number; release: () => void } {
  let open: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  const counter = {
    count: 0,
    release: () => {
      open();
    },
  };
  server.use(
    http.put(`${BELTS_URL}/:id`, async () => {
      counter.count += 1;
      await held;
      return undefined;
    }),
  );
  return counter;
}

/** The first PUT is on its way and no second one was sent: let it answer. */
async function releaseTheOnePut(puts: { count: number; release: () => void }) {
  await waitFor(() => {
    expect(puts.count).toBe(1);
  });
  expect(screen.getByRole('dialog', { name: 'Editar faixa Cinza' })).toBeInTheDocument();
  puts.release();
}

async function openCinza(): Promise<{ user: UserEvent; dialog: HTMLElement }> {
  // Enter in the Nome field: a field only for the admin master (#143).
  const { user } = await renderApp({ route: '/faixas', signedInAs: 'master' });
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
    await releaseTheOnePut(puts);

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
    await releaseTheOnePut(puts);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts.count).toBe(1);
  });
});
