/**
 * Recent writes laid over the reads of `GET /requirements` (§ 6.5, RN017, #25): the `by_belt`
 * GSI may answer the list from before a write the API has confirmed, and that late read must
 * not undo the write while it is recent (`RECENT_WRITE_WINDOW_MS`).
 */
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useDeleteRequirement,
  useRequirements,
  useUpdateRequirement,
} from '../../../src/api/queries';
import {
  RECENT_WRITE_WINDOW_MS,
  forgetRecentRequirementWrites,
  overlayRecentWrites,
  recordRequirementWrite,
} from '../../../src/api/recentRequirementWrites';
import type { Requirement } from '../../../src/api/types';
import { AppProviders } from '../../../src/app/AppProviders';
import { createMockAuth } from '../../../src/auth/mockAuth';
import { createMockDb, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';

const CINZA = mockBelts.find((belt) => belt.name === 'Cinza')!.id;
const AZUL = mockBelts.find((belt) => belt.name === 'Azul')!.id;
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

function item(id: string, overrides: Partial<Requirement> = {}): Requirement {
  return {
    id,
    belt_id: CINZA,
    kind: 'PRACTICE',
    category: 'Naguewaza',
    description: `Item ${id}`,
    expected_answer: null,
    sort_order: 1,
    ...overrides,
  };
}

function ids(items: readonly Requirement[]): string[] {
  return items.map((candidate) => candidate.id);
}

describe('overlayRecentWrites', () => {
  const cinza = { belt_id: CINZA };
  const read = [item('a', { sort_order: 1 }), item('b', { sort_order: 2 })];

  it('a deleted id leaves the read and a created item enters in sheet order', () => {
    const queryClient = new QueryClient();
    recordRequirementWrite(queryClient, 'a', null, T0);
    recordRequirementWrite(queryClient, 'c', item('c', { sort_order: 0 }), T0);

    expect(ids(overlayRecentWrites(queryClient, cinza, read, T0 + 1))).toEqual(['c', 'b']);
  });

  it('the write stops counting once the window is over', () => {
    const queryClient = new QueryClient();
    recordRequirementWrite(queryClient, 'a', null, T0);

    const justBefore = T0 + RECENT_WRITE_WINDOW_MS - 1;
    expect(ids(overlayRecentWrites(queryClient, cinza, read, justBefore))).toEqual(['b']);
    const atTheEnd = T0 + RECENT_WRITE_WINDOW_MS;
    expect(ids(overlayRecentWrites(queryClient, cinza, read, atTheEnd))).toEqual(['a', 'b']);
  });

  it('the window follows the clock when no instant is passed', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    try {
      const queryClient = new QueryClient();
      recordRequirementWrite(queryClient, 'a', null);
      vi.setSystemTime(T0 + RECENT_WRITE_WINDOW_MS - 1);
      expect(ids(overlayRecentWrites(queryClient, cinza, read))).toEqual(['b']);
      vi.setSystemTime(T0 + RECENT_WRITE_WINDOW_MS);
      expect(ids(overlayRecentWrites(queryClient, cinza, read))).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the newer write of an id prevails over the older one', () => {
    const queryClient = new QueryClient();
    recordRequirementWrite(queryClient, 'a', item('a', { description: 'Primeira' }), T0);
    recordRequirementWrite(queryClient, 'a', item('a', { description: 'Segunda' }), T0 + 10);
    expect(overlayRecentWrites(queryClient, cinza, read, T0 + 20)[0]?.description).toBe('Segunda');

    recordRequirementWrite(queryClient, 'a', null, T0 + 30);
    expect(ids(overlayRecentWrites(queryClient, cinza, read, T0 + 40))).toEqual(['b']);
  });

  it('an item moved to another belt or kind leaves the old list and enters the new one', () => {
    const queryClient = new QueryClient();
    recordRequirementWrite(queryClient, 'a', item('a', { belt_id: AZUL }), T0);
    recordRequirementWrite(queryClient, 'b', item('b', { kind: 'THEORY' }), T0);

    expect(ids(overlayRecentWrites(queryClient, cinza, read, T0 + 1))).toEqual(['b']);
    expect(
      ids(overlayRecentWrites(queryClient, { belt_id: CINZA, kind: 'PRACTICE' }, read, T0 + 1)),
    ).toEqual([]);
    expect(ids(overlayRecentWrites(queryClient, { belt_id: AZUL }, [], T0 + 1))).toEqual(['a']);
  });

  it('a list without a belt filter only gets replacements and removals, in its own order', () => {
    const queryClient = new QueryClient();
    const all = [item('z', { belt_id: AZUL, sort_order: 9 }), ...read];
    recordRequirementWrite(queryClient, 'z', item('z', { belt_id: AZUL, description: 'Nova' }), T0);
    recordRequirementWrite(queryClient, 'a', null, T0);
    recordRequirementWrite(queryClient, 'n', item('n'), T0);

    const result = overlayRecentWrites(queryClient, {}, all, T0 + 1);
    expect(ids(result)).toEqual(['z', 'b']);
    expect(result[0]?.description).toBe('Nova');
  });

  it('the writes of one QueryClient do not reach another, and are forgotten at sign out', () => {
    const first = new QueryClient();
    const second = new QueryClient();
    recordRequirementWrite(first, 'a', null, T0);

    expect(ids(overlayRecentWrites(second, cinza, read, T0 + 1))).toEqual(['a', 'b']);
    expect(ids(overlayRecentWrites(first, cinza, read, T0 + 1))).toEqual(['b']);

    forgetRecentRequirementWrites(first);
    expect(ids(overlayRecentWrites(first, cinza, read, T0 + 1))).toEqual(['a', 'b']);
  });
});

/** Branca/Cinza has items in the mock data; Cinza starts empty. */
const BRANCA_CINZA = mockBelts.find((belt) => belt.name === 'Branca/Cinza')!.id;

let db: MockDb;
/** What the GSI still shows: the requirements as they were before the writes. */
let indexSnapshot: Requirement[] | null;

async function renderHooks() {
  const auth = createMockAuth(null);
  await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role: 'examiner' });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
      {children}
    </AppProviders>
  );
  const hooks = renderHook(
    () => ({
      source: useRequirements({ belt_id: BRANCA_CINZA }),
      target: useRequirements({ belt_id: CINZA }),
      update: useUpdateRequirement(),
      remove: useDeleteRequirement(),
    }),
    { wrapper },
  );
  await waitFor(() => {
    expect(hooks.result.current.source.isSuccess).toBe(true);
    expect(hooks.result.current.target.isSuccess).toBe(true);
  });
  return { ...hooks, queryClient };
}

