/**
 * "Novo aluno" (§ 6.2): the form, the client checks (convenience only), the API errors,
 * RN014 and no double submit.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudentInput } from '../../../src/api/types';
import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const STUDENTS_URL = `${TEST_API_URL}/students`;
const DATES_MESSAGE = 'Datas inválidas: verifique nascimento e data da faixa atual';
const GREEN_BELT = mockBelts.find((belt) => belt.name === 'Verde')!;

let db: MockDb;

/** Records the `POST /students` bodies and lets the simulated API answer them. */
function recordPosts(): StudentInput[] {
  const bodies: StudentInput[] = [];
  server.use(
    http.post(STUDENTS_URL, async ({ request }) => {
      bodies.push((await request.clone().json()) as StudentInput);
      return undefined;
    }),
  );
  return bodies;
}

function field(name: RegExp): HTMLElement {
  return screen.getByLabelText(name);
}

/** Paste instead of typing key by key: same React events, much less work for the suite. */
async function fillIn(user: UserEvent, input: HTMLElement, text: string) {
  await user.click(input);
  await user.paste(text);
}

async function fillValidForm(user: UserEvent) {
  await fillIn(user, field(/^Nome/), '  Lia Tanaka ');
  await user.selectOptions(screen.getByRole('combobox', { name: /^Faixa atual/ }), 'Verde');
  // Set like a pick in the native date picker; the RN014 tests below type the dates.
  fireEvent.change(field(/^Nascimento/), { target: { value: '2013-04-20' } });
  fireEvent.change(field(/^Na faixa desde/), { target: { value: '2025-12-01' } });
  await user.selectOptions(screen.getByRole('combobox', { name: /^Graus/ }), '1 grau');
  await fillIn(user, field(/^Registro na federação/), 'FPJ-0042');
}

async function openForm(role: 'examiner' | 'guardian' = 'guardian') {
  const result = await renderApp({ route: '/alunos/novo', signedInAs: role });
  await screen.findByRole('combobox', { name: /^Faixa atual/ });
  return result;
}

