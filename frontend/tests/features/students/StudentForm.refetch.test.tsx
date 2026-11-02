/**
 * The student form and background refetches (§ 6.2): once the data is on screen, a refetch
 * (window focus) never throws away what the user typed, whether it succeeds with newer
 * data, fails, or is refused with 403; a first load that fails still shows the error with
 * "Tentar de novo", and the retry brings the form. A 404 on refetch means the student is
 * gone (deleted elsewhere or no longer the caller's), so the page says so.
 */
import { act, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { resetViewport, setViewportWidth } from '../../viewport';

/** Guardian's student without exams. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const ANA_URL = `${TEST_API_URL}/students/${ANA}`;

let db: MockDb;

function nameField(): HTMLElement {
  return screen.getByRole('textbox', { name: /^Nome/ });
}

async function typeName(user: UserEvent, text: string) {
  const name = nameField();
  await user.clear(name);
  await user.click(name);
  await user.paste(text);
}

async function windowRegainsFocus() {
  await act(async () => {
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

async function openAna() {
  const result = await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
  await screen.findByRole('textbox', { name: /^Nome/ });
  return result;
}

describe('student form and background refetches (§ 6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetViewport();
  });

  it('a refetch that brings newer data keeps what the user typed', async () => {
    const { user } = await openAna();
    await typeName(user, 'Ana Souza Lima');

    const stored = db.students.find((item) => item.student.id === ANA)!;
    stored.student = { ...stored.student, full_name: 'Ana Souza Mudou' };
    await windowRegainsFocus();

    expect(nameField()).toHaveValue('Ana Souza Lima');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a 403 on refetch keeps the form and the typed name', async () => {
    const { user } = await openAna();
    await typeName(user, 'Ana Souza Lima');

    server.use(
      http.get(ANA_URL, () => HttpResponse.json({ message: 'Acesso negado' }, { status: 403 })),
    );
    await windowRegainsFocus();

    expect(nameField()).toHaveValue('Ana Souza Lima');
    expect(screen.getByRole('button', { name: 'Salvar alterações' })).toBeInTheDocument();
  });

  it('a failing belts refetch on the edit page keeps the form', async () => {
    const { user } = await openAna();
    await typeName(user, 'Ana Souza Lima');

    server.use(http.get(`${TEST_API_URL}/belts`, () => HttpResponse.error()));
    await windowRegainsFocus();

    expect(nameField()).toHaveValue('Ana Souza Lima');
    expect(screen.getByRole('combobox', { name: /^Faixa atual/ })).toBeInTheDocument();
  });

  it('a 404 on refetch says the student is gone', async () => {
    await openAna();

    server.use(
      http.get(ANA_URL, () =>
        HttpResponse.json({ message: 'Aluno não encontrado' }, { status: 404 }),
      ),
    );
    await windowRegainsFocus();

    expect(
      await screen.findByRole('heading', { name: 'Aluno não encontrado' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voltar para a lista de alunos' })).toHaveAttribute(
      'href',
      '/alunos',
    );
  });

  it('a first load that fails shows the error, and "Tentar de novo" brings the form', async () => {
    let fail = true;
    server.use(
      http.get(ANA_URL, () =>
        fail ? HttpResponse.json({ message: 'Erro no servidor' }, { status: 500 }) : undefined,
      ),
    );
    const { user } = await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Não foi possível carregar o aluno')).toBeInTheDocument();
    expect(within(alert).getByText('Erro no servidor')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^Nome/ })).not.toBeInTheDocument();

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByRole('textbox', { name: /^Nome/ })).toHaveValue('Ana Souza');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a first belts load that fails on "Novo aluno" shows the error with retry', async () => {
    let fail = true;
    server.use(http.get(`${TEST_API_URL}/belts`, () => (fail ? HttpResponse.error() : undefined)));
    const { user } = await renderApp({ route: '/alunos/novo', signedInAs: 'guardian' });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Não foi possível carregar as faixas')).toBeInTheDocument();
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByRole('combobox', { name: /^Faixa atual/ })).toBeInTheDocument();
  });
});

describe('student name links in the list (§ 6.2, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetViewport();
  });

  it('at 390 px each card title is one link to /alunos/{id}', async () => {
    setViewportWidth(390);
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await screen.findByText('Ana Souza');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    for (const { student } of db.students) {
      const heading = screen.getByRole('heading', { level: 2, name: student.full_name });
      const links = within(heading).getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute('href', `/alunos/${student.id}`);
    }
  });

  it('at 768 px Tab goes region, then each name in row order, then leaves the table', async () => {
    setViewportWidth(768);
    const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    const region = screen.getByRole('region', { name: 'Lista de alunos' });
    const names = within(table)
      .getAllByRole('rowheader')
      .map((header) => within(header).getByRole('link'));

    for (let i = 0; i < 40 && document.activeElement !== region; i++) await user.tab();
    expect(document.activeElement).toBe(region);
    for (const link of names) {
      await user.tab();
      expect(document.activeElement).toBe(link);
    }
    await user.tab();
    expect(region.contains(document.activeElement)).toBe(false);
  });

  it('a guardian only gets links to their own students', async () => {
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    const hrefs = within(table)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs).not.toContain('/alunos/7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03');
  });
});
