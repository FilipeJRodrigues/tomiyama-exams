/**
 * After creating, editing or deleting an item, the requirements lists and the exam sheets in
 * cache reload: the sheet of § 6.4 and its RN007 totals come from the requirements.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  useCreateRequirement,
  useDeleteRequirement,
  useExamSheet,
  useRequirements,
  useUpdateRequirement,
} from '../../../src/api/queries';
import { AppProviders } from '../../../src/app/AppProviders';
import { createMockAuth } from '../../../src/auth/mockAuth';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockBelts,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';

/** Helena's exam, in progress at the open event, targets Marrom. */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const MARROM = mockBelts.find((belt) => belt.name === 'Marrom')!.id;

let db: MockDb;

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
  return renderHook(
    () => ({
      sheet: useExamSheet(MOCK_EVENT_IDS.open, HELENA),
      practice: useRequirements({ belt_id: MARROM, kind: 'PRACTICE' }),
      create: useCreateRequirement(),
      update: useUpdateRequirement(),
      remove: useDeleteRequirement(),
    }),
    { wrapper },
  );
}

describe('requirements cache (§ 6.5 → § 6.4)', () => {
  beforeEach(() => {
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('a created item shows in the list and in the open exam sheet', async () => {
    const { result } = await renderHooks();
    await waitFor(() => {
      expect(result.current.sheet.data?.summary.PRACTICE.total).toBe(4);
    });
    expect(result.current.practice.data).toHaveLength(4);

    await act(async () => {
      await result.current.create.mutateAsync({
        belt_id: MARROM,
        kind: 'PRACTICE',
        category: 'Naguewaza',
        description: 'Harai goshi',
        expected_answer: null,
      });
    });
    // At once in the list of its belt and kind, at the end of the sheet.
    expect(result.current.practice.data?.at(-1)?.description).toBe('Harai goshi');
    await waitFor(() => {
      expect(result.current.sheet.data?.summary.PRACTICE.total).toBe(5);
    });
  });

  it('an item moved to the other kind leaves the list, and a deleted one leaves the sheet', async () => {
    const { result } = await renderHooks();
    await waitFor(() => {
      expect(result.current.practice.data).toHaveLength(4);
    });
    const osoto = mockRequirementId('Marrom', 4);
    const item = result.current.practice.data!.find((candidate) => candidate.id === osoto)!;

    await act(async () => {
      await result.current.update.mutateAsync({
        id: osoto,
        input: { ...item, kind: 'THEORY' },
      });
    });
    expect(result.current.practice.data?.map((candidate) => candidate.id)).not.toContain(osoto);
    await waitFor(() => {
      expect(result.current.sheet.data?.summary.THEORY.total).toBe(4);
    });

    await act(async () => {
      await result.current.remove.mutateAsync(osoto);
    });
    await waitFor(() => {
      expect(result.current.sheet.data?.items.map((candidate) => candidate.id)).not.toContain(
        osoto,
      );
    });
    expect(db.requirements.some((candidate) => candidate.id === osoto)).toBe(false);
  });
});
