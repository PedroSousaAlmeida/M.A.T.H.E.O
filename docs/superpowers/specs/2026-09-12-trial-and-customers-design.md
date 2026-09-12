# Trial de 30 dias + Tomadores salvos — Backend (v0.2.0)

**Data:** 2026-09-12
**Status:** aprovado para planejamento
**Base:** branch `dev` após o MVP (spec `2026-09-11-nfse-emitter-backend-design.md`). Este documento só descreve o que muda.

## 1. Objetivo

1. **Trial**: toda empresa nasce com 30 dias grátis; após o prazo, só a emissão de notas é bloqueada até a empresa virar paga (cobrança fica fora deste ciclo — a mudança de plano é manual no banco).
2. **Tomadores salvos** (clientes recorrentes): CRUD por empresa e uso direto na emissão, para que o MEI não redigite CPF/CNPJ e nome a cada nota.

## 2. Decisões

| Tema | Decisão |
|---|---|
| Onde vive o trial | No nosso banco (`Company`), não no Logto. Começa no `POST /companies`, não no registro do Logto |
| O que o trial bloqueia | Só `POST /invoices` → `402 Payment Required`. Consultar, baixar, cancelar e editar empresa continuam |
| Plano | enum `Plan { TRIAL, ACTIVE }`; `ACTIVE` nunca expira. Sem endpoint para mudar plano nesta versão |
| Módulo de tomadores | `src/modules/customers/` (nome em inglês; campos fiscais em português). Escopo sempre pela empresa do JWT |
| Nota × cliente | A nota guarda **cópia** dos dados do tomador (como hoje). Mudar o cliente depois não altera notas emitidas. A nota referencia o cliente por `customerId` opcional, só para rastreio |
| Emissão | `POST /invoices` aceita `customerId` **ou** os campos `tomador*` (exatamente um dos dois). Com `tomador*` + `saveCustomer: true`, o cliente é criado (ou reaproveitado se o documento já existir) |
| Versão | `0.2.0` (minor: funcionalidade nova compatível — os campos `tomador*` continuam aceitos) |
| Padrões | Mesmos do MVP: NestJS controller/service/module/dto, Prisma, specs em `test/` espelhando `src/`, `bun test`, commits convencionais |

## 3. Modelo de dados (Prisma — diff)

```prisma
enum Plan {
  TRIAL
  ACTIVE
}

model Company {
  // ... campos existentes
  plan        Plan      @default(TRIAL)
  trialEndsAt DateTime                       // preenchido pelo service: now + 30 dias
  customers   Customer[]
}

model Customer {
  id        String   @id @default(uuid())
  companyId String
  company   Company  @relation(fields: [companyId], references: [id])
  documento String                           // CPF (11) ou CNPJ (14), só dígitos
  nome      String
  email     String?
  telefone  String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  invoices  Invoice[]

  @@unique([companyId, documento])
  @@index([companyId, nome])
  @@map("customers")
}

model Invoice {
  // ... campos existentes
  customerId String?
  customer   Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)
}
```

Migration: `trialEndsAt` é `NOT NULL`; para linhas existentes a migration preenche `createdAt + 30 dias` (SQL escrito à mão na migration gerada).

## 4. Trial

- `CompaniesService.create` grava `plan: TRIAL`, `trialEndsAt: now + 30d` (constante `TRIAL_DAYS = 30`).
- `CompanyResponse` ganha `plan` e `trialEndsAt`.
- `CompaniesService.assertCanEmit(company)`: se `plan === TRIAL && trialEndsAt < now` → lança `HttpException({ message: 'Trial expired', details: { trialEndsAt } }, 402)`. Chamado por `InvoicesService.emit` logo após `getCompanyWithCertificate` (antes de gerar numeração — nota não é criada).
- Mudar para `ACTIVE`: manual (`UPDATE companies SET plan='ACTIVE'`). Documentado no README.

## 5. Tomadores (customers)

### Endpoints (todos sob `/api/v0`, JWT obrigatório, escopo = empresa do usuário)

