/**
 * Erro: no modo simulado, o selo "Dados simulados" do cabeçalho aparece como
 * "DADOS SIMULADOS": o `Badge` do Mantine aplica `text-transform: uppercase` por padrão
 * (classe `m_347db0ec`). Visto no Edge a 1280 px na lista de alunos, nos dois temas.
 * Esperado: texto em caixa de frase, sem caixa alta decorativa (§ 6, primeira linha).
 * Issue: -
 *
 * O jsdom não carrega o CSS do Mantine; o teste aceita trocar o `Badge` por outro
 * componente ou anular a caixa alta por estilo (`tt="none"` ou `styles` no tema).
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { installMockApi } from '../msw-server';
import { renderApp } from '../render';

describe('selo "Dados simulados" (§ 6)', () => {
  it('fica em caixa de frase', async () => {
    installMockApi();
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const badge = await screen.findByText('Dados simulados', { selector: 'header *' });
    const root = badge.closest('.mantine-Badge-root');
    if (root) {
      expect(root.getAttribute('style') ?? '').toMatch(/text-transform:\s*none/);
    }
  });
});
