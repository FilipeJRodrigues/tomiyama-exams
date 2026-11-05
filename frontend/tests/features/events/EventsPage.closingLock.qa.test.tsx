/**
 * Eventos (§ 6.5, § 6.7): as travas de envio presas até o diálogo terminar de fechar (#88) não
 * podem ficar presas depois dele. Criar dois eventos seguidos, abrir a exclusão durante a saída
 * da edição, criar depois de excluir, 503/504 e nova tentativa, 409 seguido de "Cancelar" e o
 * diálogo em tela cheia no celular.
 *
 * A resposta da API e a saída do diálogo são seguradas pelo teste (`holdExitTransitions`), sem
 * espera real.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { holdExitTransitions } from '../../exitTransitions';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import {
  EVENTS_URL,
  dialogGone,
  field,
  makeEvent,
  openDelete,
  openEdit,
  openEvents,
  openNew,
  replaceText,
} from './helpers';

let db: MockDb;

type Answer = 'ok' | '503' | '504';

interface WriteControl {
  count: number;
  /** Answers of the next requests, in order; with none left the mock answers. */
  answers: Answer[];
  /** The next request waits for `open()`. */
  hold: () => { open: () => void };
}

function controlWrites(method: 'post' | 'put' | 'delete', url: string): WriteControl {
  let gate: Promise<void> | null = null;
  const control: WriteControl = {
    count: 0,
    answers: [],
    hold: () => {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open };
    },
  };
  server.use(
    http[method](url, async () => {
      control.count += 1;
      if (gate) {
        const waiting = gate;
        gate = null;
        await waiting;
      }
      const answer = control.answers.shift() ?? 'ok';
      if (answer === '503') {
        return HttpResponse.json({ message: 'Sistema ocupado no momento.' }, { status: 503 });
      }
      if (answer === '504') {
        return HttpResponse.json({ message: 'Endpoint request timed out' }, { status: 504 });
      }
      return undefined;
    }),
  );
  return control;
}

function stored(name: string): number {
  return db.events.filter((event) => event.name === name).length;
}

async function createWithEnter(user: UserEvent, name: string, date: string) {
  const dialog = await openNew(user);
  await replaceText(user, field(dialog, /^Nome/), name);
  await user.type(field(dialog, /^Data do exame/), date);
  await user.click(field(dialog, /^Nome/));
  await user.keyboard('{Enter}');
  return dialog;
}

