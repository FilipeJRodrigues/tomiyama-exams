/**
 * Erro: com o formulário de aluno aberto e campos já alterados, a janela volta a ter foco
 * (`refetchOnWindowFocus`, ligado por causa do § 6.4) e o React Query recarrega
 * `GET /students/{id}` e `GET /belts`. Se essa recarga falhar (rede instável no celular,
 * 5xx), a consulta passa a `isError` mesmo com os dados já carregados, e a página troca o
 * formulário por "Não foi possível carregar…" + "Tentar de novo": tudo o que foi digitado
 * se perde. O mesmo acontece em "Novo aluno" quando a recarga das faixas falha.
 * Esperado: depois que os dados chegaram, uma recarga que falha não tira o formulário da
 * tela nem apaga os valores digitados (§ 6.2); o erro de carga só substitui o formulário
 * quando ainda não há dados.
 * Issue: -
 */
import { act, screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

/** Guardian's student without exams. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';

async function typeName(user: UserEvent, text: string) {
  const name = screen.getByRole('textbox', { name: /^Nome/ });
  await user.clear(name);
  await user.click(name);
  await user.paste(text);
}

/** What the browser fires when the user comes back to the tab. */
async function windowRegainsFocus() {
  await act(async () => {
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

describe('formulário de aluno e recarga que falha (§ 6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('na edição, a recarga do aluno que falha mantém o formulário e o nome digitado', async () => {
    const { user } = await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
    await screen.findByRole('textbox', { name: /^Nome/ });
    await typeName(user, 'Ana Souza Lima');

    server.use(
      http.get(`${TEST_API_URL}/students/${ANA}`, () =>
        HttpResponse.json({ message: 'Erro no servidor' }, { status: 500 }),
      ),
    );
    await windowRegainsFocus();

    expect(screen.getByRole('textbox', { name: /^Nome/ })).toHaveValue('Ana Souza Lima');
    expect(screen.getByRole('button', { name: 'Salvar alterações' })).toBeInTheDocument();
  });

  it('em "Novo aluno", a recarga das faixas que falha mantém o que foi digitado', async () => {
    const { user } = await renderApp({ route: '/alunos/novo', signedInAs: 'guardian' });
    await screen.findByRole('textbox', { name: /^Nome/ });
    await typeName(user, 'João Pedro Araújo');

    server.use(http.get(`${TEST_API_URL}/belts`, () => HttpResponse.error()));
    await windowRegainsFocus();

    expect(screen.getByRole('textbox', { name: /^Nome/ })).toHaveValue('João Pedro Araújo');
    expect(screen.getByRole('button', { name: 'Cadastrar aluno' })).toBeInTheDocument();
  });
});
