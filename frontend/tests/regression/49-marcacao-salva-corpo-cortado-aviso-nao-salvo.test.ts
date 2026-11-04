/**
 * Erro: a etapa 3 passou a tratar todo erro que não é `ApiError` como "a requisição nem
 * saiu" (`markOutcomeUnknown` devolve false), e o aviso diz "Não foi possível salvar a
 * marcação". Mas o cliente da API também lança um erro que não é `ApiError` quando a
 * resposta chega e a conexão cai no meio do corpo (`response.text()` rejeita com
 * `TypeError`), fora do `try` do `fetch`. Numa resposta 200 a API já gravou a marcação:
 * como `mayHaveSavedMark` continua true, o exame recarrega e o item aparece marcado ao lado
 * de um aviso que diz que não foi salvo, o que o aviso nunca pode fazer (§ 6.4, RN006). O
 * mesmo vale para o 504 com o corpo cortado, que deixa de ser tratado como 504.
 * Esperado: uma resposta que chegou, mas cujo corpo não pôde ser lido, tem resultado
 * desconhecido para a marcação (`markOutcomeUnknown` true: "Não foi possível confirmar a
 * marcação"), como a falha de rede e o 504. Só o erro antes do envio (token) fica false.
 * Issue: #49 (etapa 3, ajuste de `markOutcomeUnknown`)
 */
import { describe, expect, it } from 'vitest';

import { createApiClient } from '../../src/api/client';
import { markOutcomeUnknown } from '../../src/features/exam/examModel';

/** A response whose headers arrived and whose body the connection cut halfway. */
function cutBody(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"answer":'));
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

async function markError(status: number): Promise<unknown> {
  const api = createApiClient({
    baseUrl: 'http://api.test',
    getToken: () => Promise.resolve('token'),
    fetchFn: () => Promise.resolve(cutBody(status)),
  });
  return api.put('/events/e/exams/s/answers/r', { correct: true }).then(
    () => {
      throw new Error('a marcação devia falhar ao ler o corpo');
    },
    (error: unknown) => error,
  );
}

describe('marcação com a resposta cortada no meio do corpo (§ 6.4, RN006, #49)', () => {
  it.each([200, 504])(
    'rn006 a resposta %i com o corpo cortado tem resultado desconhecido, não "não salvo"',
    async (status) => {
      const error = await markError(status);

      expect(markOutcomeUnknown(error)).toBe(true);
    },
  );
});
