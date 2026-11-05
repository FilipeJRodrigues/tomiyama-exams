/**
 * Erro: nas confirmações "Excluir evento" e "Excluir requisito" (§ 6.5), depois de uma exclusão
 * que deu certo ("Evento excluído." / "Requisito excluído."), o diálogo continua montado durante
 * a animação de saída (cerca de 200 ms), com o foco no "Excluir" habilitado de novo. Enter nele
 * ou um clique nesse intervalo envia um segundo `DELETE` do mesmo id, que a API responde com
 * 404: o `confirmDelete` de `EventsPage` e de `RequirementsPage` só confere `deleting`, a trava
 * `busy` (liberada no fim da requisição) e `isPending`.
 * Esperado: depois de uma exclusão que deu certo, nenhum envio novo até o diálogo terminar de
 * fechar. Uma exclusão que falhou continua permitindo nova tentativa (último caso, guarda).
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
import { EVENTS_URL, makeEvent, openEvents } from '../features/events/helpers';
import { REQUIREMENTS_URL, openRequirements } from '../features/requirements/helpers';
import { server, TEST_API_URL } from '../msw-server';

const REFUSAL = 'Serviço indisponível, tente de novo';

interface DeleteControl {
  count: number;
  /** The first DELETE answers 503 instead of deleting. */
  refuseFirst: boolean;
  /** Lets the first DELETE go on (the others never wait). */
  releaseFirst: () => void;
}

/** Counts the DELETEs; the first waits for `releaseFirst()`, the others reach the mock at once. */
function controlDeletes(url: string): DeleteControl {
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
    http.delete(url, async () => {
      control.count += 1;
      if (control.count > 1) return undefined;
      await first;
      if (control.refuseFirst) return HttpResponse.json({ message: REFUSAL }, { status: 503 });
      return undefined;
    }),
  );
  return control;
}

async function openDelete(user: UserEvent, buttonName: string, title: string) {
  await user.click(screen.getByRole('button', { name: buttonName }));
  return screen.findByRole('dialog', { name: title });
}

/**
 * The first DELETE is on its way: hold the closing, let it answer and wait for the notice. The
 * confirmation is then closing (as in the fade-out) and still on the screen.
 */
async function deleteAndHoldClosing(deletes: DeleteControl, notice: string, title: string) {
  await waitFor(() => {
    expect(deletes.count).toBe(1);
  });
  const exit = holdExitTransitions();
  deletes.releaseFirst();
  expect(await screen.findByRole('status')).toHaveTextContent(notice);
  expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
  return exit;
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

describe('excluir evento: novo envio durante o fechamento da confirmação (#88)', () => {
  const TITLE = 'Excluir evento';
  const BUTTON = 'Excluir evento Exame cancelado';
  const NOTICE = 'Evento excluído.';

  beforeEach(() => {
    const db = createMockDb();
    db.events.push(
      makeEvent('evento-sem-exames', {
        name: 'Exame cancelado',
        exam_date: '2026-08-15',
        created_at: '2026-07-01T12:00:00+00:00',
      }),
    );
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('Enter de novo no "Excluir" durante o fechamento não envia outro DELETE', async () => {
    const deletes = controlDeletes(`${EVENTS_URL}/:id`);
    const { user } = await openEvents();
    const dialog = await openDelete(user, BUTTON, TITLE);
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    const exit = await deleteAndHoldClosing(deletes, NOTICE, TITLE);

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(deletes.count, 'DELETEs depois de um Enter durante o fechamento').toBe(1);
  });

  it('um clique em "Excluir" durante o fechamento não envia outro DELETE', async () => {
    const deletes = controlDeletes(`${EVENTS_URL}/:id`);
    const { user } = await openEvents();
    const dialog = await openDelete(user, BUTTON, TITLE);
    const confirm = within(dialog).getByRole('button', { name: 'Excluir' });
    await user.click(confirm);
    const exit = await deleteAndHoldClosing(deletes, NOTICE, TITLE);

    await user.click(confirm);
    exit.release();
    await dialogGone();
    expect(deletes.count, 'DELETEs depois de um clique durante o fechamento').toBe(1);
  });

  it('guarda: depois de um DELETE recusado, Enter no "Excluir" tenta de novo e exclui', async () => {
    const deletes = controlDeletes(`${EVENTS_URL}/:id`);
    deletes.refuseFirst = true;
    const { user } = await openEvents();
    const dialog = await openDelete(user, BUTTON, TITLE);
    const confirm = within(dialog).getByRole('button', { name: 'Excluir' });
    await user.click(confirm);
    await waitFor(() => {
      expect(deletes.count).toBe(1);
    });
    deletes.releaseFirst();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(REFUSAL);
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });

    confirm.focus();
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(screen.getByRole('status')).toHaveTextContent(NOTICE);
    expect(deletes.count).toBe(2);
  });
});

describe('excluir requisito: novo envio durante o fechamento da confirmação (#88)', () => {
  const TITLE = 'Excluir requisito';
  const BUTTON = 'Excluir Deashi barai';
  const NOTICE = 'Requisito excluído.';

  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  it('Enter de novo no "Excluir" durante o fechamento não envia outro DELETE', async () => {
    const deletes = controlDeletes(`${REQUIREMENTS_URL}/:id`);
    const { user } = await openRequirements();
    const dialog = await openDelete(user, BUTTON, TITLE);
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    const exit = await deleteAndHoldClosing(deletes, NOTICE, TITLE);

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(deletes.count, 'DELETEs depois de um Enter durante o fechamento').toBe(1);
  });

  it('um clique em "Excluir" durante o fechamento não envia outro DELETE', async () => {
    const deletes = controlDeletes(`${REQUIREMENTS_URL}/:id`);
    const { user } = await openRequirements();
    const dialog = await openDelete(user, BUTTON, TITLE);
    const confirm = within(dialog).getByRole('button', { name: 'Excluir' });
    await user.click(confirm);
    const exit = await deleteAndHoldClosing(deletes, NOTICE, TITLE);

    await user.click(confirm);
    exit.release();
    await dialogGone();
    expect(deletes.count, 'DELETEs depois de um clique durante o fechamento').toBe(1);
  });

  it('guarda: depois de um DELETE recusado, Enter no "Excluir" tenta de novo e exclui', async () => {
    const deletes = controlDeletes(`${REQUIREMENTS_URL}/:id`);
    deletes.refuseFirst = true;
    const { user } = await openRequirements();
    const dialog = await openDelete(user, BUTTON, TITLE);
    const confirm = within(dialog).getByRole('button', { name: 'Excluir' });
    await user.click(confirm);
    await waitFor(() => {
      expect(deletes.count).toBe(1);
    });
    deletes.releaseFirst();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(REFUSAL);
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });

    confirm.focus();
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(screen.getByRole('status')).toHaveTextContent(NOTICE);
    expect(deletes.count).toBe(2);
  });
});
