/**
 * Student form edge cases (§ 6.2, § 6.7, LGPD): a name with only spaces is caught before
 * the API, a 401 while saving ends the session, and the student data never reaches the
 * console, the URL or the browser storage.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const STUDENTS_URL = `${TEST_API_URL}/students`;
const NAME = 'Lia Tanaka Araújo';

async function fillValidForm(user: UserEvent, name: string) {
  const input = screen.getByLabelText(/^Nome/);
  await user.click(input);
  await user.paste(name);
  await user.selectOptions(screen.getByRole('combobox', { name: /^Faixa atual/ }), 'Verde');
  fireEvent.change(screen.getByLabelText(/^Nascimento/), { target: { value: '2013-04-20' } });
  fireEvent.change(screen.getByLabelText(/^Na faixa desde/), { target: { value: '2025-12-01' } });
}

describe('student form edge cases (§ 6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a name with only spaces is refused on the name field and nothing is sent', async () => {
    let posts = 0;
    server.use(
      http.post(STUDENTS_URL, () => {
        posts++;
        return undefined;
      }),
    );
    const { user } = await renderApp({ route: '/alunos/novo', signedInAs: 'guardian' });
    await screen.findByRole('combobox', { name: /^Faixa atual/ });
    await fillValidForm(user, '    ');

    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));

    expect(await screen.findByText('Informe o nome.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Nome/)).toHaveFocus();
    expect(posts).toBe(0);
  });

  it('a 401 while saving ends the session', async () => {
    server.use(
      http.post(STUDENTS_URL, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );
    const { user } = await renderApp({ route: '/alunos/novo', signedInAs: 'guardian' });
    await screen.findByRole('combobox', { name: /^Faixa atual/ });
    await fillValidForm(user, NAME);

    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));

    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Nome/)).not.toBeInTheDocument();
  });

  it('keeps the student data out of the console, the URL and the storage (LGPD)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const { user, router } = await renderApp({ route: '/alunos/novo', signedInAs: 'guardian' });
    await screen.findByRole('combobox', { name: /^Faixa atual/ });
    await fillValidForm(user, NAME);

    await user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));
    expect(await screen.findByText('Aluno cadastrado.')).toBeInTheDocument();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/alunos');
    });
    const location = router.state.location;
    expect(`${location.pathname}${location.search}${location.hash}`).not.toContain('Lia');
    expect(JSON.stringify(window.history.state ?? null)).not.toContain('Lia');
    const stored = [localStorage, sessionStorage]
      .flatMap((storage) => Object.keys(storage).map((key) => storage.getItem(key) ?? ''))
      .join('\n');
    expect(stored).not.toContain('Lia');
    expect(stored).not.toContain('2013-04-20');
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('Lia');
    }
  });
});
