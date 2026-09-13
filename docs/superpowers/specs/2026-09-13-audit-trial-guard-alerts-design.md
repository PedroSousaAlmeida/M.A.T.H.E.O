# Auditoria, trial guard, validação de documentos e alertas — Backend (v0.3.0)

**Data:** 2026-09-13
**Status:** aprovado para planejamento
**Base:** `dev` = `v0.2.0` (specs anteriores: `2026-09-11-nfse-emitter-backend-design.md`, `2026-09-12-trial-and-customers-design.md`). Este documento só descreve o que muda.

## 1. Objetivo

1. **Rastreabilidade**: todo request tem um `requestId`; logs da aplicação saem em JSON estruturado com esse id; toda ação relevante de um usuário fica registrada numa tabela de auditoria imutável, consultável pela própria empresa.
2. **Trial como guard global**: trial vencido bloqueia por padrão; rotas liberadas são marcadas com `@AllowExpiredTrial()` (mesmo padrão do `@Public()`).
3. **CPF/CNPJ válidos**: dígito verificador validado nos DTOs.
4. **Alertas**: `GET /alerts` devolve avisos calculados (certificado, trial, notas pendentes) para o dashboard.

## 2. Decisões

| Tema | Decisão |
|---|---|
| Request id | Middleware lê `x-request-id` (se válido: 1–128 chars `[A-Za-z0-9._-]`) ou gera `crypto.randomUUID()`; devolve no header `x-request-id` da resposta; guarda em `AsyncLocalStorage` (`RequestContext`) junto com `userId` (preenchido pelo `JwtAuthGuard`) |
| Logger | `pino` como `LoggerService` do Nest (`app.useLogger`). JSON sempre; `pino-pretty` só quando `LOG_PRETTY=true` (default `true` em `NODE_ENV=development`). Todo log dentro de um request carrega `requestId` e `userId` via `RequestContext`. Um log de acesso por request: `method, path, statusCode, durationMs` |
| Auditoria | Tabela `audit_logs` **append-only** (sem update/delete pela aplicação). Gravação **explícita** nos services (não interceptor): quem sabe o que aconteceu é o service. Falha ao gravar auditoria **não** falha a ação principal: loga `error` e segue (a ação já foi persistida) |
| Trial | `TrialGuard` global (ordem: Throttler → JWT → Trial). Carrega a empresa do `sub`, anexa em `request.company`. Sem empresa → passa. Trial vencido → `402` **exceto** em rotas com `@AllowExpiredTrial()`. `CompaniesService.assertCanEmit` é removido do `emit` (o guard cobre) e vira `isTrialExpired(company)` puro, reutilizado pelo guard e pelos alertas |
| Política do trial vencido | **Modo leitura + saídas**: liberado ler tudo, cancelar nota, atualizar empresa e certificado, ver auditoria e alertas. Bloqueado: emitir nota, criar/editar/apagar clientes |
| CPF/CNPJ | Validação de dígito verificador em `cnpj` (empresa), `documento` (cliente), `tomadorDocumento` (nota). Sequências repetidas (`111…`) inválidas. CNPJ alfanumérico **não suportado** nesta versão (documentado) |
| Alertas | Calculados na hora, sem tabela. Endpoint próprio `GET /alerts` (módulo `alerts`, depende de `companies` e `invoices`) — evita ciclo `companies → invoices` |
| Versão | `0.3.0` |

## 3. Estrutura de pastas (diff)

```
src/
├── common/
│   ├── request-context.ts            # AsyncLocalStorage<{ requestId, userId? }>
│   ├── request-id.middleware.ts       # gera/propaga x-request-id, abre o contexto
│   ├── logger/pino-logger.service.ts  # LoggerService do Nest sobre pino, com requestId/userId
│   └── validators/document.ts         # isValidCpf, isValidCnpj, @IsCpfOrCnpj(), @IsCnpj()
# (não há logging.interceptor.ts: o log de acesso vive em request-id.middleware.ts,
#  para cobrir também requests rejeitados pelo TrialGuard/outros guards)
└── modules/
    ├── audit/
    │   ├── audit.module.ts (global)  audit.service.ts  audit.controller.ts  dto/list-audit-logs.dto.ts
    ├── companies/
    │   ├── trial.guard.ts  allow-expired-trial.decorator.ts   (+ isTrialExpired em companies.service.ts)
    └── alerts/
        ├── alerts.module.ts  alerts.service.ts  alerts.controller.ts
test/ espelha tudo acima; test/app.e2e.spec.ts ganha auditoria, alerts, requestId
```

## 4. Modelo de dados (Prisma — diff)

```prisma
enum AuditOutcome {
  SUCCESS
  FAILURE
}

model AuditLog {
  id         String       @id @default(uuid())
  occurredAt DateTime     @default(now())
  requestId  String?
  userId     String
  companyId  String?
  action     String                       // ex.: "invoice.emitted"
  entityType String?                      // "company" | "invoice" | "customer"
  entityId   String?
  outcome    AuditOutcome @default(SUCCESS)
  statusCode Int?
  metadata   Json?
  ip         String?
  userAgent  String?

  @@index([companyId, occurredAt(sort: Desc)])
  @@index([userId, occurredAt(sort: Desc)])
  @@map("audit_logs")
}
```

