# Emissor de NFS-e para MEI — Backend (MVP)

**Data:** 2026-09-11
**Status:** aprovado para planejamento

## 1. Objetivo

Backend que permite a um MEI emitir, consultar, baixar e cancelar NFS-e
através da **API do Sistema Nacional NFS-e** (Emissor Público Nacional,
gov.br). O MVP existe para validar se o produto funciona; tudo que não é
necessário para emitir uma nota ponta a ponta fica fora.

## 2. Contexto e restrições

- A API Nacional é gratuita, mas **exige certificado digital ICP-Brasil
  (e-CNPJ A1)** para autenticar (mTLS) e assinar o XML da DPS. Login gov.br
  só funciona no portal/app, não na API.
- Cobre apenas **NFS-e (serviços)**. NF-e de produto (SEFAZ) está fora.
- Ambiente de **produção restrita** (sandbox) também exige certificado
  válido; notas emitidas lá não têm valor fiscal, com qualquer valor.
- Hoje não há certificado disponível. O desenvolvimento acontece contra um
  gateway **fake**; a integração real é ligada quando um e-CNPJ A1 for
  emitido.
- Endpoints da API Nacional usados (Manual dos Contribuintes v1.2, out/2025):
  `POST /nfse`, `GET /nfse/{chaveAcesso}`, `POST /nfse/{chaveAcesso}/eventos`,
  `GET /dps/{id}`, `GET /parametros_municipais/...` (este último fora do MVP).
  Produção restrita: `https://adn.producaorestrita.nfse.gov.br`.

## 3. Decisões

| Tema | Decisão |
|---|---|
| Framework | NestJS, padrão controller/service/module/dto, sem camadas extras |
| Identidade | **Logto** self-hosted (container). A API não tem módulo de usuários; só valida JWT via JWKS e usa `sub` como `userId` |
| Banco | PostgreSQL + **Prisma** |
| Integração fiscal | Direta na API Nacional (sem intermediário). Uma única abstração: `NfseGateway` (fake / real) |
| Emissão | Síncrona: request → API Nacional → resposta. Sem fila |
| Multi-tenant | 1 usuário = 1 empresa no MVP |
| Certificado | `.pfx` + senha guardados criptografados (AES-256-GCM, chave em env) |
| Testes | Jest; specs em `test/` espelhando `src/`; mocks, sem banco real (exceto um e2e mínimo) |
| Tooling | pnpm, `class-validator`/`class-transformer` nos DTOs, validação de env na subida |
| Idioma do código | Inglês, com termos fiscais em português (`dps`, `nfse`, `tomador`, `chaveAcesso`) |
| Infra local | `docker-compose`: `postgres`, `logto` (com seu próprio Postgres), `api` |

## 4. Arquitetura

```
[Cliente] --JWT (Logto)--> [NestJS API] --Prisma--> [Postgres]
                               |
                               +--NfseGateway--> [API Nacional NFS-e]
                                    (fake | real: mTLS + XML assinado)
```

`NFSE_ENV=fake | producao-restrita | producao` escolhe a implementação do
gateway e a URL base.

## 5. Estrutura de pastas

```
src/
├── main.ts
├── app.module.ts
├── config/                 # validação de env: DATABASE_URL, LOGTO_ISSUER, LOGTO_AUDIENCE,
│                           # CERT_ENCRYPTION_KEY (32 bytes hex), NFSE_ENV, NFSE_BASE_URL
├── prisma/                 # PrismaModule (global) + PrismaService
└── modules/
    ├── auth/               # JwtAuthGuard (passport-jwt + jwks-rsa), decorator @CurrentUser()
    ├── companies/          # controller, service, module, dto/
    ├── invoices/           # controller, service, module, dto/
    └── nfse/               # integração — sem controller
        ├── nfse.module.ts
        ├── nfse-gateway.ts             # interface NfseGateway + token NFSE_GATEWAY
        ├── fake-nfse.gateway.ts
        ├── national-nfse.gateway.ts
        ├── dps-builder.ts
        ├── xml-signer.ts
        ├── errors.ts                   # NfseRejectedError, NfseUnavailableError
        └── crypto/certificate-vault.ts
test/
├── app.e2e-spec.ts
└── modules/                # espelho de src/modules — todos os .spec.ts ficam aqui
    ├── auth/jwt-auth.guard.spec.ts
    ├── companies/companies.service.spec.ts
    ├── invoices/invoices.service.spec.ts
    └── nfse/
        ├── dps-builder.spec.ts
        ├── xml-signer.spec.ts
        ├── certificate-vault.spec.ts
        └── fake-nfse.gateway.spec.ts
```

