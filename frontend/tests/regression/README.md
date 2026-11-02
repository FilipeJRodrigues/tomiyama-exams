# Testes de regressão do frontend

Todo erro apontado no frontend vira um teste aqui **antes** da correção. O teste precisa
falhar pelo motivo certo com o código antigo e passar depois da correção; não apague, não
pule (`skip`) nem afrouxe um teste daqui para fazer a verificação passar.

## Formato

- Um arquivo por erro: `<issue ou data>-<assunto>.test.ts(x)`, por exemplo
  `2026-11-02-data-nascimento-fuso.test.tsx` ou `42-botao-confirmar-presenca.test.tsx`.
- No topo, um comentário com o erro observado, o esperado e a issue, se houver:

```tsx
/**
 * Erro: a data de nascimento 01/03/2018 aparecia como 28/02/2018 na lista de alunos.
 * Esperado: a data do calendário, sem conversão de fuso (§ 3).
 * Issue: #42
 */
```

- Use os utilitários de `tests/` (`renderApp` em `tests/render.tsx`, `installMockApi` e
  `server` em `tests/msw-server.ts`) e nomeie pelo id da regra quando houver (`rn005 ...`).
- A suíte roda com `TZ=America/Sao_Paulo` (`vite.config.ts`), para erros de fuso aparecerem
  como no Brasil.

Os arquivos daqui rodam com `npm test`, junto com o resto da suíte.
