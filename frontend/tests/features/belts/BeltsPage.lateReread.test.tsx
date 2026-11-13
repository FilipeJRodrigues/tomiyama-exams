/**
 * § 6.5, #143: "Reler a faixa" whose answer comes after its dialog closed. The answer belongs
 * to a dialog that is gone, so it is dropped: the dialog open now (even of the same belt)
 * shows no reread error, no "relida" notice, and saves as usual.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const BELTS_URL = `${TEST_API_URL}/belts`;
const CINZA_AZUL = mockBelts.find((belt) => belt.name === 'Cinza/Azul')!;

let db: MockDb;

/** Holds the next request that passes while `holding`, then answers it with `answer`. */
function heldGet(answer: () => Response | undefined) {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = { holding: false, waiting: 0 };
  const handler = http.get(BELTS_URL, async () => {
    if (!state.holding) return undefined;
    state.holding = false;
    state.waiting += 1;
    await opened;
    return answer();
  });
  return {
    state,
    handler,
    open: () => {
      open();
    },
  };
}

describe('faixas: releitura que chega depois do diálogo fechar (#143)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  async function rereadThenReopenSameBelt(answer: () => Response | undefined) {
    const get = heldGet(answer);
    server.use(get.handler);
    const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    await screen.findByRole('table', { name: 'Faixas' });
    await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza/Azul' }));
    const first = await screen.findByRole('dialog', { name: 'Editar faixa Cinza/Azul' });

    // The master changed the belt meanwhile: the save gets the 403 with "Reler a faixa".
    db.belts = db.belts.map((belt) =>
      belt.id === CINZA_AZUL.id ? { ...belt, color_primary: '#123456' } : belt,
    );
    await user.click(within(first).getByRole('button', { name: 'Salvar' }));
    const alert = await within(first).findByRole('alert');
    // ...and undid it: the belt as the list shows it saves again.
    db.belts = db.belts.map((belt) => (belt.id === CINZA_AZUL.id ? CINZA_AZUL : belt));

    get.state.holding = true;
    await user.click(within(alert).getByRole('button', { name: 'Reler a faixa' }));
    await waitFor(() => {
      expect(get.state.waiting).toBe(1);
    });
    await user.click(within(first).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // The same belt, opened again: a new dialog.
    await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza/Azul' }));
    const second = await screen.findByRole('dialog', { name: 'Editar faixa Cinza/Azul' });
    const age = within(second).getByLabelText(/Idade mínima/);
    await user.clear(age);
    await user.type(age, '12');

    get.open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { user, second, age };
  }

  it('descarta a falha da releitura antiga: o novo diálogo não mostra erro e salva', async () => {
    const { user, second, age } = await rereadThenReopenSameBelt(() =>
      HttpResponse.json({ message: 'Sistema ocupado no momento.' }, { status: 503 }),
    );

    expect(within(second).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(second).queryByText(/Não foi possível reler a faixa/)).not.toBeInTheDocument();
    expect(age).toHaveValue('12');

    await user.click(within(second).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza/Azul salva.');
    expect(db.belts.find((belt) => belt.id === CINZA_AZUL.id)?.min_age_years).toBe(12);
  }, 30_000);

  it('descarta o sucesso da releitura antiga: o novo diálogo não mostra "relida"', async () => {
    const { user, second, age } = await rereadThenReopenSameBelt(() => undefined);

    expect(within(second).queryByText('Faixa relida com os dados atuais.')).not.toBeInTheDocument();
    expect(age).toHaveValue('12');

    await user.click(within(second).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza/Azul salva.');
  }, 30_000);
});