Jest: `roots: ['<rootDir>/test']`, alias `@/` → `src/`. Nenhum `.spec.ts`
dentro de `src/`.

## 6. Componentes

| Unidade | Faz | Depende de |
|---|---|---|
| `AuthModule` | Valida JWT do Logto (JWKS), injeta `userId` (`sub`) | config |
| `CompaniesService` | CRUD da empresa do usuário; recebe `.pfx` + senha, valida abrindo o pfx, extrai validade, criptografa e salva | `PrismaService`, `CertificateVault` |
| `InvoicesService` | Valida entrada, carrega empresa + certificado, chama o gateway, persiste `Invoice` | `PrismaService`, `NfseGateway`, `CertificateVault` |
| `NfseGateway` (interface) | `emit(dps, cert) → { chaveAcesso, numeroNfse, xmlDps, xmlNfse }`, `get(chave)`, `cancel(chave, motivo, cert)`, `pdf(chave, cert) → Buffer` | — |
| `FakeNfseGateway` | Implementação em memória; sucesso por padrão, rejeição configurável | — |
| `NationalNfseGateway` | HTTP real: agente https com `pfx` (mTLS), DPS assinada, gzip + base64 conforme leiaute; traduz respostas em `NfseRejectedError` / `NfseUnavailableError` | `DpsBuilder`, `XmlSigner`, axios/https |
| `DpsBuilder` | Dados tipados → XML da DPS (leiaute nacional). Função pura | — |
| `XmlSigner` | Assina XML (XML-DSig) com a chave do A1 | `xml-crypto`, `node-forge` (abrir pfx) |
| `CertificateVault` | `encrypt(buffer)` / `decrypt(buffer)` AES-256-GCM (`iv + tag + ciphertext`) | `CERT_ENCRYPTION_KEY` |

Regras de fronteira: módulos expõem apenas o service; nenhum service acessa
tabelas de outro módulo; `nfse/` não conhece usuário nem banco — recebe
dados e certificado, devolve resultado.

## 7. Modelo de dados (Prisma)

```prisma
enum InvoiceStatus {
  PENDING
  ISSUED
  REJECTED
  CANCELLED
}

model Company {
  id                 String    @id @default(uuid())
  userId             String    @unique   // sub do JWT (Logto)
  cnpj               String    @unique
  razaoSocial        String
  inscricaoMunicipal String?
  codigoMunicipio    String              // IBGE, 7 dígitos
  email              String?
  telefone           String?
  certificatePfx     Bytes?              // .pfx criptografado
  certificatePass    String?             // senha criptografada (base64 do payload AES-GCM)
  certificateExpiry  DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  invoices           Invoice[]
}

model Invoice {
  id               String        @id @default(uuid())
  companyId        String
  company          Company       @relation(fields: [companyId], references: [id])
  status           InvoiceStatus @default(PENDING)
  dpsNumero        Int
  dpsSerie         String        @default("1")
  tomadorDocumento String                 // CPF ou CNPJ, só dígitos
  tomadorNome      String
  tomadorEmail     String?
  descricao        String
  valor            Decimal       @db.Decimal(12, 2)
  codigoTributacao String                 // código nacional de tributação, ex. "01.01.01"
  chaveAcesso      String?       @unique
  numeroNfse       String?
  xmlDps           String?
  xmlNfse          String?
  rejectionReason  String?
  cancelledAt      DateTime?
  cancelReason     String?
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt

  @@unique([companyId, dpsSerie, dpsNumero])
}
```

- `dpsNumero` é sequencial por empresa, gerado em transação
  (`max(dpsNumero) + 1`); a API Nacional exige unicidade
  município + CNPJ + série + número.
- Os dois XMLs são persistidos para auditoria e re-download sem bater na
  API. PDF (DANFSe) não é persistido.

## 8. Endpoints

Todos exigem `Authorization: Bearer <JWT Logto>`. A empresa é sempre
resolvida pelo `userId` do token — nunca por id na URL.

### Companies

| Método | Rota | Comportamento |
|---|---|---|
| `POST` | `/companies` | Cria a empresa do usuário. `409` se já existe |
| `GET` | `/companies/me` | Dados da empresa. Nunca retorna pfx/senha; expõe `certificateExpiry` e `hasCertificate` |
| `PATCH` | `/companies/me` | Atualiza dados fiscais |
| `PUT` | `/companies/me/certificate` | multipart `file` (.pfx, ≤ 10 KB) + `password`. Abre o pfx para validar senha, extrai validade, criptografa, salva. `422` se inválido |

### Invoices

