/**
 * Student form in edit mode (§ 6.2): loading, saving, 404, the graduation lock after the
 * first exam (RN013, decided by the API) and deleting (RN018).
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudentInput } from '../../../src/api/types';
import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

/** Guardian's student without exams. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
/** Examiner's student (a guardian gets 404). */
const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';
/** Examiner's inactive student with exams. */
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
/** Guardian's student with exams. */
const GABRIEL = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07';

const LOCK_MESSAGE = 'Somente examinadores alteram a graduação após o primeiro exame';
const HAS_EXAMS_MESSAGE = 'Aluno possui exames registrados';
const DATES_MESSAGE = 'Datas inválidas: verifique nascimento e data da faixa atual';
const CINZA = mockBelts.find((belt) => belt.name === 'Cinza')!;
const LARANJA = mockBelts.find((belt) => belt.name === 'Laranja')!;
const AMARELA_LARANJA = mockBelts.find((belt) => belt.name === 'Amarela/Laranja')!;

let db: MockDb;

function studentUrl(id: string): string {
  return `${TEST_API_URL}/students/${id}`;
}

function recordRequests(method: 'put' | 'delete' | 'get', url: string) {
  const requests: { method: string; body: unknown }[] = [];
  server.use(
    http[method](url, async ({ request }) => {
      const text = await request.clone().text();
      requests.push({ method: request.method, body: text ? (JSON.parse(text) as unknown) : null });
      return undefined;
    }),
  );
  return requests;
}

function field(name: RegExp): HTMLElement {
  return screen.getByLabelText(name);
}

/** Paste instead of typing key by key: same React events, much less work for the suite. */
async function fillIn(user: UserEvent, input: HTMLElement, text: string) {
  await user.click(input);
  await user.paste(text);
}

async function openEdit(id: string, role: 'examiner' | 'guardian') {
  const result = await renderApp({ route: `/alunos/${id}`, signedInAs: role });
  await screen.findByRole('combobox', { name: /^Faixa atual/ });
  return result;
}