describe('new student form (§ 6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the form by the page title and starts with the § 3.3 defaults', async () => {
    await openForm();
    expect(screen.getByRole('heading', { level: 1, name: 'Novo aluno' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Novo aluno' })).toBeInTheDocument();
    expect(field(/^Nome/)).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /^Faixa atual/ })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /^Graus/ })).toHaveValue('0');
    expect(screen.getByRole('switch', { name: /^Ativo/ })).toBeChecked();
    expect(field(/^Nascimento/)).toHaveAttribute('type', 'date');
    expect(field(/^Na faixa desde/)).toHaveAttribute('type', 'date');
    // Native date inputs do not offer future days (RN014).
    expect(field(/^Nascimento/)).toHaveAttribute('max', '2026-11-02');
    expect(field(/^Na faixa desde/)).toHaveAttribute('max', '2026-11-02');
  });

  it('offers the API belts in graduation order and stripes 0 to 4', async () => {
    await openForm();
    const belt = screen.getByRole('combobox', { name: /^Faixa atual/ });
    const names = within(belt)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual(['Selecione a faixa', ...mockBelts.map((item) => item.name)]);
    const stripes = screen.getByRole('combobox', { name: /^Graus/ });
    expect(
      within(stripes)
        .getAllByRole('option')
        .map((option) => [option.getAttribute('value'), option.textContent]),
    ).toEqual([
      ['0', 'Nenhum'],
      ['1', '1 grau'],
      ['2', '2 graus'],
      ['3', '3 graus'],
      ['4', '4 graus'],
    ]);
  });

  it('creates the student, goes back to the list and announces it', async () => {
    const bodies = recordPosts();
    const { user, router } = await openForm();
    await fillValidForm(user);
    await user.click(screen.getByRole('switch', { name: /^Ativo/ }));
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Aluno cadastrado.');
    expect(router.state.location.pathname).toBe('/alunos');
    expect(bodies).toEqual([
      {
        full_name: 'Lia Tanaka',
        birth_date: '2013-04-20',
        current_belt_id: GREEN_BELT.id,
        current_belt_since: '2025-12-01',
        stripes: 1,
        federation_id: 'FPJ-0042',
        active: false,
      },
    ]);
    // The list was invalidated: the new student comes from the API.
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(within(table).getByRole('rowheader', { name: 'Lia Tanaka' })).toBeInTheDocument();
    expect(db.students.at(-1)?.student.owner_id).toBe('mock-guardian');
  });

  it('takes focus to the notice and clears it from the router state', async () => {
    const { user, router } = await openForm();
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));
    const notice = await screen.findByRole('status');
    await waitFor(() => {
      expect(notice).toHaveFocus();
    });
    await waitFor(() => {
      expect(router.state.location.state).toBeNull();
    });
    expect(notice).toBeInTheDocument();
    await user.click(within(notice).getByRole('button', { name: 'Fechar aviso' }));
    expect(screen.queryByText('Aluno cadastrado.')).not.toBeInTheDocument();
  });

  it('marks every missing field, links the message and focuses the first one', async () => {
    const bodies = recordPosts();
    const { user } = await openForm();
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));

    const expected: [HTMLElement, string][] = [
      [field(/^Nome/), 'Informe o nome.'],
      [screen.getByRole('combobox', { name: /^Faixa atual/ }), 'Selecione a faixa atual.'],
      [field(/^Nascimento/), 'Informe a data de nascimento.'],
      [field(/^Na faixa desde/), 'Informe desde quando está na faixa atual.'],
    ];
    for (const [input, message] of expected) {
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(expect.stringContaining(message));
    }
    expect(field(/^Nome/)).toHaveFocus();
    expect(field(/^Registro na federação/)).not.toHaveAttribute('aria-invalid', 'true');
    expect(bodies).toHaveLength(0);
  });

  it('clears the message of a field as soon as it is edited', async () => {
    const { user } = await openForm();
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));
    await fillIn(user, field(/^Nome/), 'L');
    expect(field(/^Nome/)).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Informe o nome.')).not.toBeInTheDocument();
    expect(screen.getByText('Selecione a faixa atual.')).toBeInTheDocument();
  });

  it('limits the name and the federation id like the API', async () => {
    const { user } = await openForm();
    await fillValidForm(user);
    await user.clear(field(/^Nome/));
    await user.click(field(/^Nome/));
    await user.paste('a'.repeat(121));
    await user.click(field(/^Registro na federação/));
    await user.paste('x'.repeat(30));
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));
    expect(field(/^Nome/)).toHaveAccessibleDescription('Use no máximo 120 caracteres.');
    expect(field(/^Registro na federação/)).toHaveAccessibleDescription(
      expect.stringContaining('Use no máximo 30 caracteres.'),
    );
  });

  it('rn014 refuses a belt date before the birth, on the client, with the API text', async () => {
    const bodies = recordPosts();
    const { user } = await openForm();
    await fillValidForm(user);
    await user.clear(field(/^Na faixa desde/));
    await user.type(field(/^Na faixa desde/), '2013-04-19');
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));

    const since = field(/^Na faixa desde/);
    expect(since).toHaveAttribute('aria-invalid', 'true');
    expect(since).toHaveAccessibleDescription(expect.stringContaining(DATES_MESSAGE));
    expect(since).toHaveFocus();
    expect(bodies).toHaveLength(0);
  });

  it('rn014 refuses a future birth date on the client', async () => {
    const { user } = await openForm();
    await fillValidForm(user);
    await user.clear(field(/^Nascimento/));
    await user.type(field(/^Nascimento/), '2026-11-03');
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));
    expect(field(/^Nascimento/)).toHaveAccessibleDescription(DATES_MESSAGE);
  });

  it('rn014 shows the API message when the server refuses the dates', async () => {
    // A clock ahead of the server's: the client accepts, the API answers 400.
    server.use(
      http.post(STUDENTS_URL, () => HttpResponse.json({ message: DATES_MESSAGE }, { status: 400 })),
    );
    const { user, router } = await openForm();
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível salvar');
    expect(alert).toHaveTextContent(DATES_MESSAGE);
    expect(router.state.location.pathname).toBe('/alunos/novo');
  });

  it('shows any API error above the fields, linked to the form, keeping what was typed', async () => {
    server.use(
      http.post(STUDENTS_URL, () =>
        HttpResponse.json({ message: 'Faixa atual: faixa não encontrada' }, { status: 400 }),
      ),
    );
    const { user } = await openForm();
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Faixa atual: faixa não encontrada');
    const form = screen.getByRole('form', { name: 'Novo aluno' });
    expect(form).toHaveAttribute('aria-describedby', alert.id);
    expect(field(/^Nome/)).toHaveValue('  Lia Tanaka ');
    expect(screen.getByRole('button', { name: 'Cadastrar aluno' })).toBeEnabled();
  });

  it('shows the network message when the API cannot be reached', async () => {
    server.use(http.post(STUDENTS_URL, () => HttpResponse.error()));
    const { user } = await openForm();
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível falar com o servidor',
    );
  });

  it('sends only once on a double click and shows the button loading', async () => {
    let release: () => void = () => undefined;
    const bodies: unknown[] = [];
    server.use(
      http.post(STUDENTS_URL, async ({ request }) => {
        bodies.push(await request.clone().json());
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      }),
    );
    const { user } = await openForm();
    await fillValidForm(user);
    const submit = screen.getByRole('button', { name: 'Cadastrar aluno' });
    await user.dblClick(submit);
    await user.type(field(/^Registro na federação/), '{Enter}');

    await waitFor(() => {
      expect(submit).toHaveAttribute('data-loading', 'true');
    });
    expect(submit).toBeDisabled();
    release();
    expect(await screen.findByRole('status')).toHaveTextContent('Aluno cadastrado.');
    expect(bodies).toHaveLength(1);
  });

  it('"Cancelar" goes back to the list without sending anything', async () => {
    const bodies = recordPosts();
    const { user, router } = await openForm();
    await fillIn(user, field(/^Nome/), 'Rascunho');
    await user.click(screen.getByRole('link', { name: 'Cancelar' }));
    expect(router.state.location.pathname).toBe('/alunos');
    expect(await screen.findByRole('table', { name: 'Alunos' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it('shows the belts error with "Tentar de novo"', async () => {
    server.use(
      http.get(
        `${TEST_API_URL}/belts`,
        () => HttpResponse.json({ message: 'Erro no servidor. Tente de novo.' }, { status: 500 }),
        { once: true },
      ),
    );
    const { user } = await renderApp({ route: '/alunos/novo', signedInAs: 'examiner' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar as faixas');
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('combobox', { name: /^Faixa atual/ })).toBeInTheDocument();
  });

  it('shows a labelled loading state while the belts load', async () => {
    let release: () => void = () => undefined;
    server.use(
      http.get(`${TEST_API_URL}/belts`, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json(mockBelts);
      }),
    );
    await renderApp({ route: '/alunos/novo', signedInAs: 'examiner' });
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando faixas…');
    release();
    expect(await screen.findByRole('combobox', { name: /^Faixa atual/ })).toBeInTheDocument();
  });

  it('reaches every control by Tab, in screen order', async () => {
    const { user } = await openForm();
    const expected = [
      field(/^Nome/),
      screen.getByRole('combobox', { name: /^Faixa atual/ }),
      field(/^Nascimento/),
      field(/^Na faixa desde/),
      screen.getByRole('combobox', { name: /^Graus/ }),
      field(/^Registro na federação/),
      screen.getByRole('switch', { name: /^Ativo/ }),
      screen.getByRole('button', { name: 'Cadastrar aluno' }),
      screen.getByRole('link', { name: 'Cancelar' }),
    ];
    field(/^Nome/).focus();
    for (const control of expected.slice(1)) {
      await user.tab();
      expect(control).toHaveFocus();
    }
  });

  it.each([1280, 768, 390])('keeps every field and action at %i px', async (width) => {
    setViewportWidth(width);
    await openForm();
    for (const name of [/^Nome/, /^Nascimento/, /^Na faixa desde/, /^Registro na federação/]) {
      expect(field(name)).toBeVisible();
    }
    expect(screen.getByRole('button', { name: 'Cadastrar aluno' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Cancelar' })).toBeVisible();
  });
});
