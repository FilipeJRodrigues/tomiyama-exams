/**
 * Academy screen (§ 6.6), the academy data read again while the screen is open, beyond
 * `AcademyPage.reload.test.tsx` (qa-frontend, #26): a field typed back to its value follows
 * again; leaving the screen and coming back shows the new values; StrictMode (as in
 * `main.tsx`); the unknown outcome of a save (network, 504) followed by reloads; the focus on
 * the master's selector and the caret of the field being typed; the messages of the fields; no
 * console errors.
 *
 * The state while a request is on its way is checked with the response held (`gate`), never
 * with a delay.
 */
import { focusManager } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProviders } from '../../../src/app/AppProviders';
import { createQueryClient } from '../../../src/app/queryClient';
import { createRoutes } from '../../../src/app/routes';
import { createMockAuth } from '../../../src/auth/mockAuth';
import { MOCK_MASTER_EMAIL, MOCK_MASTER_ID, MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { createMockDb, type MockDb, type MockSettings } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import {
  ROUTE,
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
const MASTER_SIMULADO = 'Master Simulado (master@example.com)';
const ORIGINAL_NAME = 'Academia Simulada de Judô';

let db: MockDb;
let settingsReads: number;

beforeEach(() => {
  db = createMockDb();
  settingsReads = 0;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.get(SETTINGS_URL, () => {
      settingsReads += 1;
      return undefined;
    }),
  );
});

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
});

function savedElsewhere(fields: Partial<MockSettings>) {
  db.settings = { ...db.settings, ...fields };
}

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

/** React and Mantine complaints (render-phase updates, keys, act) during a test. */
function watchConsole() {
  const error = vi.spyOn(console, 'error');
  const warn = vi.spyOn(console, 'warn');
  return () => [...error.mock.calls, ...warn.mock.calls].map((args) => args.map(String).join(' '));
}

async function openInStrictMode(profile: 'examiner' | 'master') {
  const auth = createMockAuth(window.sessionStorage);
  if (profile === 'master') {
    await auth.signIn({ email: MOCK_MASTER_EMAIL, password: 'senha-teste', role: 'examiner' });
  } else {
    await auth.signIn({ email: 'examiner@example.com', password: 'senha-teste', role: 'examiner' });
  }
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: true } });
  const router = createMemoryRouter(createRoutes({ useMocks: true }), { initialEntries: [ROUTE] });
  const user = userEvent.setup({ delay: null });
  render(
    <StrictMode>
      <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );
  await screen.findByRole('form', { name: 'Dados da academia' });
  return { user };
}

describe('academy screen, edited or not (qa-frontend, § 6.6)', () => {
  it('a name typed back to the value read follows the next reload', async () => {
    const { user } = await openAcademy('examiner');
    await replaceText(user, nameField(), 'Academia Nova');
    await replaceText(user, nameField(), ORIGINAL_NAME);
    savedElsewhere({ academy_name: 'Outro nome' });

    await windowFocusBack();

    await waitFor(() => {
      expect(nameField()).toHaveValue('Outro nome');
    });
  });

  it('the master: a selector put back on the sensei read follows the next reload', async () => {
    const { user } = await openAcademy('master');
    await user.selectOptions(senseiSelect(), MASTER_SIMULADO);
    await user.selectOptions(senseiSelect(), 'examinadora@example.com');
    savedElsewhere({ sensei_user_id: MOCK_USER_IDS.examiner });

    await windowFocusBack();

    await waitFor(() => {
      expect(senseiSelect()).toHaveValue(MOCK_USER_IDS.examiner);
    });
  });

  it('two reloads in a row with nothing edited: the fields show the last one', async () => {
    await openAcademy('examiner');
    savedElsewhere({ academy_name: 'Primeiro', certificate_city: 'Ibaté' });
    await windowFocusBack();
    await waitFor(() => {
      expect(nameField()).toHaveValue('Primeiro');
    });

    savedElsewhere({ academy_name: 'Segundo', certificate_city: null });
    await windowFocusBack();
    await waitFor(() => {
      expect(nameField()).toHaveValue('Segundo');
    });
    // A city removed elsewhere (null) empties the untouched field.
    expect(cityField()).toHaveValue('');
  });

  it('leaving the screen and coming back shows the values saved meanwhile', async () => {
    const { router } = await openAcademy('examiner');
    await act(async () => {
      await router.navigate('/eventos');
    });
    savedElsewhere({ academy_name: 'Outro nome', certificate_city: 'Araraquara' });
    await act(async () => {
      await router.navigate(ROUTE);
    });
    await screen.findByRole('form', { name: 'Dados da academia' });

    await waitFor(() => {
      expect(nameField()).toHaveValue('Outro nome');
    });
    expect(cityField()).toHaveValue('Araraquara');
  });

  it('another examiner: the inactive sensei notice comes with the reload, for him too', async () => {
    await openAcademy('examiner');
    savedElsewhere({ sensei_user_id: 'conta-removida' });

    await windowFocusBack();

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Sensei inativo');
    expect(note).toHaveTextContent('Só o administrador master pode escolher outro sensei.');
    expect(senseiSelect()).toHaveDisplayValue('Examinador não encontrado (inativo)');
  });
});