| Método | Rota | Comportamento |
|---|---|---|
| `POST` | `/invoices` | Emite (fluxo abaixo) |
| `GET` | `/invoices` | Lista paginada da empresa: `?status=&page=&limit=` |
| `GET` | `/invoices/:id` | Detalhe. `404` se não pertence à empresa do usuário |
| `GET` | `/invoices/:id/xml` | XML da NFS-e (do banco). `404` se não `ISSUED`/`CANCELLED` |
| `GET` | `/invoices/:id/pdf` | DANFSe — proxy para a API Nacional |
| `POST` | `/invoices/:id/cancel` | body `{ motivo }`. Só para `ISSUED`; registra evento de cancelamento; vira `CANCELLED` |

### Fluxo de emissão (`POST /invoices`)

1. Valida DTO: `tomadorDocumento` (CPF/CNPJ válido), `tomadorNome`,
   `descricao`, `valor > 0`, `codigoTributacao` no formato `NN.NN.NN`.
2. Carrega empresa do usuário. `422` se sem certificado ou vencido.
3. Transação: gera `dpsNumero`, cria `Invoice` com `PENDING`.
4. `CertificateVault.decrypt` → `NfseGateway.emit(dpsData, cert)`.
5. Resultado:
   - sucesso → `ISSUED` + `chaveAcesso`, `numeroNfse`, `xmlDps`, `xmlNfse`;
   - `NfseRejectedError` → `REJECTED` + `rejectionReason`; responde `422`
     com o motivo;
   - `NfseUnavailableError` → permanece `PENDING`; responde `502`.
6. Retorna a `Invoice`.

Reconciliação de `PENDING` (via `GET /dps/{id}`) fica fora do MVP; o status
já deixa isso possível.

## 9. Erros

- Exceções HTTP padrão do Nest + filtro global que padroniza o body:
  `{ statusCode, message, details? }`.
- O gateway real traduz toda resposta da API Nacional em
  `NfseRejectedError` (regra de negócio; carrega código e mensagem do fisco)
  ou `NfseUnavailableError` (rede/5xx/timeout). `InvoicesService` só
  conhece essas duas.

## 10. Segurança

- Certificado nunca sai da API: nenhum endpoint devolve pfx ou senha; logs
  não imprimem o buffer nem a senha.
- `CERT_ENCRYPTION_KEY` (32 bytes, hex) obrigatória; app não sobe sem ela.
- Upload de certificado limitado a 10 KB e MIME `application/x-pkcs12`.
- `@nestjs/throttler` em `POST /invoices`.
- Toda consulta de `Invoice` filtra por `companyId` da empresa do usuário.

## 11. Testes

Todos em `test/`, Jest, dependências mockadas (`PrismaService`,
`NfseGateway`, `CertificateVault`). Sem banco real nos unitários.

| Spec | Casos |
|---|---|
| `companies.service.spec.ts` | cria; `409` na segunda; atualiza; upload rejeita pfx inválido e senha errada; extrai validade; resposta nunca contém pfx/senha |
| `invoices.service.spec.ts` | emite com sucesso; `422` sem certificado; `422` certificado vencido; rejeição → `REJECTED`; indisponível → `PENDING` + `502`; cancela só `ISSUED`; `dpsNumero` sequencial; não acessa invoice de outra empresa |
| `dps-builder.spec.ts` | XML contém campos obrigatórios do leiaute; snapshot |
| `xml-signer.spec.ts` | assina com pfx auto-assinado de fixture; assinatura valida |
| `certificate-vault.spec.ts` | round-trip; chave errada falha; payloads diferentes para mesmo input (iv aleatório) |
| `fake-nfse.gateway.spec.ts` | sucesso padrão; rejeição configurável; cancel/get/pdf |
| `jwt-auth.guard.spec.ts` | válido; inválido; expirado; issuer/audience errados (JWKS mockado) |
| `app.e2e-spec.ts` | sobe o app com `FakeNfseGateway` e Postgres do compose; caminho feliz: cria empresa → sobe certificado de fixture → emite → lista |

## 12. Fora do MVP

Reconciliação de `PENDING`; fila assíncrona; múltiplas empresas por
usuário; tomadores salvos; substituição de nota; consulta de parâmetros
municipais; NF-e de produto; notificações; relatórios.

## 13. Referências

- Manual dos Contribuintes – API Sistema Nacional NFS-e v1.2 (out/2025):
  https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-emissor-publico-api-sistema-nacional-nfs-e-v1-2-out2025.pdf
- Swagger Contribuintes ISSQN: https://www.nfse.gov.br/swagger/contribuintesissqn/
- Produção restrita: https://adn.producaorestrita.nfse.gov.br/contribuintes/docs/index.html
- Leiautes DPS/NFS-e e eventos: anexos I e II do manual acima
