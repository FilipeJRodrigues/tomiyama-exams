/**
 * Belts screen (§ 6.5, § 6.7), the edit dialog by profile (#143): the admin master edits every
 * field; any other examiner edits only the minimum age (RN001) and the minimum time in the
 * previous belt (RN002), sees the rest as text and sends it back as read. A 403 for a belt the
 * master changed meanwhile shows the API message and lets the belt be read again.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BeltInput } from '../../../src/api/types';
import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { resetViewport, setViewportWidth } from '../../viewport';

const BELTS_URL = `${TEST_API_URL}/belts`;
const CINZA_AZUL = mockBelts.find((belt) => belt.name === 'Cinza/Azul')!;
const ONLY_MASTER =
  'Somente o administrador master altera nome, kyū, ordem, nível e cores da faixa';

let db: MockDb;

async function openBelts(profile: 'master' | 'examiner') {
  const result = await renderApp({ route: '/faixas', signedInAs: profile });
  await screen.findByRole('button', { name: 'Editar faixa Cinza/Azul' });
  return result;
}

async function openEditor(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: `Editar faixa ${name}` }));
  return screen.findByRole('dialog', { name: `Editar faixa ${name}` });
}

function recordPuts(): BeltInput[] {
  const bodies: BeltInput[] = [];
  server.use(
    http.put(`${BELTS_URL}/:id`, async ({ request }) => {
      bodies.push((await request.clone().json()) as BeltInput);
      return undefined;
    }),
  );
  return bodies;
}

async function replaceText(user: UserEvent, input: HTMLElement, text: string) {
  await user.clear(input);
  if (text) {
    await user.click(input);
    await user.paste(text);
  }
}

function ageField(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('textbox', { name: /^Idade mínima/ });
}

function monthsField(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('textbox', { name: /^Carência/ });
}

/** Label/value pairs of the read-only belt data, in screen order. */
function fixedData(dialog: HTMLElement): [string, string][] {
  const section = within(dialog).getByRole('region', { name: 'Dados da faixa' });
  const terms = Array.from(section.querySelectorAll('dt'));
  return terms.map((term) => [
    term.textContent.trim(),
    term.nextElementSibling?.textContent.trim() ?? '',
  ]);
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

describe('belt dialog of the admin master (#143)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('shows every field, as before, and no read-only belt data', async () => {
    const { user } = await openBelts('master');
    const dialog = await openEditor(user, 'Cinza/Azul');

    // Nome, Ordem, Idade mínima, Carência, Cor and Cor das pontas; Kyū and Nível are selects.
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(6);
    expect(within(dialog).getByRole('textbox', { name: /^Nome/ })).toHaveValue('Cinza/Azul');
    expect(within(dialog).getByRole('textbox', { name: /^Ordem/ })).toHaveValue('3');
    expect(within(dialog).getByRole('combobox', { name: 'Kyū' })).toHaveValue('9');
    expect(within(dialog).getByRole('combobox', { name: /^Nível/ })).toHaveValue('BASIC');
    expect(ageField(dialog)).toHaveValue('6');
    expect(monthsField(dialog)).toHaveValue('6');
    expect(within(dialog).getByRole('textbox', { name: /^Cor$|^Cor \*/ })).toHaveValue('#9E9E9E');
    expect(within(dialog).getByRole('textbox', { name: /^Cor das pontas/ })).toHaveValue('#1E63C6');
    expect(within(dialog).queryByRole('region', { name: 'Dados da faixa' })).toBeNull();
    expect(within(dialog).queryByText(/Só o administrador master/)).toBeNull();
    await waitFor(() => {
      expect(within(dialog).getByRole('textbox', { name: /^Nome/ })).toHaveFocus();
    });
  });

  it('saves a new name, order, kyū, level and colors', async () => {
    const puts = recordPuts();
    const { user } = await openBelts('master');
    const dialog = await openEditor(user, 'Cinza/Azul');
    await replaceText(user, within(dialog).getByRole('textbox', { name: /^Nome/ }), 'Cinza-azul');
    await replaceText(user, within(dialog).getByRole('textbox', { name: /^Ordem/ }), '50');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Kyū' }), '8');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /^Nível/ }),
      'INTERMEDIATE',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await dialogGone();
    expect(puts).toEqual([
      {
        name: 'Cinza-azul',
        kyu: 8,
        sort_order: 50,
        level: 'INTERMEDIATE',
        min_age_years: 6,
        min_months_previous: 6,
        color_primary: '#9E9E9E',
        color_secondary: '#1E63C6',
      },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza-azul salva.');
  });
});

