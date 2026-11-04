import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  NETWORK_ERROR_STATUS,
  buildApiUrl,
  createApiClient,
  errorMessage,
  messageFromErrorBody,
} from '../../src/api/client';
import { server, TEST_API_URL } from '../msw-server';

function client(token: string | null = 'token-123', onUnauthorized = vi.fn()) {
  return createApiClient({
    baseUrl: TEST_API_URL,
    getToken: () => Promise.resolve(token),
    onUnauthorized,
  });
}

describe('createApiClient', () => {
  it('sends the token in the Authorization header', async () => {
    let received: string | null = null;
    server.use(
      http.get(`${TEST_API_URL}/belts`, ({ request }) => {
        received = request.headers.get('Authorization');
        return HttpResponse.json([]);
      }),
    );
    await client().get('/belts');
    expect(received).toBe('Bearer token-123');
  });

  it('sends no Authorization header when signed out', async () => {
    let hasHeader = true;
    server.use(
      http.get(`${TEST_API_URL}/belts`, ({ request }) => {
        hasHeader = request.headers.has('Authorization');
        return HttpResponse.json([]);
      }),
    );
    await client(null).get('/belts');
    expect(hasHeader).toBe(false);
  });

  it('adds the query string and skips empty values', async () => {
    let url = '';
    server.use(
      http.get(`${TEST_API_URL}/students`, ({ request }) => {
        url = request.url;
        return HttpResponse.json([]);
      }),
    );
    await client().get('/students', {
      active: true,
      belt_id: undefined,
      reference_date: '2027-03-13',
    });
    expect(url).toBe(`${TEST_API_URL}/students?active=true&reference_date=2027-03-13`);
  });

  it('sends JSON bodies and returns the parsed answer', async () => {
    server.use(
      http.post(`${TEST_API_URL}/students`, async ({ request }) => {
        expect(request.headers.get('Content-Type')).toBe('application/json');
        return HttpResponse.json(await request.json(), { status: 201 });
      }),
    );
    await expect(client().post('/students', { full_name: 'Ana' })).resolves.toEqual({
      full_name: 'Ana',
    });
  });

  it('returns undefined on 204', async () => {
    server.use(
      http.delete(`${TEST_API_URL}/students/1`, () => new HttpResponse(null, { status: 204 })),
    );
    await expect(client().delete('/students/1')).resolves.toBeUndefined();
  });

  it('keeps the pt-BR message of the backend', async () => {
    server.use(
      http.post(`${TEST_API_URL}/events/1/exams`, () =>
        HttpResponse.json({ message: 'Presença já confirmada neste evento' }, { status: 409 }),
      ),
    );
    const error = await client()
      .post('/events/1/exams', { student_id: 'x' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: 'Presença já confirmada neste evento' });
  });

  it('translates the API Gateway 401 and ends the session', async () => {
    const onUnauthorized = vi.fn();
    server.use(
      http.get(`${TEST_API_URL}/belts`, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
    );
    await expect(client('expired', onUnauthorized).get('/belts')).rejects.toMatchObject({
      status: 401,
      message: 'Sua sessão expirou. Entre de novo.',
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('uses a pt-BR message when the body is not JSON', async () => {
    server.use(
      http.get(`${TEST_API_URL}/belts`, () => new HttpResponse('<html>', { status: 502 })),
    );
    await expect(client().get('/belts')).rejects.toMatchObject({
      status: 502,
      message: 'Erro no servidor. Tente de novo.',
    });
  });

  it('turns a network failure into a pt-BR message', async () => {
    server.use(http.get(`${TEST_API_URL}/belts`, () => HttpResponse.error()));
    await expect(client().get('/belts')).rejects.toMatchObject({
      status: NETWORK_ERROR_STATUS,
      message: 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.',
    });
  });

  it('returns null for an empty or non-JSON 200 body', async () => {
    server.use(
      http.get(`${TEST_API_URL}/belts`, () => new HttpResponse('', { status: 200 })),
      http.get(`${TEST_API_URL}/students`, () => new HttpResponse('<html>', { status: 200 })),
    );
    await expect(client().get('/belts')).resolves.toBeNull();
    await expect(client().get('/students')).resolves.toBeNull();
  });

  it('uses the message of the status when an error body is empty', async () => {
    server.use(http.get(`${TEST_API_URL}/belts`, () => new HttpResponse(null, { status: 504 })));
    await expect(client().get('/belts')).rejects.toMatchObject({
      status: 504,
      message: 'O servidor demorou para responder. Tente de novo.',
    });
  });
});

describe('createApiClient with a body cut halfway', () => {
  /** Headers arrived; the connection dropped while the body was still coming. */
  function cutBody(status: number): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":'));
        controller.error(new TypeError('terminated'));
      },
    });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }

  function cutClient(status: number, onUnauthorized = vi.fn()) {
    return createApiClient({
      baseUrl: TEST_API_URL,
      getToken: () => Promise.resolve('token-123'),
      onUnauthorized,
      fetchFn: () => Promise.resolve(cutBody(status)),
    });
  }

  it('turns a cut 200 into the network error: the outcome is unknown', async () => {
    const error = await cutClient(200)
      .put('/events/e/exams/s/answers/r', { correct: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: NETWORK_ERROR_STATUS,
      message: 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.',
    });
  });

  it('keeps the status of a cut 504, with its own message', async () => {
    const error = await cutClient(504)
      .get('/belts')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 504,
      message: 'O servidor demorou para responder. Tente de novo.',
    });
  });

  it('keeps the status of a cut 401 and still ends the session', async () => {
    const onUnauthorized = vi.fn();
    await expect(cutClient(401, onUnauthorized).get('/belts')).rejects.toMatchObject({
      status: 401,
      message: 'Sua sessão expirou. Entre de novo.',
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('messageFromErrorBody', () => {
  it('translates the English messages of API Gateway', () => {
    expect(messageFromErrorBody(403, { message: 'Forbidden' })).toBe(
      'Você não tem permissão para esta ação.',
    );
    expect(messageFromErrorBody(404, { message: 'Not Found' })).toBe('Recurso não encontrado.');
    expect(messageFromErrorBody(429, { message: 'Too Many Requests' })).toBe(
      'Muitas requisições. Aguarde um instante e tente de novo.',
    );
  });

  it('falls back by status when there is no message', () => {
    expect(messageFromErrorBody(400, null)).toBe('Dados inválidos.');
    expect(messageFromErrorBody(500, {})).toBe('Erro no servidor. Tente de novo.');
  });
});

describe('errorMessage', () => {
  it('hides unexpected errors behind a generic message', () => {
    expect(errorMessage(new ApiError(400, 'Nome: obrigatório'))).toBe('Nome: obrigatório');
    expect(errorMessage(new TypeError('x is undefined'))).toBe('Algo deu errado. Tente de novo.');
  });
});

describe('buildApiUrl', () => {
  it('resolves a relative base against the page origin', () => {
    expect(buildApiUrl('/api', '/belts')).toBe(`${window.location.origin}/api/belts`);
  });
});