async function settled(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
    expect(queryClient.isMutating()).toBe(0);
  });
}

describe('requirements lists with a late GSI after a write (§ 6.5, RN017)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    indexSnapshot = null;
    server.use(
      http.get(`${TEST_API_URL}/requirements`, ({ request }) => {
        if (indexSnapshot === null) return undefined;
        const belt = new URL(request.url).searchParams.get('belt_id');
        return HttpResponse.json(
          indexSnapshot
            .filter((candidate) => candidate.belt_id === belt)
            .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1)),
        );
      }),
    );
  });

  afterEach(() => {
    indexSnapshot = null;
  });

  it('rn017 an item moved to another belt leaves the old list even with a late read', async () => {
    const { result, queryClient } = await renderHooks();
    const moved = result.current.source.data![0]!;
    indexSnapshot = db.requirements.map((candidate) => ({ ...candidate }));

    await act(async () => {
      await result.current.update.mutateAsync({
        id: moved.id,
        input: { ...moved, belt_id: CINZA },
      });
    });
    await settled(queryClient);

    expect(ids(result.current.source.data!)).not.toContain(moved.id);
    expect(ids(result.current.target.data!)).toContain(moved.id);
  });

  it('rn017 an item gone with a 404 does not come back with a late read', async () => {
    const { result, queryClient } = await renderHooks();
    const gone = result.current.source.data![0]!;
    indexSnapshot = db.requirements.map((candidate) => ({ ...candidate }));
    // Another examiner deleted it; the GSI still shows it.
    db.requirements = db.requirements.filter((candidate) => candidate.id !== gone.id);

    await act(async () => {
      await expect(result.current.remove.mutateAsync(gone.id)).rejects.toThrow(
        'Requisito não encontrado',
      );
    });
    await settled(queryClient);

    expect(ids(result.current.source.data!)).not.toContain(gone.id);
  });
});
