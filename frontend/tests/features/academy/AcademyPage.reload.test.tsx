/**
 * Academy screen (§ 6.6), the academy data read again while the screen is open (window focus,
 * reload after a refusal): each field not edited since the last sync (name, city, sensei)
 * shows the new value; an edited one keeps what the user typed, with no conflict notice. A
 * reload never moves the focus nor checks the fields. After a save the answer is the new base:
 * no field counts as edited, so the next reload updates them again.
 *
 * The state while a request is on its way is checked with the response held (`gate`), never
 * with a delay.
 */
import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MOCK_MASTER_ID, MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { createMockDb, type MockDb, type MockSettings } from '../../../src/mocks/data';
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
const SENSEI_SIMULADO = 'Sensei Simulado (examinador@example.com)';
const FIELD_MESSAGE = /Informe o nome da academia\.|Use no máximo/;

let db: MockDb;
let settingsReads: number;
/** While set, each `GET /settings` waits for it, then answers what the mock has by then. */
let readGate: ReturnType<typeof gate> | null;

beforeEach(() => {
  db = createMockDb();
  settingsReads = 0;
  readGate = null;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.get(SETTINGS_URL, async () => {
      settingsReads += 1;
      if (readGate) await readGate.wait;
      return undefined;
    }),
  );
});

afterEach(() => {
  focusManager.setFocused(undefined);
});

/** Another examiner (or the master) saved meanwhile. */
function savedElsewhere(fields: Partial<MockSettings>) {
  db.settings = { ...db.settings, ...fields };
}

/** The window gets the focus back: the settings are read again; resolves once asked. */
async function windowFocusBack() {
  const before = settingsReads;
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => {
    expect(settingsReads).toBeGreaterThan(before);
  });
}

function fieldMessages() {
  return screen.queryAllByText(FIELD_MESSAGE);
}

/** Holds every `PUT /settings` until `release()`, then lets the mock answer. */
function holdPuts() {
  const held = gate();
  server.use(
    http.put(SETTINGS_URL, async () => {
      await held.wait;
      return undefined;
    }),
  );
  return held;
}