Sem relação com `Company` (o log sobrevive à empresa; `companyId` é só referência). `metadata` nunca contém senha, pfx, XML, token ou dados do certificado além da validade.

## 5. Rastreabilidade

### 5.1 `RequestContext` e `requestId`
- `RequestContext.run({ requestId }, next)` no middleware; `RequestContext.get()` em qualquer ponto do request; `RequestContext.set({ userId })` chamado pelo `JwtAuthGuard` após validar o token.
- Header de resposta `x-request-id` sempre presente (inclusive em erros — o filtro global também inclui `requestId` no body: `{ statusCode, message, details?, requestId }`).

### 5.2 Logger
- `PinoLoggerService` implementa `LoggerService` (`log/error/warn/debug/verbose`) e mescla `{ requestId, userId }` do contexto em cada linha.
- O log de acesso vive em `request-id.middleware.ts` (não num interceptor), para cobrir também requests rejeitados por guards (ex.: TrialGuard). Uma linha por request via `logger.access(...)`, com os campos estruturados `{ msg: 'request', method, path, statusCode, durationMs }` (mais `context: 'HTTP'` e `requestId`/`userId` do `RequestContext`); `path` nunca inclui a query string. `/health` fica em `debug` para não poluir.
- Nível via env `LOG_LEVEL` (`fatal|error|warn|info|debug|trace`, default `info`; `debug` em development).

### 5.3 Auditoria
`AuditService.record(entry)`: `{ action, companyId?, entityType?, entityId?, outcome?, statusCode?, metadata? }` — `userId`, `requestId`, `ip`, `userAgent` vêm do `RequestContext`/request. Ações registradas:

| Service | action | metadata |
|---|---|---|
| companies | `company.created` | `{ cnpj }` |
| companies | `company.updated` | `{ fields: [...] }` (nomes dos campos alterados) |
| companies | `certificate.uploaded` | `{ certificateExpiry, subjectCn }` |
| customers | `customer.created` / `customer.updated` / `customer.deleted` | `{ documento }` (+ `fields` no update) |
| invoices | `invoice.emitted` | `{ dpsNumero, chaveAcesso, numeroNfse, valor, tomadorDocumento, customerId }` |
| invoices | `invoice.rejected` (FAILURE, 422) | `{ dpsNumero, code, reason }` |
| invoices | `invoice.pending` (FAILURE, 502) | `{ dpsNumero }` |
| invoices | `invoice.cancelled` | `{ chaveAcesso, motivo }` |
| invoices | `invoice.cancel_rejected` (FAILURE, 422) | `{ chaveAcesso, code, reason }` |
| trial guard | `trial.blocked` (FAILURE, 402) | `{ method, path, trialEndsAt }` |

`GET /audit-logs?page=&limit=&action=&from=&to=` → paginado `{ data, page, limit, total }`, ordem `occurredAt desc`, escopo `companyId` da empresa do usuário. Resposta: `{ id, occurredAt, action, entityType, entityId, outcome, statusCode, metadata, requestId }` (sem `ip`/`userAgent` — ficam só no banco). Liberado com trial vencido. Retenção: 5 anos (documentado; sem job nesta versão).

## 6. Trial guard

- `@AllowExpiredTrial()` → `SetMetadata('allowExpiredTrial', true)`; `TrialGuard` usa `Reflector.getAllAndOverride` (handler e classe), como o `@Public()`.
- Guard: se `@Public()` → `true`. Busca `company` por `userId` (`select id, plan, trialEndsAt, cnpj, ...` — a entidade inteira) e anexa em `request.company`. Sem empresa → `true`. Se `isTrialExpired(company)` e sem `@AllowExpiredTrial()` → grava `trial.blocked` na auditoria e lança `HttpException({ message: 'Trial expired', details: { trialEndsAt } }, 402)`.
- Marcação de rotas:

| Liberado com trial vencido (`@AllowExpiredTrial()`) | Bloqueado |
|---|---|
| `GET /companies/me`, `PATCH /companies/me`, `PUT /companies/me/certificate` | `POST /companies` (sem empresa passa de qualquer jeito) |
| `GET /invoices`, `GET /invoices/:id`, `/xml`, `/pdf`, `POST /invoices/:id/cancel` | `POST /invoices` |
| `GET /customers`, `GET /customers/:id` | `POST/PATCH/DELETE /customers` |
| `GET /audit-logs`, `GET /alerts`, `GET /health` (público) | — |

- `InvoicesService.emit` deixa de chamar `assertCanEmit`; `CompaniesService.assertCanEmit` é substituído por `isTrialExpired(company): boolean`.

