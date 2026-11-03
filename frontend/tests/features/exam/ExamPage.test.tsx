/**
 * § 6.4 exam of a student: header, previous/next present student, tabs with counts, "Só não
 * marcados", items by category, RN007 summary, states and reload on window focus. Marking
 * (step 2) is in `ExamMarking.test.tsx`; the sensei decision (step 3) comes later.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Exam } from '../../../src/api/types';
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
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const FABIO = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e06';
const GABRIEL = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07';
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const HELENA_URL = `${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`;

let db: MockDb;

function installApi() {
  db = createMockDb({ includeShowcase: true });
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
}

/** Holds the matching GETs until `release` is called, then lets the API answer. */
function holdRequests(url: string) {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  server.use(
    http.get(url, async () => {
      await gate;
      return undefined;
    }),
  );
  return () => {
    open();
  };
}

function openExam(eventId: string, studentId: string) {
  return renderApp({ route: examPath(eventId, studentId), signedInAs: 'examiner' });
}

async function examHeading(name: string) {
  return screen.findByRole('heading', { level: 1, name });
}

function tab(name: RegExp) {
  return screen.getByRole('tab', { name });
}

function category(name: RegExp) {
  return screen.getByRole('region', { name });
}

/**
 * Text of each item and its mark: the read-only text, or the pressed Certo/Errado button
 * ("Não marcado" when none is) while the exam takes marks.
 */
function itemTexts(section: HTMLElement): string[] {
  return within(section)
    .getAllByRole('listitem')
    .map((item) => {
      const buttons = within(item).queryAllByRole('button');
      if (buttons.length === 0) return item.textContent.trim();
      const group = within(item).getByRole('group');
      const text = item.textContent.replace(group.textContent, '').trim();
      const pressed = buttons.find((button) => button.getAttribute('aria-pressed') === 'true');
      return `${text}${pressed?.textContent ?? 'Não marcado'}`;
    });
}

function scores() {
  return screen.getByTestId('exam-scores');
}

function summary() {
  return screen.getByRole('complementary', { name: 'Resumo do exame' });
}

