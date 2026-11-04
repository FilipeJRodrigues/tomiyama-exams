/**
 * Academy screen (§ 6.6), coverage added by qa-frontend (#26): session expired on the save,
 * keyboard order of each profile (§ 6.7), the examiners reloaded after the 400 of an inactive
 * sensei, a disabled sensei still in the group (e-mail, no name), the first save of an
 * examiner without a sensei and the master's choice kept when changed during the save.
 *
 * The state while a request is on its way is checked with the response held (`gate`), never
 * with a delay.
 */
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import {
  EXAMINERS_URL,
  SETTINGS_URL,
  cityField,
  gate,
  makeSettings,
  nameField,
  openAcademy,
  puts,
  recordRequests,
  replaceText,
  saveButton,
  senseiSelect,
} from './helpers';

const SAVED = 'Dados da academia salvos.';

let db: MockDb;

describe('academy screen, qa-frontend coverage (§ 6.6, § 6.7)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('a 401 on the save ends the session and leaves the screen', async () => {
    server.use(
      http.put(SETTINGS_URL, () =>
        HttpResponse.json({ message: 'Faça login para continuar' }, { status: 401 }),
      ),
    );
    const { user } = await openAcademy('examiner');
    await user.click(saveButton());

    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Dados da academia' })).not.toBeInTheDocument();
  });

  it('the master reaches name, sensei, city and "Salvar" with Tab, in that order', async () => {
    const { user } = await openAcademy('master');
    nameField().focus();

    await user.tab();
    expect(senseiSelect()).toHaveFocus();
    await user.tab();
    expect(cityField()).toHaveFocus();
    await user.tab();
    expect(saveButton()).toHaveFocus();
  });

  it('another examiner goes from the name to the city with Tab (the selector is read only)', async () => {
    const { user } = await openAcademy('examiner');
    nameField().focus();

    await user.tab();
    expect(cityField()).toHaveFocus();
    await user.tab();
    expect(saveButton()).toHaveFocus();
  });

  it('after the 400 of an inactive sensei the master gets the examiners again', async () => {
    db.settings.sensei_user_id = 'conta-removida';
    const requests = recordRequests();
    const { user } = await openAcademy('master');
    const examinerReads = () => requests.filter((request) => request.url === EXAMINERS_URL).length;
    const before = examinerReads();

    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'O sensei precisa ser um examinador ativo',
    );
    await waitFor(() => {
      expect(examinerReads()).toBeGreaterThan(before);
    });
  });

  it('a disabled sensei still in the group (e-mail, no name) is named by the e-mail', async () => {
    server.use(
      http.get(SETTINGS_URL, () =>
        HttpResponse.json(
          makeSettings({
            sensei: { id: 'sensei-1', email: 'carla@example.com', name: null, active: false },
          }),
        ),
      ),
    );
    await openAcademy('master');

    expect(screen.getByRole('note')).toHaveTextContent(
      'O sensei carla@example.com não é mais um examinador ativo e não pode decidir os exames.',
    );
    expect(senseiSelect()).toHaveDisplayValue('carla@example.com (inativo)');
  });

  it('first use by another examiner: sends the sensei null and the first-use text goes away', async () => {
    db.settings = {
      academy_name: null,
      sensei_user_id: null,
      certificate_city: null,
      created_at: null,
      updated_at: null,
    };
    const requests = recordRequests();
    const { user } = await openAcademy('examiner');
    expect(screen.getByText('Os dados da academia ainda não foram preenchidos.')).toBeVisible();

    await replaceText(user, nameField(), 'Academia Ação');
    await user.click(saveButton());

    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests)[0]?.body).toEqual({
      academy_name: 'Academia Ação',
      sensei_user_id: null,
      certificate_city: null,
    });
    expect(screen.queryByText(/ainda não foram preenchidos/)).not.toBeInTheDocument();
  });

  it('a sensei chosen by the master while the save is on its way stays chosen', async () => {
    const held = gate();
    server.use(
      http.put(SETTINGS_URL, async () => {
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openAcademy('master');
    await user.click(saveButton());
    await waitFor(() => {
      expect(saveButton()).toBeDisabled();
    });

    await user.selectOptions(senseiSelect(), 'Sensei Simulado (examinador@example.com)');
    held.release();

    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(senseiSelect()).toHaveValue(MOCK_USER_IDS.examiner);
    // What was saved is the sensei of the submission, not the one chosen afterwards.
    expect(db.settings.sensei_user_id).toBe('mock-examiner-2');
  });
});