describe('belt dialog of an examiner who is not the admin master (#143)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });
  afterEach(() => {
    resetViewport();
  });

  it('rn001 rn002 shows only the age and months fields; the rest is text with the reason', async () => {
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');

    expect(within(dialog).getAllByRole('textbox')).toEqual([ageField(dialog), monthsField(dialog)]);
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(ageField(dialog)).toHaveValue('6');
    expect(monthsField(dialog)).toHaveValue('6');
    expect(ageField(dialog)).toBeEnabled();
    expect(monthsField(dialog)).toBeEnabled();

    const section = within(dialog).getByRole('region', { name: 'Dados da faixa' });
    expect(section).toHaveAccessibleDescription(
      'Só o administrador master altera nome, ordem, kyū, nível e cores.',
    );
    expect(fixedData(dialog)).toEqual([
      ['Nome', 'Cinza/Azul'],
      ['Ordem', '3'],
      ['Kyū', '9'],
      ['Nível', 'Básico'],
      ['Cores', '#9E9E9E, pontas #1E63C6'],
    ]);
    // Text, not disabled fields: nothing there takes the focus or looks like a field.
    expect(section.querySelector('input, select, textarea, [disabled], [tabindex]')).toBeNull();
    // The belt drawn in its colors: decorative, the colors are written below it.
    const drawing = within(section).getByTestId('belt-drawing');
    expect(drawing).toHaveAttribute('aria-hidden', 'true');
    expect(drawing.style.background).toContain('linear-gradient');

    await waitFor(() => {
      expect(ageField(dialog)).toHaveFocus();
    });
  });

  it('writes "Sem kyū" for the belt without kyū', async () => {
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Branca');
    expect(fixedData(dialog)).toEqual([
      ['Nome', 'Branca'],
      ['Ordem', '0'],
      ['Kyū', 'Sem kyū'],
      ['Nível', 'Básico'],
      ['Cores', '#FFFFFF'],
    ]);
  });

  it('rn001 rn002 sends the typed age and months with every other field as read', async () => {
    const puts = recordPuts();
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');
    await replaceText(user, ageField(dialog), '7');
    await replaceText(user, monthsField(dialog), '12');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await dialogGone();
    expect(puts).toEqual([
      {
        name: 'Cinza/Azul',
        kyu: 9,
        sort_order: 3,
        level: 'BASIC',
        min_age_years: 7,
        min_months_previous: 12,
        color_primary: '#9E9E9E',
        color_secondary: '#1E63C6',
      },
    ]);
    expect(db.belts.find((belt) => belt.id === CINZA_AZUL.id)).toEqual({
      ...CINZA_AZUL,
      min_age_years: 7,
      min_months_previous: 12,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza/Azul salva.');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar faixa Cinza/Azul' })).toHaveFocus();
    });
  });

  it('rn001 rn002 saves the ceilings (age 99, months 240) and 0', async () => {
    const puts = recordPuts();
    const { user } = await openBelts('examiner');
    let dialog = await openEditor(user, 'Cinza/Azul');
    await replaceText(user, ageField(dialog), '99');
    await replaceText(user, monthsField(dialog), '240');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    dialog = await openEditor(user, 'Cinza/Azul');
    await replaceText(user, ageField(dialog), '0');
    await replaceText(user, monthsField(dialog), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    expect(puts.map((body) => [body.min_age_years, body.min_months_previous])).toEqual([
      [99, 240],
      [0, 0],
    ]);
  });

  it('rn001 rn002 refuses one past each ceiling in the field, with focus and no PUT', async () => {
    const puts = recordPuts();
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');
    await replaceText(user, ageField(dialog), '100');
    await replaceText(user, monthsField(dialog), '241');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(ageField(dialog)).toHaveAccessibleDescription(/Use um número inteiro de 0 a 99\./);
    expect(monthsField(dialog)).toHaveAccessibleDescription(/Use um número inteiro de 0 a 240\./);
    expect(ageField(dialog)).toHaveAttribute('aria-invalid', 'true');
    expect(ageField(dialog)).toHaveFocus();
    expect(puts).toHaveLength(0);
  });

  it('rn001 rn002 asks for an empty field and refuses a sign or a decimal', async () => {
    const puts = recordPuts();
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');
    await replaceText(user, ageField(dialog), '');
    await replaceText(user, monthsField(dialog), '-1');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(within(dialog).getByText('Informe a idade mínima.')).toBeVisible();
    expect(monthsField(dialog)).toHaveAccessibleDescription(/Use um número inteiro de 0 a 240\./);
    expect(ageField(dialog)).toHaveFocus();

    await replaceText(user, ageField(dialog), '6');
    await replaceText(user, monthsField(dialog), '1,5');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(monthsField(dialog)).toHaveFocus();
    expect(puts).toHaveLength(0);
  });

  it('a belt changed by the master meanwhile: 403 with the API message, nothing saved, reread and save', async () => {
    const puts = recordPuts();
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');
    // The master renames the belt and moves it while the dialog is open.
    db.belts = db.belts.map((belt) =>
      belt.id === CINZA_AZUL.id ? { ...belt, name: 'Cinza e azul', sort_order: 30 } : belt,
    );
    await replaceText(user, ageField(dialog), '8');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent(ONLY_MASTER);
    expect(alert).toHaveTextContent('Os dados da faixa mudaram enquanto a tela estava aberta.');
    expect(db.belts.find((belt) => belt.id === CINZA_AZUL.id)?.min_age_years).toBe(6);
    expect(puts).toHaveLength(1);
    expect(
      screen.getByRole('form', { name: 'Editar faixa Cinza/Azul' }),
    ).toHaveAccessibleDescription(new RegExp(ONLY_MASTER));

    await user.click(within(alert).getByRole('button', { name: 'Reler a faixa' }));

    const updated = await screen.findByRole('dialog', { name: 'Editar faixa Cinza e azul' });
    expect(within(updated).getByRole('status')).toHaveTextContent(
      'Faixa relida com os dados atuais.',
    );
    expect(within(updated).queryByRole('alert')).toBeNull();
    expect(fixedData(updated).slice(0, 2)).toEqual([
      ['Nome', 'Cinza e azul'],
      ['Ordem', '30'],
    ]);
    // What was typed stays; the focus goes to the first field.
    expect(ageField(updated)).toHaveValue('8');
    await waitFor(() => {
      expect(ageField(updated)).toHaveFocus();
    });
    // The list behind the dialog caught up too.
    expect(screen.getByRole('button', { name: 'Editar faixa Cinza e azul' })).toBeInTheDocument();

    await user.click(within(updated).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(puts[1]).toMatchObject({ name: 'Cinza e azul', sort_order: 30, min_age_years: 8 });
    expect(db.belts.find((belt) => belt.id === CINZA_AZUL.id)?.min_age_years).toBe(8);
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza e azul salva.');
  });

  it('a failed reread keeps the error and the button, with the reason, and tries again', async () => {
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');
    db.belts = db.belts.map((belt) =>
      belt.id === CINZA_AZUL.id ? { ...belt, color_primary: '#808080' } : belt,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const alert = await within(dialog).findByRole('alert');

    let failGet = true;
    server.use(
      http.get(BELTS_URL, () =>
        failGet
          ? HttpResponse.json(
              { message: 'Sistema ocupado no momento. Tente de novo em instantes.' },
              { status: 503 },
            )
          : undefined,
      ),
    );
    const reread = within(alert).getByRole('button', { name: 'Reler a faixa' });
    await user.click(reread);
    await waitFor(() => {
      expect(alert).toHaveTextContent(
        'Não foi possível reler a faixa. Sistema ocupado no momento. Tente de novo em instantes.',
      );
    });
    expect(alert).toHaveTextContent(ONLY_MASTER);
    await waitFor(() => {
      expect(reread).toBeEnabled();
    });
    expect(reread).toHaveFocus();

    failGet = false;
    await user.click(reread);
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Faixa relida');
    expect(fixedData(dialog)).toContainEqual(['Cores', '#808080, pontas #1E63C6']);
  });

  it('a belt deleted meanwhile: the reread says it was not found', async () => {
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');
    server.use(
      http.put(`${BELTS_URL}/:id`, () =>
        HttpResponse.json({ message: ONLY_MASTER }, { status: 403 }),
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const alert = await within(dialog).findByRole('alert');
    db.belts = db.belts.filter((belt) => belt.id !== CINZA_AZUL.id);
    await user.click(within(alert).getByRole('button', { name: 'Reler a faixa' }));
    await waitFor(() => {
      expect(alert).toHaveTextContent('Não foi possível reler a faixa. Faixa não encontrada');
    });
  });

  it('another 403 shows its message with no reread button', async () => {
    server.use(
      http.put(`${BELTS_URL}/:id`, () =>
        HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
      ),
    );
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos examinadores');
    expect(within(alert).queryByRole('button', { name: 'Reler a faixa' })).toBeNull();
  });

  it('the master never gets the reread button, even for the same message', async () => {
    server.use(
      http.put(`${BELTS_URL}/:id`, () =>
        HttpResponse.json({ message: ONLY_MASTER }, { status: 403 }),
      ),
    );
    const { user } = await openBelts('master');
    const dialog = await openEditor(user, 'Cinza/Azul');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(ONLY_MASTER);
    expect(within(alert).queryByRole('button', { name: 'Reler a faixa' })).toBeNull();
  });

  it('keeps the other API errors as before (400, 404, 503)', async () => {
    const answers: [number, string][] = [
      [400, 'Idade mínima: deve estar entre 0 e 99'],
      [404, 'Faixa não encontrada'],
      [503, 'Sistema ocupado no momento. Tente de novo em instantes.'],
    ];
    let current = answers[0]!;
    server.use(
      http.put(`${BELTS_URL}/:id`, () =>
        HttpResponse.json({ message: current[1] }, { status: current[0] }),
      ),
    );
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');
    for (const answer of answers) {
      current = answer;
      await waitFor(() => {
        expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
      });
      await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
      await waitFor(() => {
        expect(within(dialog).getByRole('alert')).toHaveTextContent(answer[1]);
      });
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Não foi possível salvar');
      expect(within(dialog).queryByRole('button', { name: 'Reler a faixa' })).toBeNull();
    }
  });

  it('keeps Tab inside the dialog through the two fields and the buttons only', async () => {
    const { user } = await openBelts('examiner');
    const dialog = await openEditor(user, 'Cinza/Azul');
    await waitFor(() => {
      expect(ageField(dialog)).toHaveFocus();
    });
    const reached: Element[] = [];
    for (let step = 0; step < 5; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      if (document.activeElement) reached.push(document.activeElement);
    }
    expect(new Set(reached)).toEqual(
      new Set([
        monthsField(dialog),
        within(dialog).getByRole('button', { name: 'Cancelar' }),
        within(dialog).getByRole('button', { name: 'Salvar' }),
        within(dialog).getByRole('button', { name: 'Fechar' }),
        ageField(dialog),
      ]),
    );
  });

  it('on the phone (360 px) the dialog takes the screen with the data, the fields and the buttons', async () => {
    setViewportWidth(360);
    const puts = recordPuts();
    const { user } = await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    await screen.findByRole('list', { name: 'Faixas' });
    const dialog = await openEditor(user, 'Cinza/Azul');
    // The dialog fades in: wait for it.
    await waitFor(() => {
      expect(within(dialog).getByRole('region', { name: 'Dados da faixa' })).toBeVisible();
    });
    expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeVisible();
    await replaceText(user, monthsField(dialog), '9');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(puts[0]).toMatchObject({ name: 'Cinza/Azul', min_months_previous: 9 });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Editar faixa Cinza/Azul' })).toHaveFocus();
    });
  });
});
