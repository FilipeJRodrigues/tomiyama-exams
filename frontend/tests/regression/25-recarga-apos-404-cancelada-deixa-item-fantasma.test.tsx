/**
 * Erro: na tela "Requisitos" (§ 6.5, RN017), um "Excluir" que recebe 404 ("Requisito não
 * encontrado": outro examinador já o excluiu) recarrega a lista (`reloadOnConflict`). Se
 * outra gravação é confirmada enquanto essa recarga ainda está a caminho (rede lenta, Lambda
 * fria), `applyConfirmedWrite` a cancela com `cancelQueries` (que devolve o estado anterior)
 * e não a busca de novo, porque a lista já tinha dados: o item que a API disse não existir
 * continua na lista, sem nova recarga até trocar o filtro ou a tela. O mesmo vale para uma
 * recarga por foco da janela que traria a mudança de outro examinador.
 * Esperado: depois do 404 a lista fica sem o item, mesmo que outra gravação seja confirmada
 * durante a recarga (o que a API confirmou também fica).
 * Issue: #25
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Requirement } from '../../src/api/types';
import { createMockDb, mockBelts, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const REQUIREMENTS_URL = `${TEST_API_URL}/requirements`;
const BRANCA_CINZA = mockBelts.find((belt) => belt.name === 'Branca/Cinza')!.id;

let db: MockDb;
let holdNext: boolean;
/** Lets the held GET answer (with the list as it was when it was asked). */
let release: (() => void) | null;

function descriptions(): string[] {
  const table = screen.getByRole('table', { name: 'Requisitos' });
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map((row) => row.querySelectorAll('th, td')[3]?.textContent.trim() ?? '');
}

describe('lista de requisitos depois de um 404 com outra gravação durante a recarga (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    holdNext = false;
    release = null;
    server.use(
      http.get(REQUIREMENTS_URL, async ({ request }) => {
        const belt = new URL(request.url).searchParams.get('belt_id');
        if (!holdNext || belt !== BRANCA_CINZA) return undefined;
        holdNext = false;
        const snapshot = db.requirements
          .filter((item) => item.belt_id === belt)
          .map((item) => ({ ...item }))
          .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json<Requirement[]>(snapshot);
      }),
    );
  });

  it('rn017 o item excluído por outro examinador sai da lista mesmo com outra exclusão confirmada', async () => {
    const { user } = await renderApp({ route: '/requisitos', signedInAs: 'examiner' });
    await screen.findByRole('table', { name: 'Requisitos' });
    const gone = db.requirements.find(
      (item) => item.belt_id === BRANCA_CINZA && item.description === 'Osoto gari',
    ) as Requirement;
    const other = db.requirements.find(
      (item) => item.belt_id === BRANCA_CINZA && item.description !== 'Osoto gari',
    ) as Requirement;
    // Another examiner deletes "Osoto gari".
    db.requirements = db.requirements.filter((item) => item.id !== gone.id);

    holdNext = true;
    await user.click(screen.getByRole('button', { name: 'Excluir Osoto gari' }));
    let dialog = await screen.findByRole('dialog', { name: 'Excluir requisito' });
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Requisito não encontrado');
    // The reload asked by the 404 is on its way.
    await waitFor(() => {
      expect(release).not.toBeNull();
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Excluir requisito' })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: `Excluir ${other.description}` }));
    dialog = await screen.findByRole('dialog', { name: 'Excluir requisito' });
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Requisito excluído.');
    release?.();

    await waitFor(() => {
      expect(descriptions()).not.toContain(other.description);
      expect(descriptions()).not.toContain('Osoto gari');
    });
    expect(screen.getByText(/^4 itens/)).toBeInTheDocument();
  });
});
