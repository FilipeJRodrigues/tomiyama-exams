/**
 * Events screen (§ 6.5, § 6.7): closing the notice with the keyboard puts the focus on the
 * title, never on the body (the close button goes away with the notice). QA coverage of #52.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { dialogGone, openEdit, openEvents } from './helpers';

beforeEach(() => {
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
});

it('closing "Evento salvo." with Enter puts the focus on the title', async () => {
  const { user } = await openEvents();
  const dialog = await openEdit(user, 'Exame novembro/2026');
  await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
  await dialogGone();
  const notice = screen.getByRole('status');
  expect(notice).toHaveTextContent('Evento salvo.');

  within(notice).getByRole('button', { name: 'Fechar aviso' }).focus();
  await user.keyboard('{Enter}');

  expect(screen.queryByText('Evento salvo.')).not.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 1, name: 'Eventos' })).toHaveFocus();
  });
});