describe('academy screen, the reload and the user (qa-frontend, § 6.7)', () => {
  it('the master on the selector: it follows the reload and keeps the focus', async () => {
    const { user } = await openAcademy('master');
    await user.click(nameField());
    await user.tab();
    expect(senseiSelect()).toHaveFocus();
    savedElsewhere({ sensei_user_id: MOCK_USER_IDS.examiner });

    await windowFocusBack();

    await waitFor(() => {
      expect(senseiSelect()).toHaveValue(MOCK_USER_IDS.examiner);
    });
    expect(senseiSelect()).toHaveFocus();
    expect(senseiSelect()).toHaveDisplayValue(SENSEI_SIMULADO);
  });

  it('typing in the middle of the city: the caret stays where it was after a reload', async () => {
    const { user } = await openAcademy('examiner');
    await replaceText(user, cityField(), 'Araquara');
    // Caret after "Ara".
    cityField().setSelectionRange(3, 3);
    savedElsewhere({ academy_name: 'Outro nome' });

    await windowFocusBack();
    await waitFor(() => {
      expect(nameField()).toHaveValue('Outro nome');
    });

    await user.keyboard('ra');
    expect(cityField()).toHaveValue('Araraquara');
    expect(cityField()).toHaveFocus();
  });

  it('the message of an edited field stays through a reload; no new message appears', async () => {
    const { user } = await openAcademy('examiner');
    await user.clear(nameField());
    await user.click(saveButton());
    expect(screen.getByText('Informe o nome da academia.')).toBeVisible();
    expect(nameField()).toHaveFocus();
    savedElsewhere({ academy_name: 'Outro nome', certificate_city: 'Araraquara' });

    await windowFocusBack();

    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });
    expect(nameField()).toHaveValue('');
    expect(screen.getByText('Informe o nome da academia.')).toBeVisible();
    expect(screen.queryByText(/Use no máximo/)).not.toBeInTheDocument();
    expect(nameField()).toHaveFocus();
  });

  it('a reload while the save is on its way: one PUT, the button stays busy', async () => {
    const held = gate();
    let putCount = 0;
    server.use(
      http.put(SETTINGS_URL, async () => {
        putCount += 1;
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openAcademy('examiner');
    await replaceText(user, nameField(), 'Academia Nova');
    await user.click(saveButton());
    await waitFor(() => {
      expect(saveButton()).toBeDisabled();
    });
    savedElsewhere({ certificate_city: 'Araraquara' });
    await windowFocusBack();
    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });
    expect(saveButton()).toBeDisabled();
    await user.dblClick(saveButton());

    held.release();
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(putCount).toBe(1);
  });

  it('no console errors or warnings while reloads and a save change the fields', async () => {
    const { user } = await openAcademy('master');
    // From here on: the mount itself (the session read) is not what is checked.
    const complaints = watchConsole();
    await replaceText(user, nameField(), 'Academia Nova');
    savedElsewhere({ certificate_city: 'Araraquara', sensei_user_id: MOCK_USER_IDS.examiner });
    await windowFocusBack();
    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });
    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    savedElsewhere({ academy_name: 'Outro nome' });
    await windowFocusBack();
    await waitFor(() => {
      expect(nameField()).toHaveValue('Outro nome');
    });

    expect(complaints()).toEqual([]);
  });
});

