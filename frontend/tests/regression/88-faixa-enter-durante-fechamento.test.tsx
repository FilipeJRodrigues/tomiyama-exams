/**
 * Erro: no diálogo "Editar faixa" (§ 6.5), depois de um envio que deu certo ("Faixa Cinza
 * salva."), o diálogo continua montado durante a animação de saída (cerca de 200 ms), com o
 * foco no campo e o "Salvar" habilitado de novo. Enter no campo, Enter no "Salvar" ou um clique
 * nele nesse intervalo envia um segundo `PUT /belts/{id}`: o `save` de `BeltsPage` só confere
 * `dialog`, a trava `busy` (liberada no fim do PUT) e `isPending`.
 * Esperado: depois de um envio que deu certo, nenhum envio novo até o diálogo terminar de
 * fechar. Um envio que falhou continua permitindo nova tentativa (último caso, guarda).
 * Issue: #88
 *
 * A resposta do PUT e a saída do diálogo são seguradas pelo teste (`holdExitTransitions`),
 * sem espera real.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { holdExitTransitions } from '../exitTransitions';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const BELTS_URL = `${TEST_API_URL}/belts`;
const TITLE = 'Editar faixa Cinza';

interface PutControl {
  count: number;
  /** The first PUT answers 400 instead of saving. */
  refuseFirst: boolean;
  /** Lets the first PUT go on (the others never wait). */
  releaseFirst: () => void;
}

/** Counts the PUTs; the first waits for `releaseFirst()`, the others reach the mock at once. */
function controlPuts(): PutControl {
  let open: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    open = resolve;
  });
  const control: PutControl = {
    count: 0,
    refuseFirst: false,
    releaseFirst: () => {
      open();
    },
  };
  server.use(
    http.put(`${BELTS_URL}/:id`, async () => {
      control.count += 1;
      if (control.count > 1) return undefined;
      await first;
      if (control.refuseFirst) {
        return HttpResponse.json({ message: 'Ordem: deve estar entre 0 e 99' }, { status: 400 });
      }
      return undefined;
    }),
  );
  return control;
}

async function openCinza(): Promise<{ user: UserEvent; dialog: HTMLElement }> {
  // Enter in the Nome field: a field only for the admin master (#143).
  const { user } = await renderApp({ route: '/faixas', signedInAs: 'master' });
  await screen.findByRole('table', { name: 'Faixas' });
  await user.click(screen.getByRole('button', { name: TITLE }));
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  return { user, dialog };
}

/**
 * The first PUT is on its way: hold the closing, let the PUT answer and wait for the saved
 * notice. The dialog is then closing (as in the fade-out) and still on the screen.
 */
async function saveAndHoldClosing(puts: PutControl) {
  await waitFor(() => {
    expect(puts.count).toBe(1);
  });
  const exit = holdExitTransitions();
  puts.releaseFirst();
  expect(await screen.findByRole('status')).toHaveTextContent('Faixa Cinza salva.');
  expect(screen.getByRole('dialog', { name: TITLE })).toBeInTheDocument();
  return exit;
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

describe('faixas: novo envio durante o fechamento do diálogo (#88)', () => {
  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  it('Enter de novo no campo Nome durante o fechamento não envia outro PUT', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openCinza();
    await user.click(within(dialog).getByLabelText(/^Nome/));
    await user.keyboard('{Enter}');
    const exit = await saveAndHoldClosing(puts);

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(puts.count, 'PUTs depois de um Enter durante o fechamento').toBe(1);
  });

  it('um clique em "Salvar" durante o fechamento não envia outro PUT', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openCinza();
    const save = within(dialog).getByRole('button', { name: 'Salvar' });
    await user.click(save);
    const exit = await saveAndHoldClosing(puts);

    await user.click(save);
    exit.release();
    await dialogGone();
    expect(puts.count, 'PUTs depois de um clique em "Salvar" durante o fechamento').toBe(1);
  });

  it('Enter com o foco no "Salvar" durante o fechamento não envia outro PUT (caminho do #63)', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openCinza();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const exit = await saveAndHoldClosing(puts);

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(puts.count, 'PUTs depois de um Enter no "Salvar" durante o fechamento').toBe(1);
  });

  it('guarda: depois de um PUT recusado, Enter no campo tenta de novo e salva', async () => {
    const puts = controlPuts();
    puts.refuseFirst = true;
    const { user, dialog } = await openCinza();
    await user.click(within(dialog).getByLabelText(/^Nome/));
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    puts.releaseFirst();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Ordem: deve estar entre 0 e 99',
    );
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    });

    await user.click(within(dialog).getByLabelText(/^Nome/));
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza salva.');
    expect(puts.count).toBe(2);
  });
});
