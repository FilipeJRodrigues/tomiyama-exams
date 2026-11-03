/**
 * § 6.4 exam of a student, step 2: Certo/Errado saved at once with an optimistic update
 * (RN006), the RN007 summary from the API, the locks of a decided exam (RN010) and of a
 * closed event (RN016), the order of fast clicks, keyboard use, "Só não marcados" and the
 * live region of the percentages (§ 6.7).
 *
 * Helena (open event, Marrom belt, exam in progress): Teórico 1/3 marked (Professor certo;
 * Parar and Nome do fundador não marcados), 33,3%; Prático 2/4, 25%.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExamSummary } from '../../../src/api/types';
import { examPath } from '../../../src/app/navigation';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const SHEET_URL = `${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`;
const ANSWER_URL = `${TEST_API_URL}/events/:id/exams/:studentId/answers/:requirementId`;
const PROFESSOR = mockRequirementId('Marrom', 5);
const PARAR = mockRequirementId('Marrom', 6);
const FOUNDER = mockRequirementId('Marrom', 7);
const OSOTO = mockRequirementId('Marrom', 4);

let db: MockDb;
let sheetReads = 0;
/** Writes that reached the API, in order: `PUT <id> true|false` or `DELETE <id>`. */
let writes: string[] = [];

function helenaExam() {
  return db.exams.find((exam) => exam.student_id === HELENA)!;
}

function answerOf(requirementId: string) {
  return db.answers.find(
    (item) => item.exam_id === helenaExam().id && item.requirement_id === requirementId,
  );
}

function installApi() {
  db = createMockDb({ includeShowcase: true });
  sheetReads = 0;
  writes = [];
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  // Count and log, then let the simulated API answer.
  server.use(
    http.get(SHEET_URL, () => {
      sheetReads += 1;
      return undefined;
    }),
    http.put(ANSWER_URL, async ({ request, params }) => {
      const body = (await request.clone().json()) as { correct: boolean };
      writes.push(`PUT ${String(params.requirementId)} ${String(body.correct)}`);
      return undefined;
    }),
    http.delete(ANSWER_URL, ({ params }) => {
      writes.push(`DELETE ${String(params.requirementId)}`);
      return undefined;
    }),
  );
}

interface HeldWrite {
  requirementId: string;
  release: () => void;
}

/** Hold every mark (PUT and DELETE) until released, one by one, in any order. */
function holdWrites(): HeldWrite[] {
  const held: HeldWrite[] = [];
  const hold = ({ params }: { params: Record<string, unknown> }) =>
    new Promise<undefined>((resolve) => {
      held.push({
        requirementId: String(params.requirementId),
        release: () => {
          resolve(undefined);
        },
      });
    });
  server.use(http.put(ANSWER_URL, hold), http.delete(ANSWER_URL, hold));
  return held;
}

