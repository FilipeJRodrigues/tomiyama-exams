/**
 * Belts screen (§ 6.5, § 6.7), qa-frontend coverage: one PUT per save by every path
 * (Esc, close button, cancel in the same tick as the save, retry after an error, network
 * failure) and the card #47 ceilings in the dialog.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { resetViewport, setViewportWidth } from '../../viewport';

const BELTS_URL = `${TEST_API_URL}/belts`;

interface PutControl {
  count: number;
  /** How the PUT answers: the mock saves (`ok`), a 400 or a network failure. */
  answer: 'ok' | 'error400' | 'network';
  /** From now on the PUTs wait, on their way, until `release`. */
  hold: () => void;
  /** The PUTs held answer, and the next ones answer right away. */
  release: () => void;
}

function controlPuts(): PutControl {
  let held = Promise.resolve();
  let open: () => void = () => undefined;
  const control: PutControl = {
    count: 0,
    answer: 'ok',
    hold: () => {
      held = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      open();
    },
  };
  server.use(
    http.put(`${BELTS_URL}/:id`, async () => {
      control.count += 1;
      await held;
      if (control.answer === 'error400') {
        return HttpResponse.json({ message: 'Ordem: deve estar entre 0 e 99' }, { status: 400 });
      }
      if (control.answer === 'network') return HttpResponse.error();
      return undefined;
    }),
  );
  return control;
}

async function openCinza(): Promise<{ user: UserEvent; dialog: HTMLElement }> {
  // Name, order, kyū, level and colors are fields only for the admin master (#143).
  const { user } = await renderApp({ route: '/faixas', signedInAs: 'master' });
  await screen.findByRole('table', { name: 'Faixas' });
  await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza' }));
  const dialog = await screen.findByRole('dialog', { name: 'Editar faixa Cinza' });
  return { user, dialog };
}

describe('belts screen, one PUT by every path (§ 6.5)', () => {
  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  it('Esc, close and cancel in the same tick as the save keep the dialog until the answer', async () => {
    const puts = controlPuts();
    puts.hold();
    const { dialog } = await openCinza();
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
      fireEvent.keyDown(within(dialog).getByLabelText(/^Nome/), { key: 'Escape' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    });
    expect(screen.getByRole('dialog', { name: 'Editar faixa Cinza' })).toBeInTheDocument();
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    // The PUT is on its way: the dialog stays.
    expect(screen.getByRole('dialog', { name: 'Editar faixa Cinza' })).toBeInTheDocument();

    puts.release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza salva.');
    expect(puts.count).toBe(1);
  });

  it('Esc while the PUT is on its way does not close the dialog nor send again', async () => {
    const puts = controlPuts();
    puts.hold();
    const { user, dialog } = await openCinza();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Editar faixa Cinza' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    // Still on its way: the dialog stays and nothing was sent again.
    expect(screen.getByRole('dialog', { name: 'Editar faixa Cinza' })).toBeInTheDocument();
    expect(puts.count).toBe(1);

    puts.release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts.count).toBe(1);
  });

  it('after a 400, a double click on the retry sends one more PUT and saves', async () => {
    const puts = controlPuts();
    puts.answer = 'error400';
    const { user, dialog } = await openCinza();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await within(dialog).findByRole('alert');
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    });
    expect(puts.count).toBe(1);

    puts.answer = 'ok';
    puts.hold();
    await user.dblClick(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(puts.count).toBe(2);
    });
    expect(screen.getByRole('dialog', { name: 'Editar faixa Cinza' })).toBeInTheDocument();
    puts.release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts.count).toBe(2);
  });

  it('after a network failure the lock is released: Esc closes and a new opening saves once', async () => {
    const puts = controlPuts();
    puts.answer = 'network';
    const { user, dialog } = await openCinza();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await within(dialog).findByRole('alert');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar faixa Cinza' })).toHaveFocus();
    });

    puts.answer = 'ok';
    await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza' }));
    const again = await screen.findByRole('dialog', { name: 'Editar faixa Cinza' });
    expect(within(again).queryByRole('alert')).not.toBeInTheDocument();
    puts.hold();
    await user.dblClick(within(again).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(puts.count).toBe(2);
    });
    expect(screen.getByRole('dialog', { name: 'Editar faixa Cinza' })).toBeInTheDocument();
    puts.release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts.count).toBe(2);
  });

  it('reopening right after a save and saving again sends one PUT each', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openCinza();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza' }));
    const again = await screen.findByRole('dialog', { name: 'Editar faixa Cinza' });
    await user.click(within(again).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts.count).toBe(2);
  });
});

