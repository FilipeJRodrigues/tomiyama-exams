/**
 * Erro: na primeira visita (sem escolha salva), a tela "Erro ao iniciar" (`ConfigErrorScreen`,
 * mostrada quando falta a configuração ou o início falha) abre no tema claro. O `index.html`
 * já pôs a página no escuro antes do React, e o `MantineProvider` dessa tela, sem
 * `defaultColorScheme="dark"`, troca para o claro ao montar: a página pisca do escuro para o
 * branco. O `AppProviders` mudou o padrão para o escuro no #166, mas esse segundo provider
 * ficou com o padrão do Mantine (`light`).
 * Esperado: o mesmo padrão do resto do site (skill `tomiyama-design`, `colors.md`, "Tema
 * padrão"): escuro sem escolha salva, e a escolha salva (`tomiyama.color-scheme`) valendo.
 * Issue: #166
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConfigErrorScreen } from '../../src/app/ConfigErrorScreen';
import { COLOR_SCHEME_KEY } from '../../src/app/theme';

const MESSAGE = 'Configuração ausente: VITE_API_URL.';

describe('tela de erro ao iniciar: tema (#166)', () => {
  it('sem escolha salva: escuro, como o index.html e o resto do site', async () => {
    // As the browser leaves it after the script of index.html, on a first visit.
    document.documentElement.setAttribute('data-mantine-color-scheme', 'dark');
    render(<ConfigErrorScreen message={MESSAGE} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGE);
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'dark');
  });

  it('a escolha salva continua valendo', async () => {
    window.localStorage.setItem(COLOR_SCHEME_KEY, 'light');
    document.documentElement.setAttribute('data-mantine-color-scheme', 'light');
    render(<ConfigErrorScreen message={MESSAGE} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGE);
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'light');
  });
});
