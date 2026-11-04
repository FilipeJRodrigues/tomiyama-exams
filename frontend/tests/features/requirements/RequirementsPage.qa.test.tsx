/**
 * Requirements screen (§ 6.5, § 6.7), cases added by qa-frontend (#25): the kind filter
 * stays when the belt changes, 503 and 404 messages, Tab through the page, 401 on a save.
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
  kindFilter,
  openRequirements,
  recordRequests,
  replaceText,
  rowDescriptions,
} from './helpers';

let db: MockDb;

beforeEach(() => {
  db = createMockDb();
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
});

describe('requirements screen, more cases (§ 6.5, § 6.7)', () => {
  it('o tipo do filtro fica ao trocar a faixa, e o GET leva os dois filtros', async () => {
    const requests = recordRequests();
    const { user } = await openRequirements();
    await user.selectOptions(kindFilter(), 'Prático');
    await user.selectOptions(beltFilter(), 'Cinza');
    expect(kindFilter().value).toBe('PRACTICE');
    await waitFor(() => {
      const last = requests.filter((r) => r.method === 'GET').at(-1);
      expect(last?.url).toContain(`belt_id=${beltId('Cinza')}`);
      expect(last?.url).toContain('kind=PRACTICE');
    });
  });

  it('503 sem corpo no salvar mostra a mensagem em pt-BR e mantém o diálogo e os valores', async () => {
    const { user } = await openRequirements();
    server.use(http.post(REQUIREMENTS_URL, () => new HttpResponse(null, { status: 503 })));
    await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Teórico');
    await replaceText(user, within(dialog).getByLabelText(/^Categoria/), 'Vocabulário');
    await replaceText(user, within(dialog).getByLabelText(/^Descrição/), 'Começar');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Serviço indisponível. Tente de novo em instantes.',
    );
    expect(within(dialog).getByLabelText(/^Descrição/)).toHaveValue('Começar');
    expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
  });

  it('404 no excluir mostra a mensagem e a lista se atualiza sem o item', async () => {
    const { user } = await openRequirements();
    const target = db.requirements.find(
      (item) => item.belt_id === beltId('Branca/Cinza') && item.description === 'Osoto gari',
    ) as Requirement;
    db.requirements = db.requirements.filter((item) => item.id !== target.id);
    await user.click(screen.getByRole('button', { name: 'Excluir Osoto gari' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir requisito' });
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Requisito não encontrado');
    await waitFor(() => {
      expect(rowDescriptions()).not.toContain('Osoto gari');
    });
  });

  it('Tab alcança filtros, "Novo requisito", a tabela e os botões das linhas', async () => {
    const { user } = await openRequirements();
    const reached = new Set<Element>();
    for (let i = 0; i < 40; i += 1) {
      await user.tab();
      if (document.activeElement) reached.add(document.activeElement);
    }
    expect(reached).toContain(beltFilter());
    expect(reached).toContain(kindFilter());
    expect(reached).toContain(screen.getByRole('button', { name: 'Novo requisito' }));
    expect(reached).toContain(screen.getByRole('region', { name: 'Lista de requisitos' }));
    expect(reached).toContain(screen.getByRole('button', { name: 'Editar Osoto gari' }));
    expect(reached).toContain(screen.getByRole('button', { name: 'Excluir Osoto gari' }));
  });

  it('401 no salvar encerra a sessão', async () => {
    const { user } = await openRequirements();
    server.use(
      http.post(REQUIREMENTS_URL, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Teórico');
    await replaceText(user, within(dialog).getByLabelText(/^Categoria/), 'Vocabulário');
    await replaceText(user, within(dialog).getByLabelText(/^Descrição/), 'Começar');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('button', { name: /^Entrar/ })).toBeInTheDocument();
  });
});
