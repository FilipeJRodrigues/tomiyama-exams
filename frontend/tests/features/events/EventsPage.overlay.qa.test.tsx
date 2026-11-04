/**
 * Tela "Eventos" (§ 6.5, RN016, #25) com o `Scan` de `GET /events` atrasado de verdade: depois
 * de uma gravação, toda leitura da lista (a recarga em voo, a recarga pedida pela gravação, as
 * recargas por foco e a do Dia do exame) ainda devolve a lista de antes. Só a sobreposição das
 * gravações recentes (`recentEventWrites`) mantém na tela, e no seletor do Dia do exame (§ 6.3),
 * o que a API confirmou.
 *
 * Sem corrida de tempo: as leituras seguradas só respondem quando o teste manda, o relógio da
 * janela de 30 s é controlado (`vi.useFakeTimers`, só `Date`) e toda espera é por estado.
 */
import { QueryClient, focusManager } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RECENT_WRITE_WINDOW_MS } from '../../../src/api/recentWrites';
import type { ExamEvent } from '../../../src/api/types';
import { AppProviders } from '../../../src/app/AppProviders';
import { createQueryClient } from '../../../src/app/queryClient';
import { createRoutes } from '../../../src/app/routes';
import { createMockAuth } from '../../../src/auth/mockAuth';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import {
  EVENTS_URL,
  field,
  makeEvent,
  recordRequests,
  replaceText,
  rowNames,
  statusSelect,
  tableRows,
  writes,
} from './helpers';

const FREE_ID = 'evento-sem-exames';
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

let db: MockDb;
/** What the late `Scan` still answers (the events before the writes); `null` = up to date. */
let scan: ExamEvent[] | null;
/** The next list read is held until `release()`. */
let holdNext: boolean;
let release: (() => void) | null;
/** List reads that reached the mock. */
let reads: number;

function lagScan() {
  scan = db.events.map((event) => ({ ...event }));
}

type User = ReturnType<typeof userEvent.setup>;

async function openScreen(route = '/eventos') {
  const auth = createMockAuth(window.sessionStorage);
  await auth.signIn({ email: 'examiner@example.com', password: 'senha-teste', role: 'examiner' });
  const queryClient: QueryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: true } });
  const router = createMemoryRouter(createRoutes({ useMocks: true }), {
    initialEntries: [route],
  });
  const user = userEvent.setup({ delay: null });
  render(
    <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  if (route.startsWith('/eventos')) await screen.findByRole('table', { name: 'Eventos' });
  return { user, queryClient, router };
}

/**
 * No request in flight, and the screen rendered what reached the cache (TanStack notifies the
 * observers in a `setTimeout(0)`; one more turn of the timer queue lets that render happen).
 */
async function settled(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
    expect(queryClient.isMutating()).toBe(0);
  });
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
}

/** The window gets the focus back: the list reloads (from the late `Scan`, if lagging). */
async function refocus(queryClient: QueryClient) {
  const before = reads;
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => {
    expect(reads).toBeGreaterThan(before);
  });
  await settled(queryClient);
}

/** Same, but the reload is held on its way until `release()`. */
async function refocusHeld() {
  holdNext = true;
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => {
    expect(release).not.toBeNull();
  });
}

async function noDialog() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

async function createEvent(
  user: User,
  values: { name: string; date: string; status?: 'Aberto' | 'Encerrado' },
) {
  await user.click(screen.getByRole('button', { name: 'Novo evento' }));
  const dialog = await screen.findByRole('dialog', { name: 'Novo evento' });
  await replaceText(user, field(dialog, /^Nome/), values.name);
  await user.type(field(dialog, /^Data do exame/), values.date);
  if (values.status) await user.selectOptions(statusSelect(dialog), values.status);
  return dialog;
}

async function editEvent(
  user: User,
  name: string,
  values: { name?: string; status?: 'Aberto' | 'Encerrado' },
) {
  await user.click(screen.getByRole('button', { name: `Editar evento ${name}` }));
  const dialog = await screen.findByRole('dialog', { name: 'Editar evento' });
  if (values.name !== undefined) await replaceText(user, field(dialog, /^Nome/), values.name);
  if (values.status) await user.selectOptions(statusSelect(dialog), values.status);
  return dialog;
}

