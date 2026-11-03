/**
 * § 6.4: the exam reloads when the window gets the focus back (two examiners on the same
 * exam). The query asks for it itself, so it holds even if the app default changes.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useExamSheet } from '../../../src/api/queries';
import { AppProviders } from '../../../src/app/AppProviders';
import { createMockAuth } from '../../../src/auth/mockAuth';
import {
  MOCK_EVENT_IDS,
  createMockDb,
  mockRequirementId,
  type MockDb,
} from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

let db: MockDb;

describe('useExamSheet', () => {
  beforeEach(() => {
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('reloads on window focus even when the app default does not', async () => {
    const auth = createMockAuth(null);
    await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role: 'examiner' });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
        {children}
      </AppProviders>
    );
    const { result } = renderHook(() => useExamSheet(MOCK_EVENT_IDS.open, HELENA), { wrapper });
    await waitFor(() => {
      expect(result.current.data?.summary.THEORY.percent).toBe(33.3);
    });

    const exam = db.exams.find((item) => item.student_id === HELENA)!;
    db.answers.push({
      exam_id: exam.id,
      requirement_id: mockRequirementId('Marrom', 6),
      correct: true,
      marked_by: 'mock-examiner-2',
      marked_at: '2026-11-21T13:40:00+00:00',
    });
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => {
      expect(result.current.data?.summary.THEORY.percent).toBe(66.7);
    });
  });
});
