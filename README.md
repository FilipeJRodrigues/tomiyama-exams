# tomiyama-exams

Repo about Tomiyama Judo/ Jiu-Jitsu Gym for the belt exams

## Front no Amplify (dev)

O front (`frontend/`) é publicado pelo AWS Amplify Hosting, com HTTPS e CDN, a cada push no `main`. O app do Amplify é criado à mão no console e não faz parte do template SAM. O build segue o [`amplify.yml`](amplify.yml) da raiz e para com uma mensagem em pt-BR se faltar alguma das variáveis abaixo ou se `VITE_USE_MOCKS` não for `false`.

Antes de começar, faça o deploy da stack `tomiyama-dev` (veja [`backend/README.md`](backend/README.md)) e anote as saídas `ApiUrl`, `UserPoolId` e `UserPoolClientId`. Elas ficam no console do CloudFormation, na stack `tomiyama-dev`, aba **Outputs**, ou saem com `aws cloudformation describe-stacks --stack-name tomiyama-dev --region us-east-2 --profile tomiyama --query "Stacks[0].Outputs"`.

1. **Região.** No console do Amplify, escolha a região **us-east-2**, a mesma da stack `tomiyama-dev`.
2. **Repositório.** **Create new app** → **GitHub**. Na autorização do GitHub, instale o app do Amplify só no repositório `FilipeJRodrigues/tomiyama-exams` (**Only select repositories**), não em todos.
3. **Branch e monorepo.** Escolha a branch `main`, marque **My app is a monorepo** e informe a pasta `frontend`. O console cria a variável `AMPLIFY_MONOREPO_APP_ROOT=frontend`, que precisa bater com o `appRoot` do `amplify.yml`.
4. **Build.** O console detecta o `amplify.yml` da raiz; não edite os comandos lá, eles vêm do repositório. Na tela **Configurações de compilação** (console em português), o console mostra `npm run build` e `dist` detectados: não precisa mudar nada, porque vale o `amplify.yml`. Deixe desmarcadas as opções **Meu monorepo usa o backend do Amplify Gen2** e **Proteger meu site com senha**.
5. **Variáveis de ambiente.** Em **Advanced settings** (ou depois em **Hosting → Environment variables**), crie:

   | Variável                    | Valor                                     |
   | --------------------------- | ----------------------------------------- |
   | `VITE_API_URL`              | saída `ApiUrl` da stack, sem barra no fim |
   | `VITE_COGNITO_USER_POOL_ID` | saída `UserPoolId`                        |
   | `VITE_COGNITO_CLIENT_ID`    | saída `UserPoolClientId`                  |
   | `VITE_USE_MOCKS`            | `false`                                   |

   Não são segredos, mas ficam só no console: não os versione. Se mudar alguma depois, rode o build de novo (**Redeploy this version**), porque o Vite grava os valores no site durante o build.

6. **Salve e publique** (**Save and deploy**) e espere o primeiro build terminar.
7. **Rotas do React.** Em **Hosting → Rewrites and redirects**, adicione a regra abaixo para que recarregar uma página como `/alunos/123` abra o site em vez de dar 404 (todo caminho sem extensão de arquivo estático cai no `index.html`):

   | Source address                                                                                           | Target address | Type            |
   | -------------------------------------------------------------------------------------------------------- | -------------- | --------------- |
   | `</^[^.]+$\|\.(?!(css\|gif\|ico\|jpg\|js\|png\|txt\|svg\|woff\|woff2\|ttf\|map\|json\|webp)$)([^.]+$)/>` | `/index.html`  | `200 (Rewrite)` |

   No editor JSON, a mesma regra:

   ```json
   [
     {
       "source": "</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
       "status": "200",
       "target": "/index.html",
       "condition": null
     }
   ]
   ```

   O build gera hoje só `.html`, `.css` e `.js`; a lista cobre também os tipos que costumam entrar em `frontend/public` (ícones, imagens e fontes). Se um tipo novo de arquivo estático entrar no site, acrescente a extensão aqui, ou ele será trocado pelo `index.html`.

8. **CORS da API.** Anote o domínio do app, `https://main.<appid>.amplifyapp.com` (aparece em **Overview**), e libere-o no CORS da API pelo parâmetro `AllowedOrigin` da stack, como descrito em [`backend/README.md`, seção "CORS e Amplify"](backend/README.md#cors-e-amplify). Sem isso, o site abre mas o login e as telas falham ao chamar a API.
