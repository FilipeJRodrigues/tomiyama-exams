/**
 * Erro: o botão de mostrar/ocultar a senha do `PasswordInput` (Mantine) fica com
 * `tabindex="-1"` e o nome acessível em inglês "Toggle password visibility". Quem usa
 * teclado não alcança o botão com Tab, e o leitor de tela anuncia o controle em inglês.
 * Vale para "Senha" (login), "Nova senha" e "Confirme a nova senha" (primeiro acesso) e
 * para os campos de senha do cadastro.
 * Esperado: o botão entra na ordem do Tab e tem nome em pt-BR (§ 6.7: "todos os
 * controles alcançáveis por Tab"; mensagens ao usuário em pt-BR).
 * Issue: -
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderApp } from '../render';

/** The visibility toggle that sits next to a password field. */
function toggleOf(input: HTMLElement): HTMLButtonElement {
  const toggle = input
    .closest('.mantine-PasswordInput-root')
    ?.querySelector<HTMLButtonElement>('button[aria-pressed]');
  if (!toggle) throw new Error('Botão de mostrar a senha não encontrado');
  return toggle;
}

describe('botão de mostrar a senha (§ 6.7)', () => {
  it('é alcançado pelo Tab logo depois do campo de senha', async () => {
    const { user } = await renderApp({ route: '/entrar' });
    const password = await screen.findByLabelText(/^Senha/);
    password.focus();
    await user.tab();
    expect(document.activeElement).toBe(toggleOf(password));
  });

  it('tem nome acessível em pt-BR', async () => {
    await renderApp({ route: '/entrar' });
    const toggle = toggleOf(await screen.findByLabelText(/^Senha/));
    expect(toggle).not.toHaveAccessibleName(/toggle|password|visibility/i);
    expect(toggle).toHaveAccessibleName(/senha/i);
  });

  it('vale também para os campos do cadastro', async () => {
    await renderApp({ route: '/cadastro' });
    const field = await screen.findByLabelText(/^Confirme a senha/);
    const toggle = toggleOf(field);
    expect(toggle).not.toHaveAttribute('tabindex', '-1');
    expect(toggle).toHaveAccessibleName(/senha/i);
  });
});
