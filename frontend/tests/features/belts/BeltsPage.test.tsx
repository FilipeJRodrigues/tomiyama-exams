/**
 * Belts screen (§ 6.5): the list in graduation order, the edit dialog (`PUT /belts/{id}`,
 * RN015, checked by the API) and the screen states (loading, empty, load error with
 * "Tentar de novo", saving, saved, examiners only).
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Belt, BeltInput } from '../../../src/api/types';
import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const BELTS_URL = `${TEST_API_URL}/belts`;
const CINZA = mockBelts.find((belt) => belt.name === 'Cinza')!;

const BELT_NAMES_IN_ORDER = [
  'Branca',
  'Branca/Cinza',
  'Cinza',
  'Cinza/Azul',
  'Azul',
  'Azul/Amarela',
  'Amarela',
  'Amarela/Laranja',
  'Laranja',
  'Verde',
  'Roxa',
  'Marrom',
];

let db: MockDb;

function tableRows(): string[][] {
  const table = screen.getByRole('table', { name: 'Faixas' });
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent.trim()),
  );
}

function rowNames(): string[] {
  return tableRows().map((cells) => cells[1] ?? '');
}

/** The edits below change name, order and colors: fields only for the admin master (#143). */
async function openBelts(role: 'master' | 'examiner' | 'guardian' = 'master') {
  const result = await renderApp({ route: '/faixas', signedInAs: role });
  if (role !== 'guardian') await screen.findByRole('table', { name: 'Faixas' });
  return result;
}

/** Replace the text of a field (paste: same React events, less work for the suite). */
async function replaceText(user: UserEvent, input: HTMLElement, text: string) {
  await user.clear(input);
  if (text) {
    await user.click(input);
    await user.paste(text);
  }
}

function recordPuts(): { url: string; body: BeltInput }[] {
  const puts: { url: string; body: BeltInput }[] = [];
  server.use(
    http.put(`${BELTS_URL}/:id`, async ({ request }) => {
      puts.push({ url: request.url, body: (await request.clone().json()) as BeltInput });
      return undefined;
    }),
  );
  return puts;
}

function countGets(): { count: number } {
  const counter = { count: 0 };
  server.use(
    http.get(BELTS_URL, () => {
      counter.count += 1;
      return undefined;
    }),
  );
  return counter;
}

async function openEditor(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: `Editar faixa ${name}` }));
  return screen.findByRole('dialog', { name: `Editar faixa ${name}` });
}