describe('academy screen, the fields follow the settings read again (§ 6.6)', () => {
  it('nothing edited: name, city and the master selector show the new values', async () => {
    await openAcademy('master');
    savedElsewhere({
      academy_name: 'Associação Tomiyama de Judô',
      certificate_city: 'Araraquara',
      sensei_user_id: MOCK_USER_IDS.examiner,
    });

    await windowFocusBack();

    await waitFor(() => {
      expect(nameField()).toHaveValue('Associação Tomiyama de Judô');
    });
    expect(cityField()).toHaveValue('Araraquara');
    expect(senseiSelect()).toHaveValue(MOCK_USER_IDS.examiner);
    expect(senseiSelect()).toHaveDisplayValue(SENSEI_SIMULADO);
    // A reload is not a submission: no notice, no message, no error.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(SAVED)).not.toBeInTheDocument();
    expect(fieldMessages()).toHaveLength(0);
  });

  it('nothing edited by another examiner: name, city and the stored sensei shown follow', async () => {
    await openAcademy('examiner');
    savedElsewhere({
      academy_name: 'Associação Tomiyama de Judô',
      certificate_city: 'Araraquara',
      sensei_user_id: MOCK_USER_IDS.examiner,
    });

    await windowFocusBack();

    await waitFor(() => {
      expect(nameField()).toHaveValue('Associação Tomiyama de Judô');
    });
    expect(cityField()).toHaveValue('Araraquara');
    expect(senseiSelect()).toBeDisabled();
    expect(senseiSelect()).toHaveDisplayValue(SENSEI_SIMULADO);
  });

  it('an edited field keeps what was typed and the others follow; the PUT sends both', async () => {
    const { user } = await openAcademy('examiner');
    const requests = recordRequests();
    await replaceText(user, nameField(), 'Academia Nova');
    savedElsewhere({ academy_name: 'Outro nome', certificate_city: 'Araraquara' });

    await windowFocusBack();

    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });
    expect(nameField()).toHaveValue('Academia Nova');
    // No conflict notice: the user's value is the one saved (decision of 2026-11-04).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests).map((request) => request.body)).toEqual([
      {
        academy_name: 'Academia Nova',
        sensei_user_id: 'mock-examiner-2',
        certificate_city: 'Araraquara',
      },
    ]);
  });

  it('the master: a sensei chosen stays chosen, the city follows', async () => {
    const { user } = await openAcademy('master');
    const requests = recordRequests();
    await user.selectOptions(senseiSelect(), 'Master Simulado (master@example.com)');
    savedElsewhere({ sensei_user_id: MOCK_USER_IDS.examiner, certificate_city: 'Araraquara' });

    await windowFocusBack();

    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });
    expect(senseiSelect()).toHaveValue(MOCK_MASTER_ID);

    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests)[0]?.body).toEqual({
      academy_name: 'Academia Simulada de Judô',
      sensei_user_id: MOCK_MASTER_ID,
      certificate_city: 'Araraquara',
    });
  });

  it('another examiner: the PUT after the reload resends the new sensei, with no 403', async () => {
    const { user } = await openAcademy('examiner');
    const requests = recordRequests();
    // The master changes the sensei after the screen was read.
    savedElsewhere({ sensei_user_id: MOCK_USER_IDS.examiner });

    await windowFocusBack();
    await waitFor(() => {
      expect(senseiSelect()).toHaveDisplayValue(SENSEI_SIMULADO);
    });

    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(puts(requests).map((request) => request.body)).toEqual([
      {
        academy_name: 'Academia Simulada de Judô',
        sensei_user_id: MOCK_USER_IDS.examiner,
        certificate_city: 'Cidade Simulada',
      },
    ]);
  });

  it('after the 403 the reload brings the new sensei and city; the typed name stays', async () => {
    const { user } = await openAcademy('examiner');
    const requests = recordRequests();
    await replaceText(user, nameField(), 'Academia Nova');
    savedElsewhere({ sensei_user_id: MOCK_USER_IDS.examiner, certificate_city: 'Araraquara' });

    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Sem permissão');
    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });
    expect(senseiSelect()).toHaveDisplayValue(SENSEI_SIMULADO);
    expect(nameField()).toHaveValue('Academia Nova');
    // The refusal stays on the screen until the next save.
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Somente o administrador master escolhe o sensei',
    );

    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(puts(requests)[1]?.body).toEqual({
      academy_name: 'Academia Nova',
      sensei_user_id: MOCK_USER_IDS.examiner,
      certificate_city: 'Araraquara',
    });
  });

  it('the inactive sensei notice follows the sensei read again', async () => {
    await openAcademy('master');
    expect(screen.queryByText('Sensei inativo')).not.toBeInTheDocument();

    savedElsewhere({ sensei_user_id: 'conta-removida' });
    await windowFocusBack();
    expect(await screen.findByRole('note')).toHaveTextContent('Sensei inativo');
    expect(senseiSelect()).toHaveValue('conta-removida');
    expect(senseiSelect()).toHaveDisplayValue('Examinador não encontrado (inativo)');

    savedElsewhere({ sensei_user_id: MOCK_USER_IDS.examiner });
    await windowFocusBack();
    await waitFor(() => {
      expect(screen.queryByText('Sensei inativo')).not.toBeInTheDocument();
    });
    expect(senseiSelect()).toHaveValue(MOCK_USER_IDS.examiner);
  });
});

describe('academy screen, a reload while the user works (§ 6.6, § 6.7)', () => {
  it('a reload while typing changes neither the field being typed nor the focus', async () => {
    const { user } = await openAcademy('examiner');
    await user.clear(cityField());
    await user.keyboard('Ara');
    savedElsewhere({ academy_name: 'Outro nome', certificate_city: 'Cidade Nova' });

    readGate = gate();
    await windowFocusBack();
    // The read is on its way while the user keeps typing.
    await user.keyboard('ra');
    readGate.release();

    await waitFor(() => {
      expect(nameField()).toHaveValue('Outro nome');
    });
    expect(cityField()).toHaveValue('Arara');
    expect(cityField()).toHaveFocus();

    await user.keyboard('quara');
    expect(cityField()).toHaveValue('Araraquara');
    expect(cityField()).toHaveFocus();
  });

  it('the master typing the name: the untouched selector follows, the name and focus stay', async () => {
    const { user } = await openAcademy('master');
    await user.clear(nameField());
    await user.keyboard('Academia N');
    savedElsewhere({ academy_name: 'Outro nome', sensei_user_id: MOCK_USER_IDS.examiner });

    readGate = gate();
    await windowFocusBack();
    await user.keyboard('ov');
    readGate.release();

    await waitFor(() => {
      expect(senseiSelect()).toHaveValue(MOCK_USER_IDS.examiner);
    });
    expect(senseiSelect()).toHaveDisplayValue(SENSEI_SIMULADO);
    expect(nameField()).toHaveValue('Academia Nov');
    expect(nameField()).toHaveFocus();

    await user.keyboard('a');
    expect(nameField()).toHaveValue('Academia Nova');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a reload does not check the fields: an emptied name shows no message', async () => {
    const { user } = await openAcademy('examiner');
    await user.clear(nameField());
    savedElsewhere({ certificate_city: 'Araraquara' });

    await windowFocusBack();

    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });
    expect(nameField()).toHaveValue('');
    expect(nameField()).not.toHaveAttribute('aria-invalid', 'true');
    expect(fieldMessages()).toHaveLength(0);
    expect(nameField()).toHaveFocus();
  });

  it('the message of a field the reload filled goes away', async () => {
    db.settings = {
      academy_name: null,
      sensei_user_id: null,
      certificate_city: null,
      created_at: null,
      updated_at: null,
    };
    const { user } = await openAcademy('examiner');
    await user.click(saveButton());
    expect(screen.getByText('Informe o nome da academia.')).toBeVisible();

    // Another examiner filled the academy data first.
    savedElsewhere({
      academy_name: 'Associação Tomiyama de Judô',
      certificate_city: 'Araraquara',
      created_at: '2026-11-04T12:00:00+00:00',
      updated_at: '2026-11-04T12:00:00+00:00',
    });
    await windowFocusBack();

    await waitFor(() => {
      expect(nameField()).toHaveValue('Associação Tomiyama de Judô');
    });
    expect(fieldMessages()).toHaveLength(0);
    expect(cityField()).toHaveValue('Araraquara');
    expect(screen.queryByText(/ainda não foram preenchidos/)).not.toBeInTheDocument();
  });
});