describe('eventos: a trava de envio não fica presa depois do fechamento (qa-frontend, #88)', () => {
  beforeEach(() => {
    db = createMockDb();
    db.events.push(
      makeEvent('sem-exames-1', { name: 'Exame cancelado', exam_date: '2026-08-15' }),
      makeEvent('sem-exames-2', { name: 'Exame adiado', exam_date: '2026-09-12' }),
    );
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('criar dois eventos seguidos: dois POST, cada evento uma vez na API e na lista', async () => {
    const posts = controlWrites('post', EVENTS_URL);
    const { user } = await openEvents();

    await createWithEnter(user, 'Exame junho/2026', '2026-06-20');
    await dialogGone();
    expect(screen.getByRole('status')).toHaveTextContent('Evento criado.');
    // § 6.7: the focus goes to the new event's edit button.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar evento Exame junho/2026' })).toHaveFocus();
    });

    await createWithEnter(user, 'Exame julho/2026', '2026-07-18');
    await dialogGone();
    expect(posts.count).toBe(2);
    expect({ junho: stored('Exame junho/2026'), julho: stored('Exame julho/2026') }).toEqual({
      junho: 1,
      julho: 1,
    });
    await screen.findByRole('button', { name: 'Editar evento Exame julho/2026' });
    expect(screen.getAllByRole('button', { name: 'Editar evento Exame junho/2026' })).toHaveLength(
      1,
    );
  });

  it('abrir a exclusão durante a saída da edição: exclui uma vez e a edição seguinte salva', async () => {
    const puts = controlWrites('put', `${EVENTS_URL}/:id`);
    const deletes = controlWrites('delete', `${EVENTS_URL}/:id`);
    const { user } = await openEvents();
    const dialog = await openEdit(user, 'Exame adiado');
    await replaceText(user, field(dialog, /^Nome/), 'Exame adiado (nova data)');
    const { open } = puts.hold();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    const exit = holdExitTransitions();
    open();
    expect(await screen.findByRole('status')).toHaveTextContent('Evento salvo.');

    await user.click(screen.getByRole('button', { name: 'Excluir evento Exame cancelado' }));
    exit.release();
    const confirm = await screen.findByRole('dialog', { name: 'Excluir evento' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Editar evento' })).not.toBeInTheDocument();
    });
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }));
    await dialogGone();
    expect(deletes.count).toBe(1);
    expect(screen.getByRole('status')).toHaveTextContent('Evento excluído.');

    const again = await openEdit(user, 'Exame adiado (nova data)');
    await replaceText(user, field(again, /^Nome/), 'Exame adiado');
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(puts.count).toBe(2);
    expect(stored('Exame adiado')).toBe(1);
  });

  it('depois de excluir, Esc/"Cancelar" na saída não travam: criar e excluir outro funcionam', async () => {
    const deletes = controlWrites('delete', `${EVENTS_URL}/:id`);
    const posts = controlWrites('post', EVENTS_URL);
    const { user } = await openEvents();
    const confirm = await openDelete(user, 'Exame cancelado');
    const { open } = deletes.hold();
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => {
      expect(deletes.count).toBe(1);
    });
    const exit = holdExitTransitions();
    open();
    expect(await screen.findByRole('status')).toHaveTextContent('Evento excluído.');

    await user.keyboard('{Escape}');
    await user.click(within(confirm).getByRole('button', { name: 'Cancelar' }));
    exit.release();
    await dialogGone();
    expect(deletes.count).toBe(1);
    // § 6.7: the row is gone, the focus goes to the title.
    expect(screen.getByRole('heading', { name: 'Eventos', level: 1 })).toHaveFocus();

    await createWithEnter(user, 'Exame junho/2026', '2026-06-20');
    await dialogGone();
    expect(posts.count).toBe(1);

    const other = await openDelete(user, 'Exame adiado');
    await user.click(within(other).getByRole('button', { name: 'Excluir' }));
    await dialogGone();
    expect(deletes.count).toBe(2);
    expect(stored('Exame adiado')).toBe(0);
  });

  it('503 e 504 na criação deixam tentar de novo; depois do sucesso, o próximo evento é criado', async () => {
    const posts = controlWrites('post', EVENTS_URL);
    posts.answers = ['503', '504'];
    const { user } = await openEvents();
    const dialog = await createWithEnter(user, 'Exame junho/2026', '2026-06-20');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Sistema ocupado no momento.',
    );
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    });

    await user.click(field(dialog, /^Nome/));
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(posts.count).toBe(2);
    });
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    });

    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(posts.count).toBe(3);
    expect(stored('Exame junho/2026')).toBe(1);

    await createWithEnter(user, 'Exame julho/2026', '2026-07-18');
    await dialogGone();
    expect(posts.count).toBe(4);
    expect(stored('Exame julho/2026')).toBe(1);
  });

  it('exclusão recusada (409) e "Cancelar": o foco volta ao "Excluir" da linha e outra exclusão sai', async () => {
    const deletes = controlWrites('delete', `${EVENTS_URL}/:id`);
    const { user } = await openEvents();
    const confirm = await openDelete(user, 'Exame março/2026');
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }));
    await within(confirm).findByRole('alert');
    await waitFor(() => {
      expect(within(confirm).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
    });
    await user.click(within(confirm).getByRole('button', { name: 'Cancelar' }));
    await dialogGone();
    expect(screen.getByRole('button', { name: 'Excluir evento Exame março/2026' })).toHaveFocus();

    const other = await openDelete(user, 'Exame cancelado');
    await user.click(within(other).getByRole('button', { name: 'Excluir' }));
    await dialogGone();
    expect(deletes.count).toBe(2);
    expect(stored('Exame cancelado')).toBe(0);
  });

  it('no celular (tela cheia): Enter durante a saída não cria outro evento', async () => {
    setViewportWidth(375);
    const posts = controlWrites('post', EVENTS_URL);
    // On the phone the list is made of cards, not a table.
    const { user } = await renderApp({ route: '/eventos', signedInAs: 'examiner' });
    await screen.findByRole('list', { name: 'Eventos' });
    const { open } = posts.hold();
    await createWithEnter(user, 'Exame junho/2026', '2026-06-20');
    await waitFor(() => {
      expect(posts.count).toBe(1);
    });
    const exit = holdExitTransitions();
    open();
    expect(await screen.findByRole('status')).toHaveTextContent('Evento criado.');

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(posts.count).toBe(1);
    expect(stored('Exame junho/2026')).toBe(1);
  });
});
