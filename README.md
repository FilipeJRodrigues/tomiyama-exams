# tomiyama-exams

Sistema de exames de graduação de Judô da academia Tomiyama: cadastro de alunos, exame de faixa com marcação dos itens, decisão do sensei e histórico de graduações.

## Estrutura

| Pasta           | Conteúdo                                                                  |
| --------------- | ------------------------------------------------------------------------- |
| `backend/`      | API em Python 3.12 no AWS Lambda, com DynamoDB, S3, Cognito e API Gateway |
| `infra/`        | template AWS SAM da infraestrutura                                        |
| `frontend/`     | site em TypeScript + React + Vite, publicado no AWS Amplify Hosting       |
| `requirements/` | especificações: regras de negócio, modelo de dados e arquitetura na AWS   |

## Documentação

- [`backend/README.md`](backend/README.md): API (rotas, autenticação, erros), testes e deploy do backend.
- [`frontend/AMPLIFY.md`](frontend/AMPLIFY.md): publicação do front no Amplify (dev).
- [`requirements/requisitos-exame-graduacao.md`](requirements/requisitos-exame-graduacao.md): perfis, modelo de dados, regras de negócio (RN001 em diante), telas e fluxo de aceite.
- [`requirements/Arquitetura — Site Academia de Judô (AWS).md`](<requirements/Arquitetura — Site Academia de Judô (AWS).md>): stack na AWS. Quando os dois documentos conflitam, vale a stack AWS.
