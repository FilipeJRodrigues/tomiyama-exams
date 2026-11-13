import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../../src/api/client';
import { confirmAttendance } from '../../../src/api/queries';
import { examPath } from '../../../src/app/navigation';
import type { ExamEvent } from '../../../src/api/types';
import { createMockAuth } from '../../../src/auth/mockAuth';
import { createMockDb, MOCK_EVENT_IDS, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const OPEN = MOCK_EVENT_IDS.open;
const CLOSED = MOCK_EVENT_IDS.closed;
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const GABRIEL = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07';
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const EVENTS_URL = `${TEST_API_URL}/events`;
const STUDENTS_URL = `${TEST_API_URL}/students`;
const OPEN_EXAMS_URL = `${TEST_API_URL}/events/${OPEN}/exams`;
const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';

/** Rows of the open event (21/11/2026) with the showcase data, ages on the event date. */
const OPEN_ROWS = [
  ['Ana Souza', '8 anos', 'Cinza', 'Faixa Cinza/Azul', 'Elegível', 'Confirmar presença'],
  [
    'Bruno Souza',
    '7 anos',
    'Azul',
    'Faixa Azul/Amarela',
    'Bloqueado: Idade mínima para a faixa Azul/Amarela: 8 anos',
    '',
  ],
  ['Carla Mendes', '14 anos', 'Laranja', 'Grau (rumo à Verde)', 'Elegível', 'Confirmar presença'],
  [
    'Davi Oliveira',
    '10 anos',
    'Branca',
    'Faixa Branca/Cinza',
    'Bloqueado: Carência mínima de 3 meses na faixa atual (faltam 1)',
    '',
  ],
  [
    'Fábio Lima',
    '18 anos',
    'Marrom · 3 graus',
    '—',
    'Bloqueado: Faixa preta é exame da federação',
    '',
  ],
  [
    'Gabriel Costa',
    '8 anos',
    'Amarela/Laranja · 2 graus',
    'Faixa Laranja',
    'Bloqueado: Idade mínima para a faixa Laranja: 11 anos; Carência mínima de 12 meses na faixa atual (faltam 4)',
    '',
  ],
  [
    'Helena Prado',
    '15 anos',
    'Roxa · 4 graus',
    'Faixa Marrom',
    'ElegívelPresente · Em andamento',
    'Abrir exame',
  ],
];

let db: MockDb;

function installApi(options: { includeShowcase?: boolean } = { includeShowcase: true }) {
  db = createMockDb(options);
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
}

/** Records the requests matching `method url` and lets the simulated API answer them. */
function recordRequests(method: 'get' | 'post', url: string): Request[] {
  const requests: Request[] = [];
  server.use(
    http[method](url, ({ request }) => {
      requests.push(request.clone());
      return undefined;
    }),
  );
  return requests;
}

/** Holds the matching requests until `release` is called, then lets the API answer. */
function holdRequests(method: 'get' | 'post', url: string) {
  const held: Request[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  server.use(
    http[method](url, async ({ request }) => {
      held.push(request.clone());
      await gate;
      return undefined;
    }),
  );
  return {
    held,
    release: () => {
      open();
    },
  };
}

function tableRows(table: HTMLElement): string[][] {
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent.trim()),
  );
}

function rowOf(table: HTMLElement, name: string): HTMLElement {
  return within(table).getByRole('rowheader', { name }).closest('tr')!;
}

function filterRadio(name: RegExp) {
  return within(screen.getByRole('radiogroup', { name: 'Filtrar alunos' })).getByRole('radio', {
    name,
  });
}

