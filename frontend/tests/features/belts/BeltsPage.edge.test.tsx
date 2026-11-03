/**
 * Belts screen (§ 6.5, § 6.7), edge cases found by qa-frontend: a 403 or 401 on the save,
 * the range 400 of card #47, the keyboard staying inside the dialog and a new opening
 * starting without the previous error.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const BELTS_URL = `${TEST_API_URL}/belts`;

async function openBelts() {
  const result = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
  await screen.findByRole('table', { name: 'Faixas' });
  return result;
}

async function openEditor(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: `Editar faixa ${name}` }));
  return screen.findByRole('dialog', { name: `Editar faixa ${name}` });
}

function answerPut(status: number, message: string) {
  server.use(http.put(`${BELTS_URL}/:id`, () => HttpResponse.json({ message }, { status })));
}

describe('belts screen, edge cases (§ 6.5, § 6.7)', () => {
  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  it('a 403 on the save says "Sem permissão" with the API message', async () => {
    answerPut(403, 'Acesso restrito a examinadores');
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Acesso restrito a examinadores');
  });

  it('a 401 on the save ends the session and leaves no dialog behind', async () => {
    answerPut(401, 'Unauthorized');
    const { user, router } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Faixas' })).not.toBeInTheDocument();
  });

  it('shows the range 400 of the API (card #47), keeps the value and allows a new try', async () => {
    // A value the client accepts, refused by the server: its message is the one shown.
    let fail = true;
    let puts = 0;
    server.use(
      http.put(`${BELTS_URL}/:id`, () => {
        puts += 1;
        return fail
          ? HttpResponse.json({ message: 'Ordem: deve estar entre 0 e 99' }, { status: 400 })
          : undefined;
      }),
    );
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    const order = within(dialog).getByLabelText(/^Ordem/);
    await user.clear(order);
    await user.type(order, '50');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Ordem: deve estar entre 0 e 99',
    );
    expect(order).toHaveValue('50');
    expect(puts).toBe(1);
    const saveButton = within(dialog).getByRole('button', { name: 'Salvar' });
    await waitFor(() => {
      expect(saveButton).toBeEnabled();
    });

    fail = false;
    await user.click(saveButton);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts).toBe(2);
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza salva.');
  });

  it('an order out of range (150) is refused in the field, with focus and no PUT', async () => {
    let puts = 0;
    server.use(
      http.put(`${BELTS_URL}/:id`, () => {
        puts += 1;
        return undefined;
      }),
    );
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    const order = within(dialog).getByLabelText(/^Ordem/);
    await user.clear(order);
    await user.type(order, '150');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('Use um número inteiro de 0 a 99.')).toBeVisible();
    expect(order).toHaveAccessibleDescription(/Use um número inteiro de 0 a 99\./);
    expect(order).toHaveAttribute('aria-invalid', 'true');
    expect(order).toHaveFocus();
    expect(order).toHaveValue('150');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(puts).toBe(0);
  });

  it('keeps Tab inside the dialog, through every control', async () => {
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    await waitFor(() => {
      expect(within(dialog).getByLabelText(/^Nome/)).toHaveFocus();
    });
    const reached = new Set<Element>();
    for (let step = 0; step < 12; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      if (document.activeElement) reached.add(document.activeElement);
    }
    for (const control of [
      within(dialog).getByLabelText(/^Ordem/),
      within(dialog).getByRole('combobox', { name: 'Kyū' }),
      within(dialog).getByRole('combobox', { name: /^Nível/ }),
      within(dialog).getByLabelText(/^Idade mínima/),
      within(dialog).getByLabelText(/^Carência/),
      within(dialog).getByLabelText(/^Cor das pontas/),
      within(dialog).getByRole('button', { name: 'Cancelar' }),
      within(dialog).getByRole('button', { name: 'Salvar' }),
      within(dialog).getByRole('button', { name: 'Fechar' }),
    ]) {
      expect(reached).toContain(control);
    }
  });

  it('a new opening starts without the error of the previous try', async () => {
    let fail = true;
    server.use(
      http.put(`${BELTS_URL}/:id`, () =>
        fail
          ? HttpResponse.json({ message: 'Ordem: deve estar entre 0 e 99' }, { status: 400 })
          : undefined,
      ),
    );
    const { user } = await openBelts();
    let dialog = await openEditor(user, 'Cinza');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await within(dialog).findByRole('alert');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    dialog = await openEditor(user, 'Cinza');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza salva.');
  });
});
