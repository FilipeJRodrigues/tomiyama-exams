/**
 * Erro: na confirmação "Remover logo principal" da Academia (§ 6.6, RN012), depois de uma
 * remoção que deu certo ("Logo principal removido."), o diálogo continua montado durante a
 * animação de saída (cerca de 200 ms), com o foco no "Remover" habilitado de novo. Enter nele ou
 * um clique nesse intervalo envia um segundo `DELETE /settings/logos/primary`: o `confirmRemove`
 * de `LogoSlotPanel` só confere a trava `busy` (liberada no fim da requisição) e `removing`.
 * Mesma classe do erro dos diálogos de Faixas, Eventos e Requisitos.
 * Esperado: depois de uma remoção que deu certo, nenhum envio novo até o diálogo terminar de
 * fechar. Uma remoção que falhou continua permitindo nova tentativa (último caso, guarda).
 * Issue: #88
 *
 * A resposta da API e a saída do diálogo são seguradas pelo teste (`holdExitTransitions`),
 * sem espera real.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { holdExitTransitions } from '../exitTransitions';
import { openAcademy } from '../features/academy/helpers';
import {
  PNG_BYTES,
  logoUrl,
  mockLogo,
  slotButton,
  slotRegion,
} from '../features/academy/logoHelpers';
import { server, TEST_API_URL } from '../msw-server';

const TITLE = 'Remover logo principal';
const NOTICE = 'Logo principal removido.';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

interface DeleteControl {
  count: number;
  /** The first DELETE answers 503 instead of removing. */
  refuseFirst: boolean;
  /** Lets the first DELETE go on (the others never wait). */
  releaseFirst: () => void;
}

/** Counts the DELETEs; the first waits for `releaseFirst()`, the others reach the mock at once. */
function controlDeletes(): DeleteControl {
  let open: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    open = resolve;
  });
  const control: DeleteControl = {
    count: 0,
    refuseFirst: false,
    releaseFirst: () => {
      open();
    },
  };
  server.use(
    http.delete(logoUrl('primary'), async () => {
      control.count += 1;
      if (control.count > 1) return undefined;
      await first;
      if (control.refuseFirst) return HttpResponse.json({ message: BUSY }, { status: 503 });
      return undefined;
    }),
  );
  return control;
}

/** Opens the screen with both slots loaded and the confirmation of the primary logo. */
async function openRemove(): Promise<{ user: UserEvent; confirm: HTMLElement }> {
  const { user } = await openAcademy('examiner');
  await waitFor(() => {
    expect(screen.queryByText('Carregando logo…')).not.toBeInTheDocument();
  });
  await user.click(slotButton('primary', 'Remover'));
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  return { user, confirm: within(dialog).getByRole('button', { name: 'Remover' }) };
}

/**
 * The first DELETE is on its way: hold the closing, let it answer and wait for the notice. The
 * confirmation is then closing (as in the fade-out) and still on the screen.
 */
async function removeAndHoldClosing(deletes: DeleteControl) {
  await waitFor(() => {
    expect(deletes.count).toBe(1);
  });
  const exit = holdExitTransitions();
  deletes.releaseFirst();
  expect(await within(slotRegion('primary')).findByRole('status')).toHaveTextContent(NOTICE);
  expect(screen.getByRole('dialog', { name: TITLE })).toBeInTheDocument();
  return exit;
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

describe('remover logo: novo envio durante o fechamento da confirmação (#88)', () => {
  beforeEach(() => {
    const db = createMockDb();
    db.logos.primary = mockLogo(PNG_BYTES);
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('Enter de novo no "Remover" durante o fechamento não envia outro DELETE', async () => {
    const deletes = controlDeletes();
    const { user, confirm } = await openRemove();
    await user.click(confirm);
    const exit = await removeAndHoldClosing(deletes);

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(deletes.count, 'DELETEs depois de um Enter durante o fechamento').toBe(1);
  });

  it('um clique em "Remover" durante o fechamento não envia outro DELETE', async () => {
    const deletes = controlDeletes();
    const { user, confirm } = await openRemove();
    await user.click(confirm);
    const exit = await removeAndHoldClosing(deletes);

    await user.click(confirm);
    exit.release();
    await dialogGone();
    expect(deletes.count, 'DELETEs depois de um clique durante o fechamento').toBe(1);
  });

  it('guarda: depois de um DELETE recusado, Enter no "Remover" tenta de novo e remove', async () => {
    const deletes = controlDeletes();
    deletes.refuseFirst = true;
    const { user, confirm } = await openRemove();
    await user.click(confirm);
    await waitFor(() => {
      expect(deletes.count).toBe(1);
    });
    deletes.releaseFirst();
    expect(await screen.findByRole('alert')).toHaveTextContent(BUSY);
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });

    confirm.focus();
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(within(slotRegion('primary')).getByRole('status')).toHaveTextContent(NOTICE);
    expect(deletes.count).toBe(2);
  });
});
