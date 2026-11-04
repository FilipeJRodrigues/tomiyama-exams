/**
 * Requirements screen (§ 6.5): the list of one belt in sheet order, the belt filter (default
 * Branca/Cinza) and the kind filter, and the screen states (loading, empty, load error with
 * "Tentar de novo", examiners only, cards on the phone).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Requirement } from '../../../src/api/types';
import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import {
  REQUIREMENTS_URL,
  beltFilter,
  beltId,
  kindFilter,
  openRequirements,
  recordRequests,
  rowDescriptions,
  tableRows,
} from './helpers';

const BRANCA_CINZA_SHEET = [
  'Demonstrar saudação em pé',
  'Amortecimento de quedas (deitado)',
  'Deashi barai',
  'Osoto gari',
  'Professor',
  'Contar até 10 em japonês',
];

let db: MockDb;

describe('requirements screen (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('opens on Branca/Cinza, every kind, in sheet order, with every field', async () => {
    const requests = recordRequests();
    await openRequirements();
    expect(screen.getByRole('heading', { level: 1, name: 'Requisitos' })).toBeInTheDocument();
    expect(beltFilter()).toHaveValue(beltId('Branca/Cinza'));
    expect(within(beltFilter()).getByRole('option', { selected: true })).toHaveTextContent(
      'Branca/Cinza',
    );
    expect(kindFilter()).toHaveValue('');
    expect(within(kindFilter()).getByRole('option', { selected: true })).toHaveTextContent('Todos');
    expect(rowDescriptions()).toEqual(BRANCA_CINZA_SHEET);
    expect(tableRows()[0]).toEqual([
      '1',
      'Prático',
      'Fundamentos',
      'Demonstrar saudação em pé',
      'Ritsurei',
      'EditarExcluir',
    ]);
    // No expected answer: a dash, never an empty cell.
    expect(tableRows()[2]?.slice(0, 5)).toEqual(['3', 'Prático', 'Naguewaza', 'Deashi barai', '—']);
    expect(screen.getByText('6 itens: 2 teóricos e 4 práticos')).toBeInTheDocument();

    const gets = requests.filter((request) => request.method === 'GET');
    expect(gets).toHaveLength(1);
    const query = new URL(gets[0]?.url ?? '').searchParams;
    expect(query.get('belt_id')).toBe(beltId('Branca/Cinza'));
    expect(query.has('kind')).toBe(false);
  });

  it('offers the belts in graduation order and the kinds with pt-BR labels', async () => {
    await openRequirements();
    const belts = within(beltFilter())
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(belts).toEqual(
      [...db.belts].sort((a, b) => a.sort_order - b.sort_order).map((belt) => belt.name),
    );
    const kinds = within(kindFilter())
      .getAllByRole('option')
      .map((option) => [option.getAttribute('value'), option.textContent]);
    expect(kinds).toEqual([
      ['', 'Todos'],
      ['THEORY', 'Teórico'],
      ['PRACTICE', 'Prático'],
    ]);
  });

  it('keeps the sheet order even when the API sends the items shuffled', async () => {
    const shuffled: Requirement[] = db.requirements
      .filter((item) => item.belt_id === beltId('Branca/Cinza'))
      .reverse();
    server.use(http.get(REQUIREMENTS_URL, () => HttpResponse.json(shuffled)));
    await openRequirements();
    expect(rowDescriptions()).toEqual(BRANCA_CINZA_SHEET);
  });

  it('rn017 the belt filter asks the API for the chosen belt', async () => {
    const requests = recordRequests();
    const { user } = await openRequirements();
    await user.selectOptions(beltFilter(), 'Roxa');

    await waitFor(() => {
      expect(rowDescriptions()).toEqual(['Ogoshi', 'Koshi guruma', 'Professor']);
    });
    const last = requests.filter((request) => request.method === 'GET').at(-1);
    expect(new URL(last?.url ?? '').searchParams.get('belt_id')).toBe(beltId('Roxa'));
    expect(screen.getByText('3 itens: 1 teórico e 2 práticos')).toBeInTheDocument();
  });

  it('rn017 the kind filter asks the API for one kind, and "Todos" for both', async () => {
    const requests = recordRequests();
    const { user } = await openRequirements();

    await user.selectOptions(kindFilter(), 'Teórico');
    await waitFor(() => {
      expect(rowDescriptions()).toEqual(['Professor', 'Contar até 10 em japonês']);
    });
    let last = requests.filter((request) => request.method === 'GET').at(-1);
    expect(new URL(last?.url ?? '').searchParams.get('kind')).toBe('THEORY');
    expect(screen.getByText('2 itens')).toBeInTheDocument();

    await user.selectOptions(kindFilter(), 'Prático');
    await waitFor(() => {
      expect(rowDescriptions()).toEqual(BRANCA_CINZA_SHEET.slice(0, 4));
    });
    last = requests.filter((request) => request.method === 'GET').at(-1);
    expect(new URL(last?.url ?? '').searchParams.get('kind')).toBe('PRACTICE');

    // Belt and kind together; the kind stays when the belt changes.
    await user.selectOptions(beltFilter(), 'Marrom');
    await waitFor(() => {
      expect(rowDescriptions()).toEqual([
        'Demonstrar saudação em pé',
        'Demonstrar saudação ajoelhado',
        'Deashi barai',
        'Osoto gari',
      ]);
    });
    expect(kindFilter()).toHaveValue('PRACTICE');

    await user.selectOptions(kindFilter(), 'Todos');
    await waitFor(() => {
      expect(rowDescriptions()).toHaveLength(7);
    });
  });

  it('says so when the belt (or the belt and kind) has no item', async () => {
    const { user } = await openRequirements();
    await user.selectOptions(beltFilter(), 'Cinza');
    expect(await screen.findByText('Nenhum item nesta faixa.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The filters and "Novo requisito" stay: the empty belt can get its first item.
    expect(screen.getByRole('button', { name: 'Novo requisito' })).toBeInTheDocument();

    await user.selectOptions(beltFilter(), 'Amarela/Laranja');
    await screen.findByRole('table', { name: 'Requisitos' });
    await user.selectOptions(kindFilter(), 'Prático');
    expect(await screen.findByText('Nenhum item prático nesta faixa.')).toBeInTheDocument();
    await user.selectOptions(beltFilter(), 'Cinza');
    await user.selectOptions(kindFilter(), 'Teórico');
    expect(await screen.findByText('Nenhum item teórico nesta faixa.')).toBeInTheDocument();
  });

  it('shows a loading state while GET /requirements is on its way', async () => {
    server.use(
      http.get(REQUIREMENTS_URL, async () => {
        await delay('infinite');
        return HttpResponse.json([]);
      }),
    );
    await renderApp({ route: '/requisitos', signedInAs: 'examiner' });
    expect(await screen.findByText('Carregando requisitos…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Carregando requisitos…');
    // The filters are there already.
    expect(beltFilter()).toHaveValue(beltId('Branca/Cinza'));
  });

  it('shows the load error from the API and loads again with "Tentar de novo"', async () => {
    let fail = true;
    server.use(
      http.get(REQUIREMENTS_URL, () => {
        if (!fail) return undefined;
        return HttpResponse.json(
          { message: 'Sistema ocupado no momento. Tente de novo em instantes.' },
          { status: 503 },
        );
      }),
    );
    const { user } = await renderApp({ route: '/requisitos', signedInAs: 'examiner' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar os requisitos');
    expect(alert).toHaveTextContent('Sistema ocupado no momento. Tente de novo em instantes.');

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    await screen.findByRole('table', { name: 'Requisitos' });
    expect(rowDescriptions()).toEqual(BRANCA_CINZA_SHEET);
  });

  it('shows the load error of the belts with "Tentar de novo" and no list', async () => {
    let fail = true;
    server.use(
      http.get(`${TEST_API_URL}/belts`, () =>
        fail ? HttpResponse.json({ message: 'Falha simulada' }, { status: 500 }) : undefined,
      ),
    );
    const { user } = await renderApp({ route: '/requisitos', signedInAs: 'examiner' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar as faixas');
    expect(screen.queryByRole('button', { name: 'Novo requisito' })).not.toBeInTheDocument();

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    await screen.findByRole('table', { name: 'Requisitos' });
  });

  it('a 403 on the list says "Sem permissão", without "Tentar de novo"', async () => {
    server.use(
      http.get(REQUIREMENTS_URL, () =>
        HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
      ),
    );
    await renderApp({ route: '/requisitos', signedInAs: 'examiner' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos examinadores');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('defaults to the second belt in graduation order when Branca/Cinza was renamed', async () => {
    db.belts = db.belts.map((belt) =>
      belt.name === 'Branca/Cinza' ? { ...belt, name: 'Branca e cinza' } : belt,
    );
    await openRequirements();
    expect(beltFilter()).toHaveValue(beltId('Branca/Cinza'));
    expect(rowDescriptions()).toEqual(BRANCA_CINZA_SHEET);
  });

  it('shows the long belt whole (Marrom has 139 items in the real sheet)', async () => {
    const marrom = beltId('Marrom');
    db.requirements = db.requirements.filter((item) => item.belt_id !== marrom);
    for (let order = 1; order <= 139; order += 1) {
      db.requirements.push({
        id: `long-${String(order).padStart(3, '0')}`,
        belt_id: marrom,
        kind: order % 3 === 0 ? 'THEORY' : 'PRACTICE',
        category: 'Naguewaza',
        description: `Item ${String(order)}`,
        expected_answer: null,
        sort_order: order,
      });
    }
    const { user } = await openRequirements();
    await user.selectOptions(beltFilter(), 'Marrom');
    await waitFor(() => {
      expect(rowDescriptions()).toHaveLength(139);
    });
    expect(rowDescriptions().at(-1)).toBe('Item 139');
    expect(screen.getByText('139 itens: 46 teóricos e 93 práticos')).toBeInTheDocument();
    // The table scrolls inside its own region, never the page (§ 6.7).
    expect(screen.getByRole('region', { name: 'Lista de requisitos' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('shows cards on the phone (390 px), each with its buttons', async () => {
    setViewportWidth(390);
    await renderApp({ route: '/requisitos', signedInAs: 'examiner' });
    const list = await screen.findByRole('list', { name: 'Requisitos' });
    const cards = within(list).getAllByRole('listitem');
    expect(
      cards.map((card) => within(card).getByRole('heading', { level: 2 }).textContent),
    ).toEqual(BRANCA_CINZA_SHEET);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const first = cards[0]!;
    expect(within(first).getByText('Prático')).toBeInTheDocument();
    expect(within(first).getByText('Ritsurei')).toBeInTheDocument();
    expect(
      within(first).getByRole('button', { name: 'Editar Demonstrar saudação em pé' }),
    ).toBeInTheDocument();
    expect(
      within(first).getByRole('button', { name: 'Excluir Demonstrar saudação em pé' }),
    ).toBeInTheDocument();
  });

  it('is for examiners only: a guardian gets the notice and no requirements request', async () => {
    const requests = recordRequests();
    await renderApp({ route: '/requisitos', signedInAs: 'guardian' });
    expect(
      await screen.findByRole('heading', { name: 'Esta área é dos examinadores' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Novo requisito' })).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });
});