async function windowRegainsFocus() {
  await act(async () => {
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

describe('exam day (§ 6.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    installApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('states', () => {
    it('shows a labelled loading state while the events load', async () => {
      const { release } = holdRequests('get', EVENTS_URL);
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      expect(await screen.findByRole('status')).toHaveTextContent('Carregando eventos…');
      release();
      expect(await screen.findByRole('table', { name: LIST })).toBeInTheDocument();
    });

    it('shows a loading state while the students of the event load', async () => {
      const { release } = holdRequests('get', STUDENTS_URL);
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      expect(await screen.findByText('Carregando alunos…')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Evento' })).toHaveValue(OPEN);
      release();
      expect(await screen.findByRole('table', { name: LIST })).toBeInTheDocument();
    });

    it('shows the events error and reloads with "Tentar de novo"', async () => {
      server.use(
        http.get(
          EVENTS_URL,
          () => HttpResponse.json({ message: 'Erro interno. Tente de novo.' }, { status: 500 }),
          { once: true },
        ),
      );
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível carregar os eventos');
      expect(alert).toHaveTextContent('Erro interno. Tente de novo.');
      await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByRole('table', { name: LIST })).toBeInTheDocument();
    });

    it('shows the students error and reloads with "Tentar de novo"', async () => {
      server.use(
        http.get(STUDENTS_URL, () => HttpResponse.error(), { once: true }),
        http.get(OPEN_EXAMS_URL, () => HttpResponse.error(), { once: true }),
      );
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível carregar os alunos');
      expect(alert).toHaveTextContent('Não foi possível falar com o servidor.');
      await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByRole('table', { name: LIST })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows "Sem permissão" without a retry on 403', async () => {
      server.use(
        http.get(EVENTS_URL, () =>
          HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
        ),
      );
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Sem permissão');
      expect(alert).toHaveTextContent('Esta área é dos examinadores');
      expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
    });

    it('keeps guardians out without asking the API', async () => {
      const requests = recordRequests('get', EVENTS_URL);
      await renderApp({ route: ROUTE, signedInAs: 'guardian' });
      expect(
        await screen.findByRole('heading', { name: 'Esta área é dos examinadores' }),
      ).toBeInTheDocument();
      expect(requests).toHaveLength(0);
    });

    it('says there is no event and links to "Criar evento"', async () => {
      db.events = [];
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      expect(await screen.findByText('Nenhum evento cadastrado.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Criar evento' })).toHaveAttribute(
        'href',
        '/eventos',
      );
      expect(screen.queryByRole('combobox', { name: 'Evento' })).not.toBeInTheDocument();
    });

    it('says there is no open event, links to "Criar evento" and still lists the closed ones', async () => {
      db.events = db.events.filter((event) => event.status === 'CLOSED');
      const students = recordRequests('get', STUDENTS_URL);
      const { user, router } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });

      expect(await screen.findByText('Nenhum evento aberto.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Criar evento' })).toHaveAttribute(
        'href',
        '/eventos',
      );
      expect(students).toHaveLength(0);

      const select = screen.getByRole('combobox', { name: 'Evento' });
      await user.selectOptions(select, CLOSED);
      expect(await screen.findByRole('table', { name: LIST })).toBeInTheDocument();
      expect(router.state.location.search).toBe(`?evento=${CLOSED}`);
      expect(screen.queryByText('Nenhum evento aberto.')).not.toBeInTheDocument();
    });

    it('says there is no active student', async () => {
      server.use(http.get(STUDENTS_URL, () => HttpResponse.json([])));
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      expect(await screen.findByText('Nenhum aluno ativo.')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('keeps the list when a background reload fails', async () => {
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      server.use(
        http.get(EVENTS_URL, () => HttpResponse.error()),
        http.get(STUDENTS_URL, () => HttpResponse.error()),
        http.get(OPEN_EXAMS_URL, () =>
          HttpResponse.json({ message: 'Erro interno.' }, { status: 500 }),
        ),
      );
      await windowRegainsFocus();
      expect(screen.getByRole('table', { name: LIST })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Evento' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('event selector', () => {
    it('rn015 picks the most recent open event and asks the eligibility on its date', async () => {
      const students = recordRequests('get', STUDENTS_URL);
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });

      const select = screen.getByRole('combobox', { name: 'Evento' });
      expect(select).toHaveValue(OPEN);
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual([
        'Exame novembro/2026 · 21/11/2026 · Aberto',
        'Exame março/2026 · 01/03/2026 · Encerrado',
      ]);
      const params = new URL(students[0]!.url).searchParams;
      expect(params.get('active')).toBe('true');
      expect(params.get('reference_date')).toBe('2026-11-21');
    });

    it('picks the most recent open event even when a closed one is more recent', async () => {
      const recentClosed: ExamEvent = {
        id: 'evento-recente',
        name: 'Exame dezembro/2026',
        exam_date: '2026-12-12',
        status: 'CLOSED',
        created_at: '2026-10-25T12:00:00+00:00',
        updated_at: '2026-10-25T12:00:00+00:00',
      };
      db.events.push(recentClosed);
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      expect(screen.getByRole('combobox', { name: 'Evento' })).toHaveValue(OPEN);
    });

    it('rn015 keeps the chosen event in the URL and shows ages on its date', async () => {
      const students = recordRequests('get', STUDENTS_URL);
      const { user, router } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });

      await user.selectOptions(screen.getByRole('combobox', { name: 'Evento' }), CLOSED);
      expect(router.state.location.search).toBe(`?evento=${CLOSED}`);
      const table = await screen.findByRole('table', { name: LIST });
      // Ana is 8 today and was 7 on 01/03/2026.
      await waitFor(() => {
        expect(within(rowOf(table, 'Ana Souza')).getByText('7 anos')).toBeInTheDocument();
      });
      expect(new URL(students.at(-1)!.url).searchParams.get('reference_date')).toBe('2026-03-01');
    });

    it('opens the event in the URL, as after a reload', async () => {
      await renderApp({ route: `${ROUTE}?evento=${CLOSED}`, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      expect(screen.getByRole('combobox', { name: 'Evento' })).toHaveValue(CLOSED);
      expect(screen.getByRole('note')).toHaveTextContent('Evento encerrado');
    });

    // Rewritten for #28 (user's decision): it used to expect the most recent open event here.
    it('rn005 never falls back to another event when the URL event does not exist: notice, no event picked, no list', async () => {
      const exams = recordRequests('get', OPEN_EXAMS_URL);
      const { user, router } = await renderApp({
        route: `${ROUTE}?evento=nao-existe`,
        signedInAs: 'examiner',
      });
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /^O evento escolhido não foi encontrado\. Ele pode ter sido apagado\. Escolha um evento na lista\.$/,
      );
      const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Evento' });
      expect(picker).toHaveValue('');
      expect(picker.selectedOptions[0]).toHaveTextContent('Nenhum evento escolhido');
      expect(screen.queryByRole('table', { name: LIST })).not.toBeInTheDocument();
      expect(screen.queryByText('Carregando alunos…')).not.toBeInTheDocument();
      expect(screen.queryByText('Nenhum evento aberto.')).not.toBeInTheDocument();
      await waitFor(() => {
        expect(router.state.location.search).toBe('');
      });
      expect(exams).toHaveLength(0);

      // The open event is still there to be picked, and only then its list shows.
      await user.selectOptions(picker, OPEN);
      await screen.findByRole('table', { name: LIST });
      expect(screen.getByRole('combobox', { name: 'Evento' })).toHaveValue(OPEN);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(router.state.location.search).toBe(`?evento=${OPEN}`);
    });
  });

  describe('list', () => {
    it.each([1280, 768])(
      'rn005 shows the columns, the API data and the action of each row at %i px',
      async (width) => {
        setViewportWidth(width);
        await renderApp({ route: ROUTE, signedInAs: 'examiner' });
        const table = await screen.findByRole('table', { name: LIST });

        const headers = within(table).getAllByRole('columnheader');
        expect(headers.map((header) => header.textContent)).toEqual([
          'Aluno',
          'Idade',
          'Faixa atual',
          'Próximo exame',
          'Situação',
          'Ação',
        ]);
        expect(tableRows(table)).toEqual(OPEN_ROWS);
        expect(screen.queryByRole('list', { name: LIST })).not.toBeInTheDocument();
      },
    );

    it('rn005 links "Abrir exame" to the exam of the student in the event', async () => {
      const { user, router } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });
      const link = within(rowOf(table, 'Helena Prado')).getByRole('link', {
        name: 'Abrir exame de Helena Prado',
      });
      expect(link).toHaveAttribute('href', `/dia-do-exame/${OPEN}/alunos/${HELENA}`);
      await user.click(link);
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Helena Prado' }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(`/dia-do-exame/${OPEN}/alunos/${HELENA}`);
    });

    it('keeps the table in a named, focusable scroll region', async () => {
      setViewportWidth(768);
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      const region = screen.getByRole('region', { name: 'Lista de alunos do evento' });
      expect(region).toHaveAttribute('tabindex', '0');
      expect(within(region).getByRole('table', { name: LIST })).toBeInTheDocument();
    });

    it('writes the blocked state in the error color, with text and icon', async () => {
      await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      const blocked = screen.getByText('Bloqueado: Faixa preta é exame da federação', {
        selector: 'span',
      });
      expect(blocked.getAttribute('style')).toContain('var(--mantine-color-error)');
      expect(blocked.closest('[data-status]')?.querySelector('svg')).toHaveAttribute(
        'aria-hidden',
        'true',
      );
    });

    it.each([390, 640])(
      'rn005 shows cards with the same data and actions at %i px (phone, zoomed layout)',
      async (width) => {
        setViewportWidth(width);
        await renderApp({ route: ROUTE, signedInAs: 'examiner' });
        const list = await screen.findByRole('list', { name: LIST });
        expect(screen.queryByRole('table')).not.toBeInTheDocument();

        const cards = within(list).getAllByRole('listitem');
        expect(cards).toHaveLength(OPEN_ROWS.length);
        cards.forEach((card, index) => {
          const [name, ...values] = OPEN_ROWS[index]!;
          const action = values.pop();
          expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(name!);
          expect(Array.from(card.querySelectorAll('dt')).map((dt) => dt.textContent)).toEqual([
            'Idade',
            'Faixa atual',
            'Próximo exame',
            'Situação',
          ]);
          expect(
            Array.from(card.querySelectorAll('dd')).map((dd) => dd.textContent.trim()),
          ).toEqual(values);
          const controls = Array.from(card.querySelectorAll('button, a[href]'));
          expect(controls.map((control) => control.textContent)).toEqual(action ? [action] : []);
        });
        expect(screen.getByRole('radiogroup', { name: 'Filtrar alunos' })).toBeInTheDocument();
        expect(screen.getByRole('searchbox', { name: 'Buscar por nome' })).toBeInTheDocument();
      },
    );
  });

  describe('search and filters', () => {
    it('counts each filter and shows only the chosen group', async () => {
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });
      const names = () =>
        within(screen.getByRole('table', { name: LIST }))
          .getAllByRole('rowheader')
          .map((cell) => cell.textContent);

      expect(filterRadio(/^Todos \(7\)$/)).toBeChecked();
      expect(filterRadio(/^Elegíveis \(3\)$/)).not.toBeChecked();
      expect(filterRadio(/^Bloqueados \(4\)$/)).toBeInTheDocument();
      expect(filterRadio(/^Presentes \(1\)$/)).toBeInTheDocument();
      expect(within(table).getAllByRole('rowheader')).toHaveLength(7);

      await user.click(filterRadio(/^Elegíveis/));
      expect(names()).toEqual(['Ana Souza', 'Carla Mendes', 'Helena Prado']);
      await user.click(filterRadio(/^Bloqueados/));
      expect(names()).toEqual(['Bruno Souza', 'Davi Oliveira', 'Fábio Lima', 'Gabriel Costa']);
      await user.click(filterRadio(/^Presentes/));
      expect(names()).toEqual(['Helena Prado']);
      await user.click(filterRadio(/^Todos/));
      expect(names()).toHaveLength(7);
    });

    it('searches by name without accents or case and updates the counts', async () => {
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      const search = screen.getByRole('searchbox', { name: 'Buscar por nome' });

      await user.type(search, 'FABIO');
      const table = screen.getByRole('table', { name: LIST });
      expect(
        within(table)
          .getAllByRole('rowheader')
          .map((cell) => cell.textContent),
      ).toEqual(['Fábio Lima']);
      expect(filterRadio(/^Todos \(1\)$/)).toBeInTheDocument();
      expect(filterRadio(/^Bloqueados \(1\)$/)).toBeInTheDocument();
      expect(filterRadio(/^Elegíveis \(0\)$/)).toBeInTheDocument();

      await user.clear(search);
      await user.type(search, 'souza');
      expect(
        within(screen.getByRole('table', { name: LIST }))
          .getAllByRole('rowheader')
          .map((cell) => cell.textContent),
      ).toEqual(['Ana Souza', 'Bruno Souza']);
    });

    it('says when no student matches', async () => {
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      await user.type(screen.getByRole('searchbox', { name: 'Buscar por nome' }), 'zzz');
      expect(screen.getByText('Nenhum aluno encontrado.')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });
  });

  describe('confirm attendance (RN005)', () => {
    it('rn005 confirms, shows loading meanwhile and turns the row into "Abrir exame"', async () => {
      const posts = recordRequests('post', OPEN_EXAMS_URL);
      const { held, release } = holdRequests('post', OPEN_EXAMS_URL);
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });

      const button = within(rowOf(table, 'Ana Souza')).getByRole('button', {
        name: 'Confirmar presença de Ana Souza',
      });
      await user.click(button);
      await waitFor(() => {
        expect(held).toHaveLength(1);
      });
      expect(button).toHaveAttribute('data-loading', 'true');
      expect(button).toBeDisabled();

      release();
      const link = await within(rowOf(table, 'Ana Souza')).findByRole('link', {
        name: 'Abrir exame de Ana Souza',
      });
      expect(link).toHaveAttribute('href', `/dia-do-exame/${OPEN}/alunos/${ANA}`);
      await waitFor(() => {
        expect(link).toHaveFocus();
      });
      expect(screen.getByRole('status')).toHaveTextContent('Presença de Ana Souza confirmada.');
      expect(filterRadio(/^Presentes \(2\)$/)).toBeInTheDocument();
      expect(await posts[0]!.json()).toEqual({ student_id: ANA });
      expect(db.exams.some((exam) => exam.event_id === OPEN && exam.student_id === ANA)).toBe(true);
    });

    it('rn005 sends a single request on a double click', async () => {
      const posts = recordRequests('post', OPEN_EXAMS_URL);
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });
      await user.dblClick(
        within(rowOf(table, 'Carla Mendes')).getByRole('button', { name: /Confirmar presença/ }),
      );
      await within(rowOf(table, 'Carla Mendes')).findByRole('link', { name: /Abrir exame/ });
      expect(posts).toHaveLength(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each([
      [400, 'Idade mínima para a faixa Cinza/Azul: 6 anos'],
      [400, 'Evento encerrado'],
      [409, 'Outra confirmação está em andamento. Tente de novo.'],
      [409, 'Os dados do aluno mudaram. Tente de novo.'],
      [404, 'Aluno não encontrado'],
    ])('rn005 shows the API message (%i %s) and keeps the list', async (status, message) => {
      server.use(
        http.post(OPEN_EXAMS_URL, () => HttpResponse.json({ message }, { status }), {
          once: true,
        }),
      );
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });
      await user.click(
        within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
      );

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível confirmar a presença de Ana Souza');
      expect(alert).toHaveTextContent(message);
      expect(screen.getByRole('table', { name: LIST })).toBeInTheDocument();
      const button = within(
        rowOf(screen.getByRole('table', { name: LIST }), 'Ana Souza'),
      ).getByRole('button', { name: /Confirmar presença/ });
      expect(button).toBeEnabled();

      // A new attempt clears the message.
      await user.click(button);
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
    });

    it('rn005 only reloads the list when another examiner confirmed first (409)', async () => {
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });
      // Another examiner, on another device, confirms Ana in the meantime.
      const auth = createMockAuth(null);
      await auth.signIn({ email: 'outro@example.com', password: 'senha-teste', role: 'examiner' });
      const other = createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
      await confirmAttendance(other, OPEN, ANA);

      await user.click(
        within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
      );
      expect(
        await within(rowOf(table, 'Ana Souza')).findByRole('link', { name: /Abrir exame/ }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('rn016 reloads the event when the API says it was closed', async () => {
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });
      db.events = db.events.map((event) =>
        event.id === OPEN ? { ...event, status: 'CLOSED' } : event,
      );
      await user.click(
        within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent('Evento encerrado');
      expect(await screen.findByRole('note')).toHaveTextContent('Evento encerrado');
      expect(screen.queryByRole('button', { name: /Confirmar presença/ })).not.toBeInTheDocument();
    });

    it('ends the session on 401, like the other screens', async () => {
      server.use(
        http.post(OPEN_EXAMS_URL, () =>
          HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
        ),
      );
      const { user, router } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });
      await user.click(
        within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
      );
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/entrar');
      });
    });

    it('confirms from a card on the phone', async () => {
      setViewportWidth(390);
      const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const list = await screen.findByRole('list', { name: LIST });
      const card = within(list)
        .getAllByRole('listitem')
        .find((item) => item.textContent.includes('Carla Mendes'))!;
      await user.click(within(card).getByRole('button', { name: /Confirmar presença/ }));
      expect(
        await within(card).findByRole('link', { name: 'Abrir exame de Carla Mendes' }),
      ).toBeInTheDocument();
    });
  });

  describe('closed event (RN016)', () => {
    it('rn016 takes no attendance and says the event is closed', async () => {
      await renderApp({ route: `${ROUTE}?evento=${CLOSED}`, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });

      expect(screen.getByRole('note')).toHaveTextContent(
        'Evento encerradoA presença não pode mais ser confirmada neste evento.',
      );
      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((header) => header.textContent),
      ).toEqual(['Aluno', 'Idade', 'Faixa atual', 'Próximo exame', 'Situação', 'Ação']);
      expect(within(table).queryAllByRole('button')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: /Confirmar presença/ })).not.toBeInTheDocument();
      // Eligible students without exam get no action.
      expect(within(rowOf(table, 'Ana Souza')).queryByRole('link')).not.toBeInTheDocument();
      // Who attended is still written out, with the result.
      expect(within(rowOf(table, 'Gabriel Costa')).getByText('Presente · Aprovado')).toBeVisible();
      expect(filterRadio(/^Presentes \(1\)$/)).toBeInTheDocument();
    });

    it('rn008a keeps "Abrir exame" for the present students of a closed event', async () => {
      await renderApp({ route: `${ROUTE}?evento=${CLOSED}`, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });

      const links = within(table).getAllByRole('link');
      expect(links.map((link) => link.textContent)).toEqual(['Abrir exame']);
      expect(
        within(rowOf(table, 'Gabriel Costa')).getByRole('link', {
          name: 'Abrir exame de Gabriel Costa',
        }),
      ).toHaveAttribute('href', examPath(CLOSED, GABRIEL));
    });

    it('rn008a shows cards with only "Abrir exame" on the phone', async () => {
      setViewportWidth(390);
      await renderApp({ route: `${ROUTE}?evento=${CLOSED}`, signedInAs: 'examiner' });
      const list = await screen.findByRole('list', { name: LIST });
      expect(within(list).queryAllByRole('button')).toHaveLength(0);
      expect(
        within(list)
          .getAllByRole('link')
          .map((link) => link.getAttribute('href')),
      ).toEqual([examPath(CLOSED, GABRIEL)]);
      expect(screen.getByRole('note')).toHaveTextContent('Evento encerrado');
    });
  });

  describe('privacy (LGPD)', () => {
    it('keeps student data out of the URL, the storage and the console', async () => {
      const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
      );
      const { user, router } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      const table = await screen.findByRole('table', { name: LIST });
      await user.type(screen.getByRole('searchbox', { name: 'Buscar por nome' }), 'Ana');
      await user.click(
        within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
      );
      await within(rowOf(table, 'Ana Souza')).findByRole('link', { name: /Abrir exame/ });

      const url = `${router.state.location.pathname}${router.state.location.search}`;
      expect(url).not.toMatch(/ana/i);
      const stored = [window.localStorage, window.sessionStorage]
        .flatMap((storage) => Object.keys(storage).map((key) => storage.getItem(key) ?? ''))
        .join(' ');
      expect(stored).not.toContain('Ana Souza');
      for (const spy of logs) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain('Ana Souza');
        spy.mockRestore();
      }
    });
  });
});
