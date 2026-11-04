/**
 * QA (#49): o corpo cortado no meio do caminho, visto pelas telas que usam o cliente da API
 * (§ 6.5, § 6.7). A leitura cortada da lista mostra a mensagem de rede com "Tentar de novo";
 * o salvar cortado não fecha o diálogo como se tivesse salvo; um 401 cortado ainda encerra
 * a sessão. A política de reenvio das leituras (`shouldRetry`) repete o erro de rede.
 * O msw transforma um corpo com erro em falha do próprio `fetch` (sem status): por isso o
 * corte é simulado trocando o `fetch` global, que o cliente resolve a cada chamada.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, NETWORK_ERROR_STATUS } from '../../src/api/client';
import { shouldRetry } from '../../src/app/queryClient';
import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const NETWORK = 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.';

/** Os cabeçalhos chegaram; a conexão caiu com o corpo ainda chegando. */
function cutResponse(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('[{"id":'));
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

/** Corta as respostas de `method` em `path` enquanto `when()` for verdadeiro. */
function cutFetch(method: string, path: RegExp, status: number, when: () => boolean = () => true) {
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const verb = (init?.method ?? 'GET').toUpperCase();
    if (verb === method && path.test(new URL(url).pathname) && when()) {
      return Promise.resolve(cutResponse(status));
    }
    return original(input, init);
  });
}

describe('corpo cortado nas telas (§ 6.5, § 6.7, #49)', () => {
  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a leitura cortada é erro de rede, que a política de leituras repete', () => {
    expect(shouldRetry(0, new ApiError(NETWORK_ERROR_STATUS, NETWORK))).toBe(true);
    expect(shouldRetry(2, new ApiError(NETWORK_ERROR_STATUS, NETWORK))).toBe(false);
  });

  it('a lista de faixas cortada mostra a mensagem de rede e carrega no "Tentar de novo"', async () => {
    let cut = true;
    cutFetch('GET', /^\/belts$/, 200, () => cut);
    const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    expect(await screen.findByText('Não foi possível carregar as faixas')).toBeVisible();
    expect(screen.getByText(NETWORK)).toBeVisible();
    expect(screen.queryByText('Algo deu errado. Tente de novo.')).not.toBeInTheDocument();

    cut = false;
    await user.click(screen.getByRole('button', { name: /Tentar de novo/ }));
    expect(await screen.findByRole('table', { name: 'Faixas' })).toBeVisible();
  });

  it('o salvar cortado avisa no diálogo, que fica aberto com os dados', async () => {
    cutFetch('PUT', /^\/belts\/[^/]+$/, 200);
    const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    await screen.findByRole('table', { name: 'Faixas' });
    await user.click(screen.getByRole('button', { name: 'Editar faixa Cinza' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar faixa Cinza' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(NETWORK);
    expect(screen.getByRole('dialog', { name: 'Editar faixa Cinza' })).toBeVisible();
  });

  it('um 401 cortado na leitura encerra a sessão', async () => {
    cutFetch('GET', /^\/belts$/, 401);
    const { router } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/entrar');
    });
  });
});
