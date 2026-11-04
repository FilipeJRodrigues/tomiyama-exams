/**
 * Requirements screen (§ 6.5, RN017), cases added by qa-frontend (#25): a confirmed write
 * while a list read is in flight (first load, error retry, a filter left loading, a 409
 * reload followed by a new save). The held reads are released by the test, no timers.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Requirement } from '../../../src/api/types';
import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import {
  REQUIREMENTS_URL,
  beltFilter,
  beltId,
  openRequirements,
  replaceText,
  rowDescriptions,
} from './helpers';

let db: MockDb;
let holdBelt: string | null;
let held: (() => void) | null;
let failNext: boolean;

beforeEach(() => {
  db = createMockDb();
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  holdBelt = null;
  held = null;
  failNext = false;
  server.use(
    http.get(REQUIREMENTS_URL, async ({ request }) => {
      const belt = new URL(request.url).searchParams.get('belt_id');
      if (failNext && belt !== null) {
        failNext = false;
        return HttpResponse.json({ message: 'Erro simulado.' }, { status: 400 });
      }
      if (holdBelt === null || belt !== holdBelt) return undefined;
      holdBelt = null;
      const snapshot = db.requirements
        .filter((item) => item.belt_id === belt)
        .map((item) => ({ ...item }))
        .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
      await new Promise<void>((resolve) => {
        held = resolve;
      });
      return HttpResponse.json<Requirement[]>(snapshot);
    }),
  );
});

async function waitHeld() {
  await waitFor(() => {
    expect(held).not.toBeNull();
  });
}

async function createItem(
  user: Awaited<ReturnType<typeof openRequirements>>['user'],
  description: string,
  belt?: string,
) {
  await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
  const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
  if (belt) {
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Faixa/ }), belt);
  }
  await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Teórico');
  await replaceText(user, within(dialog).getByLabelText(/^Categoria/), 'Vocabulário');
  await replaceText(user, within(dialog).getByLabelText(/^Descrição/), description);
  await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
}

describe('requirements screen, write with a list read in flight (§ 6.5, RN017)', () => {
  it('lista da faixa ainda na primeira carga: o item criado aparece e a lista não fica carregando', async () => {
    const { user } = await openRequirements();
    holdBelt = beltId('Cinza');
    await user.selectOptions(beltFilter(), 'Cinza');
    await waitHeld();
    expect(screen.getByText('Carregando requisitos…')).toBeInTheDocument();

    await createItem(user, 'Começar');

    expect(await screen.findByRole('status')).toHaveTextContent('Requisito criado.');
    await waitFor(() => {
      expect(rowDescriptions()).toContain('Começar');
    });
    expect(screen.queryByText('Carregando requisitos…')).not.toBeInTheDocument();
    held?.();
  });

  it('lista em erro com "Tentar de novo" em voo: a gravação não a deixa presa', async () => {
    const { user } = await openRequirements();
    failNext = true;
    await user.selectOptions(beltFilter(), 'Cinza');
    const retry = await screen.findByRole('button', { name: 'Tentar de novo' });
    holdBelt = beltId('Cinza');
    await user.click(retry);
    await waitHeld();

    await createItem(user, 'Começar');

    expect(await screen.findByRole('status')).toHaveTextContent('Requisito criado.');
    await waitFor(() => {
      expect(rowDescriptions()).toContain('Começar');
    });
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).not.toBeInTheDocument();
    held?.();
  });

  it('filtro trocado de volta com a outra faixa ainda carregando: ela carrega depois', async () => {
    const { user } = await openRequirements();
    holdBelt = beltId('Cinza');
    await user.selectOptions(beltFilter(), 'Cinza');
    await waitHeld();
    await user.selectOptions(beltFilter(), 'Branca/Cinza');
    await screen.findByRole('table', { name: 'Requisitos' });

    await createItem(user, 'Começar', 'Cinza');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Requisito criado na faixa Cinza (Teórico), fora do filtro atual.',
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Novo requisito' })).not.toBeInTheDocument();
    });

    await user.selectOptions(beltFilter(), 'Cinza');
    await waitFor(() => {
      expect(rowDescriptions()).toContain('Começar');
    });
    held?.();
  });

  it('409 no editar, recarga em voo e novo salvar: fica a versão confirmada', async () => {
    const { user } = await openRequirements();
    server.use(
      http.put(
        `${REQUIREMENTS_URL}/:id`,
        () => {
          holdBelt = beltId('Branca/Cinza');
          return HttpResponse.json({ message: 'Conflito simulado.' }, { status: 409 });
        },
        { once: true },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Editar Osoto gari' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar requisito' });
    await replaceText(user, within(dialog).getByLabelText(/^Descrição/), 'Osoto gari (direita)');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Conflito simulado.');
    await waitHeld();

    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito salvo.');
    held?.();
    await waitFor(() => {
      expect(rowDescriptions()).toContain('Osoto gari (direita)');
    });
    expect(rowDescriptions()).not.toContain('Osoto gari');
  });
});
