/**
 * Erro: o aviso de marcação recusada some sozinho quando o mesmo item é salvo depois (nova
 * marcação do item que deu certo). Se o foco estava num botão do aviso ("Fechar aviso",
 * pelo teclado ou leitor de tela), o botão sai da tela com o foco e ele cai no `body`: quem
 * navega pelo teclado perde o lugar na lista. A etapa 3 trata o aviso trocado por outro
 * (o foco passa ao botão equivalente do novo), mas não o aviso que sai sem substituto.
 * Esperado: como quando o aviso é fechado pelo botão, o foco vai para o Certo/Errado do
 * item do aviso (o pressionado), senão para o título do exame; nunca para o `body` (§ 6.7).
 * Issue: #49 (etapa 3, item 2)
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb, mockRequirementId } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);

describe('foco quando o aviso de marcação some sozinho (§ 6.4, § 6.7, RN006, #49)', () => {
  let tries = 0;
  let release: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    tries = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
    server.use(
      http.put(ANSWER_URL, async ({ params }) => {
        if (String(params.requirementId) !== PARAR) return undefined;
        tries += 1;
        // 1ª: recusa final (403); 2ª: segura até `release` e grava.
        if (tries === 1) {
          return HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 });
        }
        await held;
        return undefined;
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn006 o foco em "Fechar aviso" vai para o item quando a nova marcação do item é salva', async () => {
    const { user } = await renderApp({
      route: examPath(MOCK_EVENT_IDS.open, HELENA),
      signedInAs: 'examiner',
    });
    await user.click(await screen.findByRole('button', { name: 'Certo: Parar' }));
    const alert = await screen.findByRole('alert');
    // Nova marcação do item, ainda a caminho; o examinador vai pelo teclado até o aviso.
    await user.click(screen.getByRole('button', { name: 'Errado: Parar' }));
    await waitFor(() => {
      expect(tries).toBe(2);
    });
    act(() => {
      within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
    });

    act(() => {
      release();
    });

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    const errado = screen.getByRole('button', { name: 'Errado: Parar' });
    await waitFor(() => {
      expect(errado).toHaveAttribute('aria-pressed', 'true');
    });
    expect(document.activeElement).not.toBe(document.body);
    expect(errado).toHaveFocus();
  });
});
