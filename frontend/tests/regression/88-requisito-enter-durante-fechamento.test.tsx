/**
 * Erro: nos diálogos "Novo requisito" e "Editar requisito" (§ 6.5), depois de um envio que deu
 * certo ("Requisito criado." / "Requisito salvo."), o diálogo continua montado durante a
 * animação de saída (cerca de 200 ms), com o foco no campo e o "Salvar" habilitado de novo.
 * Enter no campo ou um clique em "Salvar" nesse intervalo envia outro `POST /requirements`
 * (dois itens iguais na folha da faixa) ou outro `PUT /requirements/{id}`: o `save` de
 * `RequirementsPage` só confere `editor`, a trava `busy` (liberada no fim da requisição) e
 * `isPending`.
 * Esperado: depois de um envio que deu certo, nenhum envio novo até o diálogo terminar de
 * fechar; um item criado aparece uma vez só. Um envio que falhou continua permitindo nova
 * tentativa (último caso, guarda).
 * Issue: #88
 *
 * A resposta da API e a saída do diálogo são seguradas pelo teste (`holdExitTransitions`),
 * sem espera real.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { holdExitTransitions } from '../exitTransitions';
import {
  REQUIREMENTS_URL,
  openRequirements,
  replaceText,
  rowDescriptions,
} from '../features/requirements/helpers';
import { server, TEST_API_URL } from '../msw-server';

const NEW_DESCRIPTION = 'Começar';
const REFUSAL = 'Categoria: até 60 caracteres';

let db: MockDb;

interface WriteControl {
  count: number;
  /** The first request answers 400 instead of saving. */
  refuseFirst: boolean;
  /** Lets the first request go on (the others never wait). */
  releaseFirst: () => void;
}

/** Counts the writes; the first waits for `releaseFirst()`, the others reach the mock at once. */
function controlWrites(method: 'post' | 'put', url: string): WriteControl {
  let open: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    open = resolve;
  });
  const control: WriteControl = {
    count: 0,
    refuseFirst: false,
    releaseFirst: () => {
      open();
    },
  };
  server.use(
    http[method](url, async () => {
      control.count += 1;
      if (control.count > 1) return undefined;
      await first;
      if (control.refuseFirst) return HttpResponse.json({ message: REFUSAL }, { status: 400 });
      return undefined;
    }),
  );
  return control;
}

function field(dialog: HTMLElement, label: RegExp): HTMLElement {
  return within(dialog).getByLabelText(label);
}

async function openNew(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
  return screen.findByRole('dialog', { name: 'Novo requisito' });
}

async function openEdit(user: UserEvent, description: string) {
  await user.click(screen.getByRole('button', { name: `Editar ${description}` }));
  return screen.findByRole('dialog', { name: 'Editar requisito' });
}

/** A theoretical item of the belt in the filter (Branca/Cinza), at the end of its sheet. */
async function fillNew(user: UserEvent, dialog: HTMLElement) {
  await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Teórico');
  await replaceText(user, field(dialog, /^Categoria/), 'Vocabulário');
  await replaceText(user, field(dialog, /^Descrição/), NEW_DESCRIPTION);
  await replaceText(user, field(dialog, /^Resposta esperada/), 'Hajime');
}

/**
 * The first write is on its way: hold the closing, let it answer and wait for the notice. The
 * dialog is then closing (as in the fade-out) and still on the screen.
 */
async function saveAndHoldClosing(writes: WriteControl, notice: string, title: string) {
  await waitFor(() => {
    expect(writes.count).toBe(1);
  });
  const exit = holdExitTransitions();
  writes.releaseFirst();
  expect(await screen.findByRole('status')).toHaveTextContent(notice);
  expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
  return exit;
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

function stored(description: string): number {
  return db.requirements.filter((item) => item.description === description).length;
}

function shown(description: string): number {
  return rowDescriptions().filter((rowDescription) => rowDescription === description).length;
}

/** The list caught up with what the API stored (after every reload). */
async function listMatchesApi(description: string) {
  await waitFor(() => {
    expect(shown(description)).toBe(stored(description));
  });
}

describe('requisitos: novo envio durante o fechamento do diálogo (#88)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('criação: Enter de novo no campo Categoria durante o fechamento não cria um segundo item', async () => {
    const posts = controlWrites('post', REQUIREMENTS_URL);
    const { user } = await openRequirements();
    const dialog = await openNew(user);
    await fillNew(user, dialog);
    await user.click(field(dialog, /^Categoria/));
    await user.keyboard('{Enter}');
    const exit = await saveAndHoldClosing(posts, 'Requisito criado.', 'Novo requisito');

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    await listMatchesApi(NEW_DESCRIPTION);
    expect({
      posts: posts.count,
      stored: stored(NEW_DESCRIPTION),
      rows: shown(NEW_DESCRIPTION),
    }).toEqual({ posts: 1, stored: 1, rows: 1 });
  });

  it('criação: um clique em "Salvar" durante o fechamento não cria um segundo item', async () => {
    const posts = controlWrites('post', REQUIREMENTS_URL);
    const { user } = await openRequirements();
    const dialog = await openNew(user);
    await fillNew(user, dialog);
    const save = within(dialog).getByRole('button', { name: 'Salvar' });
    await user.click(save);
    const exit = await saveAndHoldClosing(posts, 'Requisito criado.', 'Novo requisito');

    await user.click(save);
    exit.release();
    await dialogGone();
    await listMatchesApi(NEW_DESCRIPTION);
    expect({
      posts: posts.count,
      stored: stored(NEW_DESCRIPTION),
      rows: shown(NEW_DESCRIPTION),
    }).toEqual({ posts: 1, stored: 1, rows: 1 });
  });

  it('edição: Enter de novo no campo Categoria durante o fechamento não envia outro PUT', async () => {
    const puts = controlWrites('put', `${REQUIREMENTS_URL}/:id`);
    const { user } = await openRequirements();
    const dialog = await openEdit(user, 'Professor');
    await replaceText(user, field(dialog, /^Categoria/), 'Vocabulário básico');
    await user.keyboard('{Enter}');
    const exit = await saveAndHoldClosing(puts, 'Requisito salvo.', 'Editar requisito');

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(puts.count, 'PUTs depois de um Enter durante o fechamento').toBe(1);
  });

  it('guarda: depois de um POST recusado, Enter no campo tenta de novo e cria um item só', async () => {
    const posts = controlWrites('post', REQUIREMENTS_URL);
    posts.refuseFirst = true;
    const { user } = await openRequirements();
    const dialog = await openNew(user);
    await fillNew(user, dialog);
    await user.click(field(dialog, /^Categoria/));
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(posts.count).toBe(1);
    });
    posts.releaseFirst();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(REFUSAL);
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    });

    await user.click(field(dialog, /^Categoria/));
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(screen.getByRole('status')).toHaveTextContent('Requisito criado.');
    await listMatchesApi(NEW_DESCRIPTION);
    expect({
      posts: posts.count,
      stored: stored(NEW_DESCRIPTION),
      rows: shown(NEW_DESCRIPTION),
    }).toEqual({ posts: 2, stored: 1, rows: 1 });
  });
});