async function windowRegainsFocus() {
  await act(async () => {
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

/** A present student at the closed event, between Élida and Gabriel in name order. */
function addFabioToClosedEvent() {
  const fabioExam: Exam = {
    id: '6f2c8d1e-4b3a-4c5d-9e6f-0201f2a3b4c5',
    event_id: CLOSED,
    student_id: FABIO,
    target_belt_id: mockBelts[11]!.id,
    kind: 'STRIPE',
    status: 'FAILED',
    decided_by_id: 'mock-examiner-2',
    decided_at: '2026-03-01T15:00:00+00:00',
    notes: 'Repetir o ukemi',
    created_by: 'mock-examiner',
    created_at: '2026-03-01T13:00:00+00:00',
    source_belt_id: null,
    source_belt_since: null,
    source_stripes: null,
  };
  db.exams.push(fabioExam);
}

describe('exam of a student (§ 6.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('header', () => {
    it('shows the student, age on the event date, belt exam, event and result', async () => {
      await openExam(OPEN, HELENA);
      expect(await examHeading('Helena Prado')).toBeInTheDocument();
      expect(screen.getByTestId('exam-meta')).toHaveTextContent('15 anos · Faixa Marrom');
      expect(screen.getByText('Exame novembro/2026 · 21/11/2026 · Aberto')).toBeInTheDocument();
      expect(screen.getByText('Em andamento').closest('[data-status]')).toHaveAttribute(
        'data-status',
        'IN_PROGRESS',
      );
    });

    it('rn004 names a stripe exam "Grau na faixa X (rumo à Y)"', async () => {
      await openExam(CLOSED, ELIDA);
      expect(await examHeading('Élida Ramos')).toBeInTheDocument();
      expect(await screen.findByText(/Grau na faixa Verde \(rumo à Roxa\)/)).toBeInTheDocument();
      expect(screen.getByTestId('exam-meta')).toHaveTextContent(
        '15 anos · Grau na faixa Verde (rumo à Roxa)',
      );
      expect(screen.getByText('Exame março/2026 · 01/03/2026 · Encerrado')).toBeInTheDocument();
      expect(screen.getByText('Aprovado').closest('[data-status]')).toHaveAttribute(
        'data-status',
        'APPROVED',
      );
    });

    it('shows the failed result', async () => {
      addFabioToClosedEvent();
      await openExam(CLOSED, FABIO);
      expect(await examHeading('Fábio Lima')).toBeInTheDocument();
      expect(screen.getByText('Reprovado').closest('[data-status]')).toHaveAttribute(
        'data-status',
        'FAILED',
      );
    });

    it('links the trail back to the exam day with the same event selected', async () => {
      const { user, router } = await openExam(CLOSED, ELIDA);
      await examHeading('Élida Ramos');
      const trail = screen.getByRole('navigation', { name: 'Caminho' });
      expect(within(trail).getByText('Élida Ramos')).toHaveAttribute('aria-current', 'page');
      const back = within(trail).getByRole('link', { name: 'Dia do exame' });
      expect(back).toHaveAttribute('href', `/dia-do-exame?evento=${CLOSED}`);

      await user.click(back);
      expect(await screen.findByRole('heading', { name: 'Dia do exame' })).toBeInTheDocument();
      expect(router.state.location.search).toBe(`?evento=${CLOSED}`);
      expect(await screen.findByRole('combobox', { name: 'Evento' })).toHaveValue(CLOSED);
    });
  });

  describe('previous and next present student', () => {
    it('disables "Anterior" on the first student and links "Próximo" to the next', async () => {
      addFabioToClosedEvent();
      await openExam(CLOSED, ELIDA);
      await examHeading('Élida Ramos');
      const group = screen.getByRole('group', { name: 'Alunos presentes' });
      expect(within(group).getByRole('button', { name: 'Anterior' })).toBeDisabled();
      expect(
        await within(group).findByRole('link', { name: 'Próximo: Fábio Lima' }),
      ).toHaveAttribute('href', examPath(CLOSED, FABIO));
    });

    it('walks through the present students in name order', async () => {
      addFabioToClosedEvent();
      const { user, router } = await openExam(CLOSED, FABIO);
      await examHeading('Fábio Lima');
      const group = screen.getByRole('group', { name: 'Alunos presentes' });
      expect(
        await within(group).findByRole('link', { name: 'Anterior: Élida Ramos' }),
      ).toHaveAttribute('href', examPath(CLOSED, ELIDA));

      const next = within(group).getByRole('link', { name: 'Próximo: Gabriel Costa' });
      next.focus();
      await user.click(next);
      expect(await examHeading('Gabriel Costa')).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(examPath(CLOSED, GABRIEL));
      expect(within(group).getByRole('button', { name: 'Próximo' })).toBeDisabled();
      expect(within(group).getByRole('link', { name: 'Anterior: Fábio Lima' })).toBeInTheDocument();
    });

    it('keeps the focus on "Próximo" while the next exam loads', async () => {
      addFabioToClosedEvent();
      const { user } = await openExam(CLOSED, ELIDA);
      await examHeading('Élida Ramos');
      const release = holdRequests(`${TEST_API_URL}/events/${CLOSED}/exams/${FABIO}`);
      const next = await screen.findByRole('link', { name: 'Próximo: Fábio Lima' });
      await user.click(next);
      expect(await screen.findByText('Carregando exame…')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Próximo: Gabriel Costa' })).toHaveFocus();
      release();
      expect(await examHeading('Fábio Lima')).toBeInTheDocument();
    });

    it('disables both while the exams of the event load', async () => {
      const release = holdRequests(`${TEST_API_URL}/events/${OPEN}/exams`);
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      const group = screen.getByRole('group', { name: 'Alunos presentes' });
      expect(within(group).getByRole('button', { name: 'Anterior' })).toBeDisabled();
      expect(within(group).getByRole('button', { name: 'Próximo' })).toBeDisabled();
      release();
    });

    it('disables both for the only present student', async () => {
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
      });
      expect(screen.getByRole('button', { name: 'Próximo' })).toBeDisabled();
    });
  });

  describe('items', () => {
    it('shows the tabs with marked/total from the API summary', async () => {
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      expect(tab(/^Teórico 1\/3$/)).toHaveAttribute('aria-selected', 'true');
      expect(tab(/^Prático 2\/4$/)).toHaveAttribute('aria-selected', 'false');
    });

    it('groups the items by category in sheet order with x/N each', async () => {
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      expect(screen.getAllByRole('region', { name: /\d+\/\d+$/ })).toHaveLength(2);
      expect(category(/^Vocabulário 1\/2$/)).toBeInTheDocument();
      expect(category(/^Histórico 0\/1$/)).toBeInTheDocument();
      expect(itemTexts(category(/^Vocabulário/))).toEqual([
        'ProfessorResposta esperada: SenseiCerto',
        'PararResposta esperada: MateNão marcado',
      ]);
    });

    it('switches to the practical items', async () => {
      const { user } = await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      await user.click(tab(/^Prático/));
      expect(tab(/^Prático/)).toHaveAttribute('aria-selected', 'true');
      expect(itemTexts(category(/^Fundamentos 2\/2$/))).toEqual([
        'Demonstrar saudação em péResposta esperada: RitsureiCerto',
        'Demonstrar saudação ajoelhadoResposta esperada: ZareiErrado',
      ]);
      // Items without an expected answer show only the description.
      expect(itemTexts(category(/^Naguewaza 0\/2$/))).toEqual([
        'Deashi baraiNão marcado',
        'Osoto gariNão marcado',
      ]);
      expect(screen.queryByRole('region', { name: /^Vocabulário/ })).not.toBeInTheDocument();
    });

    it('"Só não marcados" hides the marked items and the categories left empty', async () => {
      const { user } = await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      const filter = screen.getByRole('switch', { name: 'Só não marcados' });
      await user.click(filter);
      expect(filter).toBeChecked();
      expect(itemTexts(category(/^Vocabulário 1\/2$/))).toEqual([
        'PararResposta esperada: MateNão marcado',
      ]);

      await user.click(tab(/^Prático/));
      expect(screen.queryByRole('region', { name: /^Fundamentos/ })).not.toBeInTheDocument();
      expect(itemTexts(category(/^Naguewaza 0\/2$/))).toHaveLength(2);

      await user.click(filter);
      expect(category(/^Fundamentos 2\/2$/)).toBeInTheDocument();
    });

    it('says when every item of the kind is marked', async () => {
      const { user } = await openExam(CLOSED, ELIDA);
      await examHeading('Élida Ramos');
      await user.click(screen.getByRole('switch', { name: 'Só não marcados' }));
      expect(screen.getByText('Todos os itens teóricos estão marcados.')).toBeInTheDocument();
    });

    it('rn007 says when the belt has no item of the kind', async () => {
      const { user } = await openExam(CLOSED, GABRIEL);
      await examHeading('Gabriel Costa');
      expect(tab(/^Prático 0\/0$/)).toBeInTheDocument();
      await user.click(tab(/^Prático/));
      expect(screen.getByText('Esta faixa não tem itens práticos.')).toBeInTheDocument();
    });

    it('rn010 shows the marks read-only, as text with an icon and no buttons', async () => {
      const { user } = await openExam(CLOSED, GABRIEL);
      await examHeading('Gabriel Costa');
      expect(screen.getByText('Certo').closest('[data-mark]')).toHaveAttribute(
        'data-mark',
        'correct',
      );
      expect(screen.getByText('Errado').closest('[data-mark]')).toHaveAttribute(
        'data-mark',
        'wrong',
      );
      expect(screen.getByText('Certo').parentElement?.querySelector('svg')).not.toBeNull();
      expect(screen.queryByRole('button', { name: /Certo|Errado/ })).not.toBeInTheDocument();

      await user.click(tab(/^Teórico/));
      expect(screen.queryByRole('button', { name: /Certo|Errado/ })).not.toBeInTheDocument();
    });

    it('rn016 says the event is closed for an exam still in progress', async () => {
      db.exams = db.exams.map((exam) =>
        exam.student_id === GABRIEL
          ? { ...exam, status: 'IN_PROGRESS', decided_by_id: null, decided_at: null }
          : exam,
      );
      await openExam(CLOSED, GABRIEL);
      await examHeading('Gabriel Costa');
      const note = screen.getByRole('note');
      expect(note).toHaveTextContent('Evento encerrado');
      expect(note).toHaveTextContent('O sensei ainda pode decidir o exame.');
      expect(screen.queryByRole('button', { name: /Certo|Errado/ })).not.toBeInTheDocument();
    });

    it('keeps the tab and the filter when moving to the next student', async () => {
      addFabioToClosedEvent();
      const { user } = await openExam(CLOSED, ELIDA);
      await examHeading('Élida Ramos');
      await user.click(tab(/^Prático/));
      await user.click(screen.getByRole('switch', { name: 'Só não marcados' }));
      await user.click(await screen.findByRole('link', { name: 'Próximo: Fábio Lima' }));
      await examHeading('Fábio Lima');
      expect(tab(/^Prático/)).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('switch', { name: 'Só não marcados' })).toBeChecked();
    });
  });

  describe('summary', () => {
    it('rn007 shows both percentages, marked counts and the marking progress', async () => {
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      expect(summary()).toHaveTextContent(
        'Acertos ÷ itens do tipo; item não marcado conta como não acertado.',
      );
      const live = scores();
      // The numbers are read out by a separate, quieter live region (ExamMarking.test.tsx).
      expect(screen.getByTestId('percent-live')).toHaveAttribute('aria-live', 'polite');
      expect(within(live).getByText('33,3%')).toBeInTheDocument();
      expect(within(live).getByText('marcados 1 de 3')).toBeInTheDocument();
      expect(within(live).getByText('25%')).toBeInTheDocument();
      expect(within(live).getByText('marcados 2 de 4')).toBeInTheDocument();
      const progress = within(summary()).getByRole('progressbar', { name: 'Marcação' });
      expect(progress).toHaveAttribute('aria-valuenow', '43');
      expect(progress).toHaveAttribute('aria-valuetext', '3 de 7 itens marcados');
    });

    it('rn007 shows "—" for a kind without items', async () => {
      await openExam(CLOSED, GABRIEL);
      await examHeading('Gabriel Costa');
      const practice = scores().querySelector('[data-score="PRACTICE"]') as HTMLElement;
      expect(within(practice).getByText('—')).toBeInTheDocument();
      expect(within(practice).getByText('marcados 0 de 0')).toBeInTheDocument();
      expect(within(scores()).getByText('50%')).toBeInTheDocument();
    });

    it('rn008 says who decided, by name', async () => {
      await openExam(CLOSED, ELIDA);
      await examHeading('Élida Ramos');
      expect(
        await within(summary()).findByText('Decidido por Sensei Simulado'),
      ).toBeInTheDocument();
      expect(within(summary()).queryByRole('button')).not.toBeInTheDocument();
    });

    it('rn008 falls back to the e-mail and shows the notes', async () => {
      addFabioToClosedEvent();
      await openExam(CLOSED, FABIO);
      await examHeading('Fábio Lima');
      expect(
        await within(summary()).findByText('Decidido por examinadora@example.com'),
      ).toBeInTheDocument();
      expect(within(summary()).getByText('Observação: Repetir o ukemi')).toBeInTheDocument();
    });

    it('says when who decided is no longer an active examiner', async () => {
      db.examiners = [];
      await openExam(CLOSED, ELIDA);
      await examHeading('Élida Ramos');
      expect(
        await within(summary()).findByText('Decidido por um examinador que não está mais ativo'),
      ).toBeInTheDocument();
    });

    it('shows nothing about the decision while the exam is in progress', async () => {
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      expect(within(summary()).queryByText(/Decidido/)).not.toBeInTheDocument();
      expect(within(summary()).queryByRole('button')).not.toBeInTheDocument();
    });

    it('is a sticky column at the right on the notebook', async () => {
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      expect(summary()).toHaveStyle({ position: 'sticky' });
      expect(screen.queryByTestId('summary-spacer')).not.toBeInTheDocument();
    });

    it.each([390, 768])('is a bar fixed at the bottom at %i px', async (width) => {
      setViewportWidth(width);
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      expect(summary()).toHaveStyle({ position: 'fixed', bottom: '0px' });
      expect(within(summary()).getByText('33,3%')).toBeInTheDocument();
      expect(screen.getByTestId('summary-spacer')).toBeInTheDocument();
    });
  });

  describe('reload on window focus', () => {
    it('reloads the exam when the window gets the focus back (two examiners)', async () => {
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      expect(within(scores()).getByText('33,3%')).toBeInTheDocument();

      const exam = db.exams.find((item) => item.student_id === HELENA)!;
      db.answers.push({
        exam_id: exam.id,
        requirement_id: mockRequirementId('Marrom', 6),
        correct: true,
        marked_by: 'mock-examiner-2',
        marked_at: '2026-11-21T13:40:00+00:00',
      });
      await windowRegainsFocus();

      expect(await within(scores()).findByText('66,7%')).toBeInTheDocument();
      expect(tab(/^Teórico 2\/3$/)).toBeInTheDocument();
      expect(itemTexts(category(/^Vocabulário 2\/2$/))[1]).toBe(
        'PararResposta esperada: MateCerto',
      );
    });

    it('keeps the exam on screen when a background reload fails', async () => {
      await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      server.use(http.get(HELENA_URL, () => HttpResponse.error()));
      await windowRegainsFocus();
      expect(screen.getByRole('heading', { level: 1, name: 'Helena Prado' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('states', () => {
    it('shows a labelled loading state', async () => {
      const release = holdRequests(HELENA_URL);
      await openExam(OPEN, HELENA);
      expect(await screen.findByText('Carregando exame…')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Exame do aluno' })).toBeInTheDocument();
      release();
      expect(await examHeading('Helena Prado')).toBeInTheDocument();
    });

    it('shows the error and reloads with "Tentar de novo"', async () => {
      server.use(
        http.get(
          HELENA_URL,
          () => HttpResponse.json({ message: 'Erro interno. Tente de novo.' }, { status: 500 }),
          { once: true },
        ),
      );
      const { user } = await openExam(OPEN, HELENA);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível carregar o exame');
      expect(alert).toHaveTextContent('Erro interno. Tente de novo.');
      await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await examHeading('Helena Prado')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says "Exame não encontrado" and links back to the event', async () => {
      await openExam(OPEN, ANA);
      expect(await examHeading('Exame não encontrado')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Voltar ao Dia do exame' })).toHaveAttribute(
        'href',
        `/dia-do-exame?evento=${OPEN}`,
      );
    });

    it('says "Evento não encontrado" and links back to the exam day', async () => {
      await openExam('evento-inexistente', HELENA);
      expect(await examHeading('Evento não encontrado')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Voltar ao Dia do exame' })).toHaveAttribute(
        'href',
        '/dia-do-exame',
      );
    });

    it('shows "Sem permissão" without a retry on 403', async () => {
      server.use(
        http.get(HELENA_URL, () =>
          HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
        ),
      );
      await openExam(OPEN, HELENA);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Sem permissão');
      expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
    });

    it('keeps guardians out', async () => {
      await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'guardian' });
      expect(
        await screen.findByRole('heading', { name: 'Esta área é dos examinadores' }),
      ).toBeInTheDocument();
    });

    it('rn018 shows the exam of a deleted student', async () => {
      db.students = db.students.filter((item) => item.student.id !== HELENA);
      await openExam(OPEN, HELENA);
      expect(await examHeading('Aluno excluído')).toBeInTheDocument();
      expect(screen.getByRole('note')).toHaveTextContent(
        'O cadastro do aluno foi excluído. O exame continua registrado.',
      );
      expect(screen.getByTestId('exam-meta')).toHaveTextContent(/^Faixa Marrom$/);
      expect(within(scores()).getByText('33,3%')).toBeInTheDocument();
    });
  });

  describe('privacy (LGPD)', () => {
    it('keeps student data out of the URL, the storage and the console', async () => {
      const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
      );
      const { router } = await openExam(OPEN, HELENA);
      await examHeading('Helena Prado');
      const url = `${router.state.location.pathname}${router.state.location.search}`;
      expect(url).not.toMatch(/helena/i);
      const stored = [window.localStorage, window.sessionStorage]
        .flatMap((storage) => Object.keys(storage).map((key) => storage.getItem(key) ?? ''))
        .join(' ');
      expect(stored).not.toContain('Helena Prado');
      for (const spy of logs) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain('Helena Prado');
        spy.mockRestore();
      }
    });
  });
});
