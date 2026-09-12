# MATHEO — Emissor de NFS-e para MEI (backend)

API NestJS (Bun) que emite NFS-e pela API do Sistema Nacional NFS-e. Design: `docs/superpowers/specs/2026-09-11-nfse-emitter-backend-design.md`.

## Rodar local

```bash
cp .env.example .env
# gere a chave: bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))" → CERT_ENCRYPTION_KEY
docker compose up -d postgres logto   # ou: podman compose up -d postgres logto
bun install
bun run prisma:migrate
bun run dev            # http://localhost:3000/api/v0/health
```

O `docker-compose.yml` é apenas para desenvolvimento local (credenciais padrão, portas administrativas expostas) e não deve ser usado como está em produção. Todas as portas publicadas (5432, 3001, 3002, 3000) ficam vinculadas a `127.0.0.1`, não acessíveis pela rede.

Rodando a API dentro do container (`docker compose --profile full up`), `LOGTO_JWKS_URL` aponta para o endereço interno da rede (`http://logto:3001/oidc/jwks`) enquanto `LOGTO_ENDPOINT` continua com o endereço externo (`http://localhost:3001`), para casar com o `iss` dos tokens emitidos.

Logto admin: http://localhost:3002 — crie um **API Resource** com o indicador igual a `LOGTO_API_RESOURCE` e um app (SPA/Native) que peça esse resource; o access token emitido é o `Bearer` da API.

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

## Versionamento

O projeto segue [SemVer](https://semver.org). Enquanto estiver em alfa o *major* fica em `0` e só `minor`/`patch` sobem (`0.1.0` → `0.1.1` → `0.2.0`…). A versão em `package.json` é a fonte da verdade:

- `docs/collections/*.postman_collection.json` deve ter `info.version` igual — `bun run version:check` valida.
- Todo PR para `main` precisa subir a versão (`.github/workflows/version.yml` compara com a `main` e recusa versão igual, menor ou já tagueada).
- No merge em `main` a action cria a tag `vX.Y.Z` e a GitHub Release (marcada como *pre-release* enquanto major = 0). Se a tag já existir, ela valida que aponta pra mesma versão.
- `.github/workflows/ci.yml` roda typecheck, testes unitários e o `version:check` em todo PR.

## Postman

Importe `docs/collections/matheo-nfse-api.postman_collection.json` e o environment `docs/collections/local.postman_environment.json`. A collection já vem com **OAuth 2.0 (Authorization Code + PKCE)** apontando para o Logto: preencha `logtoClientId`/`logtoClientSecret` no environment (App ID/Secret de uma *Traditional web app* do Logto com redirect URI `https://oauth.pstmn.io/v1/callback`), abra *Authorization* na collection e clique em *Get New Access Token*. O parâmetro `resource` já vai configurado — sem ele o Logto emite token opaco e a API responde 401. O request `POST /invoices` salva o `id` retornado em `invoiceId` para os requests seguintes. Ao criar uma collection nova, use a mesma versão do `package.json` em `info.version`.