describe('academy screen, StrictMode as in main.tsx (qa-frontend)', () => {
  it('the untouched fields follow, the typed one stays, and after the save all follow', async () => {
    const complaints = watchConsole();
    const { user } = await openInStrictMode('master');
    await replaceText(user, nameField(), '  Academia Nova  ');
    savedElsewhere({ certificate_city: 'Araraquara', sensei_user_id: MOCK_USER_IDS.examiner });

    await windowFocusBack();
    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });
    expect(senseiSelect()).toHaveValue(MOCK_USER_IDS.examiner);
    expect(nameField()).toHaveValue('  Academia Nova  ');
    expect(nameField()).toHaveFocus();

    await user.click(saveButton());
    expect(await screen.findByText(SAVED)).toBeVisible();
    expect(nameField()).toHaveValue('Academia Nova');

    savedElsewhere({
      academy_name: 'Outro nome',
      certificate_city: 'Ibaté',
      sensei_user_id: MOCK_MASTER_ID,
    });
    await windowFocusBack();
    await waitFor(() => {
      expect(nameField()).toHaveValue('Outro nome');
    });
    expect(cityField()).toHaveValue('Ibaté');
    expect(senseiSelect()).toHaveValue(MOCK_MASTER_ID);
    expect(complaints()).toEqual([]);
  });
});

describe('academy screen, a save with no answer and the reloads (qa-frontend, § 6.6)', () => {
  /** The API stores the body, then the answer is lost (504 of the gateway). */
  function storeThen504() {
    server.use(
      http.put(SETTINGS_URL, async ({ request }) => {
        const body = (await request.json()) as {
          academy_name: string;
          sensei_user_id: string | null;
          certificate_city: string | null;
        };
        db.settings = {
          ...db.settings,
          academy_name: body.academy_name,
          sensei_user_id: body.sensei_user_id,
          certificate_city: body.certificate_city,
        };
        return HttpResponse.json({ message: 'Endpoint request timed out' }, { status: 504 });
      }),
    );
  }

  it('stored before the 504: after its reload the fields count as saved and follow later', async () => {
    storeThen504();
    const { user } = await openAcademy('examiner');
    await replaceText(user, nameField(), 'Academia Nova');
    await replaceText(user, cityField(), 'Ibaté');
    const before = settingsReads;
    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível confirmar o salvamento',
    );
    await waitFor(() => {
      expect(settingsReads).toBeGreaterThan(before);
    });
    expect(nameField()).toHaveValue('Academia Nova');
    expect(cityField()).toHaveValue('Ibaté');

    // The reload brought what was typed: no field is edited any more.
    savedElsewhere({ academy_name: 'Outro nome', certificate_city: 'Araraquara' });
    await windowFocusBack();
    await waitFor(() => {
      expect(nameField()).toHaveValue('Outro nome');
    });
    expect(cityField()).toHaveValue('Araraquara');
  });

  it('lost on the network: the typed name stays, the city saved elsewhere follows', async () => {
    server.use(http.put(SETTINGS_URL, () => HttpResponse.error()));
    const requests = recordRequests();
    const { user } = await openAcademy('examiner');
    await replaceText(user, nameField(), 'Academia Nova');
    savedElsewhere({ certificate_city: 'Araraquara' });

    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível confirmar o salvamento',
    );
    await waitFor(() => {
      expect(cityField()).toHaveValue('Araraquara');
    });
    expect(nameField()).toHaveValue('Academia Nova');
    expect(puts(requests)).toHaveLength(1);
    expect(db.settings.academy_name).toBe(ORIGINAL_NAME);
    expect(db.settings.certificate_city).toBe('Araraquara');
  });
});
