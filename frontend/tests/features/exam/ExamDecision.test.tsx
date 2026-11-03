/**
 * § 6.4 exam of a student, step 3: the sensei decision (RN008, RN008a, RN009, RN010).
 *
 * The simulated examiner (`mock-examiner`) is the sensei when the test sets
 * `db.settings.sensei_user_id` to him; by default the sensei is the second examiner
 * (`examinadora@example.com`, no name). Helena (open event, exam of the Marrom belt in
 * progress) is the student decided here.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecisionInput } from '../../../src/api/types';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { examPath } from '../../../src/app/navigation';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockBelts,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const { open: OPEN, closed: CLOSED } = MOCK_EVENT_IDS;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const DECISION_URL = `${TEST_API_URL}/events/:id/exams/:studentId/decision`;
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const EVENT_EXAMS_URL = `${TEST_API_URL}/events/${OPEN}/exams`;
const SETTINGS_URL = `${TEST_API_URL}/settings`;
const MARROM = mockBelts.find((belt) => belt.name === 'Marrom')!;
const PARAR = mockRequirementId('Marrom', 6);

let db: MockDb;
/** Bodies of the decisions that reached the API, in order. */
let decisions: DecisionInput[] = [];
let eventExamsReads = 0;

function installApi() {
  db = createMockDb({ includeShowcase: true });
  decisions = [];
  eventExamsReads = 0;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.post(DECISION_URL, async ({ request }) => {
      decisions.push((await request.clone().json()) as DecisionInput);
      return undefined;
    }),
    http.get(EVENT_EXAMS_URL, () => {
      eventExamsReads += 1;
      return undefined;
    }),
  );
}

function makeUserTheSensei() {
  db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
}

function helenaExam() {
  return db.exams.find((exam) => exam.student_id === HELENA)!;
}

function helena() {
  return db.students.find((item) => item.student.id === HELENA)!.student;
}