describe('academy screen, after a save the answer is the new base (§ 6.6)', () => {
  it('another examiner: a reload with new values updates the saved fields again', async () => {
    const { user } = await openAcademy('examiner');
    await replaceText(user, nameField(), '  Academia Nova  ');
    await replaceText(user, cityField(), 'Ibaté');
    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    // What the API stored (trimmed): no field counts as edited any more.
    expect(nameField()).toHaveValue('Academia Nova');

    savedElsewhere({
      academy_name: 'Associação Tomiyama de Judô',
      certificate_city: 'Araraquara',
      sensei_user_id: MOCK_USER_IDS.examiner,
    });
    await windowFocusBack();

    await waitFor(() => {
      expect(nameField()).toHaveValue('Associação Tomiyama de Judô');
    });
    expect(cityField()).toHaveValue('Araraquara');
    expect(senseiSelect()).toHaveDisplayValue(SENSEI_SIMULADO);
  });

  it('the master: the sensei chosen and saved follows a later reload', async () => {
    const { user } = await openAcademy('master');
    await user.selectOptions(senseiSelect(), SENSEI_SIMULADO);
    await replaceText(user, cityField(), ' Ibaté ');
    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(cityField()).toHaveValue('Ibaté');

    savedElsewhere({ sensei_user_id: MOCK_MASTER_ID, certificate_city: 'Araraquara' });
    await windowFocusBack();

    await waitFor(() => {
      expect(senseiSelect()).toHaveValue(MOCK_MASTER_ID);
    });
    expect(cityField()).toHaveValue('Araraquara');
  });

  it('what was typed while the save was on its way stays through a later reload', async () => {
    const held = holdPuts();
    const { user } = await openAcademy('examiner');
    await replaceText(user, nameField(), '  Academia Nova  ');
    await replaceText(user, cityField(), ' Araraquara ');
    await user.click(saveButton());
    await waitFor(() => {
      expect(saveButton()).toBeDisabled();
    });
    await user.type(cityField(), 'x');
    held.release();
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(cityField()).toHaveValue(' Araraquara x');
    // Field by field: the name, untouched since the submission, is the one stored.
    expect(nameField()).toHaveValue('Academia Nova');

    savedElsewhere({ academy_name: 'Outro nome', certificate_city: 'Ibaté' });
    await windowFocusBack();

    await waitFor(() => {
      expect(nameField()).toHaveValue('Outro nome');
    });
    expect(cityField()).toHaveValue(' Araraquara x');
  });

  it('a reload while the save is on its way: the fields end with what the API stored', async () => {
    const held = holdPuts();
    const { user } = await openAcademy('examiner');
    await replaceText(user, nameField(), 'Academia Nova');
    await user.click(saveButton());
    await waitFor(() => {
      expect(saveButton()).toBeDisabled();
    });

    // Another examiner saves the city before this PUT reaches the API.
    savedElsewhere({ certificate_city: 'Araraquara' });
    await windowFocusBack();
    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });

    held.release();
    expect(await screen.findByText(SAVED)).toBeVisible();
    // No lock in the API: the PUT carried the city read before, and the screen shows it.
    expect(db.settings.certificate_city).toBe('Cidade Simulada');
    await waitFor(() => {
      expect(cityField()).toHaveValue('Cidade Simulada');
    });
    expect(nameField()).toHaveValue('Academia Nova');

    // Neither field counts as edited after the save.
    savedElsewhere({ academy_name: 'Outro nome', certificate_city: 'Ibaté' });
    await windowFocusBack();
    await waitFor(() => {
      expect(nameField()).toHaveValue('Outro nome');
    });
    expect(cityField()).toHaveValue('Ibaté');
  });
});
