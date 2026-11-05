/**
 * Erro (dos testes, não da tela): casos que seguram a resposta da API com espera real no mock
 * (`delay(100)`, `delay(150)` do msw) oscilam sob carga, porque o que eles querem conferir "com
 * a requisição a caminho" só vale se a máquina chegar lá antes dos N ms:
 * - `BeltsPage.save.test.tsx`, "Esc while the PUT is on its way…" (`puts.wait = 150`): sob
 *   carga o PUT responde antes do Esc e o caso passa a testar outra coisa (o Enter cai no
 *   diálogo saindo ou no "Editar faixa Cinza" de volta); falhou com `expected 2 to be 1`.
 * - `RequirementsPage.save.test.tsx`, "a double click on Salvar…" (`delay(100)`): o
 *   `waitFor(data-loading)` termina com um `setTimeout(0)` da Testing Library; se a tela levou
 *   mais de 100 ms para desenhar o "Salvar" carregando, o POST responde antes desse temporizador
 *   e "Cancelar" já está habilitado quando o teste confere que o diálogo está travado.
 *   Reproduzido segurando a thread 400 ms logo depois do "Salvar" carregando: falha em
 *   `toBeDisabled()`. O mesmo vale para "a double Enter in the edit…" e "a double click on
 *   Excluir…", do mesmo arquivo, e para `2026-11-03-faixa-envio-duplo` (`delay(50)`).
 * Esperado: nenhum teste usa espera real do msw como sincronização. A resposta fica segura por
 * uma promessa que o próprio teste libera (`gate()` de `tests/features/academy/helpers.ts`, o
 * `controlPuts().releaseFirst` de `88-faixa-enter-durante-fechamento`), conferindo o estado
 * "a caminho" antes de liberar. `delay('infinite')` (resposta que nunca vem) continua valendo.
 * Issue: #63
 */
import { describe, expect, it } from 'vitest';

/** Source of every test file under `tests/`, by path relative to this folder (`../x/y.test.tsx`). */
const SOURCES = import.meta.glob<string>('../**/*.test.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const THIS_FILE = '63-mock-com-espera-real.test.ts';

/** `file:line  code` of each msw `delay(...)` that waits real time (anything but 'infinite'). */
function realDelays(): string[] {
  const found: string[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    if (path.endsWith(`/${THIS_FILE}`)) continue;
    source.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(/\bdelay\(([^)]*)\)/g)) {
        const argument = (match[1] ?? '').trim();
        if (argument === "'infinite'" || argument === '"infinite"') continue;
        found.push(`${path.replace(/^\.\.\//, '')}:${String(index + 1)}  ${line.trim()}`);
      }
    });
  }
  return found;
}

describe('mocks hold answers with a promise the test releases, never with real time (#63)', () => {
  it('finds the test files (the scan is not empty)', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
  });

  it('no test of tests/ waits with delay(N) of msw', () => {
    expect(realDelays()).toEqual([]);
  });
});
