/**
 * Text without accents and case, for the name search (`Élida` matches `elida`). Same idea
 * as `fold_name` in the backend: NFD splits each accented letter into the base letter
 * plus combining marks, which are dropped.
 */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

/** Whether `text` contains `query`, ignoring accents, case and extra spaces. */
export function matchesQuery(text: string, query: string): boolean {
  const needle = foldText(query).trim().replace(/\s+/g, ' ');
  if (!needle) return true;
  return foldText(text).replace(/\s+/g, ' ').includes(needle);
}
