/**
 * QA (#185): a fila do exame (§ 6.4 "Fila", RN006, § 6.7) nos casos que os testes do card não
 * cobrem: anterior/próximo aluno no meio da espera e logo depois da troca, exame decidido e
 * evento encerrado no meio, "Tentar de novo" e API lenta (a troca espera a gravação), marcação
 * pelo teclado com "Só não marcados", troca de aba na espera, marcação de outro examinador fora
 * da espera (o toque logo depois também é ignorado), marcar e desmarcar na mesma espera,
 * desmarcar pelo teclado e as duas regiões ao vivo (percentuais e fila) na troca. Com o aviso de
 * erro aberto (decisões de 2026-11-19): a marcação em outra aba também espera o aviso fechar,
 * "Tentar de novo" pelo toque deixa o foco no item e fechar pelo teclado o aviso de uma marcação
 * feita pelo teclado leva o foco ao primeiro item em aberto.
 *
 * Helena (evento aberto, Marrom, exame em andamento): Teórico — Vocabulário: Professor certo,
 * Parar não marcado; Histórico: Nome do fundador do Judô não marcado.
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Exam } from '../../../src/api/types';
import { examPath } from '../../../src/app/navigation';
import { DOUBLE_TAP_MS } from '../../../src/features/exam/markClickGuard';
import { MOVE_DELAY_MS, SLIDE_MS } from '../../../src/features/exam/markQueue';
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

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PARAR = mockRequirementId('Marrom', 6);
const FOUNDER = mockRequirementId('Marrom', 7);
const DEASHI = mockRequirementId('Marrom', 3);
const FOUNDER_NAME = 'Nome do fundador do Judô';
const SHEET_ORDER = ['Professor', 'Parar', FOUNDER_NAME];
const THEORY_AT_START = ['Parar', 'Professor', FOUNDER_NAME];
const THEORY_AFTER_PARAR = [FOUNDER_NAME, 'Professor', 'Parar'];

let db: MockDb;

function helenaExam() {
  return db.exams.find((exam) => exam.student_id === HELENA)!;
}

function answerOf(requirementId: string) {
  return db.answers.find(
    (item) => item.exam_id === helenaExam().id && item.requirement_id === requirementId,
  );
}

/** Élida at the open event, Marrom too: the same items (same ids), nothing marked. */
function addElidaToOpenEvent() {
  const marrom = mockBelts.find((belt) => belt.name === 'Marrom')!;
  const elidaExam: Exam = {
    id: '6f2c8d1e-4b3a-4c5d-9e6f-01a1b2c3d4e05',
    event_id: OPEN,
    student_id: ELIDA,
    target_belt_id: marrom.id,
    kind: 'BELT',
    status: 'IN_PROGRESS',
    decided_by_id: null,
    decided_at: null,
    notes: null,
    created_by: 'mock-examiner',
    created_at: '2026-11-02T12:00:00+00:00',
    source_belt_id: null,
    source_belt_since: null,
    source_stripes: null,
  };
  db.exams.push(elidaExam);
}

async function openHelena() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

/** Items of the tab with Certo/Errado, top to bottom. */
function itemOrder(): string[] {
  return screen
    .getAllByRole('group', { name: /^Marcação: / })
    .map((group) => group.getAttribute('aria-label')!.replace('Marcação: ', ''));
}

/** Items of the tab, read-only or not, top to bottom. */
function listOrder(): string[] {
  return screen
    .getAllByRole('listitem')
    .filter((item) => item.hasAttribute('data-item'))
    .map((item) => item.querySelector('p')?.textContent ?? '');
}

function stopTheClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.now() });
}

