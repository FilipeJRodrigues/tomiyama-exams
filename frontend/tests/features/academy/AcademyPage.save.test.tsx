/**
 * Academy screen (§ 6.6), the save (`PUT /settings`, § 3.7): the master changes and removes
 * the sensei; another examiner saves name and city resending the stored sensei (also an
 * inactive one); the API refusals (400, 403, 503) and the unknown outcome with its message;
 * one request per submission and the focus kept (§ 6.7).
 *
 * The state while a request is on its way is checked with the response held (`gate`), never
 * with a delay.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import {
  SETTINGS_URL,
  cityField,
  gate,
  nameField,
  openAcademy,
  puts,
  recordRequests,
  replaceText,
  saveButton,
  senseiSelect,
} from './helpers';

const SAVED = 'Dados da academia salvos.';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

let db: MockDb;

function savedNotice() {
  return screen.queryByText(SAVED);
}

describe('academy screen, the master saves (§ 6.6)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('changes the sensei: PUT with every field, notice, focus kept on "Salvar"', async () => {
    const { user } = await openAcademy('master');
    const requests = recordRequests();

    await user.selectOptions(senseiSelect(), 'Sensei Simulado (examinador@example.com)');
    await user.click(saveButton());

    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(SAVED);
    expect(puts(requests)).toEqual([
      {
        method: 'PUT',
        url: SETTINGS_URL,
        body: {
          academy_name: 'Academia Simulada de Judô',
          sensei_user_id: MOCK_USER_IDS.examiner,
          certificate_city: 'Cidade Simulada',
        },
      },
    ]);
    expect(db.settings.sensei_user_id).toBe(MOCK_USER_IDS.examiner);
    expect(senseiSelect()).toHaveValue(MOCK_USER_IDS.examiner);
    expect(saveButton()).toHaveFocus();
  });

  it('removes the sensei with "Sem sensei": sensei_user_id null', async () => {
    const { user } = await openAcademy('master');
    const requests = recordRequests();

    await user.selectOptions(senseiSelect(), 'Sem sensei');
    await user.click(saveButton());

    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests)[0]?.body).toMatchObject({ sensei_user_id: null });
    expect(db.settings.sensei_user_id).toBeNull();
    expect(senseiSelect()).toHaveDisplayValue('Sem sensei');
  });

  it('first use: fills everything and the fields show what the API stored', async () => {
    db.settings = {
      academy_name: null,
      sensei_user_id: null,
      certificate_city: null,
      created_at: null,
      updated_at: null,
    };
    const { user } = await openAcademy('master');
    const requests = recordRequests();

    await replaceText(user, nameField(), '  Associação Tomiyama de Judô  ');
    await user.selectOptions(senseiSelect(), 'Master Simulado (master@example.com)');
    await replaceText(user, cityField(), ' Araraquara ');
    await user.click(saveButton());

    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests)[0]?.body).toEqual({
      academy_name: 'Associação Tomiyama de Judô',
      sensei_user_id: 'mock-master',
      certificate_city: 'Araraquara',
    });
    expect(nameField()).toHaveValue('Associação Tomiyama de Judô');
    expect(cityField()).toHaveValue('Araraquara');
    expect(screen.queryByText(/ainda não foram preenchidos/)).not.toBeInTheDocument();
  });

  it('shows the 400 of an inactive sensei kept by the master; nothing is saved', async () => {
    db.settings.sensei_user_id = 'conta-removida';
    const { user } = await openAcademy('master');
    await replaceText(user, nameField(), 'Outro nome');
    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível salvar');
    expect(alert).toHaveTextContent('O sensei precisa ser um examinador ativo');
    expect(db.settings.academy_name).toBe('Academia Simulada de Judô');
    expect(nameField()).toHaveValue('Outro nome');
    expect(savedNotice()).not.toBeInTheDocument();

    // Choosing an active examiner saves.
    await user.selectOptions(senseiSelect(), 'Sensei Simulado (examinador@example.com)');
    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(db.settings).toMatchObject({
      academy_name: 'Outro nome',
      sensei_user_id: MOCK_USER_IDS.examiner,
    });
  });
});

describe('academy screen, another examiner saves (§ 6.6)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('saves name and city resending the stored sensei; a blank city is null', async () => {
    const { user } = await openAcademy('examiner');
    const requests = recordRequests();

    await replaceText(user, nameField(), 'Academia Nova');
    await replaceText(user, cityField(), '   ');
    await user.click(saveButton());

    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests)).toEqual([
      {
        method: 'PUT',
        url: SETTINGS_URL,
        body: {
          academy_name: 'Academia Nova',
          sensei_user_id: 'mock-examiner-2',
          certificate_city: null,
        },
      },
    ]);
    expect(db.settings).toMatchObject({
      academy_name: 'Academia Nova',
      sensei_user_id: 'mock-examiner-2',
      certificate_city: null,
    });
    expect(cityField()).toHaveValue('');
  });

  it('resends null when there is no sensei', async () => {
    db.settings.sensei_user_id = null;
    const { user } = await openAcademy('examiner');
    const requests = recordRequests();
    await user.click(saveButton());

    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests)[0]?.body).toMatchObject({ sensei_user_id: null });
  });

  it('saves with an inactive stored sensei, resending it', async () => {
    db.settings.sensei_user_id = 'conta-removida';
    const { user } = await openAcademy('examiner');
    const requests = recordRequests();
    expect(screen.getByText('Sensei inativo')).toBeVisible();

    await replaceText(user, cityField(), 'Araraquara');
    await user.click(saveButton());

    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests)[0]?.body).toMatchObject({
      sensei_user_id: 'conta-removida',
      certificate_city: 'Araraquara',
    });
    // Still inactive after the save: the notice stays.
    expect(screen.getByText('Sensei inativo')).toBeVisible();
  });

  it('shows the 403 when the master changed the sensei meanwhile, then saves with the new one', async () => {
    const { user } = await openAcademy('examiner');
    const requests = recordRequests();
    // The master changes the sensei after the screen was read.
    db.settings.sensei_user_id = MOCK_USER_IDS.examiner;

    await replaceText(user, nameField(), 'Academia Nova');
    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Somente o administrador master escolhe o sensei');
    expect(alert).toHaveTextContent(
      'O sensei foi trocado enquanto a tela estava aberta. Confira o sensei atual e salve de novo.',
    );
    expect(db.settings.academy_name).toBe('Academia Simulada de Judô');
    // The settings reload: the selector shows the new sensei, the typed name stays.
    await waitFor(() => {
      expect(senseiSelect()).toHaveDisplayValue('Sensei Simulado (examinador@example.com)');
    });
    expect(nameField()).toHaveValue('Academia Nova');

    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests).map((request) => request.body)).toEqual([
      {
        academy_name: 'Academia Nova',
        sensei_user_id: 'mock-examiner-2',
        certificate_city: 'Cidade Simulada',
      },
      {
        academy_name: 'Academia Nova',
        sensei_user_id: MOCK_USER_IDS.examiner,
        certificate_city: 'Cidade Simulada',
      },
    ]);
  });
});

describe('academy screen, checks and API errors', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('checks the fields before sending and focuses the first invalid one', async () => {
    const { user } = await openAcademy('examiner');
    const requests = recordRequests();

    await replaceText(user, nameField(), '   ');
    await replaceText(user, cityField(), 'x'.repeat(81));
    await user.click(saveButton());

    expect(screen.getByText('Informe o nome da academia.')).toBeVisible();
    expect(screen.getByText('Use no máximo 80 caracteres.')).toBeVisible();
    expect(nameField()).toHaveFocus();
    expect(nameField()).toHaveAccessibleDescription(/Informe o nome da academia\./);

    await replaceText(user, nameField(), 'x'.repeat(256));
    await replaceText(user, cityField(), 'Araraquara');
    await user.click(saveButton());
    expect(screen.getByText('Use no máximo 255 caracteres.')).toBeVisible();
    expect(puts(requests)).toHaveLength(0);
  });

  it('counts characters like the API: 255 emoji (510 UTF-16 units) pass', async () => {
    const { user } = await openAcademy('examiner');
    await replaceText(user, nameField(), '🥋'.repeat(255));
    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
  });

  it.each([
    [400, 'Cidade do certificado: máximo de 80 caracteres', 'Não foi possível salvar'],
    [400, 'Nome da academia: máximo de 255 caracteres', 'Não foi possível salvar'],
    [400, 'Sensei: máximo de 128 caracteres', 'Não foi possível salvar'],
    [403, 'Somente o administrador master escolhe o sensei', 'Sem permissão'],
    [503, BUSY, 'Não foi possível salvar'],
  ])('shows the %i "%s" of the API and keeps the fields', async (status, message, title) => {
    server.use(http.put(SETTINGS_URL, () => HttpResponse.json({ message }, { status })));
    const { user } = await openAcademy('master');
    await replaceText(user, cityField(), 'Araraquara');
    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent(message);
    expect(screen.getByRole('form', { name: 'Dados da academia' })).toHaveAccessibleDescription(
      new RegExp(message),
    );
    expect(cityField()).toHaveValue('Araraquara');
    expect(savedNotice()).not.toBeInTheDocument();
    expect(saveButton()).toHaveFocus();
  });

  it('without an answer says the data may have been saved and reloads the settings', async () => {
    let settingsReads = 0;
    server.use(
      http.get(SETTINGS_URL, () => {
        settingsReads += 1;
        return undefined;
      }),
      http.put(SETTINGS_URL, () => HttpResponse.error()),
    );
    const { user } = await openAcademy('examiner');
    const readsBefore = settingsReads;
    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível confirmar o salvamento');
    expect(alert).toHaveTextContent(
      'Os dados podem ter sido salvos. Confira os campos e salve de novo se precisar.',
    );
    await waitFor(() => {
      expect(settingsReads).toBeGreaterThan(readsBefore);
    });
  });
});

describe('academy screen, one request per submission', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  function holdPuts() {
    const held = gate();
    const counter = { count: 0 };
    server.use(
      http.put(SETTINGS_URL, async () => {
        counter.count += 1;
        await held.wait;
        return undefined;
      }),
    );
    return { held, counter };
  }

  it('a double click sends one PUT; the button is busy while it is on its way', async () => {
    const { user } = await openAcademy('examiner');
    const { held, counter } = holdPuts();

    await user.dblClick(saveButton());
    await waitFor(() => {
      expect(saveButton()).toBeDisabled();
    });
    expect(saveButton()).toHaveAttribute('data-loading');
    expect(counter.count).toBe(1);

    held.release();
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(saveButton()).toBeEnabled();
    expect(counter.count).toBe(1);
  });

  it('two submits before the next render send one PUT', async () => {
    await openAcademy('examiner');
    const { held, counter } = holdPuts();
    const form = screen.getByRole('form', { name: 'Dados da academia' });

    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => {
      expect(counter.count).toBe(1);
    });
    held.release();
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(counter.count).toBe(1);
  });

  it('keeps what was typed while the PUT was on its way', async () => {
    const { user } = await openAcademy('examiner');
    const { held } = holdPuts();

    await replaceText(user, cityField(), ' Araraquara ');
    await user.click(saveButton());
    await waitFor(() => {
      expect(saveButton()).toBeDisabled();
    });
    await user.type(cityField(), 'x');
    held.release();

    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(cityField()).toHaveValue(' Araraquara x');
  });

  it('Enter twice in a field sends one PUT', async () => {
    const { user } = await openAcademy('examiner');
    const { held, counter } = holdPuts();

    await user.click(cityField());
    await user.keyboard('{Enter}{Enter}');
    await waitFor(() => {
      expect(counter.count).toBe(1);
    });
    held.release();
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(counter.count).toBe(1);
  });
});

describe('academy screen, the saved notice', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('goes away when a field changes', async () => {
    const { user } = await openAcademy('examiner');
    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();

    await user.type(cityField(), 'x');
    expect(savedNotice()).not.toBeInTheDocument();
  });

  it('closes with "Fechar aviso" and the focus goes to the title', async () => {
    const { user } = await openAcademy('examiner');
    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Fechar aviso' }));
    expect(savedNotice()).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Academia', level: 1 })).toHaveFocus();
    });
  });
});