describe('belts screen on the phone (§ 6.7)', () => {
  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });
  afterEach(() => {
    resetViewport();
  });

  it('a refused ceiling and a double click on the phone: message, focus, then one PUT and focus back', async () => {
    setViewportWidth(390);
    const puts = controlPuts();
    const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    await screen.findByRole('list', { name: 'Faixas' });
    await user.click(screen.getByRole('button', { name: 'Editar faixa Verde' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar faixa Verde' });
    const months = within(dialog).getByLabelText(/^Carência/);
    await user.clear(months);
    await user.type(months, '241');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(months).toHaveAccessibleDescription(/Use um número inteiro de 0 a 240\./);
    expect(months).toHaveFocus();
    expect(puts.count).toBe(0);

    await user.clear(months);
    await user.type(months, '240');
    puts.hold();
    await user.dblClick(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    expect(screen.getByRole('dialog', { name: 'Editar faixa Verde' })).toBeInTheDocument();
    puts.release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts.count).toBe(1);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar faixa Verde' })).toHaveFocus();
    });
  });
});

describe('belts screen, card #47 ceilings in the dialog (RN015)', () => {
  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  async function fill(user: UserEvent, dialog: HTMLElement, label: RegExp, value: string) {
    const field = within(dialog).getByLabelText(label);
    await user.clear(field);
    await user.type(field, value);
    return field;
  }

  it('rn015 saves the ceilings: order 99, age 99, months 240', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openCinza();
    await fill(user, dialog, /^Ordem/, '99');
    await fill(user, dialog, /^Idade mínima/, '99');
    await fill(user, dialog, /^Carência/, '240');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts.count).toBe(1);
    const row = screen.getByRole('rowheader', { name: 'Cinza' }).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('99');
    expect(row).toHaveTextContent('240');
  });

  it('rn015 refuses one past each ceiling, focusing the first invalid field, with no PUT', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openCinza();
    await fill(user, dialog, /^Ordem/, '99');
    const age = await fill(user, dialog, /^Idade mínima/, '100');
    const months = await fill(user, dialog, /^Carência/, '241');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(age).toHaveAccessibleDescription(/Use um número inteiro de 0 a 99\./);
    expect(months).toHaveAccessibleDescription(/Use um número inteiro de 0 a 240\./);
    expect(age).toHaveFocus();
    expect(puts.count).toBe(0);
  });

  it('rn015 refuses a huge number, an exponent and a sign with the range message', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openCinza();
    const order = await fill(user, dialog, /^Ordem/, '99999999999999999999');
    const age = await fill(user, dialog, /^Idade mínima/, '1e3');
    const months = await fill(user, dialog, /^Carência/, '-1');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(order).toHaveAccessibleDescription(/Use um número inteiro de 0 a 99\./);
    expect(age).toHaveAccessibleDescription(/Use um número inteiro de 0 a 99\./);
    expect(months).toHaveAccessibleDescription(/Use um número inteiro de 0 a 240\./);
    expect(order).toHaveFocus();
    expect(puts.count).toBe(0);
  });

  it('the message goes away when the field is edited, and a fixed value is sent', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openCinza();
    const order = await fill(user, dialog, /^Ordem/, '100');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(within(dialog).getByText('Use um número inteiro de 0 a 99.')).toBeInTheDocument();
    await user.clear(order);
    expect(within(dialog).queryByText('Use um número inteiro de 0 a 99.')).not.toBeInTheDocument();
    await user.type(order, ' 0 ');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    // Order 0 belongs to another belt: the mock answers 409 and only that PUT was sent.
    await within(dialog).findByRole('alert');
    expect(puts.count).toBe(1);
  });
});
