import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudentView } from '../../../src/api/types';
import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const STUDENTS_URL = `${TEST_API_URL}/students`;

/** Every case of § 6.2, as the simulated API answers on 02/11/2026 (ages by the API). */
const EXAMINER_ROWS = [
  ['Ana Souza', 'Cinza', '8 anos', '14/03/2026', 'Faixa Cinza/Azul', 'Elegível'],
  [
    'Bruno Souza',
    'Azul',
    '7 anos',
    '01/11/2025',
    'Faixa Azul/Amarela',
    'Bloqueado: Idade mínima para a faixa Azul/Amarela: 8 anos',
  ],
  ['Carla Mendes', 'Laranja', '14 anos', '10/09/2025', 'Grau (rumo à Verde)', 'Elegível'],
  [
    'Davi Oliveira',
    'Branca',
    '10 anos',
    '01/09/2026',
    'Faixa Branca/Cinza',
    'Bloqueado: Carência mínima de 3 meses na faixa atual (faltam 1)',
  ],
  ['Élida Ramos', 'Verde · 1 grau', '16 anos', '20/05/2024', 'Faixa Roxa', 'Inativo'],
  [
    'Fábio Lima',
    'Marrom · 3 graus',
    '18 anos',
    '10/02/2024',
    '—',
    'Bloqueado: Faixa preta é exame da federação',
  ],
  [
    'Gabriel Costa',
    'Amarela/Laranja · 2 graus',
    '8 anos',
    '01/03/2026',
    'Faixa Laranja',
    'Bloqueado: Idade mínima para a faixa Laranja: 11 anos; Carência mínima de 12 meses na faixa atual (faltam 4)',
  ],
  ['Helena Prado', 'Roxa · 4 graus', '15 anos', '30/06/2025', 'Faixa Marrom', 'Elegível'],
];

const CARD_LABELS = ['Faixa atual', 'Idade', 'Na faixa desde', 'Próximo exame', 'Situação'];

function installShowcaseApi() {
  server.use(
    ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
  );
}

/** Records every `GET /students` and lets the simulated API answer it. */
function recordStudentRequests(): Request[] {
  const requests: Request[] = [];
  server.use(
    http.get(STUDENTS_URL, ({ request }) => {
      requests.push(request.clone());
      return undefined;
    }),
  );
  return requests;
}

function tableRows(table: HTMLElement): string[][] {
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent.trim()),
  );
}

function statusTexts(text: string): HTMLElement[] {
  return screen.getAllByText(text, { selector: 'span' });
}

