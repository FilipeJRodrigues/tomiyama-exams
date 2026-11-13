/**
 * Erro: na tela Faixas (§ 6.5), o examinador comum recebe o 403 "Somente o administrador master
 * altera…" e clica em "Reler a faixa". Enquanto a releitura (`GET /belts`) está a caminho, ele
 * fecha o diálogo ("Cancelar" fica habilitado), abre outra faixa e clica em "Salvar". Quando a
 * releitura antiga chega, `rereadBelt` (BeltsPage) chama `update.reset()` sem conferir se o
 * diálogo ainda é o da releitura: o PUT da outra faixa, já a caminho, perde o retorno
 * (`onSuccess`/`onError` do `mutate` não rodam mais). O PUT grava, mas o diálogo não fecha, o
 * aviso "Faixa … salva." não aparece e a trava de envio (`useSendLock`) fica presa: "Salvar",
 * "Cancelar" e Esc não fazem mais nada até recarregar a página.
 * Esperado: a releitura de um diálogo que já fechou não mexe no envio de outro; o PUT da outra
 * faixa termina como sempre (diálogo fecha, aviso de salvo).
 * Issue: #143
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb, mockBelts, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const BELTS_URL = `${TEST_API_URL}/belts`;
const CINZA_AZUL = mockBelts.find((belt) => belt.name === 'Cinza/Azul')!;

let db: MockDb;

/** A gate the test opens: requests that pass by it while `holding` wait for `open()`. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    holding: false,
    waiting: 0,
    opened,
    open: () => {
      open();
    },
  };
}

describe('faixas: releitura atrasada de um diálogo fechado (#143)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('não solta o PUT de outra faixa salva enquanto a releitura estava a caminho', async () => {
    const getGate = gate();
    const putGate = gate();
    server.use(
      http.get(BELTS_URL, async () => {
        if (getGate.holding) {
          getGate.holding = false;
          getGate.waiting += 1;
          await getGate.opened;
        }
        return undefined;
      }),
      http.put(`${BELTS_URL}/:id`, async () => {
        if (putGate.holding) {
          putGate.holding = false;
          putGate.waiting += 1;
          await putGate.opened;
        }
        return undefined;
      }),
    );

    const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    await screen.findByRole('table', { name: 'Faixas' });
    await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza/Azul' }));
    const first = await screen.findByRole('dialog', { name: 'Editar faixa Cinza/Azul' });

    // The master renames the belt while the dialog is open: the save gets the 403.
    db.belts = db.belts.map((belt) =>
      belt.id === CINZA_AZUL.id ? { ...belt, name: 'Cinza e azul' } : belt,
    );
    await user.click(within(first).getByRole('button', { name: 'Salvar' }));
    const alert = await within(first).findByRole('alert');

    // "Reler a faixa" with the GET held, then the dialog is closed.
    getGate.holding = true;
    await user.click(within(alert).getByRole('button', { name: 'Reler a faixa' }));
    await waitFor(() => {
      expect(getGate.waiting).toBe(1);
    });
    await user.click(within(first).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Another belt, saved with its PUT held.
    await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza' }));
    const second = await screen.findByRole('dialog', { name: 'Editar faixa Cinza' });
    putGate.holding = true;
    await user.click(within(second).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(putGate.waiting).toBe(1);
    });

    // The old reread answers first, then the PUT.
    getGate.open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    putGate.open();

    // The PUT is on its way, and the dialog closes when it answers.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza salva.');
  }, 30_000);
});