## 7. CPF/CNPJ

- `src/common/validators/document.ts`: `isValidCpf(v)`, `isValidCnpj(v)` (dígitos verificadores; rejeita todos-iguais), decorators class-validator `@IsCpfOrCnpj()` e `@IsCnpj()` com mensagens `"<campo> must be a valid CPF or CNPJ"` / `"<campo> must be a valid CNPJ"`.
- Aplicação: `CreateCompanyDto.cnpj` (`@IsCnpj`), `CreateCustomerDto.documento` e `UpdateCustomerDto.documento` (`@IsCpfOrCnpj`), `CreateInvoiceDto.tomadorDocumento` (`@IsCpfOrCnpj`).
- Fixtures válidos para e2e/Postman/docs: CNPJ `11222333000181` (empresa), `11444777000161` (cliente); CPF `12345678909`, `52998224725`. Testes unitários de service não passam pelo DTO e ficam como estão.

## 8. Alertas — `GET /alerts`

Resposta `{ alerts: Alert[] }`, `Alert = { code, severity: 'info' | 'warning' | 'critical', message, data }`. Ordem: `critical` → `warning` → `info`. Regras (avaliadas sobre a empresa do usuário; 404 sem empresa):

| code | condição | severity | data |
|---|---|---|---|
| `CERTIFICATE_MISSING` | sem certificado | warning | — |
| `CERTIFICATE_EXPIRED` | `certificateExpiry < now` | critical | `{ expiredAt }` |
| `CERTIFICATE_EXPIRING` | vence em ≤ 30 dias | warning | `{ expiresAt, daysLeft }` |
| `TRIAL_EXPIRED` | `isTrialExpired` | critical | `{ trialEndsAt }` |
| `TRIAL_ENDING` | TRIAL e faltam ≤ 5 dias | warning | `{ trialEndsAt, daysLeft }` |
| `INVOICES_PENDING` | notas `PENDING` criadas há > 10 min | warning | `{ count }` |

`AlertsService` depende de `CompaniesService.findMine` e de um novo `InvoicesService.countStalePending(userId, olderThanMinutes)`. Mensagens em português.

## 9. Erros

Formato mantido, com `requestId` acrescentado: `{ statusCode, message, details?, requestId }`. Novo uso do `402` pelo guard (mesmo body de antes).

## 10. Testes

| Spec | Casos |
|---|---|
| `common/request-context.spec.ts` | `run/get/set`, isolamento entre contextos concorrentes |
| `common/request-id.middleware.spec.ts` | usa header válido; gera uuid quando ausente/inválido; devolve header |
| `common/logger/pino-logger.service.spec.ts` | mescla `requestId/userId`; níveis; sem contexto não quebra |
| `common/validators/document.spec.ts` | CPFs/CNPJs válidos e inválidos, repetidos, tamanho errado; decorators via `validateSync` |
| `modules/companies/trial.guard.spec.ts` | público passa; sem empresa passa; ACTIVE passa; TRIAL vigente passa; vencido + `@AllowExpiredTrial` passa; vencido sem decorator → 402 e `audit.record('trial.blocked')`; anexa `request.company` |
| `modules/audit/audit.service.spec.ts` | `record` preenche contexto; falha do prisma não propaga (loga); `findAll` monta `where` (companyId, action, período) e paginação; resposta sem `ip/userAgent` |
| `modules/companies/companies.service.spec.ts` | `isTrialExpired`; `create/update/setCertificate` chamam `audit.record` com a action/metadata certos |
| `modules/customers/customers.service.spec.ts` | `create/update/remove` auditam |
| `modules/invoices/invoices.service.spec.ts` | emitted/rejected/pending/cancelled/cancel_rejected auditados; `emit` não chama mais `assertCanEmit`; `countStalePending` |
| `modules/alerts/alerts.service.spec.ts` | cada regra e a ordenação por severidade |
| `app.e2e.spec.ts` | header `x-request-id` em sucesso e erro (+ no body de erro); trial vencido: `POST /invoices` 402, `GET /invoices` 200, `POST /customers` 402, `GET /audit-logs` 200 contendo `trial.blocked`; `GET /alerts` traz `TRIAL_EXPIRED`; `POST /companies` com CNPJ inválido → 400 |

## 11. Entregáveis fora do código

Migration; `.env.example` (`LOG_LEVEL`, `LOG_PRETTY`); README (rastreabilidade, política do trial, auditoria/retenção, CPF/CNPJ); `docs/frontend/api-brief.md` (`requestId`, `GET /alerts`, `GET /audit-logs`, política do trial, validação de documento); Postman (pastas **Alerts** e **Audit**, fixtures válidos, `info.version` 0.3.0); `package.json` 0.3.0.

## 12. Fora deste ciclo

E-mail de alertas; job de retenção; export CSV da auditoria; CNPJ alfanumérico; cache da empresa entre guard e services (o guard anexa `request.company`, mas os services continuam com suas próprias consultas — otimização futura).
