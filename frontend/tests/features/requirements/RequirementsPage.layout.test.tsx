/**
 * Requirements screen (§ 6.5, § 6.7): crossing the phone width (rotation, zoom of 200%)
 * swaps the table for cards; the focus on a row button stays on the same button.
 */
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { mediaMatches, setViewportWidth } from '../../viewport';
import { openRequirements } from './helpers';

type Listener = (event: { matches: boolean; media: string }) => void;
let listeners: { query: string; listener: Listener }[] = [];
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

function stubMatchMedia() {
  listeners = [];
  window.matchMedia = ((query: string) => ({
    matches: mediaMatches(query),
    media: query,
    onchange: null,
    addListener: (listener: Listener) => {
      listeners.push({ query, listener });
    },
    removeListener: () => undefined,
    addEventListener: (_type: string, listener: Listener) => {
      listeners.push({ query, listener });
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function resizeTo(width: number) {
  setViewportWidth(width);
  act(() => {
    for (const { query, listener } of listeners) {
      listener({ matches: mediaMatches(query), media: query });
    }
  });
}

describe('requirements screen, change of layout (§ 6.7)', () => {
  beforeEach(() => {
    stubMatchMedia();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  afterEach(() => {
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  });

  it('keeps the focus on the same row button when the table turns into cards and back', async () => {
    await openRequirements();
    act(() => {
      screen.getByRole('button', { name: 'Excluir Osoto gari' }).focus();
    });

    resizeTo(390);
    expect(await screen.findByRole('list', { name: 'Requisitos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Excluir Osoto gari' })).toHaveFocus();

    resizeTo(1280);
    expect(await screen.findByRole('table', { name: 'Requisitos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Excluir Osoto gari' })).toHaveFocus();
  });
});
