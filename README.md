# MATHEO — Emissor de NFS-e para MEI (backend)

API NestJS (Bun) que emite NFS-e pela API do Sistema Nacional NFS-e. Design: `docs/superpowers/specs/2026-09-11-nfse-emitter-backend-design.md`.

## Rodar local

```bash
cp .env.example .env
# gere a chave: bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))" → CERT_ENCRYPTION_KEY
docker compose up -d postgres logto   # ou: podman compose up -d postgres logto
bun install
bun run prisma:migrate
bun run dev            # http://localhost:3000/api/v0/health (recarrega a cada alteração de arquivo)
bun run serve          # mesma coisa SEM watch — use quando outra pessoa (ex.: o frontend) estiver consumindo a API
```

O `docker-compose.yml` é apenas para desenvolvimento local (credenciais padrão, portas administrativas expostas) e não deve ser usado como está em produção. Todas as portas publicadas (5432, 3001, 3002, 3000) ficam vinculadas a `127.0.0.1`, não acessíveis pela rede.

Rodando a API dentro do container (`docker compose --profile full up`), `LOGTO_JWKS_URL` aponta para o endereço interno da rede (`http://logto:3001/oidc/jwks`) enquanto `LOGTO_ENDPOINT` continua com o endereço externo (`http://localhost:3001`), para casar com o `iss` dos tokens emitidos.

Logto admin: http://localhost:3002 — crie um **API Resource** com o indicador igual a `LOGTO_API_RESOURCE` e um app (SPA/Native) que peça esse resource; o access token emitido é o `Bearer` da API.

Containers (`NODE_ENV=production` no `Dockerfile`) sempre logam JSON estruturado; `LOG_PRETTY=true` força saída legível para humanos mesmo em produção.

## Testes

```bash
bun test                                  # unitários (test/, espelho de src/)
bun run test:e2e                          # e2e com Postgres do compose e gateway fake
```

## Ambientes NFS-e

`NFSE_ENV=fake` (padrão) usa `FakeNfseGateway`. Com `producao-restrita`/`producao` a API exige `NFSE_SEFIN_URL`, `NFSE_ADN_URL` e um certificado A1 válido cadastrado em `PUT /companies/me/certificate`.

## Certificado de desenvolvimento

Com `NFSE_ENV=fake` qualquer `.pfx` válido serve. Gere um autoassinado com:

```bash
bun run scripts/dev-certificate.ts dev-cert.pfx dev-password
```

e envie em `PUT /api/v0/companies/me/certificate` (form-data: `file` + `password`). Arquivos `*.pfx` são ignorados pelo git. Esse certificado **não** é ICP-Brasil e será rejeitado pela API Nacional real.

## Health

`GET /api/v0/health` (público) devolve versão (`package.json`), `stage` (`alpha` enquanto a versão for 0.x; force com `APP_STAGE`), `apiVersion`, ambiente, `nfseEnv`, `commit` (`GIT_COMMIT`, injetado no build Docker via `--build-arg GIT_COMMIT=$(git rev-parse --short HEAD)`), runtime, uptime e um check de banco (`SELECT 1`). Responde **503** com `status: "degraded"` se o banco falhar — serve de healthcheck de container.

## Documentação OpenAPI e CORS

- **Swagger UI:** `http://localhost:3000/api/v0/docs` · **OpenAPI JSON:** `http://localhost:3000/api/v0/docs-json` (públicos). O JSON serve para gerar clients tipados no frontend, ex.: `npx openapi-typescript http://localhost:3000/api/v0/docs-json -o src/api/schema.d.ts`.
- **`docs/openapi.json`** é versionado no repo (gerado por `bun run openapi:export`; o CI falha se estiver desatualizado). Toda rota documenta request **e** response (`*ResponseModel`, paginação `{ data, page, limit, total }`, `ErrorResponse` com `requestId`), então dá para gerar tipos/clients direto dele.
- **CORS:** `CORS_ORIGINS` (lista separada por vírgula; default `http://localhost:5173`). Headers expostos ao browser: `x-request-id`, `Content-Disposition`.