describe('edit student form (§ 6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads GET /students/{id} into the fields, dates as the API sent them', async () => {
    await openEdit(GABRIEL, 'guardian');
    expect(screen.getByRole('heading', { level: 1, name: 'Editar aluno' })).toBeInTheDocument();
    expect(field(/^Nome/)).toHaveValue('Gabriel Costa');
    expect(screen.getByRole('combobox', { name: /^Faixa atual/ })).toHaveValue(AMARELA_LARANJA.id);
    expect(field(/^Nascimento/)).toHaveValue('2017-12-05');
    expect(field(/^Na faixa desde/)).toHaveValue('2026-03-01');
    expect(screen.getByRole('combobox', { name: /^Graus/ })).toHaveValue('2');
    expect(field(/^Registro na federação/)).toHaveValue('');
    expect(screen.getByRole('switch', { name: /^Ativo/ })).toBeChecked();
  });

  it('shows a labelled loading state while the student loads', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(studentUrl(ANA), async () => {
        await gate;
        return undefined;
      }),
    );
    await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando aluno…');
    release();
    expect(await screen.findByLabelText(/^Nome/)).toHaveValue('Ana Souza');
  });

  it('saves every field with PUT and goes back to the list with a notice', async () => {
    const puts = recordRequests('put', studentUrl(ANA));
    const { user, router } = await openEdit(ANA, 'guardian');
    await user.clear(field(/^Nome/));
    await fillIn(user, field(/^Nome/), 'Ana Souza Lima');
    await fillIn(user, field(/^Registro na federação/), 'FPJ-7');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Alterações salvas.');
    expect(router.state.location.pathname).toBe('/alunos');
    expect(puts.map((request) => request.body)).toEqual([
      {
        full_name: 'Ana Souza Lima',
        birth_date: '2018-05-10',
        current_belt_id: CINZA.id,
        current_belt_since: '2026-03-14',
        stripes: 0,
        federation_id: 'FPJ-7',
        active: true,
      } satisfies StudentInput,
    ]);
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(within(table).getByRole('rowheader', { name: 'Ana Souza Lima' })).toBeInTheDocument();
  });

  it('says "Aluno não encontrado" on 404 (someone else\'s student)', async () => {
    const { user, router } = await renderApp({ route: `/alunos/${CARLA}`, signedInAs: 'guardian' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Aluno não encontrado' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Voltar para a lista de alunos' }));
    expect(router.state.location.pathname).toBe('/alunos');
  });

  it('says "Aluno não encontrado" for an id that does not exist', async () => {
    await renderApp({ route: '/alunos/nao-existe', signedInAs: 'examiner' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Aluno não encontrado' }),
    ).toBeInTheDocument();
  });

  it('shows a load error with "Tentar de novo"', async () => {
    server.use(
      http.get(
        studentUrl(ANA),
        () => HttpResponse.json({ message: 'Erro no servidor. Tente de novo.' }, { status: 500 }),
        { once: true },
      ),
    );
    const { user } = await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(alert).toHaveTextContent('Não foi possível carregar o aluno');
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByLabelText(/^Nome/)).toHaveValue('Ana Souza');
  });

  it('shows "Sem permissão" without retry on a 403 load', async () => {
    server.use(
      http.get(studentUrl(ANA), () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })),
    );
    await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Você não tem permissão para esta ação.');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('rn013 shows the API refusal when a guardian changes the graduation after an exam', async () => {
    const { user, router } = await openEdit(GABRIEL, 'guardian');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Graus/ }), '3 graus');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent(LOCK_MESSAGE);
    expect(router.state.location.pathname).toBe(`/alunos/${GABRIEL}`);
    expect(db.students.find((item) => item.student.id === GABRIEL)?.student.stripes).toBe(2);
    // The fields stay as typed, and nothing is hidden or disabled ahead of the API.
    expect(screen.getByRole('combobox', { name: /^Graus/ })).toHaveValue('3');
    expect(screen.getByRole('combobox', { name: /^Faixa atual/ })).toBeEnabled();
  });

  it('rn013 lets the guardian edit other fields resending the same graduation', async () => {
    const puts = recordRequests('put', studentUrl(GABRIEL));
    const { user } = await openEdit(GABRIEL, 'guardian');
    await fillIn(user, field(/^Registro na federação/), 'FPJ-99');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Alterações salvas.');
    expect(puts[0]?.body).toMatchObject({
      current_belt_id: AMARELA_LARANJA.id,
      current_belt_since: '2026-03-01',
      stripes: 2,
      federation_id: 'FPJ-99',
    });
  });

  it('rn013 lets an examiner change the graduation of a student with exams', async () => {
    const { user } = await openEdit(GABRIEL, 'examiner');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Faixa atual/ }), 'Laranja');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Graus/ }), 'Nenhum');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Alterações salvas.');
    const saved = db.students.find((item) => item.student.id === GABRIEL)!.student;
    expect(saved).toMatchObject({ current_belt_id: LARANJA.id, stripes: 0 });
  });

  it('rn014 checks the dates on the client before sending', async () => {
    const puts = recordRequests('put', studentUrl(ANA));
    const { user } = await openEdit(ANA, 'guardian');
    await user.clear(field(/^Na faixa desde/));
    await user.type(field(/^Na faixa desde/), '2027-01-01');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(field(/^Na faixa desde/)).toHaveAttribute('aria-invalid', 'true');
    expect(field(/^Na faixa desde/)).toHaveAccessibleDescription(
      expect.stringContaining(DATES_MESSAGE),
    );
    expect(puts).toHaveLength(0);
  });

  it('sends only one PUT on a double click', async () => {
    const puts = recordRequests('put', studentUrl(ANA));
    const { user } = await openEdit(ANA, 'guardian');
    await user.dblClick(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Alterações salvas.');
    expect(puts).toHaveLength(1);
  });

  it('"Cancelar" goes back to the list without saving', async () => {
    const puts = recordRequests('put', studentUrl(ANA));
    const { user, router } = await openEdit(ANA, 'guardian');
    await user.clear(field(/^Nome/));
    await user.click(screen.getByRole('link', { name: 'Cancelar' }));
    expect(router.state.location.pathname).toBe('/alunos');
    expect(puts).toHaveLength(0);
  });

  it.each([1280, 768, 390])('keeps the form and both actions at %i px', async (width) => {
    setViewportWidth(width);
    await openEdit(ANA, 'guardian');
    expect(screen.getByRole('button', { name: 'Salvar alterações' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Excluir aluno' })).toBeVisible();
  });
});

describe('delete student (§ 6.2, RN018)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function openDialog(id: string, role: 'examiner' | 'guardian') {
    const result = await openEdit(id, role);
    await result.user.click(screen.getByRole('button', { name: 'Excluir aluno' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir aluno' });
    return { ...result, dialog };
  }

  it('asks for confirmation naming the student, with focus on "Cancelar"', async () => {
    const { dialog } = await openDialog(ANA, 'guardian');
    expect(dialog).toHaveTextContent('Excluir Ana Souza? Esta ação não pode ser desfeita.');
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    });
  });

  it('deletes after confirming and goes back to the list with a notice', async () => {
    const deletes = recordRequests('delete', studentUrl(ANA));
    const { user, dialog, router } = await openDialog(ANA, 'guardian');
    // Installed after the page loaded: counts only what comes after the deletion.
    const gets = recordRequests('get', studentUrl(ANA));
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Aluno excluído.');
    expect(router.state.location.pathname).toBe('/alunos');
    expect(deletes).toHaveLength(1);
    expect(db.students.some((item) => item.student.id === ANA)).toBe(false);
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(within(table).queryByRole('rowheader', { name: 'Ana Souza' })).not.toBeInTheDocument();
    // The deleted student is not asked for again.
    expect(gets).toHaveLength(0);
  });

  it('"Cancelar" closes the dialog without deleting and returns the focus', async () => {
    const deletes = recordRequests('delete', studentUrl(ANA));
    const { user, dialog } = await openDialog(ANA, 'guardian');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(deletes).toHaveLength(0);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Excluir aluno' })).toHaveFocus();
    });
  });

  it('Esc closes the dialog without deleting', async () => {
    const deletes = recordRequests('delete', studentUrl(ANA));
    const { user } = await openDialog(ANA, 'guardian');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(deletes).toHaveLength(0);
    expect(db.students.some((item) => item.student.id === ANA)).toBe(true);
  });

  it('rn018 shows the 409 message for a student with exams and keeps it', async () => {
    const { user, dialog, router } = await openDialog(ELIDA, 'examiner');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível excluir');
    expect(alert).toHaveTextContent(HAS_EXAMS_MESSAGE);
    expect(router.state.location.pathname).toBe(`/alunos/${ELIDA}`);
    expect(db.students.some((item) => item.student.id === ELIDA)).toBe(true);
  });

  it('rn018 lets the examiner deactivate instead, after the refusal', async () => {
    const { user, dialog } = await openDialog(ELIDA, 'examiner');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await within(dialog).findByRole('alert');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Reopening starts clean: the old refusal is not shown again.
    await user.click(screen.getByRole('button', { name: 'Excluir aluno' }));
    const reopened = await screen.findByRole('dialog', { name: 'Excluir aluno' });
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(within(reopened).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const active = screen.getByRole('switch', { name: /^Ativo/ });
    expect(active).not.toBeChecked();
    await user.click(active);
    await user.click(active);
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Alterações salvas.');
  });

  it('sends only one DELETE on a double click', async () => {
    const deletes = recordRequests('delete', studentUrl(ANA));
    const { user, dialog } = await openDialog(ANA, 'guardian');
    await user.dblClick(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Aluno excluído.');
    expect(deletes).toHaveLength(1);
  });
});
