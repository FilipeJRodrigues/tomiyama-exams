/**
 * Academy screen (§ 6.6), the academy data: loading, error with "Tentar de novo", no
 * permission, first use (every field `null`), the filled fields, the sensei selector enabled
 * only for the admin master (groups `master` and `admin`) and the inactive sensei notice.
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
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import {
  EXAMINERS_URL,
  ROUTE,
  SETTINGS_URL,
  cityField,
  gate,
  makeSettings,
  nameField,
  openAcademy,
  recordRequests,
  saveButton,
  senseiOptionLabels,
  senseiSelect,
} from './helpers';

let db: MockDb;

describe('academy screen, loading and states (§ 6.6)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('shows the loading state until the settings arrive', async () => {
    const held = gate();
    server.use(
      http.get(SETTINGS_URL, async () => {
        await held.wait;
        return undefined;
      }),
    );
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });

    expect(await screen.findByRole('heading', { name: 'Academia', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dados da academia', level: 2 })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Carregando dados da academia…');
    expect(screen.queryByRole('form')).not.toBeInTheDocument();

    held.release();
    expect(await screen.findByRole('form', { name: 'Dados da academia' })).toBeInTheDocument();
    expect(screen.queryByText('Carregando dados da academia…')).not.toBeInTheDocument();
  });

  it('shows the API error with "Tentar de novo", which loads again', async () => {
    let fail = true;
    server.use(
      http.get(SETTINGS_URL, () =>
        fail
          ? HttpResponse.json(
              { message: 'Sistema ocupado no momento. Tente de novo em instantes.' },
              { status: 503 },
            )
          : undefined,
      ),
    );
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar os dados da academia');
    expect(alert).toHaveTextContent('Sistema ocupado no momento. Tente de novo em instantes.');

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('form', { name: 'Dados da academia' })).toBeInTheDocument();
    expect(nameField()).toHaveValue('Academia Simulada de Judô');
  });

  it('shows "Sem permissão" without "Tentar de novo" on a 403', async () => {
    server.use(
      http.get(SETTINGS_URL, () =>
        HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
      ),
    );
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos examinadores');
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).not.toBeInTheDocument();
  });

  it('is for examiners only: a guardian gets the notice and no request', async () => {
    const requests = recordRequests();
    await openAcademy('guardian');

    expect(
      await screen.findByRole('heading', { name: 'Esta área é dos examinadores' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});

describe('academy screen, fields (§ 3.7)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('fills the fields with the stored settings', async () => {
    await openAcademy();

    expect(nameField()).toHaveValue('Academia Simulada de Judô');
    expect(nameField()).toBeRequired();
    expect(cityField()).toHaveValue('Cidade Simulada');
    expect(senseiSelect()).toHaveDisplayValue('examinadora@example.com');
    expect(screen.queryByText(/ainda não foram preenchidos/)).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('first use: every field null shows empty fields and "Sem sensei"', async () => {
    db.settings = {
      academy_name: null,
      sensei_user_id: null,
      certificate_city: null,
      created_at: null,
      updated_at: null,
    };
    await openAcademy();

    expect(screen.getByText('Os dados da academia ainda não foram preenchidos.')).toBeVisible();
    expect(nameField()).toHaveValue('');
    expect(cityField()).toHaveValue('');
    expect(senseiSelect()).toHaveDisplayValue('Sem sensei');
    expect(screen.queryByText('Sensei inativo')).not.toBeInTheDocument();
  });

  it('every field has a label and a description tied to it (§ 6.7)', async () => {
    await openAcademy('master');

    expect(nameField()).toHaveAccessibleDescription(/Aparece no topo do certificado/);
    expect(cityField()).toHaveAccessibleDescription(/Opcional/);
    expect(senseiSelect()).toHaveAccessibleDescription('Só o sensei decide os exames.');
  });

  it('fits the phone: the same fields and action at 320 px (§ 6.7)', async () => {
    setViewportWidth(320);
    await openAcademy('master');

    expect(nameField()).toBeVisible();
    expect(senseiSelect()).toBeEnabled();
    expect(cityField()).toBeVisible();
    expect(saveButton()).toBeVisible();
  });
});

describe('academy screen, who changes the sensei (§ 6.6)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('the master chooses among "Sem sensei" and the active examiners', async () => {
    const requests = recordRequests();
    await openAcademy('master');

    expect(senseiSelect()).toBeEnabled();
    expect(senseiSelect()).toHaveValue('mock-examiner-2');
    expect(senseiOptionLabels()).toEqual([
      'Sem sensei',
      'Sensei Simulado (examinador@example.com)',
      'examinadora@example.com',
      'Master Simulado (master@example.com)',
    ]);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toContain(
      `GET ${EXAMINERS_URL}`,
    );
  });

  it('another examiner sees the stored sensei in a disabled selector, without the list', async () => {
    const requests = recordRequests();
    await openAcademy('examiner');

    expect(senseiSelect()).toBeDisabled();
    expect(senseiSelect()).toHaveValue('mock-examiner-2');
    expect(senseiOptionLabels()).toEqual(['examinadora@example.com']);
    expect(senseiSelect()).toHaveAccessibleDescription(
      'Só o sensei decide os exames. Só o administrador master troca o sensei.',
    );
    expect(requests.some((request) => request.url === EXAMINERS_URL)).toBe(false);
    // Name and city stay open to every examiner.
    expect(nameField()).toBeEnabled();
    expect(cityField()).toBeEnabled();
  });

  it('another examiner without a sensei sees "Sem sensei", disabled', async () => {
    db.settings.sensei_user_id = null;
    await openAcademy('examiner');

    expect(senseiSelect()).toBeDisabled();
    expect(senseiOptionLabels()).toEqual(['Sem sensei']);
  });

  it('shows the master the examiners error with "Tentar de novo"', async () => {
    let fail = true;
    server.use(
      http.get(EXAMINERS_URL, () =>
        fail ? HttpResponse.json({ message: 'Erro no servidor' }, { status: 500 }) : undefined,
      ),
    );
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'master' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar os examinadores');
    expect(screen.queryByRole('form')).not.toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('form', { name: 'Dados da academia' })).toBeInTheDocument();
    expect(senseiSelect()).toBeEnabled();
  });

  it('waits for the examiners before showing the master the form', async () => {
    const held = gate();
    server.use(
      http.get(EXAMINERS_URL, async () => {
        await held.wait;
        return undefined;
      }),
    );
    await renderApp({ route: ROUTE, signedInAs: 'master' });

    expect(await screen.findByText('Carregando dados da academia…')).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    held.release();
    expect(await screen.findByRole('form', { name: 'Dados da academia' })).toBeInTheDocument();
  });
});

describe('academy screen, inactive sensei (§ 6.6)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  function useInactiveSensei() {
    server.use(
      http.get(SETTINGS_URL, () =>
        HttpResponse.json(
          makeSettings({
            sensei_user_id: 'sensei-1',
            sensei: {
              id: 'sensei-1',
              email: 'sensei@example.com',
              name: 'Tomiyama',
              active: false,
            },
          }),
        ),
      ),
    );
  }

  it('asks the master for another sensei and keeps the stored one selected', async () => {
    useInactiveSensei();
    await openAcademy('master');

    expect(screen.getByText('Sensei inativo')).toBeVisible();
    // A standing notice of the loaded data, not an interruption.
    expect(screen.getByRole('note')).toHaveTextContent('Sensei inativo');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'O sensei Tomiyama não é mais um examinador ativo e não pode decidir os exames.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Escolha outro sensei ou "Sem sensei" e salve.')).toBeVisible();
    expect(senseiSelect()).toHaveValue('sensei-1');
    expect(senseiSelect()).toHaveDisplayValue('Tomiyama (sensei@example.com) (inativo)');
    expect(senseiOptionLabels()).toContain('Sensei Simulado (examinador@example.com)');
  });

  it('tells another examiner that only the master can choose another', async () => {
    useInactiveSensei();
    await openAcademy('examiner');

    expect(screen.getByText('Sensei inativo')).toBeVisible();
    expect(screen.getByText('Só o administrador master pode escolher outro sensei.')).toBeVisible();
    expect(senseiSelect()).toBeDisabled();
    expect(senseiSelect()).toHaveDisplayValue('Tomiyama (sensei@example.com) (inativo)');
  });

  it('a sensei out of the admin group (no e-mail nor name) is still named as inactive', async () => {
    db.settings.sensei_user_id = 'conta-removida';
    await openAcademy('master');

    expect(
      screen.getByText(
        'O sensei escolhido não é mais um examinador ativo e não pode decidir os exames.',
      ),
    ).toBeVisible();
    expect(senseiSelect()).toHaveValue('conta-removida');
    expect(senseiSelect()).toHaveDisplayValue('Examinador não encontrado (inativo)');
  });

  it('an active sensei shows no notice', async () => {
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
    await openAcademy('master');
    await waitFor(() => {
      expect(senseiSelect()).toHaveDisplayValue('Sensei Simulado (examinador@example.com)');
    });
    expect(screen.queryByText('Sensei inativo')).not.toBeInTheDocument();
  });
});
