/**
 * Requisitos (§ 6.5): as travas de envio presas até o diálogo terminar de fechar (#88) não
 * podem ficar presas depois dele. Criar dois itens seguidos, excluir outro item reabrindo a
 * confirmação durante a saída, abrir "Novo requisito" durante a saída da edição e 503 com nova
 * tentativa.
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
import { REQUIREMENTS_URL, openRequirements, replaceText, rowDescriptions } from './helpers';

let db: MockDb;

type Answer = 'ok' | '503';

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
      if ((control.answers.shift() ?? 'ok') === '503') {
        return HttpResponse.json({ message: 'Sistema ocupado no momento.' }, { status: 503 });
      }
      return undefined;
    }),
  );
  return control;
}

function field(dialog: HTMLElement, label: RegExp): HTMLElement {
  return within(dialog).getByLabelText(label);
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

function stored(description: string): number {
  return db.requirements.filter((item) => item.description === description).length;
}

/** A theoretical item of the belt in the filter, saved with Enter in Categoria. */
async function createWithEnter(user: UserEvent, description: string) {
  await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
  const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
  await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Teórico');
  await replaceText(user, field(dialog, /^Categoria/), 'Vocabulário');
  await replaceText(user, field(dialog, /^Descrição/), description);
  await replaceText(user, field(dialog, /^Resposta esperada/), 'Hajime');
  await user.click(field(dialog, /^Categoria/));
  await user.keyboard('{Enter}');
  return dialog;
}

describe('requisitos: a trava de envio não fica presa depois do fechamento (qa-frontend, #88)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('criar dois itens seguidos: dois POST, cada item uma vez na API', async () => {
    const posts = controlWrites('post', REQUIREMENTS_URL);
    const { user } = await openRequirements();

    await createWithEnter(user, 'Começar');
    await dialogGone();
    expect(screen.getByRole('status')).toHaveTextContent('Requisito criado');
    await createWithEnter(user, 'Item do QA');
    await dialogGone();
    expect(posts.count).toBe(2);
    expect({ comecar: stored('Começar'), qa: stored('Item do QA') }).toEqual({
      comecar: 1,
      qa: 1,
    });
    await waitFor(() => {
      expect(rowDescriptions().filter((description) => description === 'Item do QA')).toHaveLength(
        1,
      );
    });
  });

  it('reabrir a confirmação para outro item durante a saída: o outro é excluído, uma vez', async () => {
    const deletes = controlWrites('delete', `${REQUIREMENTS_URL}/:id`);
    const { user } = await openRequirements();
    const [first, second] = rowDescriptions().filter((description) => description !== 'Professor');
    if (!first || !second) throw new Error('a folha precisa de dois itens');
    const before = { first: stored(first), second: stored(second) };

    await user.click(screen.getByRole('button', { name: `Excluir ${first}` }));
    const confirm = await screen.findByRole('dialog', { name: 'Excluir requisito' });
    const { open } = deletes.hold();
    await user.click(within(confirm).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => {
      expect(deletes.count).toBe(1);
    });
    const exit = holdExitTransitions();
    open();
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito excluído.');

    await user.click(screen.getByRole('button', { name: `Excluir ${second}` }));
    exit.release();
    const again = await screen.findByRole('dialog', { name: 'Excluir requisito' });
    expect(again).toHaveTextContent(second);
    await waitFor(() => {
      expect(within(again).getByRole('button', { name: 'Excluir' })).toBeEnabled();
    });
    await user.click(within(again).getByRole('button', { name: 'Excluir' }));
    await dialogGone();
    expect(deletes.count).toBe(2);
    expect({ first: stored(first), second: stored(second) }).toEqual({
      first: before.first - 1,
      second: before.second - 1,
    });
  });

  it('abrir "Novo requisito" durante a saída da edição: cria um item e não repete o PUT', async () => {
    const puts = controlWrites('put', `${REQUIREMENTS_URL}/:id`);
    const posts = controlWrites('post', REQUIREMENTS_URL);
    const { user } = await openRequirements();
    await user.click(screen.getByRole('button', { name: 'Editar Professor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar requisito' });
    await replaceText(user, field(dialog, /^Categoria/), 'Vocabulário básico');
    const { open } = puts.hold();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    const exit = holdExitTransitions();
    open();
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito salvo.');

    exit.release();
    await createWithEnter(user, 'Começar');
    await dialogGone();
    expect({ puts: puts.count, posts: posts.count, stored: stored('Começar') }).toEqual({
      puts: 1,
      posts: 1,
      stored: 1,
    });
  });

  it('503 na edição deixa tentar de novo; depois do sucesso, o próximo item é criado', async () => {
    const puts = controlWrites('put', `${REQUIREMENTS_URL}/:id`);
    puts.answers = ['503'];
    const posts = controlWrites('post', REQUIREMENTS_URL);
    const { user } = await openRequirements();
    await user.click(screen.getByRole('button', { name: 'Editar Professor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar requisito' });
    await replaceText(user, field(dialog, /^Categoria/), 'Vocabulário básico');
    await user.keyboard('{Enter}');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Sistema ocupado no momento.',
    );
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    });

    await user.click(field(dialog, /^Categoria/));
    await user.keyboard('{Enter}');
    await dialogGone();
    expect(puts.count).toBe(2);

    await createWithEnter(user, 'Começar');
    await dialogGone();
    expect({ posts: posts.count, stored: stored('Começar') }).toEqual({ posts: 1, stored: 1 });
  });
});
