/**
 * Erro: no Dia do exame, o aviso verde "Presença de … confirmada." e o aviso vermelho "Não foi
 * possível confirmar a presença de …" têm o botão "Fechar aviso". Ao fechar um deles pelo
 * teclado (Enter no botão), o botão some junto com o aviso e o foco cai no `body`: quem usa
 * teclado ou leitor de tela perde o lugar na página.
 * Esperado: o foco vai para o título da tela ("Dia do exame"), pela regra única de foco
 * (`focusIfLost`), como nas telas Faixas, Eventos, Requisitos e Academia (§ 6.7).
 * Issue: #52
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';
const OPEN_EXAMS_URL = `${TEST_API_URL}/events/${MOCK_EVENT_IDS.open}/exams`;
const TITLE = 'Dia do exame';

/** Where the focus is, in a short form for the failure message (`body` when lost). */
function focusedElement(): string {
  const active = document.activeElement;
  if (active === null || active === document.body) return 'body';
  const name = active.getAttribute('aria-label') ?? active.textContent.trim();
  return `${active.tagName.toLowerCase()} "${name}"`;
}

function rowOf(table: HTMLElement, name: string): HTMLElement {
  return within(table).getByRole('rowheader', { name }).closest('tr')!;
}

async function confirmAna() {
  const rendered = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
  const table = await screen.findByRole('table', { name: LIST });
  await rendered.user.click(
    within(rowOf(table, 'Ana Souza')).getByRole('button', {
      name: 'Confirmar presença de Ana Souza',
    }),
  );
  return rendered;
}

async function expectFocusOnTitle() {
  await waitFor(
    () => {
      expect(focusedElement()).toBe(`h1 "${TITLE}"`);
      expect(screen.getByRole('heading', { level: 1, name: TITLE })).toHaveFocus();
    },
    { timeout: 1500 },
  );
}

describe('rn005 foco ao fechar os avisos do Dia do exame (§ 6.3, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aviso "Presença de … confirmada.": o foco vai para o título, não para o body', async () => {
    const { user } = await confirmAna();
    const notice = await screen.findByText('Presença de Ana Souza confirmada.');
    const alert = notice.closest<HTMLElement>('[role="status"]')!;

    within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByText('Presença de Ana Souza confirmada.')).not.toBeInTheDocument();
    });

    await expectFocusOnTitle();
  });

  it('aviso "Não foi possível confirmar a presença de …": o foco vai para o título', async () => {
    server.use(
      http.post(
        OPEN_EXAMS_URL,
        () =>
          HttpResponse.json(
            { message: 'Idade mínima para a faixa Cinza/Azul: 6 anos' },
            { status: 400 },
          ),
        { once: true },
      ),
    );
    const { user } = await confirmAna();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível confirmar a presença de Ana Souza');

    within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    await expectFocusOnTitle();
  });
});
