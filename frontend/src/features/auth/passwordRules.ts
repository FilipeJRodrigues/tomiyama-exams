/** § 2: password with at least 8 characters. Cognito also refuses spaces at the edges. */
export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_HINT = `Pelo menos ${MIN_PASSWORD_LENGTH} caracteres`;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Convenience check before calling the login service; its message is the one that counts. */
export function emailProblem(email: string): string | null {
  const clean = email.trim();
  if (!clean) return 'Informe o e-mail.';
  if (!EMAIL_PATTERN.test(clean)) return 'Informe um e-mail válido.';
  return null;
}

/**
 * Checks a new password and its confirmation; `emptyMessage` names the field
 * ("Informe a senha.", "Informe a nova senha.").
 */
export function newPasswordProblem(
  password: string,
  confirmation: string,
  emptyMessage: string,
): string | null {
  if (!password.trim()) return emptyMessage;
  if (password !== password.trim()) return 'A senha não pode começar nem terminar com espaço.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (password !== confirmation) return 'As senhas não conferem.';
  return null;
}
