/**
 * Requirements screen (§ 6.5), the writes: create (`POST /requirements`), edit
 * (`PUT /requirements/{id}`, every field) and delete with confirmation
 * (`DELETE /requirements/{id}`), with the API messages (RN017 409s, the full-belt 400), one
 * request per click, `Esc` and the focus back on the row (§ 6.7).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb, mockRequirementId, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { setViewportWidth } from '../../viewport';
import { renderApp } from '../../render';
import { gate } from '../academy/helpers';
import {
  REQUIREMENTS_URL,
  beltFilter,
  beltId,
  kindFilter,
  openRequirements,
  recordRequests,
  replaceText,
  rowDescriptions,
  tableRows,
  writes,
} from './helpers';

let db: MockDb;

async function openNew(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Novo requisito' }));
  return screen.findByRole('dialog', { name: 'Novo requisito' });
}

async function openEdit(user: UserEvent, description: string) {
  await user.click(screen.getByRole('button', { name: `Editar ${description}` }));
  return screen.findByRole('dialog', { name: 'Editar requisito' });
}

async function openDelete(user: UserEvent, description: string) {
  await user.click(screen.getByRole('button', { name: `Excluir ${description}` }));
  return screen.findByRole('dialog', { name: 'Excluir requisito' });
}

function field(dialog: HTMLElement, label: RegExp) {
  return within(dialog).getByLabelText(label);
}

async function fillNew(user: UserEvent, dialog: HTMLElement) {
  await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Teórico');
  await replaceText(user, field(dialog, /^Categoria/), ' Vocabulário ');
  await replaceText(user, field(dialog, /^Descrição/), 'Começar');
  await replaceText(user, field(dialog, /^Resposta esperada/), 'Hajime');
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

describe('requirements screen, create and edit (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('creates an item at the end of the belt: no order sent, notice, focus on its row', async () => {
    const { user } = await openRequirements();
    const requests = recordRequests();
    const dialog = await openNew(user);

    // The belt of the filter; the kind is chosen (the filter is "Todos").
    expect(within(dialog).getByRole('combobox', { name: /^Faixa/ })).toHaveValue(
      beltId('Branca/Cinza'),
    );
    expect(within(dialog).getByRole('combobox', { name: /^Tipo/ })).toHaveValue('');
    expect(field(dialog, /^Ordem/)).toHaveValue('');

    await fillNew(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    expect(writes(requests)).toEqual([
      {
        method: 'POST',
        url: REQUIREMENTS_URL,
        body: {
          belt_id: beltId('Branca/Cinza'),
          kind: 'THEORY',
          category: 'Vocabulário',
          description: 'Começar',
          expected_answer: 'Hajime',
        },
      },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Requisito criado.');
    expect(rowDescriptions().at(-1)).toBe('Começar');
    expect(tableRows().at(-1)?.slice(0, 5)).toEqual([
      '7',
      'Teórico',
      'Vocabulário',
      'Começar',
      'Hajime',
    ]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar Começar' })).toHaveFocus();
    });
  });

  it('a new item starts with the kind of the filter and may get an order', async () => {
    const { user } = await openRequirements();
    await user.selectOptions(kindFilter(), 'Prático');
    await waitFor(() => {
      expect(rowDescriptions()).toHaveLength(4);
    });
    const requests = recordRequests();
    const dialog = await openNew(user);
    expect(within(dialog).getByRole('combobox', { name: /^Tipo/ })).toHaveValue('PRACTICE');
    await replaceText(user, field(dialog, /^Categoria/), 'Naguewaza');
    await replaceText(user, field(dialog, /^Descrição/), 'Hiza guruma');
    await replaceText(user, field(dialog, /^Ordem/), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    expect(writes(requests)[0]?.body).toEqual({
      belt_id: beltId('Branca/Cinza'),
      kind: 'PRACTICE',
      category: 'Naguewaza',
      description: 'Hiza guruma',
      expected_answer: null,
      sort_order: 0,
    });
    expect(rowDescriptions()[0]).toBe('Hiza guruma');
  });

  it('an item created outside the filter says where it went and leaves the list as it was', async () => {
    const { user } = await openRequirements();
    const dialog = await openNew(user);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Faixa/ }), 'Cinza');
    await fillNew(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    expect(screen.getByRole('status')).toHaveTextContent(
      'Requisito criado na faixa Cinza (Teórico), fora do filtro atual.',
    );
    expect(rowDescriptions()).toHaveLength(6);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Novo requisito' })).toHaveFocus();
    });
    await user.selectOptions(beltFilter(), 'Cinza');
    await waitFor(() => {
      expect(rowDescriptions()).toEqual(['Começar']);
    });
  });

  it('checks the fields before sending and focuses the first invalid one', async () => {
    const { user } = await openRequirements();
    const requests = recordRequests();
    const dialog = await openNew(user);
    await replaceText(user, field(dialog, /^Ordem/), '10000');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(within(dialog).getByText('Escolha o tipo.')).toBeInTheDocument();
    expect(within(dialog).getByText('Informe a categoria.')).toBeInTheDocument();
    expect(within(dialog).getByText('Informe a descrição.')).toBeInTheDocument();
    expect(within(dialog).getByText('Use um número inteiro de 0 a 9999.')).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /^Tipo/ })).toHaveFocus();
    expect(writes(requests)).toHaveLength(0);
  });

  it('rn015 shows the 400 of a full belt (item at 9999), then saves with an order', async () => {
    db.requirements.push({
      id: 'last-of-sheet',
      belt_id: beltId('Branca/Cinza'),
      kind: 'THEORY',
      category: 'Histórico',
      description: 'Último item',
      expected_answer: null,
      sort_order: 9999,
    });
    const { user } = await openRequirements();
    const dialog = await openNew(user);
    await fillNew(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível salvar');
    expect(alert).toHaveTextContent(
      'Ordem: a faixa já tem um item na ordem 9999; informe a ordem do novo item',
    );
    expect(field(dialog, /^Descrição/)).toHaveValue('Começar');
    expect(db.requirements.filter((item) => item.description === 'Começar')).toHaveLength(0);

    await replaceText(user, field(dialog, /^Ordem/), '7');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(rowDescriptions()).toContain('Começar');
  });

  it('edits an item: every field is sent, the row changes and gets the focus back', async () => {
    const { user } = await openRequirements();
    const requests = recordRequests();
    const dialog = await openEdit(user, 'Professor');

    expect(within(dialog).getByRole('combobox', { name: /^Faixa/ })).toHaveValue(
      beltId('Branca/Cinza'),
    );
    expect(within(dialog).getByRole('combobox', { name: /^Tipo/ })).toHaveValue('THEORY');
    expect(field(dialog, /^Categoria/)).toHaveValue('Vocabulário');
    expect(field(dialog, /^Descrição/)).toHaveValue('Professor');
    expect(field(dialog, /^Resposta esperada/)).toHaveValue('Sensei');
    expect(field(dialog, /^Ordem/)).toHaveValue('5');

    await replaceText(user, field(dialog, /^Resposta esperada/), 'Sensei (professor)');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    const id = mockRequirementId('Branca/Cinza', 5);
    expect(writes(requests)).toEqual([
      {
        method: 'PUT',
        url: `${REQUIREMENTS_URL}/${id}`,
        body: {
          belt_id: beltId('Branca/Cinza'),
          kind: 'THEORY',
          category: 'Vocabulário',
          description: 'Professor',
          expected_answer: 'Sensei (professor)',
          sort_order: 5,
        },
      },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Requisito salvo.');
    expect(tableRows()[4]?.[4]).toBe('Sensei (professor)');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar Professor' })).toHaveFocus();
    });
  });

  it('moves the row when its order changes; an edit needs the order', async () => {
    const { user } = await openRequirements();
    const requests = recordRequests();
    let dialog = await openEdit(user, 'Osoto gari');
    await replaceText(user, field(dialog, /^Ordem/), '');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(within(dialog).getByText('Informe a ordem.')).toBeInTheDocument();
    expect(field(dialog, /^Ordem/)).toHaveFocus();
    expect(writes(requests)).toHaveLength(0);

    await user.keyboard('{Escape}');
    await dialogGone();
    dialog = await openEdit(user, 'Osoto gari');
    await replaceText(user, field(dialog, /^Ordem/), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(rowDescriptions()[0]).toBe('Osoto gari');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar Osoto gari' })).toHaveFocus();
    });
  });

  it('rn017 shows the 409 of a belt or kind change on an item with answers', async () => {
    const { user } = await openRequirements();
    await user.selectOptions(beltFilter(), 'Roxa');
    await screen.findByRole('button', { name: 'Editar Ogoshi' });
    const before = db.requirements.find((item) => item.id === mockRequirementId('Roxa', 1));

    const dialog = await openEdit(user, 'Ogoshi');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Teórico');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Não é possível trocar a faixa ou o tipo de um requisito com respostas registradas',
    );

    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Tipo/ }), 'Prático');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Faixa/ }), 'Marrom');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Não é possível trocar a faixa ou o tipo de um requisito com respostas registradas',
      );
    });
    expect(db.requirements.find((item) => item.id === before?.id)).toEqual(before);

    // The same belt and kind (what the form resends) with a new text is accepted.
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /^Faixa/ }), 'Roxa');
    await replaceText(user, field(dialog, /^Descrição/), 'O goshi');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(rowDescriptions()[0]).toBe('O goshi');
  });

  it('shows the 404 of an item gone meanwhile and the list catches up', async () => {
    const { user } = await openRequirements();
    const dialog = await openEdit(user, 'Deashi barai');
    db.requirements = db.requirements.filter((item) => item.description !== 'Deashi barai');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Requisito não encontrado');
    await waitFor(() => {
      expect(rowDescriptions()).not.toContain('Deashi barai');
    });
  });

  it('a 403 on the save says "Sem permissão" with the API message', async () => {
    server.use(
      http.post(REQUIREMENTS_URL, () =>
        HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
      ),
    );
    const { user } = await openRequirements();
    const dialog = await openNew(user);
    await fillNew(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos examinadores');
  });

  it('a double click on "Salvar" sends one POST; the dialog is locked meanwhile', async () => {
    let posts = 0;
    const held = gate();
    server.use(
      http.post(REQUIREMENTS_URL, async () => {
        posts += 1;
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openRequirements();
    const dialog = await openNew(user);
    await fillNew(user, dialog);
    const save = within(dialog).getByRole('button', { name: 'Salvar' });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    await waitFor(() => {
      expect(save).toHaveAttribute('data-loading', 'true');
    });
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'Novo requisito' })).toBeInTheDocument();
    await waitFor(() => {
      expect(posts).toBe(1);
    });
    // The POST is still on its way: the dialog stays locked.
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'Novo requisito' })).toBeInTheDocument();

    held.release();
    await dialogGone();
    expect(posts).toBe(1);
    expect(db.requirements.filter((item) => item.description === 'Começar')).toHaveLength(1);
  });

  it('a double Enter in the edit sends one PUT', async () => {
    let puts = 0;
    const held = gate();
    server.use(
      http.put(`${REQUIREMENTS_URL}/:id`, async () => {
        puts += 1;
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openRequirements();
    const dialog = await openEdit(user, 'Professor');
    const form = within(dialog).getByRole('form', { name: 'Editar requisito' });
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(puts).toBe(1);
    });
    // The PUT is on its way: the dialog stays.
    expect(screen.getByRole('dialog', { name: 'Editar requisito' })).toBeInTheDocument();

    held.release();
    await dialogGone();
    expect(puts).toBe(1);
  });

  it('closes with Esc, saves nothing and gives the focus back; a new opening starts over', async () => {
    const { user } = await openRequirements();
    const requests = recordRequests();
    let dialog = await openEdit(user, 'Deashi barai');
    await replaceText(user, field(dialog, /^Descrição/), 'Outro');
    await user.keyboard('{Escape}');
    await dialogGone();
    expect(writes(requests)).toHaveLength(0);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar Deashi barai' })).toHaveFocus();
    });

    dialog = await openEdit(user, 'Deashi barai');
    expect(field(dialog, /^Descrição/)).toHaveValue('Deashi barai');
  });

  it('keeps Tab inside the dialog, through every control', async () => {
    const { user } = await openRequirements();
    const dialog = await openEdit(user, 'Professor');
    await waitFor(() => {
      expect(within(dialog).getByRole('combobox', { name: /^Faixa/ })).toHaveFocus();
    });
    const reached = new Set<Element>();
    for (let step = 0; step < 10; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      if (document.activeElement) reached.add(document.activeElement);
    }
    for (const control of [
      within(dialog).getByRole('combobox', { name: /^Tipo/ }),
      field(dialog, /^Categoria/),
      field(dialog, /^Descrição/),
      field(dialog, /^Resposta esperada/),
      field(dialog, /^Ordem/),
      within(dialog).getByRole('button', { name: 'Cancelar' }),
      within(dialog).getByRole('button', { name: 'Salvar' }),
      within(dialog).getByRole('button', { name: 'Fechar' }),
    ]) {
      expect(reached).toContain(control);
    }
  });

  it('on the phone the dialog is full screen and the focus goes back to the card', async () => {
    setViewportWidth(390);
    const { user } = await renderApp({ route: '/requisitos', signedInAs: 'examiner' });
    await screen.findByRole('list', { name: 'Requisitos' });
    const dialog = await openEdit(user, 'Osoto gari');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar Osoto gari' })).toHaveFocus();
    });
  });
});

describe('requirements screen, delete (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('asks first; "Cancelar" deletes nothing and gives the focus back', async () => {
    const { user } = await openRequirements();
    const requests = recordRequests();
    const dialog = await openDelete(user, 'Deashi barai');
    expect(dialog).toHaveTextContent(
      'Excluir o item “Deashi barai” (Prático, faixa Branca/Cinza)? Esta ação não pode ser desfeita.',
    );
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await dialogGone();
    expect(writes(requests)).toHaveLength(0);
    expect(rowDescriptions()).toContain('Deashi barai');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Excluir Deashi barai' })).toHaveFocus();
    });
  });

  it('Esc closes the confirmation without deleting', async () => {
    const { user } = await openRequirements();
    const requests = recordRequests();
    await openDelete(user, 'Osoto gari');
    await user.keyboard('{Escape}');
    await dialogGone();
    expect(writes(requests)).toHaveLength(0);
  });

  it('deletes after the confirmation: DELETE, row gone, notice, focus on the title', async () => {
    const { user } = await openRequirements();
    const requests = recordRequests();
    const dialog = await openDelete(user, 'Deashi barai');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await dialogGone();

    expect(writes(requests)).toEqual([
      {
        method: 'DELETE',
        url: `${REQUIREMENTS_URL}/${mockRequirementId('Branca/Cinza', 3)}`,
        body: null,
      },
    ]);
    expect(rowDescriptions()).not.toContain('Deashi barai');
    expect(screen.getByRole('status')).toHaveTextContent('Requisito excluído.');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Requisitos' })).toHaveFocus();
    });
  });

  it('rn017 an item with answers is not deleted: the 409 stays in the dialog', async () => {
    const { user } = await openRequirements();
    await user.selectOptions(beltFilter(), 'Roxa');
    await screen.findByRole('button', { name: 'Excluir Professor' });
    const dialog = await openDelete(user, 'Professor');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível excluir');
    expect(alert).toHaveTextContent('Requisito possui respostas registradas');
    expect(db.requirements.some((item) => item.id === mockRequirementId('Roxa', 3))).toBe(true);

    await user.keyboard('{Escape}');
    await dialogGone();
    expect(rowDescriptions()).toContain('Professor');
  });

  it('a double click on "Excluir" sends one DELETE; Esc waits for the answer', async () => {
    let deletes = 0;
    const held = gate();
    server.use(
      http.delete(`${REQUIREMENTS_URL}/:id`, async () => {
        deletes += 1;
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openRequirements();
    const dialog = await openDelete(user, 'Osoto gari');
    const confirm = within(dialog).getByRole('button', { name: 'Excluir' });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    await waitFor(() => {
      expect(confirm).toHaveAttribute('data-loading', 'true');
    });
    expect(screen.getByRole('dialog', { name: 'Excluir requisito' })).toBeInTheDocument();
    await waitFor(() => {
      expect(deletes).toBe(1);
    });
    // The DELETE is still on its way: Esc did not close the dialog.
    expect(screen.getByRole('dialog', { name: 'Excluir requisito' })).toBeInTheDocument();

    held.release();
    await dialogGone();
    expect(deletes).toBe(1);
    expect(rowDescriptions()).not.toContain('Osoto gari');
  });

  it('a new confirmation starts without the error of the previous one', async () => {
    const { user } = await openRequirements();
    await user.selectOptions(beltFilter(), 'Roxa');
    await screen.findByRole('button', { name: 'Excluir Ogoshi' });
    let dialog = await openDelete(user, 'Ogoshi');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await within(dialog).findByRole('alert');
    await user.keyboard('{Escape}');
    await dialogGone();

    dialog = await openDelete(user, 'Koshi guruma');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});
