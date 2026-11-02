/**
 * § 6: sentence case. The theme turns off the Mantine Badge uppercase for every Badge, not
 * only the "Dados simulados" one (checked in Edge: computed `text-transform: none`).
 */
import { Badge, MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { theme } from '../../src/app/theme';

describe('Badge do tema (§ 6)', () => {
  it.each(['light', 'filled', 'outline', 'dot'] as const)(
    'variante %s sem caixa alta',
    (variant) => {
      render(
        <MantineProvider theme={theme}>
          <Badge variant={variant}>Em caixa de frase</Badge>
        </MantineProvider>,
      );
      const root = screen.getByText('Em caixa de frase').closest('.mantine-Badge-root');
      expect(root).not.toBeNull();
      expect(root?.getAttribute('style') ?? '').toMatch(/text-transform:\s*none/);
    },
  );
});
