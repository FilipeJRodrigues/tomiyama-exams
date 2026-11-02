/**
 * The e-mail as the user pool stores it: no spaces at the edges and in lower case. The
 * pool compares usernames with case, so every call to Cognito goes through this.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