describe('students list (§ 6.2)', () => {
  beforeEach(() => {
    // Fixed "today" for the ages the simulated API computes; timers stay real.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    installShowcaseApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a labelled loading state while the API answers', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(STUDENTS_URL, async () => {
        await gate;
        return HttpResponse.json([]);
      }),
    );
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando alunos…');
    release();
    expect(await screen.findByText('Nenhum aluno cadastrado.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the API error and reloads with "Tentar de novo"', async () => {
    server.use(
      http.get(
        STUDENTS_URL,
        () => HttpResponse.json({ message: 'Erro no servidor. Tente de novo.' }, { status: 500 }),
        { once: true },
      ),
    );
    // Registered last, so it runs first and sees both calls.
    const requests = recordStudentRequests();
    const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar os alunos');
    expect(alert).toHaveTextContent('Erro no servidor. Tente de novo.');

    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('table', { name: 'Alunos' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(requests).toHaveLength(2);
  });

  it('shows the no-permission message without a retry on 403', async () => {
    server.use(
      http.get(STUDENTS_URL, () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })),
    );
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Você não tem permissão para esta ação.');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says there is no student when the list is empty', async () => {
    server.use(http.get(STUDENTS_URL, () => HttpResponse.json([])));
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    expect(await screen.findByText('Nenhum aluno cadastrado.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /novo aluno/i })).not.toBeInTheDocument();
  });

  it.each([1280, 768])('shows a table with column and row headers at %i px', async (width) => {
    setViewportWidth(width);
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos' });

    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((header) => header.textContent)).toEqual([
      'Nome',
      'Faixa atual',
      'Idade',
      'Na faixa desde',
      'Próximo exame',
      'Situação',
    ]);
    for (const header of headers) expect(header).toHaveAttribute('scope', 'col');
    const rowHeaders = within(table).getAllByRole('rowheader');
    expect(rowHeaders[0]).toHaveTextContent('Ana Souza');
    expect(rowHeaders[0]).toHaveAttribute('scope', 'row');
    expect(screen.queryByRole('list', { name: 'Alunos' })).not.toBeInTheDocument();
  });

  it('rn001 rn004 lists every situation and next exam the API computed', async () => {
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(tableRows(table)).toEqual(EXAMINER_ROWS);
  });

  it('rn001 rn004 shows the API eligibility as is, without recalculating it', async () => {
    // A 3-year-old with no time on the belt would be blocked; the API says eligible.
    const view: StudentView = {
      id: 'aluno-1',
      owner_id: 'mock-examiner',
      full_name: 'Teste Sem Regra',
      birth_date: '2023-10-01',
      current_belt_id: '312a6c3e-04d8-51cc-a3b0-0dfec1701953',
      current_belt_since: '2026-11-01',
      stripes: 0,
      federation_id: null,
      active: true,
      created_at: '2026-11-01T12:00:00+00:00',
      updated_at: null,
      current_belt_name: 'Cinza',
      age: 3,
      eligibility: {
        eligible: true,
        kind: 'STRIPE',
        target_belt_id: 'x',
        target_belt_name: 'Azul',
        reasons: [],
      },
    };
    server.use(http.get(STUDENTS_URL, () => HttpResponse.json([view])));
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(tableRows(table)).toEqual([
      ['Teste Sem Regra', 'Cinza', '3 anos', '01/11/2026', 'Grau (rumo à Azul)', 'Elegível'],
    ]);
  });

  it('writes the blocked state in the error color, with text and icon', async () => {
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await screen.findByRole('table', { name: 'Alunos' });

    const [blocked] = statusTexts('Bloqueado: Faixa preta é exame da federação');
    expect(blocked!.getAttribute('style')).toContain('var(--mantine-color-error)');
    const status = blocked!.closest('[data-status]');
    expect(status).toHaveAttribute('data-status', 'blocked');
    expect(status?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const eligible = statusTexts('Elegível')[0]!.closest('[data-status]');
    expect(eligible?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(statusTexts('Inativo')[0]!.getAttribute('style') ?? '').not.toContain(
      'var(--mantine-color-error)',
    );
  });

  it('draws a decorative, bordered belt color sample', async () => {
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    const davi = within(table).getByRole('rowheader', { name: 'Davi Oliveira' }).closest('tr')!;
    const swatch = await within(davi).findByTestId('belt-swatch');
    expect(swatch).toHaveAttribute('aria-hidden', 'true');
    // White belt on a white page: the border keeps it visible.
    expect(swatch.getAttribute('style')).toContain('border: 1px solid var(--mantine-color-dimmed)');
    expect(within(davi).getAllByRole('cell')[0]).toHaveTextContent(/^Branca$/);
  });

  it.each([390, 640])(
    'shows a list of cards with the same data at %i px (phone, 200%% zoom)',
    async (width) => {
      setViewportWidth(width);
      await renderApp({ route: '/alunos', signedInAs: 'examiner' });
      const list = await screen.findByRole('list', { name: 'Alunos' });
      expect(screen.queryByRole('table')).not.toBeInTheDocument();

      const cards = within(list).getAllByRole('listitem');
      expect(cards).toHaveLength(EXAMINER_ROWS.length);
      cards.forEach((card, index) => {
        const [name, ...values] = EXAMINER_ROWS[index]!;
        expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(name!);
        const terms = Array.from(card.querySelectorAll('dt')).map((dt) => dt.textContent);
        const details = Array.from(card.querySelectorAll('dd')).map((dd) => dd.textContent.trim());
        expect(terms).toEqual(CARD_LABELS);
        expect(details).toEqual(values);
      });
    },
  );

  it('asks GET /students without owner filter and shows every student to examiners', async () => {
    const requests = recordStudentRequests();
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(within(table).getAllByRole('rowheader')).toHaveLength(8);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).search).toBe('');
  });

  it('shows guardians the students the API returns for them', async () => {
    const requests = recordStudentRequests();
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Ana Souza', 'Bruno Souza', 'Gabriel Costa']);
    expect(new URL(requests[0]!.url).search).toBe('');
    expect(requests[0]!.headers.get('Authorization')).toMatch(/^Bearer /);
  });

  it('does not filter by owner on the screen: it shows whatever the API sends', async () => {
    const examinerOwned = createMockDb({ includeShowcase: true }).students.find(
      (item) => item.student.full_name === 'Helena Prado',
    )!;
    const view: StudentView = {
      ...examinerOwned.student,
      current_belt_name: 'Roxa',
      age: 15,
      eligibility: examinerOwned.eligibility,
    };
    server.use(http.get(STUDENTS_URL, () => HttpResponse.json([view])));
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(within(table).getByRole('rowheader')).toHaveTextContent('Helena Prado');
  });
});
