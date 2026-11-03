/**
 * § 6.4 / § 6.7: closing the notice of a refused mark ("Fechar aviso") takes its button away.
 * The focus goes back to the Certo/Errado buttons of the item the notice names, so the
 * examiner keeps the place in the list; when that item is not on the screen, to the title.
 */
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { MOCK_EVENT_IDS, createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;

function refuseWrites(status: number, message: string) {
  const refuse = () => HttpResponse.json({ message }, { status });
  server.use(http.put(ANSWER_URL, refuse), http.delete(ANSWER_URL, refuse));
}

async function openHelena() {
  const rendered = await renderApp({
    route: examPath(MOCK_EVENT_IDS.open, HELENA),
    signedInAs: 'examiner',
  });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

describe('focus when the mark failure notice closes (§ 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn006 goes to the buttons of the item named in the notice', async () => {
    refuseWrites(503, 'Sistema ocupado no momento. Tente de novo em instantes.');
    const { user } = await openHelena();
    await user.click(screen.getByRole('button', { name: 'Errado: Parar' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível salvar a marcação de "Parar"');

    within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Nothing pressed on the item (the mark was put back): the first button.
    expect(screen.getByRole('button', { name: 'Certo: Parar' })).toHaveFocus();
  });

  it('rn006 goes to the pressed button of the item', async () => {
    refuseWrites(409, 'Outra marcação está em andamento. Tente de novo.');
    const { user } = await openHelena();
    await user.click(screen.getByRole('button', { name: 'Errado: Professor' }));
    const alert = await screen.findByRole('alert');

    within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
    await user.keyboard('{Enter}');

    const certo = screen.getByRole('button', { name: 'Certo: Professor' });
    expect(certo).toHaveAttribute('aria-pressed', 'true');
    expect(certo).toHaveFocus();
  });

  it('goes to the title when the item is not on the screen', async () => {
    refuseWrites(503, 'Sistema ocupado no momento. Tente de novo em instantes.');
    const { user } = await openHelena();
    await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));
    const alert = await screen.findByRole('alert');
    await user.click(screen.getByRole('tab', { name: /^Prático/ }));
    expect(screen.queryByRole('button', { name: 'Certo: Parar' })).not.toBeInTheDocument();

    within(alert).getByRole('button', { name: 'Fechar aviso' }).focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('heading', { level: 1, name: 'Helena Prado' })).toHaveFocus();
  });
});