async function release(write: HeldWrite | undefined) {
  if (!write) throw new Error('Nenhuma marcação retida');
  await act(async () => {
    write.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/** Answer every mark with this error, as the API does. */
function refuseWrites(status: number, message: string) {
  const refuse = () => HttpResponse.json({ message }, { status });
  server.use(http.put(ANSWER_URL, refuse), http.delete(ANSWER_URL, refuse));
}

async function openHelena() {
  const rendered = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
  return rendered;
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

function scores() {
  return screen.getByTestId('exam-scores');
}

function theoryScore() {
  return scores().querySelector<HTMLElement>('[data-score="THEORY"]')!;
}

async function windowRegainsFocus() {
  await act(async () => {
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

describe('marking the exam items (§ 6.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('buttons', () => {
    it('rn006 shows Certo and Errado on each item, named after it, 44 px tall', async () => {
      await openHelena();
      const group = screen.getByRole('group', { name: 'Marcação: Parar' });
      const certo = within(group).getByRole('button', { name: 'Certo: Parar' });
      const errado = within(group).getByRole('button', { name: 'Errado: Parar' });
      expect(certo).toHaveTextContent('Certo');
      expect(errado).toHaveTextContent('Errado');
      expect(certo).toHaveAttribute('aria-pressed', 'false');
      expect(errado).toHaveAttribute('aria-pressed', 'false');
      expect(certo).toHaveStyle({ minHeight: '44px' });
      expect(errado).toHaveStyle({ minHeight: '44px' });
      // The saved mark is the pressed button.
      expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Errado: Professor')).toHaveAttribute('aria-pressed', 'false');
    });

    it('rn006 shows the buttons on the practical items too', async () => {
      const { user } = await openHelena();
      await user.click(screen.getByRole('tab', { name: /^Prático/ }));
      expect(button('Errado: Demonstrar saudação ajoelhado')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(button('Certo: Osoto gari')).toHaveAttribute('aria-pressed', 'false');
    });

    it('fit the phone width', async () => {
      setViewportWidth(390);
      await openHelena();
      expect(button('Certo: Parar')).toBeInTheDocument();
      expect(button('Errado: Parar')).toBeInTheDocument();
    });
  });

  describe('saving at once', () => {
    it('rn006 marks an item certo, at once, and saves it', async () => {
      const held = holdWrites();
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));

      // Optimistic: the item, the tab, the category and the percentage move before the API.
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('tab', { name: /^Teórico 2\/3$/ })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: /^Vocabulário 2\/2$/ })).toBeInTheDocument();
      expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
      expect(within(theoryScore()).getByText('marcados 2 de 3')).toBeInTheDocument();
      expect(
        within(screen.getByRole('complementary', { name: 'Resumo do exame' })).getByRole(
          'progressbar',
        ),
      ).toHaveAttribute('aria-valuetext', '4 de 7 itens marcados');
      expect(answerOf(PARAR)).toBeUndefined();

      await release(held[0]);
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(true);
      });
      expect(writes).toEqual([`PUT ${PARAR} true`]);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    });

    it('rn006 marks an item errado', async () => {
      const { user } = await openHelena();
      await user.click(button('Errado: Parar'));
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
      expect(within(theoryScore()).getByText('33,3%')).toBeInTheDocument();
      expect(within(theoryScore()).getByText('marcados 2 de 3')).toBeInTheDocument();
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(false);
      });
      expect(writes).toEqual([`PUT ${PARAR} false`]);
    });

    it('rn006 switches a mark from certo to errado', async () => {
      const { user } = await openHelena();
      await user.click(button('Errado: Professor'));
      expect(button('Errado: Professor')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'false');
      expect(within(theoryScore()).getByText('0%')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Teórico 1\/3$/ })).toBeInTheDocument();
      await waitFor(() => {
        expect(answerOf(PROFESSOR)?.correct).toBe(false);
      });
    });

    it('rn006 takes the mark off when the pressed button is clicked again', async () => {
      const { user } = await openHelena();
      await user.click(button('Certo: Professor'));
      expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'false');
      expect(button('Errado: Professor')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('tab', { name: /^Teórico 0\/3$/ })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: /^Vocabulário 0\/2$/ })).toBeInTheDocument();
      expect(within(theoryScore()).getByText('0%')).toBeInTheDocument();
      await waitFor(() => {
        expect(answerOf(PROFESSOR)).toBeUndefined();
      });
      expect(writes).toEqual([`DELETE ${PROFESSOR}`]);
    });

    it('rn007 shows the summary the API sends back', async () => {
      const fromApi: ExamSummary = {
        THEORY: { kind: 'THEORY', total: 3, marked: 3, correct: 3, percent: 100 },
        PRACTICE: { kind: 'PRACTICE', total: 4, marked: 4, correct: 1, percent: 25 },
      };
      server.use(
        http.put(ANSWER_URL, () =>
          HttpResponse.json({
            answer: {
              requirement_id: PARAR,
              correct: true,
              marked_by: 'mock-examiner',
              marked_at: '2026-11-21T12:00:00+00:00',
            },
            summary: fromApi,
          }),
        ),
      );
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      // Another examiner marked the rest meanwhile: the API numbers win over the preview.
      expect(await within(theoryScore()).findByText('100%')).toBeInTheDocument();
      expect(within(theoryScore()).getByText('marcados 3 de 3')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Prático 4\/4$/ })).toBeInTheDocument();
    });
  });

  describe('errors', () => {
    it('rn006 puts the item back and warns with the API message (503)', async () => {
      refuseWrites(503, 'Sistema ocupado no momento. Tente de novo em instantes.');
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível salvar a marcação de "Parar"');
      expect(alert).toHaveTextContent('Sistema ocupado no momento. Tente de novo em instantes.');
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('tab', { name: /^Teórico 1\/3$/ })).toBeInTheDocument();
      expect(within(theoryScore()).getByText('33,3%')).toBeInTheDocument();
      expect(screen.queryByText('Aprovado')).not.toBeInTheDocument();

      await user.click(within(alert).getByRole('button', { name: 'Fechar aviso' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('rn006 puts an unmarked item back on a transaction conflict, without reloading', async () => {
      refuseWrites(409, 'Outra marcação está em andamento. Tente de novo.');
      const { user } = await openHelena();
      const reads = sheetReads;
      await user.click(button('Certo: Professor'));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Outra marcação está em andamento. Tente de novo.',
      );
      expect(button('Certo: Professor')).toHaveAttribute('aria-pressed', 'true');
      expect(within(theoryScore()).getByText('33,3%')).toBeInTheDocument();
      expect(sheetReads).toBe(reads);
    });

    it('warns when the server cannot be reached', async () => {
      server.use(http.put(ANSWER_URL, () => HttpResponse.error()));
      const { user } = await openHelena();
      await user.click(button('Errado: Parar'));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.',
      );
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'false');
    });

    it('rn010 reloads a decided exam and shows it read-only', async () => {
      const { user } = await openHelena();
      // The sensei decided on another device.
      Object.assign(helenaExam(), {
        status: 'APPROVED',
        decided_by_id: 'mock-examiner',
        decided_at: '2026-11-21T12:00:00+00:00',
      });
      await user.click(button('Certo: Parar'));

      expect(await screen.findByRole('alert')).toHaveTextContent('Exame já decidido');
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /^(Certo|Errado):/ })).not.toBeInTheDocument();
      });
      expect(screen.getByText('Aprovado')).toBeInTheDocument();
      const parar = screen.getByText('Parar').closest('li')!;
      expect(within(parar).getByText('Não marcado')).toBeInTheDocument();
      expect(answerOf(PARAR)).toBeUndefined();
    });

    it('rn016 reloads when the event was closed and shows the items read-only', async () => {
      const { user } = await openHelena();
      db.events = db.events.map((event) =>
        event.id === OPEN ? { ...event, status: 'CLOSED' } : event,
      );
      await user.click(button('Certo: Professor'));

      expect(await screen.findByRole('alert')).toHaveTextContent('Evento encerrado');
      expect(await screen.findByRole('note')).toHaveTextContent(
        'Os itens não podem mais ser marcados.',
      );
      expect(screen.queryByRole('button', { name: /^(Certo|Errado):/ })).not.toBeInTheDocument();
      expect(answerOf(PROFESSOR)?.correct).toBe(true);
    });
  });

  describe('fast clicks', () => {
    it('rn006 sends one mark per item at a time and the last click wins', async () => {
      const held = holdWrites();
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await user.click(button('Errado: Parar'));
      await user.click(button('Certo: Parar'));
      await user.click(button('Errado: Parar'));
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      // The first click is on its way; the others only changed the wanted mark.
      expect(held).toHaveLength(1);

      await release(held[0]);
      expect(held).toHaveLength(2);
      // The first answer (certo) does not undo the newer click.
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      await release(held[1]);

      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(false);
      });
      expect(writes).toEqual([`PUT ${PARAR} true`, `PUT ${PARAR} false`]);
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(within(theoryScore()).getByText('33,3%')).toBeInTheDocument();
    });

    it('rn006 sends nothing more when the item ends as the first click sent it', async () => {
      const held = holdWrites();
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await user.click(button('Errado: Parar'));
      await user.click(button('Certo: Parar'));
      await release(held[0]);
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(true);
      });
      expect(held).toHaveLength(1);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
    });

    it('rn007 keeps every item right when answers of several items come out of order', async () => {
      const held = holdWrites();
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await user.click(button('Certo: Nome do fundador do Judô'));
      expect(within(theoryScore()).getByText('100%')).toBeInTheDocument();
      expect(held.map((write) => write.requirementId)).toEqual([PARAR, FOUNDER]);

      // The newer one comes back first, then the older one.
      await release(held[1]);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Certo: Nome do fundador do Judô')).toHaveAttribute('aria-pressed', 'true');
      expect(within(theoryScore()).getByText('100%')).toBeInTheDocument();
      const reads = sheetReads;
      await release(held[0]);

      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Certo: Nome do fundador do Judô')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('tab', { name: /^Teórico 3\/3$/ })).toBeInTheDocument();
      // Their summaries may miss each other: the exam reloads once both landed.
      await waitFor(() => {
        expect(sheetReads).toBe(reads + 1);
      });
      expect(within(theoryScore()).getByText('100%')).toBeInTheDocument();
      expect(within(theoryScore()).getByText('marcados 3 de 3')).toBeInTheDocument();
    });

    it('rn006 ends as saved, with a warning, when a mark of the series is refused', async () => {
      // Certo (held) goes through, the newer Errado is refused: the screen shows what was saved.
      let releaseFirst: () => void = () => undefined;
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let calls = 0;
      server.use(
        http.put(ANSWER_URL, async () => {
          calls += 1;
          if (calls === 1) {
            await first;
            return undefined;
          }
          return HttpResponse.json(
            { message: 'Sistema ocupado no momento. Tente de novo em instantes.' },
            { status: 503 },
          );
        }),
      );
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await user.click(button('Errado: Parar'));
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      releaseFirst();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Sistema ocupado no momento. Tente de novo em instantes.',
      );
      expect(answerOf(PARAR)?.correct).toBe(true);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'false');
      expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    });

    it('rn006 rolls back only the refused item', async () => {
      server.use(
        http.put(ANSWER_URL, ({ params }) =>
          params.requirementId === PARAR
            ? HttpResponse.json(
                { message: 'Sistema ocupado no momento. Tente de novo em instantes.' },
                { status: 503 },
              )
            : undefined,
        ),
      );
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      await user.click(button('Certo: Nome do fundador do Judô'));
      await screen.findByRole('alert');
      await waitFor(() => {
        expect(answerOf(FOUNDER)?.correct).toBe(true);
      });
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'false');
      expect(button('Certo: Nome do fundador do Judô')).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => {
        expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
      });
    });
  });

  describe('reload on window focus', () => {
    it('waits while a mark is on its way, then reloads (no flicker)', async () => {
      const held = holdWrites();
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      // Another examiner marks a practical item meanwhile.
      db.answers.push({
        exam_id: helenaExam().id,
        requirement_id: OSOTO,
        correct: true,
        marked_by: 'mock-examiner-2',
        marked_at: '2026-11-21T13:40:00+00:00',
      });
      const reads = sheetReads;
      await windowRegainsFocus();
      expect(sheetReads).toBe(reads);
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');

      await release(held[0]);
      await waitFor(() => {
        expect(sheetReads).toBe(reads + 1);
      });
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(await screen.findByRole('tab', { name: /^Prático 3\/4$/ })).toBeInTheDocument();
    });

    it('cancels a reload already on its way when an item is marked', async () => {
      // The reload started before the click would bring Parar back as "não marcado".
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const { user } = await openHelena();
      server.use(
        http.get(
          SHEET_URL,
          async () => {
            await gate;
            return undefined;
          },
          { once: true },
        ),
      );
      await windowRegainsFocus();
      await user.click(button('Certo: Parar'));
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(true);
      });
      openGate();
      await waitFor(() => {
        expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    });
  });

  describe('leaving the screen', () => {
    it('rn006 saves a mark on its way on the exam it was made on', async () => {
      const held = holdWrites();
      const { user } = await openHelena();
      await user.click(button('Certo: Parar'));
      const trail = screen.getByRole('navigation', { name: 'Caminho' });
      await user.click(within(trail).getByRole('link', { name: 'Dia do exame' }));
      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { level: 1, name: 'Helena Prado' }),
        ).not.toBeInTheDocument();
      });

      await release(held[0]);
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(true);
      });
      // Nothing of Helena's exam spills over the exam day.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await user.click(await screen.findByRole('link', { name: /Helena Prado/ }));
      await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
      expect(await screen.findByRole('button', { name: 'Certo: Parar' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(within(theoryScore()).getByText('66,7%')).toBeInTheDocument();
    });
  });

  describe('keyboard', () => {
    it('rn006 reaches the buttons with Tab and marks with Space and Enter', async () => {
      const { user } = await openHelena();
      button('Certo: Professor').focus();
      await user.tab();
      expect(button('Errado: Professor')).toHaveFocus();
      await user.tab();
      expect(button('Certo: Parar')).toHaveFocus();

      // Visible focus ring on keyboard focus (theme `focusRing: 'auto'`, § 6.7).
      expect(button('Certo: Parar')).toHaveClass('mantine-focus-auto');
      expect(button('Certo: Parar')).not.toHaveStyle({ outline: 'none' });

      await user.keyboard(' ');
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Certo: Parar')).toHaveFocus();
      await user.tab();
      expect(button('Errado: Parar')).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(button('Errado: Parar')).toHaveFocus();

      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(false);
      });
      expect(button('Errado: Parar')).toHaveFocus();
    });
  });

  describe('"Só não marcados"', () => {
    it('keeps a just-marked item in place until the tab or the filter changes', async () => {
      const { user } = await openHelena();
      const filter = screen.getByRole('switch', { name: 'Só não marcados' });
      await user.click(filter);
      expect(screen.queryByText('Professor')).not.toBeInTheDocument();

      await user.click(button('Certo: Parar'));
      await waitFor(() => {
        expect(answerOf(PARAR)?.correct).toBe(true);
      });
      // Still under the finger, pressed, with the counts already moved.
      expect(button('Certo: Parar')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('region', { name: /^Vocabulário 2\/2$/ })).toBeInTheDocument();
      // It can still be changed there.
      await user.click(button('Errado: Parar'));
      expect(button('Errado: Parar')).toHaveAttribute('aria-pressed', 'true');

      await user.click(screen.getByRole('tab', { name: /^Prático/ }));
      await user.click(screen.getByRole('tab', { name: /^Teórico/ }));
      expect(screen.queryByText('Parar')).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: /^Vocabulário/ })).not.toBeInTheDocument();
      expect(button('Certo: Nome do fundador do Judô')).toBeInTheDocument();
    });

    it('hides the marked items again when the filter is turned off and on', async () => {
      const { user } = await openHelena();
      const filter = screen.getByRole('switch', { name: 'Só não marcados' });
      await user.click(filter);
      await user.click(button('Certo: Nome do fundador do Judô'));
      await waitFor(() => {
        expect(answerOf(FOUNDER)?.correct).toBe(true);
      });
      await user.click(filter);
      await user.click(filter);
      expect(screen.queryByText('Nome do fundador do Judô')).not.toBeInTheDocument();
      expect(button('Certo: Parar')).toBeInTheDocument();
    });
  });

  describe('live region', () => {
    it('reads the percentages out once, after the marks land, not at every click', async () => {
      const held = holdWrites();
      const { user } = await openHelena();
      const live = screen.getByTestId('percent-live');
      expect(live).toHaveAttribute('aria-live', 'polite');
      expect(live).toHaveTextContent('');
      expect(scores()).not.toHaveAttribute('aria-live');

      await user.click(button('Certo: Parar'));
      await user.click(button('Certo: Nome do fundador do Judô'));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      // Nothing while the marks are on their way.
      expect(live).toHaveTextContent('');

      await release(held[0]);
      await release(held[1]);
      await waitFor(() => {
        expect(live).toHaveTextContent('Teórico 100%, Prático 25%');
      });
    });

    it('says nothing when the clicks end where they started', async () => {
      const { user } = await openHelena();
      const live = screen.getByTestId('percent-live');
      await user.click(button('Certo: Professor'));
      await waitFor(() => {
        expect(answerOf(PROFESSOR)).toBeUndefined();
      });
      await user.click(button('Certo: Professor'));
      await waitFor(() => {
        expect(answerOf(PROFESSOR)?.correct).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(live).toHaveTextContent('');
    });
  });
});
