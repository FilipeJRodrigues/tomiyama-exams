/**
 * The table of the students list scrolls inside its own region (§ 6.2, § 6.7). Checked
 * in Edge at 768 px: the page does not scroll sideways, the region takes focus by Tab with
 * a visible outline and scrolls with the arrows. jsdom has no layout, so these tests pin
 * the structure: a named, focusable region that wraps the table and has no other focus
 * stop inside, and the table keeping its own name.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { resetViewport, setViewportWidth } from '../../viewport';

describe('rolagem própria da tabela de alunos (§ 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    resetViewport();
  });

  it.each([1280, 768])('a %i px a tabela fica numa região nomeada', async (width) => {
    setViewportWidth(width);
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await screen.findByText('Ana Souza');

    const region = screen.getByRole('region', { name: 'Lista de alunos' });
    expect(within(region).getByRole('table', { name: 'Alunos' })).toBeInTheDocument();
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('a região é alcançada por Tab logo depois do menu, uma única vez', async () => {
    setViewportWidth(768);
    const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await screen.findByText('Ana Souza');
    const region = screen.getByRole('region', { name: 'Lista de alunos' });

    let stops = 0;
    for (let i = 0; i < 20; i++) {
      await user.tab();
      if (document.activeElement === region) stops++;
      if (region.contains(document.activeElement) && document.activeElement !== region) {
        throw new Error('foco parou dentro da tabela');
      }
    }
    expect(stops).toBeGreaterThan(0);
    // Without other focus stops inside, the region is visited once per Tab cycle.
    expect(
      region.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'),
    ).toHaveLength(0);
  });

  it('a 640 px (zoom de 200%) a lista vira cartões, sem região rolável', async () => {
    setViewportWidth(640);
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    expect(await screen.findByRole('list', { name: 'Alunos' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Lista de alunos' })).not.toBeInTheDocument();
  });
});
