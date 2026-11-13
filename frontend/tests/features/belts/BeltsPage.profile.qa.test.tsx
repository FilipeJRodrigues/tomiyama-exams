/**
 * QA (#143): the belt dialog of an examiner who is not the admin master, beyond the feature
 * tests. The tests of the full form (double send, Enter while closing) moved to the master;
 * these keep the same guarantees in the limited mode, and pin the body sent for the belts
 * whose optional fields come empty (no kyū, one color) in every shape the API may use.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Belt } from '../../../src/api/types';
import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { holdExitTransitions } from '../../exitTransitions';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const BELTS_URL = `${TEST_API_URL}/belts`;
const BRANCA = mockBelts.find((belt) => belt.name === 'Branca')!;

let db: MockDb;

/** Counts the PUTs and keeps their raw bodies; the first waits for `releaseFirst()`. */
function controlPuts() {
  let open: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    open = resolve;
  });
  const control = {
    bodies: [] as string[],
    releaseFirst: () => {
      open();
    },
  };
  server.use(
    http.put(`${BELTS_URL}/:id`, async ({ request }) => {
      control.bodies.push(await request.clone().text());
      if (control.bodies.length === 1) await first;
      return undefined;
    }),
  );
  return control;
}

async function openEditor(name: string): Promise<{ user: UserEvent; dialog: HTMLElement }> {
  const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
  await screen.findByRole('table', { name: 'Faixas' });
  await user.click(screen.getByRole('button', { name: `Editar faixa ${name}` }));
  const dialog = await screen.findByRole('dialog', { name: `Editar faixa ${name}` });
  return { user, dialog };
}

function ageField(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('textbox', { name: /^Idade mínima/ });
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

describe('belt dialog of an examiner who is not the master: one PUT per send (#143)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('a double click on "Salvar" sends one PUT', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openEditor('Cinza');
    await user.dblClick(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(puts.bodies).toHaveLength(1);
    });
    puts.releaseFirst();
    await dialogGone();
    expect(puts.bodies).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza salva.');
  });

  it('Enter twice in Idade mínima sends one PUT', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openEditor('Cinza');
    await user.click(ageField(dialog));
    await user.keyboard('{Enter}{Enter}');
    await waitFor(() => {
      expect(puts.bodies).toHaveLength(1);
    });
    puts.releaseFirst();
    await dialogGone();
    expect(puts.bodies).toHaveLength(1);
  });

  it('Enter again in Idade mínima while the dialog closes sends no other PUT (#88)', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openEditor('Cinza');
    await user.click(ageField(dialog));
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(puts.bodies).toHaveLength(1);
    });
    const exit = holdExitTransitions();
    puts.releaseFirst();
    expect(await screen.findByRole('status')).toHaveTextContent('Faixa Cinza salva.');
    expect(screen.getByRole('dialog', { name: 'Editar faixa Cinza' })).toBeInTheDocument();

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(puts.bodies).toHaveLength(1);
  });
});

describe('belt dialog of an examiner who is not the master: the body as read (#143)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn001 rn002 a belt with no kyū and one color goes back with kyu and color_secondary null', async () => {
    const puts = controlPuts();
    const { user, dialog } = await openEditor('Branca');
    await user.clear(ageField(dialog));
    await user.type(ageField(dialog), ' 3 ');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    puts.releaseFirst();
    await dialogGone();

    expect(puts.bodies).toHaveLength(1);
    expect(JSON.parse(puts.bodies[0]!)).toStrictEqual({
      name: 'Branca',
      kyu: null,
      sort_order: 0,
      level: 'BASIC',
      min_age_years: 3,
      min_months_previous: 0,
      color_primary: '#FFFFFF',
      color_secondary: null,
    });
    expect(db.belts.find((belt) => belt.id === BRANCA.id)).toEqual({
      ...BRANCA,
      min_age_years: 3,
    });
  });

  it.each([
    ['""', ''],
    ['absent', undefined],
  ])(
    'a GET with color_secondary %s goes back the same way and is accepted',
    async (_label, secondary) => {
      server.use(
        http.get(BELTS_URL, () =>
          HttpResponse.json(
            db.belts.map((belt) => {
              if (belt.id !== BRANCA.id) return belt;
              const copy: Partial<Belt> = { ...belt };
              delete copy.color_secondary;
              return (
                secondary === undefined ? copy : { ...copy, color_secondary: secondary }
              ) as Belt;
            }),
          ),
        ),
      );
      const puts = controlPuts();
      const { user, dialog } = await openEditor('Branca');
      expect(within(dialog).getByRole('region', { name: 'Dados da faixa' })).toHaveTextContent(
        '#FFFFFF',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
      puts.releaseFirst();
      await dialogGone();
      const sent = JSON.parse(puts.bodies[0]!) as Record<string, unknown>;
      expect(sent.color_secondary).toBe(secondary);
      expect(screen.getByRole('status')).toHaveTextContent('Faixa Branca salva.');
    },
  );
});
