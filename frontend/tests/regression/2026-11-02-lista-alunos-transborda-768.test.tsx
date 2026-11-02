/**
 * Erro: a 768 px (largura de referência do § 6.7), o menu lateral fica aberto (240 px) e
 * sobram cerca de 500 px para a tabela de alunos de seis colunas, que precisa de uns
 * 610 px. No Edge, com os dados simulados, `document.documentElement.scrollWidth` é 868 px
 * para uma janela de 768 px: a página inteira (cabeçalho com "Sair" incluído) rola na
 * horizontal e a coluna "Situação" ("Elegível" / "Bloqueado: …") fica fora da tela. A
 * tabela não está dentro de um contêiner com rolagem própria e a troca para cartões só
 * acontece abaixo de 768 px.
 * Esperado: a 768 px a lista cabe na largura disponível sem a página rolar na horizontal:
 * ou a lista vira cartões, ou a tabela fica num contêiner que rola sozinho
 * (`Table.ScrollContainer`, `ScrollArea` ou `overflow-x: auto`) (§ 6.2, § 6.7).
 * Issue: -
 *
 * O jsdom não calcula layout, então o teste verifica a estrutura que evita o transbordo.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

const SCROLL_CONTAINER =
  '.mantine-TableScrollContainer-scrollContainer, .mantine-ScrollArea-root, .mantine-ScrollArea-viewport';

/** True when some ancestor of the table, up to `main`, scrolls on its own horizontally. */
function insideHorizontalScroll(table: HTMLElement): boolean {
  let node = table.parentElement;
  while (node && node.tagName !== 'MAIN') {
    if (node.matches(SCROLL_CONTAINER)) return true;
    if (/overflow(-x)?:\s*(auto|scroll)/.test(node.getAttribute('style') ?? '')) return true;
    node = node.parentElement;
  }
  return false;
}

describe('lista de alunos a 768 px (§ 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('não faz a página rolar na horizontal: cartões ou tabela com rolagem própria', async () => {
    setViewportWidth(768);
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await screen.findByText('Ana Souza');

    const table = screen.queryByRole('table', { name: 'Alunos' });
    const cards = screen.queryByRole('list', { name: 'Alunos' });
    expect(cards !== null || (table !== null && insideHorizontalScroll(table))).toBe(true);
  });
});