| Método | Rota | Comportamento |
|---|---|---|
| `POST` | `/customers` | cria. `409` se já existe cliente com o mesmo `documento` na empresa |
| `GET` | `/customers?search=&page=&limit=` | lista paginada (`{ data, page, limit, total }`), ordem por `nome`. `search` filtra por `nome` (contains, case-insensitive) **ou** `documento` (startsWith) |
| `GET` | `/customers/:id` | detalhe. `404` se não pertence à empresa |
| `PATCH` | `/customers/:id` | atualiza `nome`, `email`, `telefone`, `documento` (`409` se colidir) |
| `DELETE` | `/customers/:id` | remove. Notas antigas mantêm a cópia dos dados e ficam com `customerId = null` (`onDelete: SetNull`). `204` |

DTOs: `documento` `^(\d{11}|\d{14})$`; `nome` 2–150; `email` opcional válido; `telefone` opcional 10–11 dígitos; `search` opcional 1–100; `page`/`limit` como em invoices.

`CustomerResponse`: `{ id, documento, nome, email, telefone, createdAt, updatedAt }`.

`CustomersService` expõe também `findEntity(userId, id)` (404) e `findOrCreateByDocumento(companyId, data)` para uso interno da emissão — nunca acessa tabelas de outro módulo além de `companies.findMine(userId)` para resolver `companyId`.

### Emissão com cliente

`CreateInvoiceDto` passa a ter:

```ts
customerId?: string;            // uuid
tomadorDocumento?: string;      // continuam existindo, mas passam a ser opcionais
tomadorNome?: string;
tomadorEmail?: string;
saveCustomer?: boolean;         // default false; só faz sentido com tomador*
descricao, valor, codigoTributacao   // inalterados
```

Regra (validada no service, `400` com mensagem clara):
- exatamente um de `customerId` **ou** (`tomadorDocumento` + `tomadorNome`);
- `saveCustomer` só com `tomador*`.

Fluxo em `InvoicesService.emit`:
1. `getCompanyWithCertificate` → `assertCanEmit` (trial).
2. Resolve o tomador: com `customerId` → `customers.findEntity` (404 se não é da empresa) e copia `documento/nome/email`; com `tomador*` e `saveCustomer` → `customers.findOrCreateByDocumento`; senão usa os campos como hoje.
3. Cria a nota com a cópia dos dados e `customerId` (quando houver). Resto igual ao MVP.

`InvoiceResponse` ganha `customerId: string | null`.

## 6. Erros

Só um código novo: **`402`** `{ statusCode: 402, message: 'Trial expired', details: { trialEndsAt } }`. Os demais seguem o formato existente.

## 7. Testes

| Spec | Casos novos |
|---|---|
| `companies.service.spec.ts` | `create` grava `TRIAL` + `trialEndsAt = now + 30d` (tolerância de 5 s); `assertCanEmit` passa em TRIAL vigente e em ACTIVE vencido, lança 402 em TRIAL vencido |
| `customers.service.spec.ts` (novo) | cria; 409 documento duplicado; lista com `search` por nome e por documento (verifica o `where` montado); detalhe escopado; 404 de outra empresa; update; update com colisão 409; delete; `findOrCreateByDocumento` reaproveita existente |
| `invoices.service.spec.ts` | emit com `customerId` copia dados do cliente e grava `customerId`; `customerId` de outra empresa → 404; `tomador*` + `saveCustomer` cria cliente e grava `customerId`; nem `customerId` nem `tomador*` → 400; ambos → 400; trial vencido → 402 e nenhuma nota criada |
| `app.e2e.spec.ts` | fluxo ganha: criar cliente → emitir com `customerId` → nota traz `customerId` e dados copiados; listar clientes com `search` |

## 8. Entregáveis fora do código

- Migration Prisma commitada.
- Collection Postman: pasta **Customers** (5 requests) + `POST /invoices` com exemplo usando `customerId`; `info.version` = `0.2.0`.
- `docs/frontend/api-brief.md`: seção de tomadores, novos campos de `Company`/`Invoice`, erro 402.
- README: como ativar um plano manualmente.
- `package.json` → `0.2.0`.

## 9. Fora deste ciclo

Cobrança/checkout; endpoint de troca de plano; serviços salvos; validação de dígito verificador de CPF/CNPJ (fica para o ciclo seguinte, como combinado); importação de clientes em massa.