## Endpoints

Todas as rotas, incluindo `/health`, vivem sob o prefixo `/api/v0`.

| Método | Rota | Descrição |
|---|---|---|
| GET | /api/v0/health | health check (público) |
| POST | /api/v0/companies | cria a empresa do usuário |
| GET | /api/v0/companies/me | dados da empresa |
| PATCH | /api/v0/companies/me | atualiza dados |
| PUT | /api/v0/companies/me/certificate | multipart `file` (.pfx) + `password` |
| POST | /api/v0/invoices | emite NFS-e |
| GET | /api/v0/invoices?status=&page=&limit= | lista |
| GET | /api/v0/invoices/:id | detalhe |
| GET | /api/v0/invoices/:id/xml | XML da NFS-e |
| GET | /api/v0/invoices/:id/pdf | DANFSe |
| POST | /api/v0/invoices/:id/cancel | `{ motivo }` |
| POST | /api/v0/customers | cria cliente (tomador) salvo |
| GET | /api/v0/customers?search=&page=&limit= | lista clientes da empresa |
| GET | /api/v0/customers/:id | detalhe do cliente |
| PATCH | /api/v0/customers/:id | atualiza cliente |
| DELETE | /api/v0/customers/:id | remove cliente (notas antigas ficam com `customerId = null`) |
| GET | /api/v0/alerts | avisos da empresa (certificado, trial, notas paradas) |
| GET | /api/v0/audit-logs?page=&limit=&action=&from=&to= | extrato de ações (auditoria) da empresa |

## Rastreabilidade

Toda resposta (sucesso ou erro) carrega o header `x-request-id`: reaproveita o que o client mandar (se for um valor válido) ou gera um `uuid`. Corpos de erro sempre trazem o mesmo valor em `requestId`, além de `statusCode`/`message`/`details?`. O `RequestContext` (AsyncLocalStorage) carrega `requestId`/`userId`/`ip`/`userAgent` durante o request e é consumido pelo logger e pela auditoria.

Logs são em JSON estruturado via `pino`, com `requestId`/`userId` mesclados em cada linha quando dentro de um request. `LOG_LEVEL` controla o nível (`fatal|error|warn|info|debug|trace`, default `info`); `LOG_PRETTY=true` liga saída colorida/legível para humanos (default: ligado só em `NODE_ENV=development`; containers rodam com `NODE_ENV=production` e logam JSON — use `LOG_PRETTY=true` para sobrepor). Se `pino-pretty` não estiver instalado, cai para JSON e avisa uma vez em `warn`. Uma linha `info` por request (`{ msg: 'request', method, path, statusCode, durationMs }`, sem query string); `/health` fica em `debug` para não poluir os logs de healthcheck.

## Auditoria

`audit_logs` é **append-only**: cada ação sensível (criar/atualizar empresa, subir certificado, criar/atualizar/remover cliente, emitir/rejeitar/cancelar nota, bloqueio por trial vencido) grava uma linha com `action`, `outcome` (`SUCCESS`/`FAILURE`), `statusCode`, `metadata` e o `requestId`/`userId`/`ip`/`userAgent` do request. Uma falha ao gravar a auditoria **nunca** derruba a ação do usuário — só é logada.

`GET /api/v0/audit-logs` lista, paginado e escopado à empresa do usuário logado, as ações mais recentes primeiro; `ip`/`userAgent` ficam só no banco (não voltam na API). **Nunca** guardamos segredos em `metadata` (senha de certificado, chave privada, token) — só identificadores e valores de negócio (CNPJ, chave de acesso, motivo, etc.). Retenção prevista: **5 anos** (documentado nesta versão; ainda sem job de expurgo automático).