async function deleteEvent(user: User, name: string) {
  await user.click(screen.getByRole('button', { name: `Excluir evento ${name}` }));
  const dialog = await screen.findByRole('dialog', { name: 'Excluir evento' });
  await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
  return dialog;
}

async function goTo(user: User, queryClient: QueryClient, link: 'Dia do exame' | 'Eventos') {
  await user.click(screen.getByRole('link', { name: link }));
  if (link === 'Eventos') await screen.findByRole('table', { name: 'Eventos' });
  else await screen.findByRole('heading', { level: 1, name: 'Dia do exame' });
  await settled(queryClient);
}

/** What the § 6.3 picker shows, and its options. */
function picker() {
  const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Evento' });
  const options = Array.from(select.options)
    .filter((option) => !option.disabled)
    .map((option) => option.text);
  const chosen = select.selectedOptions[0]?.text ?? '';
  return { chosen, options };
}

describe('Eventos com o Scan atrasado: sobreposição das gravações recentes (§ 6.5, RN016)', () => {
  beforeEach(() => {
    db = createMockDb();
    db.events.push(
      makeEvent(FREE_ID, {
        name: 'Exame cancelado',
        exam_date: '2026-08-15',
        created_at: '2026-07-01T12:00:00+00:00',
      }),
    );
    scan = null;
    holdNext = false;
    release = null;
    reads = 0;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    server.use(
      http.get(EVENTS_URL, async () => {
        reads += 1;
        const held = holdNext;
        holdNext = false;
        if (scan === null && !held) return undefined;
        // A held read answers what the table had when it was asked.
        const answer = (scan ?? db.events).map((event) => ({ ...event }));
        if (held) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return HttpResponse.json<ExamEvent[]>(answer);
      }),
    );
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('rn016 recarga em voo + Scan atrasado: o evento criado fica, também nas recargas seguintes', async () => {
    const { user, queryClient } = await openScreen();
    lagScan();

    const dialog = await createEvent(user, { name: 'Exame junho/2027', date: '2027-06-20' });
    await refocusHeld();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Evento criado.');

    release?.();
    await settled(queryClient);
    expect(rowNames()).toEqual([
      'Exame junho/2027',
      'Exame novembro/2026',
      'Exame cancelado',
      'Exame março/2026',
    ]);

    await refocus(queryClient);
    expect(rowNames()[0]).toBe('Exame junho/2027');
    expect(rowNames()).toHaveLength(4);
  });

  it('rn016 recarga em voo + Scan atrasado: a edição (nome e situação) fica', async () => {
    const { user, queryClient } = await openScreen();
    lagScan();

    const dialog = await editEvent(user, 'Exame novembro/2026', {
      name: 'Exame de novembro',
      status: 'Encerrado',
    });
    await refocusHeld();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Evento salvo.');

    release?.();
    await settled(queryClient);
    await refocus(queryClient);
    expect(tableRows()[0]).toEqual([
      'Exame de novembro',
      '21/11/2026',
      'Encerrado',
      'EditarExcluir',
    ]);
    expect(rowNames()).not.toContain('Exame novembro/2026');
  });

  it('rn016 recarga em voo + Scan atrasado: o evento excluído não volta', async () => {
    const { user, queryClient } = await openScreen();
    lagScan();

    await user.click(screen.getByRole('button', { name: 'Excluir evento Exame cancelado' }));
    const dialog = await screen.findByRole('dialog', { name: 'Excluir evento' });
    await refocusHeld();
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Evento excluído.');

    release?.();
    await settled(queryClient);
    await refocus(queryClient);
    expect(rowNames()).toEqual(['Exame novembro/2026', 'Exame março/2026']);
  });

  it('rn016 404 "Evento não encontrado" ao editar, com o Scan ainda trazendo o evento: ele sai e não volta', async () => {
    const { user, queryClient } = await openScreen();
    // Another examiner deleted it; the Scan has not caught up.
    lagScan();
    db.events = db.events.filter((event) => event.id !== FREE_ID);

    const dialog = await editEvent(user, 'Exame cancelado', { name: 'Exame recuperado' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Evento não encontrado');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await noDialog();

    await settled(queryClient);
    await refocus(queryClient);
    expect(rowNames()).toEqual(['Exame novembro/2026', 'Exame março/2026']);
  });

  it('rn016 404 de outra origem (API Gateway "Not Found") não tira o evento da lista', async () => {
    const { user, queryClient } = await openScreen();
    server.use(
      http.put(`${EVENTS_URL}/:id`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
      http.delete(`${EVENTS_URL}/:id`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );

    const editDialog = await editEvent(user, 'Exame cancelado', { name: 'Outro nome' });
    await user.click(within(editDialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(editDialog).findByRole('alert')).toHaveTextContent(
      'Recurso não encontrado.',
    );
    await user.click(within(editDialog).getByRole('button', { name: 'Cancelar' }));
    await noDialog();

    const deleteDialog = await deleteEvent(user, 'Exame cancelado');
    expect(await within(deleteDialog).findByRole('alert')).toHaveTextContent(
      'Recurso não encontrado.',
    );
    await user.click(within(deleteDialog).getByRole('button', { name: 'Cancelar' }));
    await noDialog();

    await settled(queryClient);
    await refocus(queryClient);
    expect(rowNames()).toEqual(['Exame novembro/2026', 'Exame cancelado', 'Exame março/2026']);
  });

  it('rn016 a janela é de 30 s: até lá vale a gravação; depois, o que a API devolve', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const { user, queryClient } = await openScreen();

    const dialog = await editEvent(user, 'Exame cancelado', { name: 'Exame A' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await noDialog();
    await settled(queryClient);
    expect(rowNames()).toContain('Exame A');

    // Another examiner renames it right after; the Scan is up to date.
    const free = db.events.find((event) => event.id === FREE_ID)!;
    free.name = 'Exame B';

    vi.setSystemTime(T0 + RECENT_WRITE_WINDOW_MS - 1);
    await refocus(queryClient);
    expect(rowNames()).toContain('Exame A');
    expect(rowNames()).not.toContain('Exame B');

    vi.setSystemTime(T0 + RECENT_WRITE_WINDOW_MS);
    await refocus(queryClient);
    expect(rowNames()).toContain('Exame B');
    expect(rowNames()).not.toContain('Exame A');
  });

  it('rn016 Sair e entrar com outro examinador: a gravação do anterior não se sobrepõe à API', async () => {
    const { user, router, queryClient } = await openScreen();

    const dialog = await editEvent(user, 'Exame cancelado', { name: 'Exame X' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await noDialog();
    await settled(queryClient);
    // Right after, another examiner renames it back on the server.
    db.events.find((event) => event.id === FREE_ID)!.name = 'Exame cancelado';

    await user.click(screen.getByRole('button', { name: 'Sair' }));
    const email = await screen.findByLabelText(/^E-mail/);
    await replaceText(user, email, 'outro.examinador@example.com');
    await replaceText(user, screen.getByLabelText(/^Senha/), 'senha-teste');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Entrar' })).not.toBeInTheDocument();
    });
    await act(() => router.navigate('/eventos'));
    await screen.findByRole('table', { name: 'Eventos' });
    await settled(queryClient);

    expect(rowNames()).toContain('Exame cancelado');
    expect(rowNames()).not.toContain('Exame X');
  });

  it('rn016 duas edições seguidas do mesmo evento com o Scan atrasado: vale a mais nova', async () => {
    const { user, queryClient } = await openScreen();
    lagScan();

    let dialog = await editEvent(user, 'Exame cancelado', { name: 'Exame A' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await noDialog();
    dialog = await editEvent(user, 'Exame A', { name: 'Exame B', status: 'Encerrado' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await noDialog();
    await settled(queryClient);
    await refocus(queryClient);

    expect(tableRows()[1]).toEqual(['Exame B', '15/08/2026', 'Encerrado', 'EditarExcluir']);
    expect(rowNames()).not.toContain('Exame A');
  });
});

describe('Eventos e o Dia do exame com o Scan atrasado (§ 6.3, RN016)', () => {
  beforeEach(() => {
    db = createMockDb();
    scan = null;
    holdNext = false;
    release = null;
    reads = 0;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    server.use(
      http.get(EVENTS_URL, () => {
        reads += 1;
        return scan ? HttpResponse.json<ExamEvent[]>(scan.map((e) => ({ ...e }))) : undefined;
      }),
    );
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  it('rn016 criar, encerrar, reabrir e excluir: o seletor mostra sempre o evento aberto mais recente', async () => {
    const { user, queryClient } = await openScreen('/dia-do-exame');
    await screen.findByRole('combobox', { name: 'Evento' });
    await settled(queryClient);
    expect(picker().chosen).toBe('Exame novembro/2026 · 21/11/2026 · Aberto');

    await goTo(user, queryClient, 'Eventos');
    lagScan();
    const created = await createEvent(user, { name: 'Exame dezembro/2026', date: '2026-12-12' });
    await user.click(within(created).getByRole('button', { name: 'Salvar' }));
    await noDialog();

    await goTo(user, queryClient, 'Dia do exame');
    expect(picker().chosen).toBe('Exame dezembro/2026 · 12/12/2026 · Aberto');

    await goTo(user, queryClient, 'Eventos');
    let dialog = await editEvent(user, 'Exame dezembro/2026', { status: 'Encerrado' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await noDialog();
    await goTo(user, queryClient, 'Dia do exame');
    expect(picker().chosen).toBe('Exame novembro/2026 · 21/11/2026 · Aberto');
    expect(picker().options).toContain('Exame dezembro/2026 · 12/12/2026 · Encerrado');

    await goTo(user, queryClient, 'Eventos');
    dialog = await editEvent(user, 'Exame dezembro/2026', { status: 'Aberto' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await noDialog();
    await goTo(user, queryClient, 'Dia do exame');
    expect(picker().chosen).toBe('Exame dezembro/2026 · 12/12/2026 · Aberto');

    await goTo(user, queryClient, 'Eventos');
    await deleteEvent(user, 'Exame dezembro/2026');
    await noDialog();
    await goTo(user, queryClient, 'Dia do exame');
    expect(picker().chosen).toBe('Exame novembro/2026 · 21/11/2026 · Aberto');
    expect(picker().options.some((text) => text.startsWith('Exame dezembro/2026'))).toBe(false);
  });

  it('rn016 encerrar o evento escolhido no Dia do exame tira as ações da lista dele', async () => {
    const { user, queryClient, router } = await openScreen('/dia-do-exame');
    expect(
      (await screen.findAllByRole('button', { name: /^Confirmar presença/ })).length,
    ).toBeGreaterThan(0);
    await settled(queryClient);

    await goTo(user, queryClient, 'Eventos');
    lagScan();
    const dialog = await editEvent(user, 'Exame novembro/2026', { status: 'Encerrado' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await noDialog();

    await act(() => router.navigate(`/dia-do-exame?evento=${MOCK_EVENT_IDS.open}`));
    expect(await screen.findByRole('note')).toHaveTextContent('Evento encerrado');
    await settled(queryClient);
    expect(screen.queryByRole('button', { name: /^Confirmar presença/ })).not.toBeInTheDocument();
  });
});

describe('Eventos: envio duplo e campos (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    reads = 0;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('dois Enter seguidos no formulário novo enviam um só POST', async () => {
    const { user, queryClient } = await openScreen();
    const requests = recordRequests();
    const dialog = await createEvent(user, { name: 'Exame único', date: '2027-01-30' });
    const form = within(dialog).getByRole('form', { name: 'Novo evento' });
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await noDialog();
    await settled(queryClient);
    expect(writes(requests)).toHaveLength(1);
    expect(db.events.filter((event) => event.name === 'Exame único')).toHaveLength(1);
  });

  it('nome só com espaços não é enviado; nome com acento e espaços nas pontas vai aparado', async () => {
    const { user, queryClient } = await openScreen();
    const requests = recordRequests();
    const dialog = await createEvent(user, { name: '    ', date: '2027-01-30' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Informe o nome.')).toBeInTheDocument();
    expect(field(dialog, /^Nome/)).toHaveFocus();
    expect(writes(requests)).toHaveLength(0);

    await replaceText(user, field(dialog, /^Nome/), '  Exame de graduação – São João  ');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await noDialog();
    await settled(queryClient);
    expect(writes(requests)[0]?.body).toEqual({
      name: 'Exame de graduação – São João',
      exam_date: '2027-01-30',
      status: 'OPEN',
    });
    expect(rowNames()[0]).toBe('Exame de graduação – São João');
  });
});