describe('belts screen (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('lists the belts in graduation order with every field of the model', async () => {
    await openBelts();
    expect(screen.getByRole('heading', { level: 1, name: 'Faixas' })).toBeInTheDocument();
    expect(rowNames()).toEqual(BELT_NAMES_IN_ORDER);
    const rows = tableRows();
    expect(rows[0]).toEqual([
      '0',
      'Branca',
      '—',
      'Básico',
      'Sem mínimo',
      'Sem carência',
      '#FFFFFF',
      'Editar',
    ]);
    expect(rows[3]).toEqual([
      '3',
      'Cinza/Azul',
      '9',
      'Básico',
      '6 anos',
      '6 meses',
      '#9E9E9E, pontas #1E63C6',
      'Editar',
    ]);
    expect(rows[8]?.slice(0, 6)).toEqual([
      '8',
      'Laranja',
      '4',
      'Intermediário',
      '11 anos',
      '12 meses',
    ]);
  });

  it('keeps the graduation order even when the API sends the belts shuffled', async () => {
    const shuffled: Belt[] = [...db.belts].reverse();
    server.use(http.get(BELTS_URL, () => HttpResponse.json(shuffled)));
    await openBelts();
    expect(rowNames()).toEqual(BELT_NAMES_IN_ORDER);
  });

  it('shows a loading state while GET /belts is on its way', async () => {
    server.use(
      http.get(BELTS_URL, async () => {
        await delay('infinite');
        return HttpResponse.json([]);
      }),
    );
    await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando faixas…');
  });

  it('says so when there is no belt', async () => {
    server.use(http.get(BELTS_URL, () => HttpResponse.json([])));
    await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    expect(await screen.findByText('Nenhuma faixa cadastrada.')).toBeInTheDocument();
  });

  it('shows the load error from the API and loads again with "Tentar de novo"', async () => {
    let fail = true;
    server.use(
      http.get(BELTS_URL, () => {
        if (!fail) return undefined;
        return HttpResponse.json(
          { message: 'Sistema ocupado no momento. Tente de novo em instantes.' },
          { status: 503 },
        );
      }),
    );
    const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar as faixas');
    expect(alert).toHaveTextContent('Sistema ocupado no momento. Tente de novo em instantes.');

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    await screen.findByRole('table', { name: 'Faixas' });
    expect(rowNames()).toEqual(BELT_NAMES_IN_ORDER);
  });

  it('edits a belt: sends every field, closes the dialog and updates the list', async () => {
    const { user } = await openBelts();
    const puts = recordPuts();
    const gets = countGets();
    const dialog = await openEditor(user, 'Cinza');

    expect(within(dialog).getByLabelText(/^Nome/)).toHaveValue('Cinza');
    expect(within(dialog).getByLabelText(/^Ordem/)).toHaveValue('2');
    expect(within(dialog).getByRole('combobox', { name: 'Kyū' })).toHaveValue('10');
    expect(within(dialog).getByRole('combobox', { name: /^Nível/ })).toHaveValue('BASIC');
    expect(within(dialog).getByLabelText(/^Cor das pontas/)).toHaveValue('');

    await replaceText(user, within(dialog).getByLabelText(/^Idade mínima/), '6');
    await replaceText(user, within(dialog).getByLabelText(/^Cor das pontas/), '#1e63c6');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe(`${BELTS_URL}/${CINZA.id}`);
    expect(puts[0]?.body).toEqual({
      name: 'Cinza',
      kyu: 10,
      sort_order: 2,
      level: 'BASIC',
      min_age_years: 6,
      min_months_previous: 3,
      color_primary: '#9E9E9E',
      color_secondary: '#1E63C6',
    });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza salva.');
    expect(tableRows()[2]).toEqual([
      '2',
      'Cinza',
      '10',
      'Básico',
      '6 anos',
      '3 meses',
      '#9E9E9E, pontas #1E63C6',
      'Editar',
    ]);
    // The list is reloaded from the API after the save.
    await waitFor(() => {
      expect(gets.count).toBeGreaterThanOrEqual(1);
    });
    // The focus goes back to the belt's edit button (§ 6.7).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar faixa Cinza' })).toHaveFocus();
    });
  });

  it('moves the belt in the list when its order changes and keeps the focus on it', async () => {
    db.belts = db.belts.map((belt) =>
      belt.name === 'Marrom' ? { ...belt, sort_order: 20 } : belt,
    );
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Branca');
    await replaceText(user, within(dialog).getByLabelText(/^Ordem/), '15');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(rowNames().at(-2)).toBe('Branca');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar faixa Branca' })).toHaveFocus();
    });
  });

  it('shows the 400 message of the API in the dialog and keeps what was typed', async () => {
    server.use(
      http.put(`${BELTS_URL}/:id`, () =>
        HttpResponse.json({ message: 'Kyū: deve estar entre 1 e 11' }, { status: 400 }),
      ),
    );
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Verde');
    await replaceText(user, within(dialog).getByLabelText(/^Nome/), 'Verde escura');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível salvar');
    expect(alert).toHaveTextContent('Kyū: deve estar entre 1 e 11');
    expect(screen.getByRole('dialog', { name: 'Editar faixa Verde' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Nome/)).toHaveValue('Verde escura');
    expect(rowNames()).toContain('Verde');
  });

  it('rn015 shows the 409 of a taken order and saves nothing', async () => {
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    await replaceText(user, within(dialog).getByLabelText(/^Ordem/), '1');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Já existe uma faixa com esta ordem',
    );
    expect(db.belts.find((belt) => belt.id === CINZA.id)?.sort_order).toBe(2);
  });

  it('rn015 shows the 409 of a taken name, whatever the case', async () => {
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    await replaceText(user, within(dialog).getByLabelText(/^Nome/), 'azul');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Já existe uma faixa com este nome',
    );
  });

  it('shows the 404 of a belt gone meanwhile', async () => {
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Roxa');
    db.belts = db.belts.filter((belt) => belt.name !== 'Roxa');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Faixa não encontrada');
  });

  it('shows the 503 message of the API', async () => {
    server.use(
      http.put(`${BELTS_URL}/:id`, () =>
        HttpResponse.json(
          { message: 'Sistema ocupado no momento. Tente de novo em instantes.' },
          { status: 503 },
        ),
      ),
    );
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Azul');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Sistema ocupado no momento. Tente de novo em instantes.',
    );
  });

  it('checks the fields before sending and focuses the first invalid one', async () => {
    const { user } = await openBelts();
    const puts = recordPuts();
    const dialog = await openEditor(user, 'Azul');
    await replaceText(user, within(dialog).getByLabelText(/^Nome/), '');
    await replaceText(user, within(dialog).getByLabelText(/^Cor$|^Cor \*/), 'azul');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(within(dialog).getByText('Informe o nome.')).toBeInTheDocument();
    expect(within(dialog).getByText('Use o formato #RRGGBB.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Nome/)).toHaveFocus();
    expect(puts).toHaveLength(0);
  });

  it('shows the saving state and locks the dialog while the PUT is on its way', async () => {
    let release: () => void = () => undefined;
    server.use(
      http.put(`${BELTS_URL}/:id`, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      }),
    );
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Amarela');
    const save = within(dialog).getByRole('button', { name: 'Salvar' });
    await user.click(save);

    await waitFor(() => {
      expect(save).toHaveAttribute('data-loading', 'true');
    });
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Editar faixa Amarela' })).toBeInTheDocument();

    release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Amarela salva.');
  });

  it('closes the dialog with Esc, saves nothing and gives the focus back', async () => {
    const { user } = await openBelts();
    const puts = recordPuts();
    const dialog = await openEditor(user, 'Laranja');
    await replaceText(user, within(dialog).getByLabelText(/^Nome/), 'Outra');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(puts).toHaveLength(0);
    expect(rowNames()).toContain('Laranja');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar faixa Laranja' })).toHaveFocus();
    });

    // A new opening starts again from the belt.
    const again = await openEditor(user, 'Laranja');
    expect(within(again).getByLabelText(/^Nome/)).toHaveValue('Laranja');
  });

  it('closing the saved notice puts the focus on the title', async () => {
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const notice = await screen.findByRole('status');
    await user.click(within(notice).getByRole('button', { name: 'Fechar aviso' }));

    expect(screen.queryByText('Faixa Cinza salva.')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Faixas' })).toHaveFocus();
    });
  });

  it('shows cards on the phone (390 px), each with its edit button', async () => {
    setViewportWidth(390);
    const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    const list = await screen.findByRole('list', { name: 'Faixas' });
    const cards = within(list).getAllByRole('listitem');
    expect(
      cards.map((card) => within(card).getByRole('heading', { level: 2 }).textContent),
    ).toEqual(BELT_NAMES_IN_ORDER);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    const dialog = await openEditor(user, 'Verde');
    expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeInTheDocument();
  });

  it('is for examiners only: a guardian gets the notice and no belt request', async () => {
    const gets = countGets();
    await renderApp({ route: '/faixas', signedInAs: 'guardian' });
    expect(
      await screen.findByRole('heading', { name: 'Esta área é dos examinadores' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Editar faixa/ })).not.toBeInTheDocument();
    expect(gets.count).toBe(0);
  });
});