## Trial

Toda empresa nasce com `plan = 'TRIAL'` e `trialEndsAt = createdAt + 30 dias` (`POST /companies`). Com o trial vencido, a API bloqueia com `402` (`details.trialEndsAt`) tudo que **cria ou altera** algo — emitir nota (`POST /invoices`) e criar/editar/excluir cliente (`POST`/`PATCH`/`DELETE /customers`) — mas libera tudo que só consulta ou usa o que já existe:

| Liberado com trial vencido | Bloqueado (`402`) |
|---|---|
| `GET/PATCH /companies/me`, `PUT /companies/me/certificate` | `POST /companies` (não afetado — empresa ainda não existe) |
| `GET /invoices`, `GET /invoices/:id`, `/xml`, `/pdf`, `POST /invoices/:id/cancel` | `POST /invoices` |
| `GET /customers`, `GET /customers/:id` | `POST/PATCH/DELETE /customers` |
| `GET /audit-logs`, `GET /alerts`, `GET /health` | — |

Cada bloqueio grava `trial.blocked` na auditoria. `GET /api/v0/companies/me` sempre mostra `plan` e `trialEndsAt`.

Para ativar manualmente uma empresa (sem gateway de pagamento nesta versão):

```sql
UPDATE companies SET plan = 'ACTIVE' WHERE cnpj = '...';
```

## Alertas

`GET /api/v0/alerts` devolve `{ alerts: [{ code, severity, message, data }] }` sobre a empresa do usuário logado, ordenado `critical` → `warning` → `info`: certificado ausente/vencido/a vencer em 30 dias, trial vencido/a vencer em 5 dias, e notas `PENDING` paradas há mais de 10 minutos sem confirmação do fisco. Liberado mesmo com trial vencido.

## Validação de documento (CPF/CNPJ)

`CreateCompanyDto.cnpj`, `CreateCustomerDto.documento`/`UpdateCustomerDto.documento` e `CreateInvoiceDto.tomadorDocumento` validam o **dígito verificador** de CPF/CNPJ (mod-11), não só formato/tamanho — sequências com todos os dígitos iguais também são rejeitadas. Documento inválido → `400` com mensagem citando o campo (`"<campo> must be a valid CPF or CNPJ"` / `"<campo> must be a valid CNPJ"`).

## Versionamento

O projeto segue [SemVer](https://semver.org). Enquanto estiver em alfa o *major* fica em `0` e só `minor`/`patch` sobem (`0.1.0` → `0.1.1` → `0.2.0`…). A versão em `package.json` é a fonte da verdade:

- `docs/collections/*.postman_collection.json` deve ter `info.version` igual — `bun run version:check` valida.
- Todo PR para `main` precisa subir a versão (`.github/workflows/version.yml` compara com a `main` e recusa versão igual, menor ou já tagueada).
- No merge em `main` a action cria a tag `vX.Y.Z` e a GitHub Release (marcada como *pre-release* enquanto major = 0). Se a tag já existir, ela valida que aponta pra mesma versão.
- `.github/workflows/ci.yml` roda typecheck, testes unitários e o `version:check` em todo PR.

## Postman

Importe `docs/collections/matheo-nfse-api.postman_collection.json` e o environment `docs/collections/local.postman_environment.json`. A collection já vem com **OAuth 2.0 (Authorization Code + PKCE)** apontando para o Logto: preencha `logtoClientId`/`logtoClientSecret` no environment (App ID/Secret de uma *Traditional web app* do Logto com redirect URI `https://oauth.pstmn.io/v1/callback`), abra *Authorization* na collection e clique em *Get New Access Token*. O parâmetro `resource` já vai configurado — sem ele o Logto emite token opaco e a API responde 401. O request `POST /invoices` salva o `id` retornado em `invoiceId` para os requests seguintes. Ao criar uma collection nova, use a mesma versão do `package.json` em `info.version`.