async function openExam(eventId = OPEN) {
  const rendered = await renderApp({ route: examPath(eventId, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

function summary() {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

function decisionGroup() {
  return within(summary()).getByRole('group', { name: 'Decisão do sensei' });
}

async function findDecideButton(name: 'Aprovar' | 'Reprovar') {
  return within(summary()).findByRole('button', { name });
}

async function dialog(name: string) {
  return screen.findByRole('dialog', { name });
}

async function waitDialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

/** Hold every decision until released (then the counting handler and the API answer). */
function holdDecisions() {
  const releases: (() => void)[] = [];
  server.use(
    http.post(DECISION_URL, async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return undefined;
    }),
  );
  return releases;
}

function refuseDecisions(status: number, message: string) {
  server.use(http.post(DECISION_URL, () => HttpResponse.json({ message }, { status })));
}

describe('sensei decision (§ 6.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('who decides', () => {
    it('rn008 shows Aprovar and Reprovar to the sensei, 44 px tall', async () => {
      makeUserTheSensei();
      await openExam();
      const approve = await findDecideButton('Aprovar');
      const fail = within(decisionGroup()).getByRole('button', { name: 'Reprovar' });
      expect(approve).toHaveStyle({ minHeight: '44px' });
      expect(fail).toHaveStyle({ minHeight: '44px' });
    });

    it('rn008 tells the other examiners who decides, without buttons', async () => {
      await openExam();
      expect(
        await within(summary()).findByText('A decisão é do sensei examinadora@example.com'),
      ).toBeInTheDocument();
      expect(within(summary()).queryByRole('button')).not.toBeInTheDocument();
    });

    it('rn008 names the sensei by name when he has one', async () => {
      db.examiners[1]!.name = 'Tomiyama';
      await openExam();
      expect(
        await within(summary()).findByText('A decisão é do sensei Tomiyama'),
      ).toBeInTheDocument();
    });

    it('rn008 asks to define the sensei, with a link to the settings', async () => {
      db.settings.sensei_user_id = null;
      await openExam();
      const note = await within(summary()).findByRole('note');
      expect(note).toHaveTextContent('Sem sensei definido');
      expect(
        within(note).getByRole('link', { name: 'Abrir configurações da academia' }),
      ).toHaveAttribute('href', '/academia');
      expect(within(summary()).queryByRole('button')).not.toBeInTheDocument();
    });

    it('rn008 asks for another sensei when the chosen one is no longer active', async () => {
      db.settings.sensei_user_id = 'conta-desabilitada';
      await openExam();
      const note = await within(summary()).findByRole('note');
      expect(note).toHaveTextContent('Sensei inativo');
      expect(note).toHaveTextContent('O sensei escolhido não está mais ativo.');
      expect(
        within(note).getByRole('link', { name: 'Abrir configurações da academia' }),
      ).toBeInTheDocument();
    });

    it('rn008 does not let an inactive sensei decide, even when it is the user', async () => {
      makeUserTheSensei();
      db.examiners = db.examiners.filter((examiner) => examiner.id !== MOCK_USER_IDS.examiner);
      await openExam();
      expect(await within(summary()).findByText('Sensei inativo')).toBeInTheDocument();
      expect(within(summary()).queryByRole('button', { name: 'Aprovar' })).not.toBeInTheDocument();
    });

    it('shows the settings error with "Tentar de novo"', async () => {
      makeUserTheSensei();
      server.use(
        http.get(
          SETTINGS_URL,
          () => HttpResponse.json({ message: 'Erro interno. Tente de novo.' }, { status: 500 }),
          { once: true },
        ),
      );
      const { user } = await openExam();
      const alert = await within(summary()).findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível saber quem é o sensei');
      expect(alert).toHaveTextContent('Erro interno. Tente de novo.');
      await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await findDecideButton('Aprovar')).toBeInTheDocument();
    });

    it('rn008a lets the sensei decide an exam of a closed event', async () => {
      makeUserTheSensei();
      db.events.find((event) => event.id === OPEN)!.status = 'CLOSED';
      await openExam();
      expect(screen.getByText(/O sensei ainda pode decidir o exame\./)).toBeInTheDocument();
      expect(await findDecideButton('Aprovar')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Certo: Parar' })).not.toBeInTheDocument();
    });
  });

  describe('deleted student (RN018)', () => {
    beforeEach(() => {
      makeUserTheSensei();
      db.students = db.students.filter((item) => item.student.id !== HELENA);
    });

    async function openDeletedExam() {
      const rendered = await renderApp({
        route: examPath(OPEN, HELENA),
        signedInAs: 'examiner',
      });
      await screen.findByRole('heading', { level: 1, name: 'Aluno excluído' });
      return rendered;
    }

    it('rn018 shows no Aprovar/Reprovar and says the exam cannot be decided', async () => {
      await openDeletedExam();
      expect(
        await within(summary()).findByText(
          'O aluno foi excluído, então o exame não pode ser decidido.',
        ),
      ).toBeInTheDocument();
      expect(within(summary()).queryByRole('button', { name: 'Aprovar' })).not.toBeInTheDocument();
      expect(within(summary()).queryByRole('button', { name: 'Reprovar' })).not.toBeInTheDocument();
    });

    it('rn018 shows no "Decidir" in the phone bar either', async () => {
      setViewportWidth(390);
      await openDeletedExam();
      expect(
        await within(summary()).findByText(
          'O aluno foi excluído, então o exame não pode ser decidido.',
        ),
      ).toBeInTheDocument();
      expect(within(summary()).queryByRole('button', { name: 'Decidir' })).not.toBeInTheDocument();
    });
  });

  describe('confirmation', () => {
    beforeEach(() => {
      makeUserTheSensei();
    });

    it('rn008 asks before approving, naming the student and the target belt', async () => {
      const { user } = await openExam();
      await user.click(await findDecideButton('Aprovar'));
      const modal = await dialog('Aprovar exame');
      expect(modal).toHaveTextContent(
        'Aprovar Helena Prado para a faixa Marrom? A decisão não pode ser desfeita.',
      );
      expect(modal).toHaveTextContent('Teórico 33,3% · Prático 25%');
      expect(within(modal).getByRole('textbox', { name: /Observação \(opcional\)/ })).toHaveFocus();
      expect(within(modal).getByRole('button', { name: 'Aprovar' })).toBeEnabled();
      expect(decisions).toEqual([]);
    });

    it('rn008 asks before failing too', async () => {
      const { user } = await openExam();
      await user.click(await findDecideButton('Reprovar'));
      const modal = await dialog('Reprovar exame');
      expect(modal).toHaveTextContent(
        'Reprovar Helena Prado no exame da faixa Marrom? A decisão não pode ser desfeita.',
      );
      expect(within(modal).getByRole('button', { name: 'Reprovar' })).toBeInTheDocument();
    });

    it('limits the note to 500 characters and counts them', async () => {
      const { user } = await openExam();
      await user.click(await findDecideButton('Aprovar'));
      const modal = await dialog('Aprovar exame');
      const notes = within(modal).getByRole('textbox', { name: /Observação/ });
      expect(notes).toHaveAttribute('maxlength', '500');
      await user.type(notes, 'Bom');
      expect(modal).toHaveTextContent('3 de 500 caracteres');
    });

    it('Cancelar closes without deciding and gives the focus back to the button', async () => {
      const { user } = await openExam();
      const approve = await findDecideButton('Aprovar');
      await user.click(approve);
      const modal = await dialog('Aprovar exame');
      await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
      await waitDialogGone();
      await waitFor(() => {
        expect(approve).toHaveFocus();
      });
      expect(decisions).toEqual([]);
      expect(helenaExam().status).toBe('IN_PROGRESS');
    });

    it('Esc closes the dialog, from the keyboard alone', async () => {
      const { user } = await openExam();
      const approve = await findDecideButton('Aprovar');
      approve.focus();
      await user.keyboard('{Enter}');
      await dialog('Aprovar exame');
      await user.keyboard('{Escape}');
      await waitDialogGone();
      await waitFor(() => {
        expect(approve).toHaveFocus();
      });
      expect(decisions).toEqual([]);
    });

    it('opens empty again after a cancelled note', async () => {
      const { user } = await openExam();
      await user.click(await findDecideButton('Aprovar'));
      let modal = await dialog('Aprovar exame');
      await user.type(within(modal).getByRole('textbox', { name: /Observação/ }), 'Rascunho');
      await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
      await waitDialogGone();
      await user.click(await findDecideButton('Reprovar'));
      modal = await dialog('Reprovar exame');
      expect(within(modal).getByRole('textbox', { name: /Observação/ })).toHaveValue('');
    });
  });

  describe('deciding', () => {
    beforeEach(() => {
      makeUserTheSensei();
    });

    it('rn009 approves: read-only screen, result, who decided, note and the reloads', async () => {
      const { user } = await openExam();
      const readsBefore = eventExamsReads;
      await user.click(await findDecideButton('Aprovar'));
      const modal = await dialog('Aprovar exame');
      await user.type(within(modal).getByRole('textbox', { name: /Observação/ }), '  Ótimo ukemi ');
      await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));

      await waitDialogGone();
      expect(decisions).toEqual([{ result: 'APPROVED', notes: 'Ótimo ukemi' }]);
      const decided = await within(summary()).findByText('Decidido por Sensei Simulado');
      expect(within(summary()).getByText('Observação: Ótimo ukemi')).toBeInTheDocument();
      // RN010: the items turn into text, the result seal changes and it is read out.
      expect(screen.queryByRole('button', { name: 'Certo: Parar' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Aprovar' })).not.toBeInTheDocument();
      expect(document.querySelector('[data-status]')).toHaveAttribute('data-status', 'APPROVED');
      expect(screen.getByTestId('decision-live')).toHaveTextContent('Exame aprovado.');
      // § 6.7: the focus goes to the decision, not lost on the page body.
      await waitFor(() => {
        expect(decided.closest('[data-slot="decision"]')).toHaveFocus();
      });
      // The exam list of the day reloads (and the API moved the student, RN009).
      await waitFor(() => {
        expect(eventExamsReads).toBeGreaterThan(readsBefore);
      });
      expect(helena()).toMatchObject({
        current_belt_id: MARROM.id,
        current_belt_since: '2026-11-21',
        stripes: 0,
      });
    });

    it('rn009 fails without a note: sends null and shows "Reprovado"', async () => {
      const { user } = await openExam();
      await user.click(await findDecideButton('Reprovar'));
      const modal = await dialog('Reprovar exame');
      await user.click(within(modal).getByRole('button', { name: 'Reprovar' }));
      await waitDialogGone();
      expect(decisions).toEqual([{ result: 'FAILED', notes: null }]);
      expect(
        await within(summary()).findByText('Decidido por Sensei Simulado'),
      ).toBeInTheDocument();
      expect(document.querySelector('[data-status]')).toHaveAttribute('data-status', 'FAILED');
      expect(screen.getByTestId('decision-live')).toHaveTextContent('Exame reprovado.');
      expect(helena().stripes).toBe(4);
    });

    it('rn008 sends once: the confirm button waits with a loader', async () => {
      const releases = holdDecisions();
      const { user } = await openExam();
      await user.click(await findDecideButton('Aprovar'));
      const modal = await dialog('Aprovar exame');
      const confirm = within(modal).getByRole('button', { name: 'Aprovar' });
      await user.click(confirm);
      await user.click(confirm);
      await user.keyboard('{Escape}');
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveAttribute('data-loading', 'true');
      expect(within(modal).getByText('Enviando a decisão…')).toBeInTheDocument();
      expect(within(modal).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
      expect(screen.getByRole('dialog', { name: 'Aprovar exame' })).toBeInTheDocument();
      await waitFor(() => {
        expect(releases).toHaveLength(1);
      });
      await act(async () => {
        releases[0]!();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      await waitDialogGone();
      expect(decisions).toHaveLength(1);
      expect(
        await within(summary()).findByText('Decidido por Sensei Simulado'),
      ).toBeInTheDocument();
    });

    it('rn010 waits for the marks on their way before deciding', async () => {
      const held: (() => void)[] = [];
      server.use(
        http.put(
          ANSWER_URL,
          () =>
            new Promise<undefined>((resolve) => {
              held.push(() => {
                resolve(undefined);
              });
            }),
        ),
      );
      const { user } = await openExam();
      await user.click(screen.getByRole('button', { name: 'Certo: Parar' }));
      await user.click(await findDecideButton('Aprovar'));
      const modal = await dialog('Aprovar exame');
      const confirm = within(modal).getByRole('button', { name: 'Aprovar' });
      expect(modal).toHaveTextContent('Aguardando as marcações serem salvas…');
      expect(confirm).toBeDisabled();
      await user.click(confirm);
      expect(decisions).toEqual([]);

      await waitFor(() => {
        expect(held).toHaveLength(1);
      });
      await act(async () => {
        held[0]!();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      await waitFor(() => {
        expect(confirm).toBeEnabled();
      });
      expect(modal).not.toHaveTextContent('Aguardando as marcações');
      await user.click(confirm);
      await waitDialogGone();
      expect(decisions).toEqual([{ result: 'APPROVED', notes: null }]);
      // The mark landed before the decision, so it counts (RN006, RN010).
      const exam = helenaExam();
      expect(exam.status).toBe('APPROVED');
      expect(
        db.answers.find((answer) => answer.exam_id === exam.id && answer.requirement_id === PARAR),
      ).toMatchObject({ correct: true });
    });
  });

  describe('refusals', () => {
    beforeEach(() => {
      makeUserTheSensei();
    });

    async function confirmApproval() {
      const rendered = await openExam();
      await rendered.user.click(await findDecideButton('Aprovar'));
      const modal = await dialog('Aprovar exame');
      await rendered.user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
      return { ...rendered, modal };
    }

    it('rn010 "Exame já decidido" closes the dialog, says so and reloads the exam', async () => {
      // Decided on another device meanwhile.
      server.use(
        http.post(DECISION_URL, () => {
          Object.assign(helenaExam(), {
            status: 'FAILED',
            decided_by_id: MOCK_USER_IDS.examiner,
            decided_at: '2026-11-21T12:00:00+00:00',
          });
          return HttpResponse.json({ message: 'Exame já decidido' }, { status: 409 });
        }),
      );
      await confirmApproval();
      await waitDialogGone();
      const alert = await within(summary()).findByRole('alert');
      expect(alert).toHaveTextContent('Exame já decidido');
      const decided = await within(summary()).findByText('Decidido por Sensei Simulado');
      expect(document.querySelector('[data-status]')).toHaveAttribute('data-status', 'FAILED');
      expect(screen.queryByRole('button', { name: 'Certo: Parar' })).not.toBeInTheDocument();
      await waitFor(() => {
        expect(decided.closest('[data-slot="decision"]')).toHaveFocus();
      });
    });

    it('rn008 shows "Somente o sensei pode decidir o exame" and reloads who the sensei is', async () => {
      server.use(
        http.post(DECISION_URL, () => {
          // The master chose another sensei meanwhile.
          db.settings.sensei_user_id = 'mock-examiner-2';
          return HttpResponse.json(
            { message: 'Somente o sensei pode decidir o exame' },
            { status: 403 },
          );
        }),
      );
      const { modal, user } = await confirmApproval();
      expect(await within(modal).findByRole('alert')).toHaveTextContent(
        'Somente o sensei pode decidir o exame',
      );
      await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
      await waitDialogGone();
      expect(
        await within(summary()).findByText('A decisão é do sensei examinadora@example.com'),
      ).toBeInTheDocument();
    });

    it('rn008 shows "Defina o sensei nas configurações da academia" (409)', async () => {
      server.use(
        http.post(DECISION_URL, () => {
          db.settings.sensei_user_id = null;
          return HttpResponse.json(
            { message: 'Defina o sensei nas configurações da academia' },
            { status: 409 },
          );
        }),
      );
      const { modal, user } = await confirmApproval();
      expect(await within(modal).findByRole('alert')).toHaveTextContent(
        'Defina o sensei nas configurações da academia',
      );
      await user.click(within(modal).getByRole('button', { name: 'Cancelar' }));
      expect(await within(summary()).findByText('Sem sensei definido')).toBeInTheDocument();
    });

    it('rn008 shows the 409 of a graduation changed since the attendance and keeps the exam', async () => {
      helena().stripes = 3;
      const { modal } = await confirmApproval();
      expect(await within(modal).findByRole('alert')).toHaveTextContent(
        'A graduação do aluno mudou desde a presença. Confira antes de decidir.',
      );
      const confirm = within(modal).getByRole('button', { name: 'Aprovar' });
      expect(confirm).toBeEnabled();
      expect(helenaExam().status).toBe('IN_PROGRESS');
    });

    it('lets the sensei try again after a 503', async () => {
      refuseDecisions(503, 'Sistema ocupado no momento. Tente de novo em instantes.');
      const { modal, user } = await confirmApproval();
      expect(await within(modal).findByRole('alert')).toHaveTextContent(
        'Sistema ocupado no momento. Tente de novo em instantes.',
      );
      installApi();
      makeUserTheSensei();
      await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
      await waitDialogGone();
      expect(decisions).toEqual([{ result: 'APPROVED', notes: null }]);
    });
  });

  describe('phone and tablet', () => {
    beforeEach(() => {
      makeUserTheSensei();
    });

    it.each([390, 768])(
      'shows "Decidir" in the bar at %i px, which opens the panel',
      async (width) => {
        setViewportWidth(width);
        const { user } = await openExam();
        const decide = await within(summary()).findByRole('button', { name: 'Decidir' });
        expect(decide).toHaveStyle({ minHeight: '44px' });
        expect(decide).toHaveAttribute('aria-expanded', 'false');
        expect(
          within(summary()).queryByRole('button', { name: 'Aprovar' }),
        ).not.toBeInTheDocument();
        // The spacer keeps the bar, now taller, off the last item.
        expect(screen.getByTestId('summary-spacer')).toBeInTheDocument();

        await user.click(decide);
        const panel = await dialog('Decidir o exame');
        expect(within(panel).getByText('33,3%')).toBeInTheDocument();
        expect(within(panel).getByRole('button', { name: 'Aprovar' })).toBeInTheDocument();
        expect(within(panel).getByRole('button', { name: 'Reprovar' })).toBeInTheDocument();
      },
    );

    it('shows the other examiners who decides in the bar, without "Decidir"', async () => {
      db.settings.sensei_user_id = 'mock-examiner-2';
      setViewportWidth(390);
      await openExam();
      expect(
        await within(summary()).findByText('A decisão é do sensei examinadora@example.com'),
      ).toBeInTheDocument();
      expect(within(summary()).queryByRole('button', { name: 'Decidir' })).not.toBeInTheDocument();
    });

    it('rn009 decides from the panel: Esc closes only the dialog, then the result shows in the bar', async () => {
      setViewportWidth(390);
      const { user } = await openExam();
      await user.click(await within(summary()).findByRole('button', { name: 'Decidir' }));
      const panel = await dialog('Decidir o exame');
      await user.click(within(panel).getByRole('button', { name: 'Aprovar' }));
      await dialog('Aprovar exame');
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Aprovar exame' })).not.toBeInTheDocument();
      });
      expect(screen.getByRole('dialog', { name: 'Decidir o exame' })).toBeInTheDocument();

      await user.click(within(panel).getByRole('button', { name: 'Aprovar' }));
      const modal = await dialog('Aprovar exame');
      await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
      await waitDialogGone();
      const decided = await within(summary()).findByText('Decidido por Sensei Simulado');
      expect(within(summary()).queryByRole('button', { name: 'Decidir' })).not.toBeInTheDocument();
      await waitFor(() => {
        expect(decided.closest('[data-slot="decision"]')).toHaveFocus();
      });
    });

    it('rn008 keeps the focus in the panel, then in the bar, after a 403 took the buttons away', async () => {
      server.use(
        http.post(DECISION_URL, () => {
          db.settings.sensei_user_id = 'mock-examiner-2';
          return HttpResponse.json(
            { message: 'Somente o sensei pode decidir o exame' },
            { status: 403 },
          );
        }),
      );
      setViewportWidth(390);
      const { user } = await openExam();
      await user.click(await within(summary()).findByRole('button', { name: 'Decidir' }));
      const panel = await dialog('Decidir o exame');
      await user.click(within(panel).getByRole('button', { name: 'Aprovar' }));
      const modal = await dialog('Aprovar exame');
      await user.click(within(modal).getByRole('button', { name: 'Aprovar' }));
      expect(await within(modal).findByRole('alert')).toHaveTextContent(
        'Somente o sensei pode decidir o exame',
      );
      expect(
        await within(panel).findByText('A decisão é do sensei examinadora@example.com'),
      ).toBeInTheDocument();

      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Aprovar exame' })).not.toBeInTheDocument();
      });
      await waitFor(() => {
        expect(panel.contains(document.activeElement)).toBe(true);
      });

      await user.keyboard('{Escape}');
      await waitDialogGone();
      await waitFor(() => {
        expect(summary().contains(document.activeElement)).toBe(true);
      });
    });

    it('closes the panel with Esc and gives the focus back to "Decidir"', async () => {
      setViewportWidth(390);
      const { user } = await openExam();
      const decide = await within(summary()).findByRole('button', { name: 'Decidir' });
      await user.click(decide);
      await dialog('Decidir o exame');
      await user.keyboard('{Escape}');
      await waitDialogGone();
      await waitFor(() => {
        expect(decide).toHaveFocus();
      });
    });
  });

  it('rn010 shows a decided exam read-only, without the decision buttons, even to the sensei', async () => {
    makeUserTheSensei();
    await renderApp({
      route: examPath(CLOSED, '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05'),
      signedInAs: 'examiner',
    });
    await screen.findByRole('heading', { level: 1, name: 'Élida Ramos' });
    expect(await within(summary()).findByText('Decidido por Sensei Simulado')).toBeInTheDocument();
    expect(within(summary()).queryByRole('button')).not.toBeInTheDocument();
  });
});