async function passes(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Real time going by (the clock not stopped). */
async function waits(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** A finger tap: the button takes the focus and the click has `detail` 1. */
function tap(name: string) {
  const target = button(name);
  act(() => {
    target.focus();
  });
  fireEvent.click(target, { detail: 1 });
}

/** Space or Enter on a focused button: a click with `detail` 0. */
function press(name: string) {
  const target = button(name);
  act(() => {
    target.focus();
  });
  fireEvent.click(target, { detail: 0 });
}

function pressed(name: string) {
  return button(name).getAttribute('aria-pressed') === 'true';
}

describe('queue of the exam, beyond the card tests (§ 6.4, RN006, #185)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('previous and next student', () => {
    it('rn006 nothing of the queue carries over, even right after the move', async () => {
      addElidaToOpenEvent();
      const { user } = await openHelena();
      const previous = await screen.findByRole('link', { name: 'Anterior: Élida Ramos' });
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);

      // To Élida inside Helena's tap window: the founder moved on Helena's screen only.
      vi.useRealTimers();
      await user.click(previous);
      await screen.findByRole('heading', { level: 1, name: 'Élida Ramos' });
      expect(itemOrder()).toEqual(SHEET_ORDER);
      expect(screen.getByTestId('queue-live')).toBeEmptyDOMElement();
      fireEvent.click(button(`Certo: ${FOUNDER_NAME}`), { detail: 1 });
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(true);
    });

    it('rn006 leaving in the middle of the wait moves nothing on the next student', async () => {
      addElidaToOpenEvent();
      const { user } = await openHelena();
      const previous = await screen.findByRole('link', { name: 'Anterior: Élida Ramos' });
      tap('Certo: Parar');
      await user.click(previous);
      await screen.findByRole('heading', { level: 1, name: 'Élida Ramos' });
      expect(itemOrder()).toEqual(SHEET_ORDER);
      await waits(MOVE_DELAY_MS + 300);
      expect(itemOrder()).toEqual(SHEET_ORDER);
      expect(screen.getByTestId('queue-live')).toBeEmptyDOMElement();

      // Back to Helena: Parar saved and at the end, with nothing announced on arrival.
      await user.click(screen.getByRole('link', { name: 'Próximo: Helena Prado' }));
      await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
      expect(answerOf(PARAR)?.correct).toBe(true);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(screen.getByTestId('queue-live')).toBeEmptyDOMElement();
    });
  });

  describe('the exam stops taking marks in the middle', () => {
    it('rn010 exam decided by another examiner: sheet order, focus on the title', async () => {
      await openHelena();
      const exam = helenaExam();
      exam.status = 'APPROVED';
      exam.decided_by_id = 'mock-examiner-2';
      exam.decided_at = '2026-11-21T14:00:00+00:00';
      tap('Certo: Parar');
      expect(await screen.findByRole('alert')).toHaveTextContent('Exame já decidido');
      await screen.findAllByText('Não marcado');
      expect(listOrder()).toEqual(SHEET_ORDER);
      expect(screen.getByRole('heading', { level: 1, name: 'Helena Prado' })).toHaveFocus();
      await waits(MOVE_DELAY_MS + 300);
      expect(listOrder()).toEqual(SHEET_ORDER);
      expect(screen.getByTestId('queue-live')).toBeEmptyDOMElement();
    });

    it('rn010 event closed in the middle of the wait after a saved mark: sheet order', async () => {
      await openHelena();
      tap('Certo: Parar');
      await waits(200);
      expect(answerOf(PARAR)?.correct).toBe(true);
      db.events = db.events.map((event) =>
        event.id === OPEN ? { ...event, status: 'CLOSED' } : event,
      );
      tap(`Certo: ${FOUNDER_NAME}`);
      expect(await screen.findByRole('alert')).toHaveTextContent('Evento encerrado');
      await screen.findAllByText('Não marcado');
      expect(listOrder()).toEqual(SHEET_ORDER);
      expect(document.activeElement).not.toBe(document.body);
      await waits(MOVE_DELAY_MS + 300);
      expect(listOrder()).toEqual(SHEET_ORDER);
    });
  });

  describe('the move waits for the save', () => {
    it('rn006 "Tentar de novo": the item moves once the mark is saved, announced', async () => {
      let busy = true;
      server.use(
        http.put(ANSWER_URL, () =>
          busy
            ? HttpResponse.json({ message: 'Serviço indisponível' }, { status: 503 })
            : undefined,
        ),
      );
      const { user } = await openHelena();
      const live = screen.getByTestId('queue-live');
      tap('Certo: Parar');
      const alert = await screen.findByRole('alert');
      expect(pressed('Certo: Parar')).toBe(false);
      await waits(MOVE_DELAY_MS + 100);
      expect(itemOrder()).toEqual(THEORY_AT_START);

      busy = false;
      await user.click(within(alert).getByRole('button', { name: /^Tentar de novo/ }));
      await waits(300);
      expect(answerOf(PARAR)?.correct).toBe(true);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      await waits(MOVE_DELAY_MS);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(live).toHaveTextContent('Parar marcado como certo, movido para o fim de Vocabulário.');
      expect(document.activeElement).not.toBe(document.body);
    });

    it('rn006 a slow API holds the move until the mark is saved', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.use(
        http.put(ANSWER_URL, async () => {
          await gate;
          return undefined;
        }),
      );
      await openHelena();
      tap('Certo: Parar');
      await waits(MOVE_DELAY_MS + 500);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      expect(pressed('Certo: Parar')).toBe(true);
      await act(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(pressed('Certo: Parar')).toBe(true);
      expect(answerOf(PARAR)?.correct).toBe(true);
    });
  });

  describe('tabs, filter and keyboard', () => {
    it('rn006 a keyboard mark under "Só não marcados" sends the focus to the first open item', async () => {
      const { user } = await openHelena();
      await user.click(screen.getByRole('switch', { name: 'Só não marcados' }));
      stopTheClock();
      press('Certo: Parar');
      await passes(MOVE_DELAY_MS);
      expect(itemOrder()).toEqual([FOUNDER_NAME, 'Parar']);
      expect(button(`Certo: ${FOUNDER_NAME}`)).toHaveFocus();
    });

    it('rn006 a tab change in the wait: the other tab neither moves nor announces', async () => {
      const { user } = await openHelena();
      tap('Certo: Parar');
      await user.click(screen.getByRole('tab', { name: /^Prático/ }));
      const practice = itemOrder();
      await waits(MOVE_DELAY_MS + 300);
      expect(itemOrder()).toEqual(practice);
      expect(screen.getByTestId('queue-live')).toBeEmptyDOMElement();
      await user.click(screen.getByRole('tab', { name: /^Teórico/ }));
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
    });

    it('rn006 a keyboard unmark puts the item back among the open ones, announced, focus kept on a mark button', async () => {
      const marrom = mockBelts.find((belt) => belt.name === 'Marrom')!;
      db.requirements.push({
        id: '9a1e0c3b-6d2f-4e8a-8b7c-00000c000099',
        belt_id: marrom.id,
        kind: 'THEORY',
        category: 'Princípios',
        description: 'Princípio da suavidade',
        expected_answer: 'Ju',
        sort_order: 8,
      });
      await openHelena();
      stopTheClock();
      press(`Certo: ${FOUNDER_NAME}`);
      await passes(MOVE_DELAY_MS);
      // Histórico, complete, went to the end of the tab.
      expect(itemOrder()).toEqual(['Parar', 'Professor', 'Princípio da suavidade', FOUNDER_NAME]);

      await passes(SLIDE_MS + DOUBLE_TAP_MS);
      press(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(false);
      await passes(MOVE_DELAY_MS);
      expect(itemOrder()).toEqual(['Parar', 'Professor', FOUNDER_NAME, 'Princípio da suavidade']);
      expect(screen.getByTestId('queue-live')).toHaveTextContent(
        'Nome do fundador do Judô desmarcado, movido para os itens em aberto de Histórico.',
      );
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toHaveAttribute('data-choice');
    });
  });

  describe('other changes of the order', () => {
    it('rn006 another examiner moves an item outside a wait: a tap on it right after is ignored', async () => {
      await openHelena();
      db.answers.push({
        exam_id: helenaExam().id,
        requirement_id: PARAR,
        correct: true,
        marked_by: 'mock-examiner-2',
        marked_at: '2026-11-21T13:40:00+00:00',
      });
      await act(async () => {
        window.dispatchEvent(new Event('visibilitychange'));
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      // Not this examiner's mark: nothing is announced.
      expect(screen.getByTestId('queue-live')).toBeEmptyDOMElement();
      tap(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(false);
      await waits(SLIDE_MS + DOUBLE_TAP_MS + 50);
      tap(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(true);
      await waits(200);
      expect(answerOf(FOUNDER)).toBeDefined();
    });

    it('rn006 a mark taken back in the same wait: nothing moves, nothing is said, a tap counts', async () => {
      await openHelena();
      stopTheClock();
      tap('Certo: Parar');
      await passes(DOUBLE_TAP_MS + 100);
      tap('Certo: Parar');
      expect(pressed('Certo: Parar')).toBe(false);
      await passes(MOVE_DELAY_MS * 2);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      expect(answerOf(PARAR)).toBeUndefined();
      expect(screen.getByTestId('queue-live')).toBeEmptyDOMElement();
      tap(`Certo: ${FOUNDER_NAME}`);
      expect(pressed(`Certo: ${FOUNDER_NAME}`)).toBe(true);
      // Saved before the test ends (a write still on its way would reach the next test's API).
      await passes(200);
      expect(answerOf(FOUNDER)?.correct).toBe(true);
    });
  });

  describe('while a notice is open (decisions of 2026-11-19)', () => {
    /** The clock goes on in steps of 10 ms until `done`, for at most 1 s. */
    async function passesUntil(done: () => boolean) {
      for (let step = 0; step < 100 && !done(); step += 1) await passes(10);
    }

    function tapIn(target: HTMLElement) {
      act(() => {
        target.focus();
      });
      fireEvent.click(target, { detail: 1 });
    }

    function pressIn(target: HTMLElement) {
      act(() => {
        target.focus();
      });
      fireEvent.click(target, { detail: 0 });
    }

    it('rn006 a mark in the other tab waits for the notice too, and is announced when it closes there', async () => {
      server.use(
        http.put(ANSWER_URL, ({ params }) =>
          String(params.requirementId) === FOUNDER
            ? HttpResponse.json({ message: 'Serviço indisponível' }, { status: 503 })
            : undefined,
        ),
      );
      await openHelena();
      const live = screen.getByTestId('queue-live');
      stopTheClock();
      tap(`Certo: ${FOUNDER_NAME}`);
      await passes(MOVE_DELAY_MS * 2);
      await passesUntil(() => screen.queryByRole('alert') !== null);
      const alert = screen.getByRole('alert');

      fireEvent.click(screen.getByRole('tab', { name: /^Prático/ }));
      const practice = ['Deashi barai', 'Osoto gari'];
      expect(itemOrder().slice(0, 2)).toEqual(practice);
      tap('Certo: Deashi barai');
      await passes(MOVE_DELAY_MS * 2);
      expect(pressed('Certo: Deashi barai')).toBe(true);
      expect(answerOf(DEASHI)?.correct).toBe(true);
      // Saved, and the wait is over: the notice still holds the list.
      expect(itemOrder().slice(0, 2)).toEqual(practice);
      expect(live).toBeEmptyDOMElement();

      tapIn(within(alert).getByRole('button', { name: 'Fechar aviso' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(itemOrder().slice(0, 2)).toEqual(['Osoto gari', 'Deashi barai']);
      expect(live).toHaveTextContent(
        /^Deashi barai marcado como certo, movido para o fim de Naguewaza\.$/,
      );
    });

    it('rn006 "Tentar de novo" with a tap: the item moves once saved, and the focus stays on it', async () => {
      let busy = true;
      server.use(
        http.put(ANSWER_URL, () =>
          busy
            ? HttpResponse.json({ message: 'Serviço indisponível' }, { status: 503 })
            : undefined,
        ),
      );
      await openHelena();
      const live = screen.getByTestId('queue-live');
      stopTheClock();
      tap('Certo: Parar');
      await passes(MOVE_DELAY_MS * 2);
      await passesUntil(() => screen.queryByRole('alert') !== null);
      const alert = screen.getByRole('alert');
      expect(itemOrder()).toEqual(THEORY_AT_START);

      busy = false;
      tapIn(within(alert).getByRole('button', { name: /^Tentar de novo/ }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await passes(200);
      expect(answerOf(PARAR)?.correct).toBe(true);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      await passes(MOVE_DELAY_MS);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(live).toHaveTextContent(
        /^Parar marcado como certo, movido para o fim de Vocabulário\. Categoria Vocabulário completa, movida para o fim da aba\.$/,
      );
      // A pointer: the focus stays on the item, now at the end of the tab.
      expect(button('Certo: Parar')).toHaveFocus();
    });

    it('rn006 a keyboard mark saved after all: closing its notice by the keyboard sends the focus to the first open item', async () => {
      // The API saves the mark, but the answer never comes back (network).
      server.use(
        http.put(ANSWER_URL, ({ params }) => {
          if (answerOf(String(params.requirementId)) === undefined) {
            db.answers.push({
              exam_id: helenaExam().id,
              requirement_id: String(params.requirementId),
              correct: true,
              marked_by: 'mock-examiner',
              marked_at: '2026-11-21T13:40:00+00:00',
            });
          }
          return HttpResponse.error();
        }),
      );
      await openHelena();
      const live = screen.getByTestId('queue-live');
      stopTheClock();
      press('Certo: Parar');
      await passes(MOVE_DELAY_MS * 2);
      await passesUntil(() => screen.queryByRole('alert') !== null && pressed('Certo: Parar'));
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível confirmar a marcação de "Parar"');
      expect(pressed('Certo: Parar')).toBe(true);
      expect(itemOrder()).toEqual(THEORY_AT_START);
      expect(live).toBeEmptyDOMElement();

      pressIn(within(alert).getByRole('button', { name: 'Fechar aviso' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(live).toHaveTextContent('Parar marcado como certo, movido para o fim de Vocabulário.');
      expect(button(`Certo: ${FOUNDER_NAME}`)).toHaveFocus();
    });
  });

  describe('live regions (§ 6.7)', () => {
    it('says the percentages once in their region and the move once in the queue region', async () => {
      await openHelena();
      const percent = screen.getByTestId('percent-live');
      const queue = screen.getByTestId('queue-live');
      stopTheClock();
      tap('Certo: Parar');
      // Each region has its own wait of about a second (the percentages count from the save,
      // whose answer comes back in between).
      for (let step = 0; step < 20; step += 1) await passes(MOVE_DELAY_MS / 10);
      expect(itemOrder()).toEqual(THEORY_AFTER_PARAR);
      expect(percent).toHaveTextContent(/^Teórico 66,7%, Prático 25%$/);
      expect(queue).toHaveTextContent(
        /^Parar marcado como certo, movido para o fim de Vocabulário\. Categoria Vocabulário completa, movida para o fim da aba\.$/,
      );

      // Nothing is said again while the screen stays still.
      const percentNode = percent.innerHTML;
      const queueNode = queue.firstElementChild;
      await passes(MOVE_DELAY_MS * 3);
      expect(percent.innerHTML).toBe(percentNode);
      expect(queue.firstElementChild).toBe(queueNode);
    });
  });
});
