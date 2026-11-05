/**
 * `useRetryFocus` with `LoadError` (§ 6.7): the focus after "Tentar de novo" of a screen's
 * load. A real query whose reads the test answers by hand, and the real `LoadError`. The
 * screens' own cases are in `tests/regression/52-foco-perdido-tentar-de-novo-*.test.tsx`; here
 * is what they leave out: the first load and the background reloads never move the focus, the
 * focus waits for the end of the read, and one press moves it once.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError } from '../../../src/api/client';
import { LoadError } from '../../../src/features/students/screenStates';
import { useRetryFocus } from '../../../src/features/students/useRetryFocus';

const TITLE = 'Dados';
const ERROR_TITLE = 'Não foi possível carregar os dados';
const RETRY = 'Tentar de novo';
const ELSEWHERE = 'Outro lugar';
const DATA = 'Dados carregados';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

type Outcome = 'ok' | 'error';

/** Each read waits until `answer` says whether it brings the data or fails (503). */
function readsByHand() {
  const waiting: ((outcome: Outcome) => void)[] = [];
  let count = 0;
  return {
    read: async (): Promise<string> => {
      count += 1;
      const outcome = await new Promise<Outcome>((resolve) => {
        waiting.push(resolve);
      });
      if (outcome === 'error') throw new ApiError(503, BUSY);
      return DATA;
    },
    count: () => count,
    answer: async (outcome: Outcome) => {
      await waitFor(() => {
        expect(waiting.length).toBeGreaterThan(0);
      });
      const next = waiting.shift()!;
      await act(async () => {
        next(outcome);
        await Promise.resolve();
      });
    },
  };
}

/** A screen with a title, another focusable place and the states of one read. */
function Screen({ read }: { read: () => Promise<string> }) {
  const query = useQuery({ queryKey: ['dados'], queryFn: read, retry: false });
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRetryFocus([query], titleRef);
  let content: ReactNode;
  if (query.data === undefined && query.isError) {
    content = (
      <LoadError
        title={ERROR_TITLE}
        error={query.error}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (query.data === undefined) {
    content = <p>Carregando…</p>;
  } else {
    content = <p>{query.data}</p>;
  }
  return (
    <>
      <h1 ref={titleRef} tabIndex={-1}>
        {TITLE}
      </h1>
      <button type="button">{ELSEWHERE}</button>
      {content}
    </>
  );
}

function renderScreen() {
  const reads = readsByHand();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup({ delay: null });
  render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <Screen read={reads.read} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { reads, user };
}

function title(): HTMLElement {
  return screen.getByRole('heading', { level: 1, name: TITLE });
}

function retryButton(): HTMLElement {
  return screen.getByRole('button', { name: RETRY });
}

/** Runs what is queued, with no real wait. */
async function flushQueued() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

/** The window gets the focus back: the read in error goes again in the background. */
function windowFocusBack() {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

async function openWithLoadError() {
  const rendered = renderScreen();
  await rendered.reads.answer('error');
  expect(await screen.findByText(ERROR_TITLE)).toBeInTheDocument();
  return rendered;
}

/** "Tentar de novo" pressed with the keyboard. */
async function retryWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
  retryButton().focus();
  await user.keyboard('{Enter}');
}

describe('useRetryFocus: the focus after "Tentar de novo" of the load (§ 6.7)', () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  it('the first load that fails does not move the focus', async () => {
    await openWithLoadError();
    await flushQueued();

    expect(document.activeElement).toBe(document.body);
    expect(title()).not.toHaveFocus();
  });

  it('a reload in the background (window focus) does not move the focus', async () => {
    const { reads } = await openWithLoadError();
    const before = reads.count();

    windowFocusBack();
    await waitFor(() => {
      expect(reads.count()).toBeGreaterThan(before);
    });
    await reads.answer('ok');
    expect(await screen.findByText(DATA)).toBeInTheDocument();
    await flushQueued();

    expect(title()).not.toHaveFocus();
  });

  it('the focus waits for the end of the read, then goes to the title', async () => {
    const { user, reads } = await openWithLoadError();

    await retryWithKeyboard(user);
    // No data yet: the error leaves the screen with its button while the read goes again.
    expect(await screen.findByText('Carregando…')).toBeInTheDocument();
    await flushQueued();
    expect(title()).not.toHaveFocus();

    await reads.answer('ok');
    expect(await screen.findByText(DATA)).toBeInTheDocument();
    await waitFor(() => {
      expect(title()).toHaveFocus();
    });
  });

  it('the read fails again: the focus goes to the new "Tentar de novo"', async () => {
    const { user, reads } = await openWithLoadError();
    const first = retryButton();

    await retryWithKeyboard(user);
    await reads.answer('error');

    await waitFor(() => {
      expect(retryButton()).toHaveFocus();
    });
    expect(retryButton()).not.toBe(first);
  });

  it('a focus the user put elsewhere during the reload stays there', async () => {
    const { user, reads } = await openWithLoadError();

    await retryWithKeyboard(user);
    screen.getByRole('button', { name: ELSEWHERE }).focus();
    await reads.answer('ok');
    expect(await screen.findByText(DATA)).toBeInTheDocument();
    await flushQueued();

    expect(screen.getByRole('button', { name: ELSEWHERE })).toHaveFocus();
  });

  it('one press moves the focus once: a later reload in the background does not', async () => {
    const { user, reads } = await openWithLoadError();
    await retryWithKeyboard(user);
    await reads.answer('error');
    await waitFor(() => {
      expect(retryButton()).toHaveFocus();
    });

    // The focus falls on the page; then the window gets the focus back and the read fails.
    act(() => {
      retryButton().blur();
    });
    const before = reads.count();
    windowFocusBack();
    await waitFor(() => {
      expect(reads.count()).toBeGreaterThan(before);
    });
    await reads.answer('error');
    expect(await screen.findByText(ERROR_TITLE)).toBeInTheDocument();
    await flushQueued();

    expect(document.activeElement).toBe(document.body);
  });
});
