/**
 * Erro: nos diálogos "Novo evento" e "Editar evento" (§ 6.5), depois de um envio que deu certo
 * ("Evento criado." / "Evento salvo."), o diálogo continua montado durante a animação de saída
 * (cerca de 200 ms), com o foco no campo e o "Salvar" habilitado de novo. Enter no campo ou um
 * clique em "Salvar" nesse intervalo envia outro `POST /events` (dois eventos iguais na lista)
 * ou outro `PUT /events/{id}`: o `save` de `EventsPage` só confere `editor`, a trava `busy`
 * (liberada no fim da requisição) e `isPending`.
 * Esperado: depois de um envio que deu certo, nenhum envio novo até o diálogo terminar de
 * fechar; um evento criado aparece uma vez só. Um envio que falhou continua permitindo nova
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
  EVENTS_URL,
  dialogGone,
  field,
  openEdit,
  openEvents,
  openNew,
  replaceText,
  rowNames,
} from '../features/events/helpers';
import { server, TEST_API_URL } from '../msw-server';

const NEW_NAME = 'Exame junho/2026';
const REFUSAL = 'Data do exame: data inválida (use AAAA-MM-DD)';

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

async function fillNew(user: UserEvent, dialog: HTMLElement) {
  await replaceText(user, field(dialog, /^Nome/), NEW_NAME);
  await user.type(field(dialog, /^Data do exame/), '2026-06-20');
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

function stored(name: string): number {
  return db.events.filter((event) => event.name === name).length;
}

function shown(name: string): number {
  return rowNames().filter((rowName) => rowName === name).length;
}

/** The list caught up with what the API stored (after every reload). */
async function listMatchesApi(name: string) {
  await waitFor(() => {
    expect(shown(name)).toBe(stored(name));
  });
}

describe('eventos: novo envio durante o fechamento do diálogo (#88)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('criação: Enter de novo no campo Nome durante o fechamento não cria um segundo evento', async () => {
    const posts = controlWrites('post', EVENTS_URL);
    const { user } = await openEvents();
    const dialog = await openNew(user);
    await fillNew(user, dialog);
    await user.click(field(dialog, /^Nome/));
    await user.keyboard('{Enter}');
    const exit = await saveAndHoldClosing(posts, 'Evento criado.', 'Novo evento');

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    await listMatchesApi(NEW_NAME);
    expect({ posts: posts.count, stored: stored(NEW_NAME), rows: shown(NEW_NAME) }).toEqual({
      posts: 1,
      stored: 1,
      rows: 1,
    });
  });

  it('criação: um clique em "Salvar" durante o fechamento não cria um segundo evento', async () => {
    const posts = controlWrites('post', EVENTS_URL);
    const { user } = await openEvents();
    const dialog = await openNew(user);
    await fillNew(user, dialog);
    const save = within(dialog).getByRole('button', { name: 'Salvar' });
    await user.click(save);
    const exit = await saveAndHoldClosing(posts, 'Evento criado.', 'Novo evento');

    await user.click(save);
    exit.release();
    await dialogGone();
    await listMatchesApi(NEW_NAME);
    expect({ posts: posts.count, stored: stored(NEW_NAME), rows: shown(NEW_NAME) }).toEqual({
      posts: 1,
      stored: 1,
      rows: 1,
    });
  });

  it('edição: Enter de novo no campo Nome durante o fechamento não envia outro PUT', async () => {
    const puts = controlWrites('put', `${EVENTS_URL}/:id`);
    const { user } = await openEvents();
    const dialog = await openEdit(user, 'Exame março/2026');
    await replaceText(user, field(dialog, /^Nome/), 'Exame março/2026 (graduação)');
    await user.keyboard('{Enter}');
    const exit = await saveAndHoldClosing(puts, 'Evento salvo.', 'Editar evento');

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(puts.count, 'PUTs depois de um Enter durante o fechamento').toBe(1);
  });

  it('guarda: depois de um POST recusado, Enter no campo tenta de novo e cria um evento só', async () => {
    const posts = controlWrites('post', EVENTS_URL);
    posts.refuseFirst = true;
    const { user } = await openEvents();
    const dialog = await openNew(user);
    await fillNew(user, dialog);
    await user.click(field(dialog, /^Nome/));
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(posts.count).toBe(1);
    });
    posts.releaseFirst();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(REFUSAL);
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    });

    await user.click(field(dialog, /^Nome/));
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(screen.getByRole('status')).toHaveTextContent('Evento criado.');
    await listMatchesApi(NEW_NAME);
    expect({ posts: posts.count, stored: stored(NEW_NAME), rows: shown(NEW_NAME) }).toEqual({
      posts: 2,
      stored: 1,
      rows: 1,
    });
  });
});
