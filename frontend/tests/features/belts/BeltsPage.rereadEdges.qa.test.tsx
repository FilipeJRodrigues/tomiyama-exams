/**
 * § 6.5, #143 (qa-frontend): bordas de "Reler a faixa" do examinador comum. Esc e o X durante
 * a releitura descartam a resposta e o próximo diálogo salva; Enter durante a releitura não
 * envia PUT; dois 403 seguidos, cada um com sua releitura, terminam salvando; e o mesmo fluxo
 * em `StrictMode` (efeitos montados duas vezes, como em `main.tsx`).
 */
import { configure, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BeltInput } from '../../../src/api/types';
import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const BELTS_URL = `${TEST_API_URL}/belts`;
const CINZA_AZUL = mockBelts.find((belt) => belt.name === 'Cinza/Azul')!;
const AZUL = mockBelts.find((belt) => belt.name === 'Azul')!;

let db: MockDb;

/** Holds the next GET /belts while `holding`, answering it when `open` is called. */
function heldGet() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = { holding: false, waiting: 0 };
  server.use(
    http.get(BELTS_URL, async () => {
      if (!state.holding) return undefined;
      state.holding = false;
      state.waiting += 1;
      await opened;
      return undefined;
    }),
  );
  return {
    state,
    open: () => {
      open();
    },
  };
}

function recordPuts(): BeltInput[] {
  const bodies: BeltInput[] = [];
  server.use(
    http.put(`${BELTS_URL}/:id`, async ({ request }) => {
      bodies.push((await request.clone().json()) as BeltInput);
      return undefined;
    }),
  );
  return bodies;
}

function changeStored(color: string) {
  db.belts = db.belts.map((belt) =>
    belt.id === CINZA_AZUL.id ? { ...belt, color_primary: color } : belt,
  );
}

async function forbiddenSave(user: UserEvent) {
  const dialog = await screen.findByRole('dialog', { name: 'Editar faixa Cinza/Azul' });
  await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
  const alert = await within(dialog).findByRole('alert');
  return { dialog, alert };
}

async function openCinzaAzul() {
  const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
  await screen.findByRole('table', { name: 'Faixas' });
  await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza/Azul' }));
  return user;
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

async function saveAzul(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Editar faixa Azul' }));
  const other = await screen.findByRole('dialog', { name: 'Editar faixa Azul' });
  const age = within(other).getByLabelText(/Idade mínima/);
  await user.clear(age);
  await user.type(age, '13');
  await user.click(within(other).getByRole('button', { name: 'Salvar' }));
  await dialogGone();
  expect(screen.getByRole('status')).toHaveTextContent('Faixa Azul salva.');
  expect(db.belts.find((belt) => belt.id === AZUL.id)?.min_age_years).toBe(13);
}

describe('faixas: bordas de "Reler a faixa" (#143, qa-frontend)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    configure({ reactStrictMode: false });
  });

  for (const how of ['Esc', 'X'] as const) {
    it(`${how} durante a releitura: a resposta é descartada e outra faixa salva`, async () => {
      const get = heldGet();
      const user = await openCinzaAzul();
      changeStored('#123456');
      const { dialog, alert } = await forbiddenSave(user);
      changeStored(CINZA_AZUL.color_primary);

      get.state.holding = true;
      await user.click(within(alert).getByRole('button', { name: 'Reler a faixa' }));
      await waitFor(() => {
        expect(get.state.waiting).toBe(1);
      });
      if (how === 'Esc') await user.keyboard('{Escape}');
      else await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
      await dialogGone();

      get.open();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByText('Faixa relida com os dados atuais.')).not.toBeInTheDocument();
      await saveAzul(user);
    }, 30_000);
  }

  it('Enter durante a releitura não envia PUT; depois dela, um só PUT', async () => {
    const puts = recordPuts();
    const get = heldGet();
    const user = await openCinzaAzul();
    changeStored('#123456');
    const { dialog, alert } = await forbiddenSave(user);
    expect(puts).toHaveLength(1);

    get.state.holding = true;
    await user.click(within(alert).getByRole('button', { name: 'Reler a faixa' }));
    await waitFor(() => {
      expect(get.state.waiting).toBe(1);
    });
    const age = within(dialog).getByLabelText(/Idade mínima/);
    await user.click(age);
    await user.keyboard('{Enter}');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(puts).toHaveLength(1);

    get.open();
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Faixa relida');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(puts).toHaveLength(2);
    expect(puts[1]).toMatchObject({ color_primary: '#123456' });
  }, 30_000);

  it('dois 403 seguidos, cada um relido com sucesso, terminam salvando', async () => {
    const puts = recordPuts();
    const user = await openCinzaAzul();
    changeStored('#111111');
    const first = await forbiddenSave(user);
    await user.click(within(first.alert).getByRole('button', { name: 'Reler a faixa' }));
    expect(await within(first.dialog).findByRole('status')).toHaveTextContent('Faixa relida');

    // O master muda de novo antes do segundo envio.
    changeStored('#222222');
    const second = await forbiddenSave(user);
    // O aviso de "relida" da primeira vez sai com o novo erro.
    expect(within(second.dialog).queryByText('Faixa relida com os dados atuais.')).toBeNull();
    await user.click(within(second.alert).getByRole('button', { name: 'Reler a faixa' }));
    expect(await within(second.dialog).findByRole('status')).toHaveTextContent('Faixa relida');
    expect(within(second.dialog).queryByRole('alert')).toBeNull();

    await user.click(within(second.dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(puts).toHaveLength(3);
    expect(puts[2]).toMatchObject({ color_primary: '#222222' });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza/Azul salva.');
  }, 30_000);

  it('em StrictMode a releitura do mesmo diálogo mostra o aviso e põe o foco no campo', async () => {
    configure({ reactStrictMode: true });
    const user = await openCinzaAzul();
    changeStored('#333333');
    const { dialog, alert } = await forbiddenSave(user);
    const age = within(dialog).getByLabelText(/Idade mínima/);
    await user.clear(age);
    await user.type(age, '9');
    await user.click(within(alert).getByRole('button', { name: 'Reler a faixa' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Faixa relida');
    expect(age).toHaveValue('9');
    await waitFor(() => {
      expect(age).toHaveFocus();
    });
  }, 30_000);

  it('em StrictMode a releitura atrasada de um diálogo fechado não trava outra faixa', async () => {
    configure({ reactStrictMode: true });
    const get = heldGet();
    const user = await openCinzaAzul();
    changeStored('#444444');
    const { dialog, alert } = await forbiddenSave(user);
    get.state.holding = true;
    await user.click(within(alert).getByRole('button', { name: 'Reler a faixa' }));
    await waitFor(() => {
      expect(get.state.waiting).toBe(1);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await dialogGone();
    get.open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await saveAzul(user);
  }, 30_000);
});
