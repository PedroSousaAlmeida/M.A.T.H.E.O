# NFS-e Emitter Backend (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A NestJS backend, running on Bun, that lets a MEI register their company + A1 certificate and emit, list, download and cancel NFS-e through the national NFS-e API (with a fake gateway until a real certificate exists).

**Architecture:** Modular NestJS monolith (`src/modules/{auth,companies,invoices,nfse}`), Prisma 7 + PostgreSQL, Logto as the identity provider (the API only verifies JWTs). The only abstraction is `NfseGateway`, with a `FakeNfseGateway` (dev/test) and a `NationalNfseGateway` (mTLS + signed DPS XML). Emission is synchronous.

**Tech Stack:** Bun (runtime, package manager, `bun test`), NestJS 11 (express platform), Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`), PostgreSQL 17, Logto (docker), `jose` (JWT/JWKS), `node-forge` (pfx → PEM), `xml-crypto` (XML-DSig), `zod` (env validation), `class-validator`/`class-transformer` (DTOs), `@nestjs/throttler`, `multer`, `supertest` (e2e).

**Spec:** `docs/superpowers/specs/2026-09-11-nfse-emitter-backend-design.md`

## Global Constraints

- Runtime: **Bun** for everything (`bun install`, `bun run`, `bun test`). No `node`/`npm`/`pnpm` commands in scripts.
- All application modules live under `src/modules/`. `src/config/` and `src/prisma/` are the only non-module folders in `src/`.
- All `.spec.ts` files live under `test/`, mirroring `src/`. **No spec file inside `src/`.**
- Tests import source via the `@/` alias (`@/modules/...`). `bunfig.toml` sets `[test] root = "test"`.
- Code in English; fiscal terms stay in Portuguese (`dps`, `nfse`, `tomador`, `chaveAcesso`, `prestador`).
- 1 user = 1 company. Company is always resolved from the JWT `sub`, never from a URL id.
- Certificate (`.pfx` + password) is stored encrypted with AES-256-GCM using `CERT_ENCRYPTION_KEY` (32 bytes, hex). It is never returned by any endpoint and never logged.
- Emission is synchronous. No queue.
- `NFSE_ENV=fake | producao-restrita | producao` selects the gateway implementation.
- Error body format everywhere: `{ statusCode, message, details? }`.
- Commit after every task with a conventional-commit message.

**Deviations from the spec (small, deliberate):**
- JWT verification uses `jose` (`jwtVerify` + `createRemoteJWKSet`) instead of `passport-jwt` + `jwks-rsa` — it's what Logto's own docs use, works in Bun without passport, and is trivially testable by injecting a local key.
- `NfseGateway` has no `get(chave)` method: no MVP endpoint uses it (XML is served from the DB, reconciliation is out of scope).
- Certificate access from `InvoicesService` goes through `CompaniesService.getCertificate(userId)` instead of using `CertificateVault` directly, so only `companies` touches the vault and the `Company` table.
- Certificate upload is validated by actually opening the `.pfx` (more reliable than MIME checks, which browsers/curl set inconsistently). Size limit of 10 KB stays.

---

## File structure

```
.
├── package.json, bunfig.toml, tsconfig.json, .env.example, .gitignore, Dockerfile, docker-compose.yml
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── prisma.config.ts
├── generated/prisma/            # prisma generate output (gitignored)
├── src/
│   ├── main.ts                  # bootstrap: ValidationPipe, HttpExceptionFilter, listen
│   ├── app.module.ts            # ConfigModule + PrismaModule + feature modules + global guard
│   ├── config/
│   │   └── env.ts               # zod schema + validateEnv() + Env type
│   ├── prisma/
│   │   ├── prisma.module.ts
│   │   └── prisma.service.ts
│   ├── common/
│   │   └── http-exception.filter.ts
│   └── modules/
│       ├── health/health.controller.ts
│       ├── auth/
│       │   ├── auth.module.ts
│       │   ├── jwks.provider.ts         # JWKS injection token + factory
│       │   ├── jwt-auth.guard.ts
│       │   ├── public.decorator.ts
│       │   └── current-user.decorator.ts
│       ├── companies/
│       │   ├── companies.module.ts
│       │   ├── companies.controller.ts
│       │   ├── companies.service.ts
│       │   └── dto/create-company.dto.ts, update-company.dto.ts, upload-certificate.dto.ts
│       ├── invoices/
│       │   ├── invoices.module.ts
│       │   ├── invoices.controller.ts
│       │   ├── invoices.service.ts
│       │   └── dto/create-invoice.dto.ts, list-invoices.dto.ts, cancel-invoice.dto.ts
│       └── nfse/
│           ├── nfse.module.ts
│           ├── nfse-gateway.ts          # NfseGateway interface, DpsData, EmitResult, NFSE_GATEWAY token
│           ├── errors.ts                # NfseRejectedError, NfseUnavailableError, InvalidCertificateError
│           ├── certificate.ts           # loadCertificate(pfx, password) → LoadedCertificate
│           ├── dps-builder.ts           # buildDpsXml(), buildCancelEventXml()
│           ├── xml-signer.ts            # signXml(), verifyXmlSignature()
│           ├── fake-nfse.gateway.ts
│           ├── national-nfse.gateway.ts
│           └── crypto/certificate-vault.ts
└── test/
    ├── helpers/test-certificate.ts      # generates a self-signed pfx for tests
    ├── helpers/prisma-mock.ts
    ├── app.e2e.spec.ts                  # skipped unless E2E_DATABASE_URL is set
    └── modules/ ... (mirror of src/modules, one spec per unit)
```

---

### Task 1: Project bootstrap (Bun + NestJS + config validation + health)

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `.env.example`
- Create: `src/main.ts`, `src/app.module.ts`, `src/config/env.ts`, `src/modules/health/health.controller.ts`
- Test: `test/config/env.spec.ts`

**Interfaces:**
- Produces: `validateEnv(raw: Record<string, unknown>): Env` and type `Env` (fields: `PORT`, `DATABASE_URL`, `LOGTO_ENDPOINT`, `LOGTO_API_RESOURCE`, `CERT_ENCRYPTION_KEY`, `NFSE_ENV`, `NFSE_SEFIN_URL`, `NFSE_ADN_URL`). Later tasks inject `ConfigService<Env, true>` and call `config.get('DATABASE_URL')` etc.

- [ ] **Step 1: Check Bun is installed**

Run: `bun --version`
Expected: a version ≥ 1.2. If missing: `curl -fsSL https://bun.sh/install | bash` and re-open the shell.

- [ ] **Step 2: Create package.json and install dependencies**

```json
{
  "name": "matheo-nfse-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/main.ts",
    "start": "bun run src/main.ts",
    "test": "bun test",
    "test:e2e": "E2E_DATABASE_URL=${E2E_DATABASE_URL:-$DATABASE_URL} bun test test/app.e2e.spec.ts",
    "prisma:generate": "bunx --bun prisma generate",
    "prisma:migrate": "bunx --bun prisma migrate dev",
    "postinstall": "bunx --bun prisma generate || true",
    "typecheck": "bunx tsc --noEmit"
  }
}
```

Run:
```bash
bun add @nestjs/common@^11 @nestjs/core@^11 @nestjs/platform-express@^11 @nestjs/config@^4 @nestjs/throttler@^6 reflect-metadata rxjs zod class-validator class-transformer jose node-forge xml-crypto @xmldom/xmldom xpath multer @prisma/client@^7 @prisma/adapter-pg pg
bun add -d typescript @types/node @types/multer @types/node-forge @types/express @types/pg @nestjs/testing@^11 supertest @types/supertest prisma@^7 bun-types
```

Expected: `bun.lock` created, no errors (the `postinstall` prints a Prisma error because there is no schema yet — the `|| true` swallows it; Task 2 fixes that).

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["bun-types", "node"],
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "test", "prisma.config.ts"]
}
```

- [ ] **Step 4: Create bunfig.toml, .gitignore and .env.example**

`bunfig.toml`:
```toml
[test]
root = "test"
```

`.gitignore`:
```
node_modules
generated/
.env
*.pfx
!test/fixtures/*.pfx
dist
```

`.env.example`:
```
PORT=3000
DATABASE_URL=postgresql://matheo:matheo@localhost:5432/matheo
# Logto (docker-compose exposes it on 3001; admin console on 3002)
LOGTO_ENDPOINT=http://localhost:3001
LOGTO_API_RESOURCE=https://api.matheo.local
# 32 random bytes as hex — generate with: bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CERT_ENCRYPTION_KEY=
# fake | producao-restrita | producao
NFSE_ENV=fake
# Only required when NFSE_ENV != fake. Confirm both against https://www.nfse.gov.br/swagger/contribuintesissqn/
NFSE_SEFIN_URL=https://sefin.producaorestrita.nfse.gov.br/SefinNacional
NFSE_ADN_URL=https://adn.producaorestrita.nfse.gov.br/contribuintes
```

- [ ] **Step 5: Write the failing env validation test**

`test/config/env.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { validateEnv } from '@/config/env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  LOGTO_ENDPOINT: 'http://localhost:3001',
  LOGTO_API_RESOURCE: 'https://api.matheo.local',
  CERT_ENCRYPTION_KEY: 'a'.repeat(64),
  NFSE_ENV: 'fake',
};

describe('validateEnv', () => {
  it('accepts a valid fake-env config and applies defaults', () => {
    const env = validateEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NFSE_ENV).toBe('fake');
  });

  it('rejects a CERT_ENCRYPTION_KEY that is not 32 bytes hex', () => {
    expect(() => validateEnv({ ...valid, CERT_ENCRYPTION_KEY: 'abc' })).toThrow(/CERT_ENCRYPTION_KEY/);
  });

  it('requires NFSE_SEFIN_URL and NFSE_ADN_URL when NFSE_ENV is not fake', () => {
    expect(() => validateEnv({ ...valid, NFSE_ENV: 'producao-restrita' })).toThrow(/NFSE_SEFIN_URL/);
  });

  it('rejects an unknown NFSE_ENV', () => {
    expect(() => validateEnv({ ...valid, NFSE_ENV: 'staging' })).toThrow(/NFSE_ENV/);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun test test/config/env.spec.ts`
Expected: FAIL — cannot resolve `@/config/env`.

- [ ] **Step 7: Implement src/config/env.ts**

```ts
import { z } from 'zod';

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    LOGTO_ENDPOINT: z.string().url(),
    LOGTO_API_RESOURCE: z.string().min(1),
    CERT_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'CERT_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex chars'),
    NFSE_ENV: z.enum(['fake', 'producao-restrita', 'producao']).default('fake'),
    NFSE_SEFIN_URL: z.string().url().optional(),
    NFSE_ADN_URL: z.string().url().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NFSE_ENV !== 'fake') {
      for (const key of ['NFSE_SEFIN_URL', 'NFSE_ADN_URL'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when NFSE_ENV=${env.NFSE_ENV}` });
        }
      }
    }
  });

export type Env = z.infer<typeof schema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test test/config/env.spec.ts`
Expected: 4 pass.

- [ ] **Step 9: Create the health controller, app module and main.ts**

`src/modules/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

`src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env';
import { HealthController } from './modules/health/health.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })],
  controllers: [HealthController],
})
export class AppModule {}
```

`src/main.ts`:
```ts
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import type { Env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}`);
}

bootstrap();
```

- [ ] **Step 10: Smoke-run the app**

Run:
```bash
cp .env.example .env
sed -i "s/^CERT_ENCRYPTION_KEY=.*/CERT_ENCRYPTION_KEY=$(bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))")/" .env
(bun run src/main.ts &) ; sleep 3 ; curl -s localhost:3000/health ; pkill -f "bun run src/main.ts"
```
Expected: `{"status":"ok"}`.

- [ ] **Step 11: Commit**

```bash
git add package.json bun.lock tsconfig.json bunfig.toml .gitignore .env.example src test
git commit -m "feat: bootstrap NestJS on Bun with validated env and health endpoint"
```

---

### Task 2: Docker infra + Prisma 7 schema and PrismaService

**Files:**
- Create: `docker-compose.yml`, `Dockerfile`, `prisma/schema.prisma`, `prisma.config.ts`
- Create: `src/prisma/prisma.module.ts`, `src/prisma/prisma.service.ts`
- Modify: `src/app.module.ts`
- Test: none (PrismaService is a thin wrapper; it is exercised by the e2e in Task 13)

**Interfaces:**
- Produces: `PrismaService` (global, extends the generated `PrismaClient`; has `company` and `invoice` delegates and `$transaction`). Generated types imported from `generated/prisma/client` (`Company`, `Invoice`, `InvoiceStatus`).

- [ ] **Step 1: Write docker-compose.yml**

```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: matheo
      POSTGRES_PASSWORD: matheo
      POSTGRES_DB: matheo
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U matheo"]
      interval: 5s
      retries: 10

  logto-db:
    image: postgres:17
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: p0stgr3s
      POSTGRES_DB: logto
    volumes: [logtodata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10

  logto:
    image: svhd/logto:latest
    depends_on:
      logto-db: { condition: service_healthy }
    entrypoint: ["sh", "-c", "npm run cli db seed -- --swe && npm start"]
    ports: ["3001:3001", "3002:3002"]
    environment:
      TRUST_PROXY_HEADER: 1
      DB_URL: postgres://postgres:p0stgr3s@logto-db:5432/logto
      ENDPOINT: http://localhost:3001
      ADMIN_ENDPOINT: http://localhost:3002

  api:
    build: .
    profiles: ["full"]          # `docker compose --profile full up` — by default run the API with `bun run dev` on the host
    depends_on:
      postgres: { condition: service_healthy }
    env_file: .env
    environment:
      DATABASE_URL: postgresql://matheo:matheo@postgres:5432/matheo
      LOGTO_ENDPOINT: http://logto:3001
    ports: ["3000:3000"]

volumes:
  pgdata:
  logtodata:
```

`Dockerfile`:
```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
COPY src ./src
EXPOSE 3000
CMD ["sh", "-c", "bunx --bun prisma migrate deploy && bun run src/main.ts"]
```

- [ ] **Step 2: Start Postgres**

Run: `docker compose up -d postgres && docker compose ps`
Expected: `postgres` healthy on 5432.

- [ ] **Step 3: Write prisma/schema.prisma and prisma.config.ts**

`prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
}

datasource db {
  provider = "postgresql"
}

enum InvoiceStatus {
  PENDING
  ISSUED
  REJECTED
  CANCELLED
}

model Company {
  id                 String    @id @default(uuid())
  userId             String    @unique
  cnpj               String    @unique
  razaoSocial        String
  inscricaoMunicipal String?
  codigoMunicipio    String
  email              String?
  telefone           String?
  certificatePfx     Bytes?
  certificatePass    String?
  certificateExpiry  DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  invoices           Invoice[]

  @@map("companies")
}

model Invoice {
  id               String        @id @default(uuid())
  companyId        String
  company          Company       @relation(fields: [companyId], references: [id])
  status           InvoiceStatus @default(PENDING)
  dpsNumero        Int
  dpsSerie         String        @default("1")
  tomadorDocumento String
  tomadorNome      String
  tomadorEmail     String?
  descricao        String
  valor            Decimal       @db.Decimal(12, 2)
  codigoTributacao String
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
  @@index([companyId, status])
  @@map("invoices")
}
```

`prisma.config.ts`:
```ts
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
```

- [ ] **Step 4: Generate the client and create the initial migration**

Run:
```bash
set -a; source .env; set +a
bunx --bun prisma generate
bunx --bun prisma migrate dev --name init
ls generated/prisma/client.ts prisma/migrations
```
Expected: `generated/prisma/` created, one migration folder `*_init`, no errors.

- [ ] **Step 5: Write PrismaService and PrismaModule**

`src/prisma/prisma.service.ts`:
```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import type { Env } from '../config/env';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super({ adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL', { infer: true }) }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

`src/prisma/prisma.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

- [ ] **Step 6: Register PrismaModule in AppModule**

`src/app.module.ts` — replace the `imports` line:
```ts
import { PrismaModule } from './prisma/prisma.module';
// ...
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule],
```

- [ ] **Step 7: Verify the app boots and connects**

Run: `(bun run src/main.ts &) ; sleep 4 ; curl -s localhost:3000/health ; pkill -f "bun run src/main.ts"`
Expected: `{"status":"ok"}` and no Prisma connection error in the output. Also run `bunx tsc --noEmit` — expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml Dockerfile prisma prisma.config.ts src
git commit -m "feat: add docker infra, Prisma schema and PrismaService"
```

---

### Task 3: CertificateVault (AES-256-GCM)

**Files:**
- Create: `src/modules/nfse/crypto/certificate-vault.ts`
- Test: `test/modules/nfse/crypto/certificate-vault.spec.ts`

**Interfaces:**
- Consumes: `ConfigService<Env, true>` → `CERT_ENCRYPTION_KEY` (64 hex chars).
- Produces: `@Injectable() CertificateVault` with `encrypt(plain: Buffer): Buffer`, `decrypt(payload: Buffer): Buffer`, `encryptString(text: string): string` (base64 payload), `decryptString(payload: string): string`. Payload layout: `iv(12) | authTag(16) | ciphertext`.

- [ ] **Step 1: Write the failing test**

`test/modules/nfse/crypto/certificate-vault.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { ConfigService } from '@nestjs/config';
import { CertificateVault } from '@/modules/nfse/crypto/certificate-vault';

const KEY_A = '11'.repeat(32);
const KEY_B = '22'.repeat(32);

function vaultWithKey(key: string) {
  const config = { get: () => key } as unknown as ConfigService;
  return new CertificateVault(config);
}

describe('CertificateVault', () => {
  it('round-trips a buffer', () => {
    const vault = vaultWithKey(KEY_A);
    const plain = Buffer.from('certificate-bytes');
    expect(vault.decrypt(vault.encrypt(plain)).equals(plain)).toBe(true);
  });

  it('round-trips a string as base64', () => {
    const vault = vaultWithKey(KEY_A);
    const payload = vault.encryptString('s3cret');
    expect(typeof payload).toBe('string');
    expect(vault.decryptString(payload)).toBe('s3cret');
  });

  it('produces different payloads for the same input (random iv)', () => {
    const vault = vaultWithKey(KEY_A);
    const plain = Buffer.from('same');
    expect(vault.encrypt(plain).equals(vault.encrypt(plain))).toBe(false);
  });

  it('fails to decrypt with another key', () => {
    const payload = vaultWithKey(KEY_A).encrypt(Buffer.from('x'));
    expect(() => vaultWithKey(KEY_B).decrypt(payload)).toThrow();
  });

  it('fails to decrypt a tampered payload', () => {
    const vault = vaultWithKey(KEY_A);
    const payload = vault.encrypt(Buffer.from('x'));
    payload[payload.length - 1] ^= 0xff;
    expect(() => vault.decrypt(payload)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/modules/nfse/crypto/certificate-vault.spec.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement the vault**

`src/modules/nfse/crypto/certificate-vault.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Env } from '../../../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

@Injectable()
export class CertificateVault {
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    this.key = Buffer.from(config.get('CERT_ENCRYPTION_KEY', { infer: true }), 'hex');
  }

  encrypt(plain: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): Buffer {
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  encryptString(text: string): string {
    return this.encrypt(Buffer.from(text, 'utf8')).toString('base64');
  }

  decryptString(payload: string): string {
    return this.decrypt(Buffer.from(payload, 'base64')).toString('utf8');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/modules/nfse/crypto/certificate-vault.spec.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/nfse/crypto test/modules/nfse/crypto
git commit -m "feat(nfse): add AES-256-GCM certificate vault"
```

---

### Task 4: Certificate loading (pfx → PEM) + test certificate helper

**Files:**
- Create: `src/modules/nfse/errors.ts`, `src/modules/nfse/certificate.ts`
- Create: `test/helpers/test-certificate.ts`
- Test: `test/modules/nfse/certificate.spec.ts`

**Interfaces:**
- Produces:
  - `errors.ts`: `class InvalidCertificateError extends Error`, `class NfseRejectedError extends Error { constructor(public readonly code: string, message: string) }`, `class NfseUnavailableError extends Error`.
  - `certificate.ts`: `interface LoadedCertificate { certPem: string; keyPem: string; notBefore: Date; notAfter: Date; subjectCn: string }` and `loadCertificate(pfx: Buffer, password: string): LoadedCertificate` (throws `InvalidCertificateError` on bad file/password).
  - `test/helpers/test-certificate.ts`: `createTestPfx(opts?: { password?: string; cn?: string; notAfter?: Date }): { pfx: Buffer; password: string; certPem: string; keyPem: string }` — self-signed RSA-2048, cached per process.

- [ ] **Step 1: Write errors.ts**

`src/modules/nfse/errors.ts`:
```ts
export class InvalidCertificateError extends Error {
  constructor(message = 'Invalid certificate file or password') {
    super(message);
    this.name = 'InvalidCertificateError';
  }
}

/** The national API accepted the request but rejected it by a business rule. */
export class NfseRejectedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NfseRejectedError';
  }
}

/** Network error, timeout or 5xx from the national API. */
export class NfseUnavailableError extends Error {
  constructor(message = 'National NFS-e API unavailable') {
    super(message);
    this.name = 'NfseUnavailableError';
  }
}
```

- [ ] **Step 2: Write the test certificate helper**

`test/helpers/test-certificate.ts`:
```ts
import forge from 'node-forge';

export interface TestPfx {
  pfx: Buffer;
  password: string;
  certPem: string;
  keyPem: string;
}

let cached: TestPfx | undefined;

export function createTestPfx(opts: { password?: string; cn?: string; notAfter?: Date } = {}): TestPfx {
  const custom = opts.cn !== undefined || opts.notAfter !== undefined || opts.password !== undefined;
  if (!custom && cached) return cached;

  const password = opts.password ?? 'test-password';
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: opts.cn ?? 'EMPRESA TESTE LTDA:12345678000199' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  const der = forge.asn1.toDer(p12).getBytes();
  const result: TestPfx = {
    pfx: Buffer.from(der, 'binary'),
    password,
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
  if (!custom) cached = result;
  return result;
}
```

- [ ] **Step 3: Write the failing test**

`test/modules/nfse/certificate.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { loadCertificate } from '@/modules/nfse/certificate';
import { InvalidCertificateError } from '@/modules/nfse/errors';
import { createTestPfx } from '../../helpers/test-certificate';

describe('loadCertificate', () => {
  it('extracts PEM cert, PEM key, validity and CN from a pfx', () => {
    const { pfx, password } = createTestPfx();
    const loaded = loadCertificate(pfx, password);
    expect(loaded.certPem).toContain('-----BEGIN CERTIFICATE-----');
    expect(loaded.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(loaded.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(loaded.subjectCn).toBe('EMPRESA TESTE LTDA:12345678000199');
  });

  it('throws InvalidCertificateError on wrong password', () => {
    const { pfx } = createTestPfx();
    expect(() => loadCertificate(pfx, 'wrong')).toThrow(InvalidCertificateError);
  });

  it('throws InvalidCertificateError on garbage bytes', () => {
    expect(() => loadCertificate(Buffer.from('not a pfx'), 'x')).toThrow(InvalidCertificateError);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test test/modules/nfse/certificate.spec.ts`
Expected: FAIL — cannot resolve `@/modules/nfse/certificate`.

- [ ] **Step 5: Implement certificate.ts**

`src/modules/nfse/certificate.ts`:
```ts
import forge from 'node-forge';
import { InvalidCertificateError } from './errors';

export interface LoadedCertificate {
  certPem: string;
  keyPem: string;
  notBefore: Date;
  notAfter: Date;
  subjectCn: string;
}

export function loadCertificate(pfx: Buffer, password: string): LoadedCertificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch {
    throw new InvalidCertificateError();
  }

  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0];
  const keyBag =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ??
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];

  if (!certBag?.cert || !keyBag?.key) {
    throw new InvalidCertificateError('pfx does not contain a certificate and a private key');
  }

  const cn = certBag.cert.subject.getField('CN')?.value ?? '';
  return {
    certPem: forge.pki.certificateToPem(certBag.cert),
    keyPem: forge.pki.privateKeyToPem(keyBag.key),
    notBefore: certBag.cert.validity.notBefore,
    notAfter: certBag.cert.validity.notAfter,
    subjectCn: String(cn),
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/modules/nfse/certificate.spec.ts`
Expected: 3 pass (first run takes ~1–2 s for RSA key generation).

- [ ] **Step 7: Commit**

```bash
git add src/modules/nfse/errors.ts src/modules/nfse/certificate.ts test/helpers test/modules/nfse/certificate.spec.ts
git commit -m "feat(nfse): load A1 certificate from pfx and add domain errors"
```

---

### Task 5: Auth module (Logto JWT verification via jose)

**Files:**
- Create: `src/modules/auth/jwks.provider.ts`, `src/modules/auth/jwt-auth.guard.ts`, `src/modules/auth/public.decorator.ts`, `src/modules/auth/current-user.decorator.ts`, `src/modules/auth/auth.module.ts`
- Modify: `src/app.module.ts`, `src/modules/health/health.controller.ts`
- Test: `test/modules/auth/jwt-auth.guard.spec.ts`

**Interfaces:**
- Consumes: `Env.LOGTO_ENDPOINT`, `Env.LOGTO_API_RESOURCE`.
- Produces:
  - `JWKS` injection token (`Symbol`) whose value is a `jose.JWTVerifyGetKey`; tests/e2e override it with a local public key.
  - `JwtAuthGuard` (registered globally as `APP_GUARD`): sets `request.user = { id: string }` from the token `sub`; throws `UnauthorizedException` otherwise.
  - `@Public()` decorator to opt a route out of the guard.
  - `@CurrentUser()` param decorator → `AuthUser` (`{ id: string }`).

- [ ] **Step 1: Write the failing guard test**

`test/modules/auth/jwt-auth.guard.spec.ts`:
```ts
import { beforeAll, describe, expect, it } from 'bun:test';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard';
import { IS_PUBLIC_KEY } from '@/modules/auth/public.decorator';

const ISSUER = 'http://localhost:3001/oidc';
const AUDIENCE = 'https://api.matheo.local';

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPrivateKey: CryptoKey;

function contextFor(authorization?: string): { ctx: ExecutionContext; request: any } {
  const request: any = { headers: authorization ? { authorization } : {} };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
  return { ctx, request };
}

function buildGuard(isPublic = false) {
  const config = {
    get: (key: string) => (key === 'LOGTO_ENDPOINT' ? 'http://localhost:3001' : AUDIENCE),
  } as unknown as ConfigService;
  const reflector = { getAllAndOverride: (key: string) => (key === IS_PUBLIC_KEY ? isPublic : undefined) } as unknown as Reflector;
  return new JwtAuthGuard(config, reflector, async () => publicKey);
}

async function token(overrides: { issuer?: string; audience?: string; key?: CryptoKey; exp?: string; sub?: string } = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES384' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.sub ?? 'user-123')
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? '1h')
    .sign(overrides.key ?? privateKey);
}

describe('JwtAuthGuard', () => {
  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair('ES384'));
    ({ privateKey: otherPrivateKey } = await generateKeyPair('ES384'));
  });

  it('accepts a valid token and sets request.user.id from sub', async () => {
    const { ctx, request } = contextFor(`Bearer ${await token()}`);
    await expect(buildGuard().canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'user-123' });
  });

  it('rejects a missing Authorization header', async () => {
    const { ctx } = contextFor(undefined);
    await expect(buildGuard().canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token signed by another key', async () => {
    const { ctx } = contextFor(`Bearer ${await token({ key: otherPrivateKey })}`);
    await expect(buildGuard().canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired token', async () => {
    const { ctx } = contextFor(`Bearer ${await token({ exp: '-10s' })}`);
    await expect(buildGuard().canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects wrong issuer and wrong audience', async () => {
    const a = contextFor(`Bearer ${await token({ issuer: 'http://evil/oidc' })}`);
    const b = contextFor(`Bearer ${await token({ audience: 'https://other' })}`);
    await expect(buildGuard().canActivate(a.ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(buildGuard().canActivate(b.ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lets @Public() routes through without a token', async () => {
    const { ctx } = contextFor(undefined);
    await expect(buildGuard(true).canActivate(ctx)).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/modules/auth/jwt-auth.guard.spec.ts`
Expected: FAIL — cannot resolve `@/modules/auth/jwt-auth.guard`.

- [ ] **Step 3: Implement decorators, JWKS provider and guard**

`src/modules/auth/public.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

`src/modules/auth/current-user.decorator.ts`:
```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  id: string;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
```

`src/modules/auth/jwks.provider.ts`:
```ts
import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../../config/env';

export const JWKS = Symbol('JWKS');

export const jwksProvider: Provider<JWTVerifyGetKey> = {
  provide: JWKS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    createRemoteJWKSet(new URL(`${config.get('LOGTO_ENDPOINT', { infer: true })}/oidc/jwks`)),
};
```

`src/modules/auth/jwt-auth.guard.ts`:
```ts
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../../config/env';
import { JWKS } from './jwks.provider';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
    @Inject(JWKS) private readonly jwks: JWTVerifyGetKey,
  ) {
    this.issuer = `${config.get('LOGTO_ENDPOINT', { infer: true })}/oidc`;
    this.audience = config.get('LOGTO_API_RESOURCE', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const { payload } = await jwtVerify(header.slice('Bearer '.length), this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      if (!payload.sub) throw new Error('missing sub');
      request.user = { id: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}
```

`src/modules/auth/auth.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { jwksProvider } from './jwks.provider';

@Module({
  providers: [jwksProvider, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [jwksProvider],
})
export class AuthModule {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/modules/auth/jwt-auth.guard.spec.ts`
Expected: 6 pass.

- [ ] **Step 5: Wire AuthModule globally and make /health public**

`src/app.module.ts` — add `AuthModule` to imports:
```ts
import { AuthModule } from './modules/auth/auth.module';
// ...
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, AuthModule],
```

`src/modules/health/health.controller.ts` — add `@Public()`:
```ts
import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

- [ ] **Step 6: Verify the guard is active**

Run: `(bun run src/main.ts &) ; sleep 4 ; curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/health ; pkill -f "bun run src/main.ts"`
Expected: `200` (public route). `bunx tsc --noEmit` — no errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth src/app.module.ts src/modules/health test/modules/auth
git commit -m "feat(auth): verify Logto JWTs with a global guard"
```

---

### Task 6: Companies module (CRUD + certificate upload)

**Files:**
- Create: `src/modules/nfse/nfse.module.ts` (minimal — exports `CertificateVault`; Task 9 extends it)
- Create: `src/modules/companies/dto/create-company.dto.ts`, `dto/update-company.dto.ts`, `dto/upload-certificate.dto.ts`
- Create: `src/modules/companies/companies.service.ts`, `companies.controller.ts`, `companies.module.ts`
- Create: `test/helpers/prisma-mock.ts`
- Modify: `src/app.module.ts`
- Test: `test/modules/companies/companies.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (`company.findUnique/create/update`), `CertificateVault`, `loadCertificate`, `InvalidCertificateError`.
- Produces `CompaniesService`:
  - `create(userId: string, dto: CreateCompanyDto): Promise<CompanyResponse>` — 409 if user already has one or CNPJ taken.
  - `findMine(userId: string): Promise<CompanyResponse>` — 404 if none.
  - `update(userId: string, dto: UpdateCompanyDto): Promise<CompanyResponse>`
  - `setCertificate(userId: string, pfx: Buffer, password: string): Promise<CompanyResponse>` — 422 if pfx/password invalid.
  - `getCompanyWithCertificate(userId: string): Promise<{ company: Company; certificate: LoadedCertificate }>` — 422 if no certificate or expired (used by invoices).
  - `CompanyResponse = { id, cnpj, razaoSocial, inscricaoMunicipal, codigoMunicipio, email, telefone, hasCertificate: boolean, certificateExpiry: Date | null, createdAt, updatedAt }`.

- [ ] **Step 1: Write the Prisma mock helper**

`test/helpers/prisma-mock.ts`:
```ts
import { mock } from 'bun:test';
import type { PrismaService } from '@/prisma/prisma.service';

export function createPrismaMock() {
  const prisma = {
    company: { findUnique: mock(), create: mock(), update: mock() },
    invoice: { findMany: mock(), findFirst: mock(), create: mock(), update: mock(), count: mock(), aggregate: mock() },
    $transaction: mock(),
  };
  // Default: run the callback with the same mock as the transaction client
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return prisma as typeof prisma & PrismaService;
}
```

- [ ] **Step 2: Write the failing service test**

`test/modules/companies/companies.service.spec.ts`:
```ts
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CompaniesService } from '@/modules/companies/companies.service';
import { CertificateVault } from '@/modules/nfse/crypto/certificate-vault';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';
import { createTestPfx } from '../../helpers/test-certificate';

const userId = 'user-1';
const baseCompany = {
  id: 'c1',
  userId,
  cnpj: '12345678000199',
  razaoSocial: 'Empresa Teste',
  inscricaoMunicipal: null,
  codigoMunicipio: '3550308',
  email: null,
  telefone: null,
  certificatePfx: null,
  certificatePass: null,
  certificateExpiry: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const createDto = { cnpj: '12345678000199', razaoSocial: 'Empresa Teste', codigoMunicipio: '3550308' };

describe('CompaniesService', () => {
  let service: CompaniesService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let vault: { encrypt: ReturnType<typeof mock>; decrypt: ReturnType<typeof mock>; encryptString: ReturnType<typeof mock>; decryptString: ReturnType<typeof mock> };

  beforeEach(async () => {
    prisma = createPrismaMock();
    vault = {
      encrypt: mock((b: Buffer) => Buffer.concat([Buffer.from('enc:'), b])),
      decrypt: mock((b: Buffer) => b.subarray(4)),
      encryptString: mock((s: string) => `enc:${s}`),
      decryptString: mock((s: string) => s.slice(4)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [CompaniesService, { provide: PrismaService, useValue: prisma }, { provide: CertificateVault, useValue: vault }],
    }).compile();
    service = moduleRef.get(CompaniesService);
  });

  describe('create', () => {
    it('creates the company for the user', async () => {
      prisma.company.findUnique.mockResolvedValue(null);
      prisma.company.create.mockResolvedValue(baseCompany);
      const result = await service.create(userId, createDto);
      expect(prisma.company.create).toHaveBeenCalledWith({ data: { ...createDto, userId } });
      expect(result.hasCertificate).toBe(false);
      expect(result).not.toHaveProperty('certificatePfx');
    });

    it('throws 409 when the user already has a company', async () => {
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      await expect(service.create(userId, createDto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws 409 when the CNPJ is already registered', async () => {
      prisma.company.findUnique.mockResolvedValue(null);
      prisma.company.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.create(userId, createDto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('findMine', () => {
    it('returns the response shape without secrets', async () => {
      prisma.company.findUnique.mockResolvedValue({ ...baseCompany, certificatePfx: Buffer.from('x'), certificatePass: 'enc:p', certificateExpiry: new Date('2030-01-01') });
      const result = await service.findMine(userId);
      expect(result.hasCertificate).toBe(true);
      expect(result).not.toHaveProperty('certificatePfx');
      expect(result).not.toHaveProperty('certificatePass');
    });

    it('throws 404 when the user has no company', async () => {
      prisma.company.findUnique.mockResolvedValue(null);
      await expect(service.findMine(userId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates only the given fields', async () => {
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      prisma.company.update.mockResolvedValue({ ...baseCompany, razaoSocial: 'Nova' });
      const result = await service.update(userId, { razaoSocial: 'Nova' });
      expect(prisma.company.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { razaoSocial: 'Nova' } });
      expect(result.razaoSocial).toBe('Nova');
    });
  });

  describe('setCertificate', () => {
    it('validates, encrypts and stores the pfx with its expiry', async () => {
      const { pfx, password } = createTestPfx();
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      prisma.company.update.mockImplementation(async ({ data }: any) => ({ ...baseCompany, ...data }));
      const result = await service.setCertificate(userId, pfx, password);
      expect(vault.encrypt).toHaveBeenCalledTimes(1);
      expect(vault.encryptString).toHaveBeenCalledWith(password);
      const data = prisma.company.update.mock.calls[0][0].data;
      expect(Buffer.isBuffer(data.certificatePfx)).toBe(true);
      expect(data.certificatePass).toBe(`enc:${password}`);
      expect(data.certificateExpiry.getTime()).toBeGreaterThan(Date.now());
      expect(result.hasCertificate).toBe(true);
      expect(result).not.toHaveProperty('certificatePfx');
    });

    it('throws 422 on wrong password', async () => {
      const { pfx } = createTestPfx();
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      await expect(service.setCertificate(userId, pfx, 'wrong')).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.company.update).not.toHaveBeenCalled();
    });
  });

  describe('getCompanyWithCertificate', () => {
    it('decrypts and loads the certificate', async () => {
      const { pfx, password } = createTestPfx();
      prisma.company.findUnique.mockResolvedValue({
        ...baseCompany,
        certificatePfx: Buffer.concat([Buffer.from('enc:'), pfx]),
        certificatePass: `enc:${password}`,
        certificateExpiry: new Date(Date.now() + 86400000),
      });
      const { company, certificate } = await service.getCompanyWithCertificate(userId);
      expect(company.id).toBe('c1');
      expect(certificate.certPem).toContain('BEGIN CERTIFICATE');
    });

    it('throws 422 when there is no certificate', async () => {
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      await expect(service.getCompanyWithCertificate(userId)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('throws 422 when the certificate is expired', async () => {
      prisma.company.findUnique.mockResolvedValue({ ...baseCompany, certificatePfx: Buffer.from('x'), certificatePass: 'enc:p', certificateExpiry: new Date('2020-01-01') });
      await expect(service.getCompanyWithCertificate(userId)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test test/modules/companies/companies.service.spec.ts`
Expected: FAIL — cannot resolve `@/modules/companies/companies.service`.

- [ ] **Step 4: Write the DTOs**

`src/modules/companies/dto/create-company.dto.ts`:
```ts
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateCompanyDto {
  @Matches(/^\d{14}$/, { message: 'cnpj must be 14 digits' })
  cnpj: string;

  @IsString()
  @Length(2, 150)
  razaoSocial: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  inscricaoMunicipal?: string;

  @Matches(/^\d{7}$/, { message: 'codigoMunicipio must be the 7-digit IBGE code' })
  codigoMunicipio: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
```

`src/modules/companies/dto/update-company.dto.ts`:
```ts
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @Length(2, 150)
  razaoSocial?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  inscricaoMunicipal?: string;

  @IsOptional()
  @Matches(/^\d{7}$/, { message: 'codigoMunicipio must be the 7-digit IBGE code' })
  codigoMunicipio?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
```

`src/modules/companies/dto/upload-certificate.dto.ts`:
```ts
import { IsString, MinLength } from 'class-validator';

export class UploadCertificateDto {
  @IsString()
  @MinLength(1)
  password: string;
}
```

- [ ] **Step 5: Write the minimal NfseModule**

`src/modules/nfse/nfse.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { CertificateVault } from './crypto/certificate-vault';

@Module({
  providers: [CertificateVault],
  exports: [CertificateVault],
})
export class NfseModule {}
```

- [ ] **Step 6: Implement CompaniesService**

`src/modules/companies/companies.service.ts`:
```ts
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Company } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { loadCertificate, type LoadedCertificate } from '../nfse/certificate';
import { CertificateVault } from '../nfse/crypto/certificate-vault';
import { InvalidCertificateError } from '../nfse/errors';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

export interface CompanyResponse {
  id: string;
  cnpj: string;
  razaoSocial: string;
  inscricaoMunicipal: string | null;
  codigoMunicipio: string;
  email: string | null;
  telefone: string | null;
  hasCertificate: boolean;
  certificateExpiry: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CertificateVault,
  ) {}

  async create(userId: string, dto: CreateCompanyDto): Promise<CompanyResponse> {
    const existing = await this.prisma.company.findUnique({ where: { userId } });
    if (existing) throw new ConflictException('User already has a company');

    try {
      const company = await this.prisma.company.create({ data: { ...dto, userId } });
      return this.toResponse(company);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('CNPJ already registered');
      }
      throw error;
    }
  }

  async findMine(userId: string): Promise<CompanyResponse> {
    return this.toResponse(await this.findEntity(userId));
  }

  async update(userId: string, dto: UpdateCompanyDto): Promise<CompanyResponse> {
    const company = await this.findEntity(userId);
    const updated = await this.prisma.company.update({ where: { id: company.id }, data: dto });
    return this.toResponse(updated);
  }

  async setCertificate(userId: string, pfx: Buffer, password: string): Promise<CompanyResponse> {
    const company = await this.findEntity(userId);

    let loaded: LoadedCertificate;
    try {
      loaded = loadCertificate(pfx, password);
    } catch (error) {
      if (error instanceof InvalidCertificateError) throw new UnprocessableEntityException(error.message);
      throw error;
    }

    const updated = await this.prisma.company.update({
      where: { id: company.id },
      data: {
        certificatePfx: this.vault.encrypt(pfx),
        certificatePass: this.vault.encryptString(password),
        certificateExpiry: loaded.notAfter,
      },
    });
    return this.toResponse(updated);
  }

  async getCompanyWithCertificate(userId: string): Promise<{ company: Company; certificate: LoadedCertificate }> {
    const company = await this.findEntity(userId);
    if (!company.certificatePfx || !company.certificatePass) {
      throw new UnprocessableEntityException('Company has no certificate');
    }
    if (company.certificateExpiry && company.certificateExpiry.getTime() < Date.now()) {
      throw new UnprocessableEntityException('Company certificate is expired');
    }
    const pfx = this.vault.decrypt(Buffer.from(company.certificatePfx));
    const password = this.vault.decryptString(company.certificatePass);
    return { company, certificate: loadCertificate(pfx, password) };
  }

  private async findEntity(userId: string): Promise<Company> {
    const company = await this.prisma.company.findUnique({ where: { userId } });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private toResponse(company: Company): CompanyResponse {
    return {
      id: company.id,
      cnpj: company.cnpj,
      razaoSocial: company.razaoSocial,
      inscricaoMunicipal: company.inscricaoMunicipal,
      codigoMunicipio: company.codigoMunicipio,
      email: company.email,
      telefone: company.telefone,
      hasCertificate: Boolean(company.certificatePfx),
      certificateExpiry: company.certificateExpiry,
      createdAt: company.createdAt,
      updatedAt: company.updatedAt,
    };
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test test/modules/companies/companies.service.spec.ts`
Expected: 11 pass.

- [ ] **Step 8: Write the controller and module, register in AppModule**

`src/modules/companies/companies.controller.ts`:
```ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UploadCertificateDto } from './dto/upload-certificate.dto';

const MAX_PFX_BYTES = 10 * 1024;

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCompanyDto) {
    return this.companies.create(user.id, dto);
  }

  @Get('me')
  findMine(@CurrentUser() user: AuthUser) {
    return this.companies.findMine(user.id);
  }

  @Patch('me')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateCompanyDto) {
    return this.companies.update(user.id, dto);
  }

  @Put('me/certificate')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PFX_BYTES, files: 1 } }))
  setCertificate(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadCertificateDto,
  ) {
    if (!file) throw new BadRequestException('file is required (.pfx)');
    return this.companies.setCertificate(user.id, file.buffer, dto.password);
  }
}
```

`src/modules/companies/companies.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { NfseModule } from '../nfse/nfse.module';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';

@Module({
  imports: [NfseModule],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
```

`src/app.module.ts` — add to imports:
```ts
import { CompaniesModule } from './modules/companies/companies.module';
// ...
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, AuthModule, CompaniesModule],
```

- [ ] **Step 9: Typecheck and boot**

Run: `bunx tsc --noEmit && (bun run src/main.ts &) ; sleep 4 ; curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/companies/me ; pkill -f "bun run src/main.ts"`
Expected: no type errors; `401` (guard active, no token).

- [ ] **Step 10: Commit**

```bash
git add src/modules/companies src/modules/nfse/nfse.module.ts src/app.module.ts test/helpers/prisma-mock.ts test/modules/companies
git commit -m "feat(companies): company CRUD and encrypted certificate upload"
```

---

### Task 7: Gateway contract types + DpsBuilder (DPS and cancel-event XML)

**Files:**
- Create: `src/modules/nfse/nfse-gateway.ts` (types + token only; implementations come in Tasks 9 and 12)
- Create: `src/modules/nfse/dps-builder.ts`
- Test: `test/modules/nfse/dps-builder.spec.ts`

**Interfaces:**
- Produces (`nfse-gateway.ts`):
```ts
export const NFSE_GATEWAY = Symbol('NFSE_GATEWAY');
export type NfseAmbiente = 'producao' | 'homologacao';
export interface DpsData {
  ambiente: NfseAmbiente;
  serie: string;                // e.g. "1"
  numero: number;               // sequential per company+serie
  dataEmissao: Date;
  prestador: { cnpj: string; inscricaoMunicipal?: string | null; codigoMunicipio: string };
  tomador: { documento: string; nome: string; email?: string | null };   // documento: 11 (CPF) or 14 (CNPJ) digits
  servico: { codigoTributacao: string; descricao: string; valor: string }; // codigoTributacao "01.01.01", valor "100.00"
}
export interface EmitResult { chaveAcesso: string; numeroNfse: string; xmlDps: string; xmlNfse: string }
export interface NfseGateway {
  emit(dps: DpsData, certificate: LoadedCertificate): Promise<EmitResult>;
  cancel(chaveAcesso: string, motivo: string, dps: Pick<DpsData, 'ambiente' | 'prestador'>, certificate: LoadedCertificate): Promise<void>;
  pdf(chaveAcesso: string, certificate: LoadedCertificate): Promise<Buffer>;
}
```
- Produces (`dps-builder.ts`): `buildDpsXml(dps: DpsData): { id: string; xml: string }`, `buildCancelEventXml(input: { ambiente: NfseAmbiente; chaveAcesso: string; cnpjAutor: string; motivo: string; dataEvento: Date; sequencial?: number }): { id: string; xml: string }`, `formatDateTimeBr(date: Date): string`, `escapeXml(text: string): string`.

- [ ] **Step 1: Write nfse-gateway.ts**

`src/modules/nfse/nfse-gateway.ts`:
```ts
import type { LoadedCertificate } from './certificate';

export const NFSE_GATEWAY = Symbol('NFSE_GATEWAY');

export type NfseAmbiente = 'producao' | 'homologacao';

export interface DpsData {
  ambiente: NfseAmbiente;
  serie: string;
  numero: number;
  dataEmissao: Date;
  prestador: { cnpj: string; inscricaoMunicipal?: string | null; codigoMunicipio: string };
  tomador: { documento: string; nome: string; email?: string | null };
  servico: { codigoTributacao: string; descricao: string; valor: string };
}

export interface EmitResult {
  chaveAcesso: string;
  numeroNfse: string;
  xmlDps: string;
  xmlNfse: string;
}

export interface NfseGateway {
  emit(dps: DpsData, certificate: LoadedCertificate): Promise<EmitResult>;
  cancel(
    chaveAcesso: string,
    motivo: string,
    dps: Pick<DpsData, 'ambiente' | 'prestador'>,
    certificate: LoadedCertificate,
  ): Promise<void>;
  pdf(chaveAcesso: string, certificate: LoadedCertificate): Promise<Buffer>;
}
```

- [ ] **Step 2: Write the failing builder test**

`test/modules/nfse/dps-builder.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { buildCancelEventXml, buildDpsXml, escapeXml, formatDateTimeBr } from '@/modules/nfse/dps-builder';
import type { DpsData } from '@/modules/nfse/nfse-gateway';

const dps: DpsData = {
  ambiente: 'homologacao',
  serie: '1',
  numero: 7,
  dataEmissao: new Date('2026-09-11T13:00:00Z'),
  prestador: { cnpj: '12345678000199', inscricaoMunicipal: '123', codigoMunicipio: '3550308' },
  tomador: { documento: '12345678909', nome: 'Cliente & Cia', email: 'c@x.com' },
  servico: { codigoTributacao: '01.01.01', descricao: 'Consultoria <TI>', valor: '150.00' },
};

describe('buildDpsXml', () => {
  it('builds a 45-char Id: DPS + cMun(7) + tpInsc(1) + inscricao(14) + serie(5) + numero(15)', () => {
    const { id } = buildDpsXml(dps);
    expect(id).toBe('DPS355030821234567800019900001000000000000007');
    expect(id).toHaveLength(45);
  });

  it('contains the mandatory DPS fields with the national namespace', () => {
    const { xml, id } = buildDpsXml(dps);
    expect(xml).toContain('<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">');
    expect(xml).toContain(`<infDPS Id="${id}">`);
    expect(xml).toContain('<tpAmb>2</tpAmb>');
    expect(xml).toContain('<serie>1</serie>');
    expect(xml).toContain('<nDPS>7</nDPS>');
    expect(xml).toContain('<cLocEmi>3550308</cLocEmi>');
    expect(xml).toContain('<prest><CNPJ>12345678000199</CNPJ><IM>123</IM>');
    expect(xml).toContain('<opSimpNac>2</opSimpNac>');
    expect(xml).toContain('<toma><CPF>12345678909</CPF>');
    expect(xml).toContain('<cTribNac>010101</cTribNac>');
    expect(xml).toContain('<vServ>150.00</vServ>');
    expect(xml).toContain('<dhEmi>2026-09-11T10:00:00-03:00</dhEmi>');
    expect(xml).toContain('<dCompet>2026-09-11</dCompet>');
  });

  it('uses <CNPJ> for a 14-digit tomador and omits <IM> when absent', () => {
    const { xml } = buildDpsXml({
      ...dps,
      prestador: { ...dps.prestador, inscricaoMunicipal: null },
      tomador: { documento: '98765432000100', nome: 'Empresa' },
    });
    expect(xml).toContain('<toma><CNPJ>98765432000100</CNPJ>');
    expect(xml).not.toContain('<IM>');
  });

  it('uses tpAmb 1 for producao and escapes text', () => {
    const { xml } = buildDpsXml({ ...dps, ambiente: 'producao' });
    expect(xml).toContain('<tpAmb>1</tpAmb>');
    expect(xml).toContain('<xNome>Cliente &amp; Cia</xNome>');
    expect(xml).toContain('<xDescServ>Consultoria &lt;TI&gt;</xDescServ>');
  });
});

describe('buildCancelEventXml', () => {
  it('builds the pedRegEvento with e101101 and a PRE id', () => {
    const chave = '1'.repeat(50);
    const { id, xml } = buildCancelEventXml({
      ambiente: 'homologacao',
      chaveAcesso: chave,
      cnpjAutor: '12345678000199',
      motivo: 'Erro de digitação',
      dataEvento: new Date('2026-09-11T13:00:00Z'),
    });
    expect(id).toBe(`PRE${chave}101101001`);
    expect(xml).toContain('<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">');
    expect(xml).toContain(`<infPedReg Id="${id}">`);
    expect(xml).toContain(`<chNFSe>${chave}</chNFSe>`);
    expect(xml).toContain('<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>9</cMotivo><xMotivo>Erro de digitação</xMotivo></e101101>');
  });
});

describe('helpers', () => {
  it('formatDateTimeBr renders São Paulo local time with offset', () => {
    expect(formatDateTimeBr(new Date('2026-01-15T03:05:09Z'))).toBe('2026-01-15T00:05:09-03:00');
  });

  it('escapeXml escapes the five XML entities', () => {
    expect(escapeXml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test test/modules/nfse/dps-builder.spec.ts`
Expected: FAIL — cannot resolve `@/modules/nfse/dps-builder`.

- [ ] **Step 4: Implement dps-builder.ts**

`src/modules/nfse/dps-builder.ts`:
```ts
import type { DpsData, NfseAmbiente } from './nfse-gateway';

export const NFSE_NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
export const APP_VERSION = 'MATHEO-0.1.0';
const TIME_ZONE = 'America/Sao_Paulo';

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 2026-09-11T10:00:00-03:00 (São Paulo wall-clock time with numeric offset). */
export function formatDateTimeBr(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

function tpAmb(ambiente: NfseAmbiente): '1' | '2' {
  return ambiente === 'producao' ? '1' : '2';
}

function tag(name: string, value: string | null | undefined): string {
  return value ? `<${name}>${escapeXml(value)}</${name}>` : '';
}

export function buildDpsXml(dps: DpsData): { id: string; xml: string } {
  const id =
    'DPS' +
    dps.prestador.codigoMunicipio.padStart(7, '0') +
    '2' + // tpInsc: 2 = CNPJ
    dps.prestador.cnpj.padStart(14, '0') +
    dps.serie.padStart(5, '0') +
    String(dps.numero).padStart(15, '0');

  const dhEmi = formatDateTimeBr(dps.dataEmissao);
  const tomadorTag = dps.tomador.documento.length === 11 ? 'CPF' : 'CNPJ';

  const xml =
    `<DPS xmlns="${NFSE_NAMESPACE}" versao="1.00">` +
    `<infDPS Id="${id}">` +
    tag('tpAmb', tpAmb(dps.ambiente)) +
    tag('dhEmi', dhEmi) +
    tag('verAplic', APP_VERSION) +
    tag('serie', dps.serie) +
    tag('nDPS', String(dps.numero)) +
    tag('dCompet', dhEmi.slice(0, 10)) +
    tag('tpEmit', '1') +
    tag('cLocEmi', dps.prestador.codigoMunicipio) +
    '<prest>' +
    tag('CNPJ', dps.prestador.cnpj) +
    tag('IM', dps.prestador.inscricaoMunicipal) +
    '<regTrib><opSimpNac>2</opSimpNac><regEspTrib>0</regEspTrib></regTrib>' +
    '</prest>' +
    '<toma>' +
    tag(tomadorTag, dps.tomador.documento) +
    tag('xNome', dps.tomador.nome) +
    tag('email', dps.tomador.email) +
    '</toma>' +
    '<serv>' +
    `<locPrest><cLocPrestacao>${dps.prestador.codigoMunicipio}</cLocPrestacao></locPrest>` +
    '<cServ>' +
    tag('cTribNac', dps.servico.codigoTributacao.replace(/\D/g, '')) +
    tag('xDescServ', dps.servico.descricao) +
    '</cServ>' +
    '</serv>' +
    '<valores>' +
    `<vServPrest><vServ>${dps.servico.valor}</vServ></vServPrest>` +
    '<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun><totTrib><indTotTrib>0</indTotTrib></totTrib></trib>' +
    '</valores>' +
    '</infDPS>' +
    '</DPS>';

  return { id, xml };
}

export function buildCancelEventXml(input: {
  ambiente: NfseAmbiente;
  chaveAcesso: string;
  cnpjAutor: string;
  motivo: string;
  dataEvento: Date;
  sequencial?: number;
}): { id: string; xml: string } {
  const tipoEvento = '101101'; // Cancelamento de NFS-e
  const id = `PRE${input.chaveAcesso}${tipoEvento}${String(input.sequencial ?? 1).padStart(3, '0')}`;

  const xml =
    `<pedRegEvento xmlns="${NFSE_NAMESPACE}" versao="1.00">` +
    `<infPedReg Id="${id}">` +
    tag('tpAmb', tpAmb(input.ambiente)) +
    tag('verAplic', APP_VERSION) +
    tag('dhEvento', formatDateTimeBr(input.dataEvento)) +
    tag('CNPJAutor', input.cnpjAutor) +
    tag('chNFSe', input.chaveAcesso) +
    `<e${tipoEvento}>` +
    tag('xDesc', 'Cancelamento de NFS-e') +
    tag('cMotivo', '9') + // 9 = outros; the free-text reason goes in xMotivo
    tag('xMotivo', input.motivo) +
    `</e${tipoEvento}>` +
    '</infPedReg>' +
    '</pedRegEvento>';

  return { id, xml };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/modules/nfse/dps-builder.spec.ts`
Expected: 8 pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/nfse/nfse-gateway.ts src/modules/nfse/dps-builder.ts test/modules/nfse/dps-builder.spec.ts
git commit -m "feat(nfse): gateway contract and DPS/cancel-event XML builders"
```

> Note for the executor: the element names follow the national DPS v1.00 layout (Anexo I of the manual). When the real certificate arrives and `producao-restrita` rejects a field, fix the builder and its test — the builder is the single place the layout lives.

---

### Task 8: XmlSigner (XML-DSig with the A1 certificate)

**Files:**
- Create: `src/modules/nfse/xml-signer.ts`
- Test: `test/modules/nfse/xml-signer.spec.ts`

**Interfaces:**
- Consumes: `LoadedCertificate` (`certPem`, `keyPem`), `buildDpsXml` (test only).
- Produces: `signXml(xml: string, certificate: LoadedCertificate, referenceLocalName: string): string` (enveloped RSA-SHA256 signature placed right after the referenced element, with `<KeyInfo><X509Data><X509Certificate>`), `verifyXmlSignature(signedXml: string, certPem: string): boolean`.

- [ ] **Step 1: Write the failing test**

`test/modules/nfse/xml-signer.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { loadCertificate } from '@/modules/nfse/certificate';
import { buildDpsXml } from '@/modules/nfse/dps-builder';
import { signXml, verifyXmlSignature } from '@/modules/nfse/xml-signer';
import { createTestPfx } from '../../helpers/test-certificate';

const dps = buildDpsXml({
  ambiente: 'homologacao',
  serie: '1',
  numero: 1,
  dataEmissao: new Date('2026-09-11T13:00:00Z'),
  prestador: { cnpj: '12345678000199', codigoMunicipio: '3550308' },
  tomador: { documento: '12345678909', nome: 'Cliente' },
  servico: { codigoTributacao: '01.01.01', descricao: 'Serviço', valor: '10.00' },
});

describe('signXml', () => {
  const { pfx, password, certPem } = createTestPfx();
  const certificate = loadCertificate(pfx, password);

  it('produces an enveloped signature after infDPS with RSA-SHA256, SHA-256 digest and the X509 certificate', () => {
    const signed = signXml(dps.xml, certificate, 'infDPS');
    expect(signed).toContain('</infDPS><Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
    expect(signed).toContain('Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"');
    expect(signed).toContain('Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"');
    expect(signed).toContain(`<Reference URI="#${dps.id}">`);
    expect(signed).toContain('<X509Certificate>');
    expect(signed.endsWith('</DPS>')).toBe(true);
  });

  it('verifies with the signing certificate and fails after tampering', () => {
    const signed = signXml(dps.xml, certificate, 'infDPS');
    expect(verifyXmlSignature(signed, certPem)).toBe(true);
    expect(verifyXmlSignature(signed.replace('<vServ>10.00</vServ>', '<vServ>99.00</vServ>'), certPem)).toBe(false);
  });

  it('fails verification with a different certificate', () => {
    const signed = signXml(dps.xml, certificate, 'infDPS');
    const other = createTestPfx({ cn: 'OUTRA' });
    expect(verifyXmlSignature(signed, other.certPem)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/modules/nfse/xml-signer.spec.ts`
Expected: FAIL — cannot resolve `@/modules/nfse/xml-signer`.

- [ ] **Step 3: Implement xml-signer.ts**

`src/modules/nfse/xml-signer.ts`:
```ts
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml, xpath } from 'xml-crypto';
import type { LoadedCertificate } from './certificate';

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const SIGNATURE_XPATH = "//*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']";

export function signXml(xml: string, certificate: LoadedCertificate, referenceLocalName: string): string {
  const referenceXpath = `//*[local-name(.)='${referenceLocalName}']`;
  const sig = new SignedXml({
    privateKey: certificate.keyPem,
    publicCert: certificate.certPem,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({
    xpath: referenceXpath,
    digestAlgorithm: SHA256,
    transforms: [ENVELOPED, C14N],
  });
  sig.computeSignature(xml, { location: { reference: referenceXpath, action: 'after' } });
  return sig.getSignedXml();
}

export function verifyXmlSignature(signedXml: string, certPem: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(signedXml, 'text/xml');
    const signatureNode = xpath.select1(SIGNATURE_XPATH, doc as unknown as Node);
    if (!signatureNode) return false;
    const sig = new SignedXml({ publicCert: certPem });
    sig.loadSignature(signatureNode as unknown as Node);
    return sig.checkSignature(signedXml);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/modules/nfse/xml-signer.spec.ts`
Expected: 3 pass. If the first assertion fails only on the exact `</infDPS><Signature xmlns=...` string (xml-crypto may emit a namespace prefix), relax it to `expect(signed).toMatch(/<\/infDPS><(\w+:)?Signature /)` — the structural assertions (`Reference URI`, algorithms, X509Certificate, verify round-trip) are the real contract.

- [ ] **Step 5: Commit**

```bash
git add src/modules/nfse/xml-signer.ts test/modules/nfse/xml-signer.spec.ts
git commit -m "feat(nfse): sign DPS XML with the A1 certificate"
```

---

### Task 9: FakeNfseGateway + NfseModule wiring by NFSE_ENV

**Files:**
- Create: `src/modules/nfse/fake-nfse.gateway.ts`
- Modify: `src/modules/nfse/nfse.module.ts`
- Test: `test/modules/nfse/fake-nfse.gateway.spec.ts`

**Interfaces:**
- Consumes: `NfseGateway`, `DpsData`, `EmitResult`, `buildDpsXml`, `signXml`, `NfseRejectedError`.
- Produces: `FakeNfseGateway implements NfseGateway` with `rejectNext(code: string, message: string)` (the next `emit`/`cancel` throws `NfseRejectedError`), `emitted: Map<chaveAcesso, EmitResult>`. `NfseModule` provides `NFSE_GATEWAY` → `FakeNfseGateway` when `NFSE_ENV=fake`, else `NationalNfseGateway` (added in Task 12 — until then the module throws a clear error for non-fake envs).

- [ ] **Step 1: Write the failing test**

`test/modules/nfse/fake-nfse.gateway.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { loadCertificate } from '@/modules/nfse/certificate';
import { NfseRejectedError } from '@/modules/nfse/errors';
import { FakeNfseGateway } from '@/modules/nfse/fake-nfse.gateway';
import type { DpsData } from '@/modules/nfse/nfse-gateway';
import { verifyXmlSignature } from '@/modules/nfse/xml-signer';
import { createTestPfx } from '../../helpers/test-certificate';

const { pfx, password, certPem } = createTestPfx();
const certificate = loadCertificate(pfx, password);
const dps: DpsData = {
  ambiente: 'homologacao',
  serie: '1',
  numero: 3,
  dataEmissao: new Date(),
  prestador: { cnpj: '12345678000199', codigoMunicipio: '3550308' },
  tomador: { documento: '12345678909', nome: 'Cliente' },
  servico: { codigoTributacao: '01.01.01', descricao: 'Serviço', valor: '10.00' },
};

describe('FakeNfseGateway', () => {
  it('emits a signed DPS and returns a 50-digit chaveAcesso, a numeroNfse and a fake NFS-e XML', async () => {
    const gateway = new FakeNfseGateway();
    const result = await gateway.emit(dps, certificate);
    expect(result.chaveAcesso).toMatch(/^\d{50}$/);
    expect(result.numeroNfse).toBe('3');
    expect(verifyXmlSignature(result.xmlDps, certPem)).toBe(true);
    expect(result.xmlNfse).toContain('<NFSe');
    expect(result.xmlNfse).toContain(result.chaveAcesso);
    expect(gateway.emitted.get(result.chaveAcesso)).toEqual(result);
  });

  it('throws NfseRejectedError once after rejectNext()', async () => {
    const gateway = new FakeNfseGateway();
    gateway.rejectNext('E0001', 'Tomador inválido');
    await expect(gateway.emit(dps, certificate)).rejects.toBeInstanceOf(NfseRejectedError);
    await expect(gateway.emit(dps, certificate)).resolves.toBeDefined();
  });

  it('cancels an emitted note and rejects unknown keys', async () => {
    const gateway = new FakeNfseGateway();
    const { chaveAcesso } = await gateway.emit(dps, certificate);
    await expect(gateway.cancel(chaveAcesso, 'erro', dps, certificate)).resolves.toBeUndefined();
    await expect(gateway.cancel('0'.repeat(50), 'erro', dps, certificate)).rejects.toBeInstanceOf(NfseRejectedError);
  });

  it('returns a PDF buffer for an emitted note', async () => {
    const gateway = new FakeNfseGateway();
    const { chaveAcesso } = await gateway.emit(dps, certificate);
    const pdf = await gateway.pdf(chaveAcesso, certificate);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/modules/nfse/fake-nfse.gateway.spec.ts`
Expected: FAIL — cannot resolve `@/modules/nfse/fake-nfse.gateway`.

- [ ] **Step 3: Implement the fake gateway**

`src/modules/nfse/fake-nfse.gateway.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { LoadedCertificate } from './certificate';
import { buildDpsXml, escapeXml, formatDateTimeBr, NFSE_NAMESPACE } from './dps-builder';
import { NfseRejectedError } from './errors';
import type { DpsData, EmitResult, NfseGateway } from './nfse-gateway';
import { signXml } from './xml-signer';

const FAKE_PDF = Buffer.from('%PDF-1.4\n%fake DANFSe generated by FakeNfseGateway\n%%EOF\n');

@Injectable()
export class FakeNfseGateway implements NfseGateway {
  readonly emitted = new Map<string, EmitResult>();
  private pendingRejection: NfseRejectedError | null = null;

  rejectNext(code: string, message: string) {
    this.pendingRejection = new NfseRejectedError(code, message);
  }

  async emit(dps: DpsData, certificate: LoadedCertificate): Promise<EmitResult> {
    this.consumeRejection();
    const { xml } = buildDpsXml(dps);
    const xmlDps = signXml(xml, certificate, 'infDPS');
    const chaveAcesso = this.fakeChave(dps);
    const numeroNfse = String(dps.numero);
    const xmlNfse =
      `<NFSe xmlns="${NFSE_NAMESPACE}" versao="1.00"><infNFSe Id="NFS${chaveAcesso}">` +
      `<nNFSe>${numeroNfse}</nNFSe><dhProc>${formatDateTimeBr(new Date())}</dhProc>` +
      `<emit><CNPJ>${dps.prestador.cnpj}</CNPJ></emit>` +
      `<toma><xNome>${escapeXml(dps.tomador.nome)}</xNome></toma>` +
      `</infNFSe>${xmlDps}</NFSe>`;
    const result = { chaveAcesso, numeroNfse, xmlDps, xmlNfse };
    this.emitted.set(chaveAcesso, result);
    return result;
  }

  async cancel(chaveAcesso: string): Promise<void> {
    this.consumeRejection();
    if (!this.emitted.has(chaveAcesso)) {
      throw new NfseRejectedError('E9999', 'NFS-e não encontrada');
    }
  }

  async pdf(chaveAcesso: string): Promise<Buffer> {
    if (!this.emitted.has(chaveAcesso)) {
      throw new NfseRejectedError('E9999', 'NFS-e não encontrada');
    }
    return FAKE_PDF;
  }

  private consumeRejection() {
    if (this.pendingRejection) {
      const error = this.pendingRejection;
      this.pendingRejection = null;
      throw error;
    }
  }

  /** cMun(7) + tpAmb(1) + AAMM(4) + CNPJ(14) + serie... — 50 digits, deterministic per DPS. */
  private fakeChave(dps: DpsData): string {
    const now = new Date();
    const aamm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const head = dps.prestador.codigoMunicipio + (dps.ambiente === 'producao' ? '1' : '2') + aamm + dps.prestador.cnpj;
    const tail = String(dps.numero).padStart(15, '0') + String(Date.now()).slice(-9);
    return (head + tail).padEnd(50, '0').slice(0, 50);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/modules/nfse/fake-nfse.gateway.spec.ts`
Expected: 4 pass.

- [ ] **Step 5: Wire NfseModule by NFSE_ENV**

`src/modules/nfse/nfse.module.ts` (replace the file):
```ts
import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { CertificateVault } from './crypto/certificate-vault';
import { FakeNfseGateway } from './fake-nfse.gateway';
import { NFSE_GATEWAY } from './nfse-gateway';

const gatewayProvider: Provider = {
  provide: NFSE_GATEWAY,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => {
    const env = config.get('NFSE_ENV', { infer: true });
    if (env === 'fake') return new FakeNfseGateway();
    throw new Error(`NFSE_ENV=${env} is not wired yet (NationalNfseGateway lands in a later task)`);
  },
};

@Module({
  providers: [CertificateVault, gatewayProvider],
  exports: [CertificateVault, gatewayProvider],
})
export class NfseModule {}
```

- [ ] **Step 6: Typecheck and run the whole suite**

Run: `bunx tsc --noEmit && bun test`
Expected: no type errors; all specs so far pass.

- [ ] **Step 7: Commit**

```bash
git add src/modules/nfse test/modules/nfse
git commit -m "feat(nfse): fake gateway and NFSE_ENV-based wiring"
```

---

### Task 10: InvoicesService — emit, list, detail, XML

**Files:**
- Create: `src/modules/invoices/dto/create-invoice.dto.ts`, `dto/list-invoices.dto.ts`
- Create: `src/modules/invoices/invoices.service.ts`
- Test: `test/modules/invoices/invoices.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (`invoice.*`, `$transaction`), `CompaniesService.getCompanyWithCertificate/findMine`, `NFSE_GATEWAY: NfseGateway`, `Env.NFSE_ENV`, `NfseRejectedError`, `NfseUnavailableError`.
- Produces `InvoicesService`:
  - `emit(userId: string, dto: CreateInvoiceDto): Promise<InvoiceResponse>`
  - `findAll(userId: string, query: ListInvoicesDto): Promise<{ data: InvoiceResponse[]; page: number; limit: number; total: number }>`
  - `findOne(userId: string, id: string): Promise<InvoiceResponse>`
  - `getXml(userId: string, id: string): Promise<string>`
  - `InvoiceResponse` = the `Invoice` row without `xmlDps`/`xmlNfse`, with `valor: string`.
  - Task 11 adds `cancel` and `getPdf` to this same class.

- [ ] **Step 1: Write the DTOs**

`src/modules/invoices/dto/create-invoice.dto.ts`:
```ts
import { IsEmail, IsNumber, IsOptional, IsPositive, IsString, Length, Matches } from 'class-validator';

export class CreateInvoiceDto {
  @Matches(/^(\d{11}|\d{14})$/, { message: 'tomadorDocumento must be a CPF (11 digits) or CNPJ (14 digits)' })
  tomadorDocumento: string;

  @IsString()
  @Length(2, 150)
  tomadorNome: string;

  @IsOptional()
  @IsEmail()
  tomadorEmail?: string;

  @IsString()
  @Length(1, 2000)
  descricao: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  valor: number;

  @Matches(/^\d{2}\.\d{2}\.\d{2}$/, { message: 'codigoTributacao must look like 01.01.01' })
  codigoTributacao: string;
}
```

`src/modules/invoices/dto/list-invoices.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { InvoiceStatus } from '../../../../generated/prisma/client';

export class ListInvoicesDto {
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
```

- [ ] **Step 2: Write the failing service test**

`test/modules/invoices/invoices.service.spec.ts`:
```ts
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { BadGatewayException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CompaniesService } from '@/modules/companies/companies.service';
import { InvoicesService } from '@/modules/invoices/invoices.service';
import { NfseRejectedError, NfseUnavailableError } from '@/modules/nfse/errors';
import { NFSE_GATEWAY } from '@/modules/nfse/nfse-gateway';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';

const userId = 'user-1';
const company = { id: 'c1', userId, cnpj: '12345678000199', inscricaoMunicipal: null, codigoMunicipio: '3550308' };
const certificate = { certPem: 'CERT', keyPem: 'KEY', notBefore: new Date(0), notAfter: new Date(9e12), subjectCn: 'X' };
const dto = { tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 150, codigoTributacao: '01.01.01' };
const pendingRow = {
  id: 'i1', companyId: 'c1', status: 'PENDING', dpsNumero: 4, dpsSerie: '1',
  tomadorDocumento: '12345678909', tomadorNome: 'Cliente', tomadorEmail: null,
  descricao: 'Serviço', valor: '150.00', codigoTributacao: '01.01.01',
  chaveAcesso: null, numeroNfse: null, xmlDps: null, xmlNfse: null, rejectionReason: null,
  cancelledAt: null, cancelReason: null, createdAt: new Date(), updatedAt: new Date(),
};
const emitResult = { chaveAcesso: '1'.repeat(50), numeroNfse: '4', xmlDps: '<DPS/>', xmlNfse: '<NFSe/>' };

describe('InvoicesService', () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let gateway: { emit: ReturnType<typeof mock>; cancel: ReturnType<typeof mock>; pdf: ReturnType<typeof mock> };
  let companies: { getCompanyWithCertificate: ReturnType<typeof mock>; findMine: ReturnType<typeof mock> };

  beforeEach(async () => {
    prisma = createPrismaMock();
    gateway = { emit: mock(), cancel: mock(), pdf: mock() };
    companies = {
      getCompanyWithCertificate: mock(async () => ({ company, certificate })),
      findMine: mock(async () => ({ id: 'c1' })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CompaniesService, useValue: companies },
        { provide: NFSE_GATEWAY, useValue: gateway },
        { provide: ConfigService, useValue: { get: () => 'fake' } },
      ],
    }).compile();
    service = moduleRef.get(InvoicesService);
  });

  describe('emit', () => {
    beforeEach(() => {
      prisma.invoice.aggregate.mockResolvedValue({ _max: { dpsNumero: 3 } });
      prisma.invoice.create.mockResolvedValue(pendingRow);
    });

    it('creates a PENDING row with the next dpsNumero, calls the gateway and marks it ISSUED', async () => {
      gateway.emit.mockResolvedValue(emitResult);
      prisma.invoice.update.mockResolvedValue({ ...pendingRow, status: 'ISSUED', ...emitResult });

      const result = await service.emit(userId, dto);

      expect(prisma.invoice.create.mock.calls[0][0].data).toMatchObject({ companyId: 'c1', dpsSerie: '1', dpsNumero: 4, valor: '150.00', status: 'PENDING' });
      const [dps, cert] = gateway.emit.mock.calls[0];
      expect(dps).toMatchObject({ ambiente: 'homologacao', serie: '1', numero: 4, prestador: { cnpj: '12345678000199', codigoMunicipio: '3550308' }, servico: { valor: '150.00', codigoTributacao: '01.01.01' } });
      expect(cert).toBe(certificate);
      expect(prisma.invoice.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'ISSUED', ...emitResult } });
      expect(result.status).toBe('ISSUED');
      expect(result.chaveAcesso).toBe(emitResult.chaveAcesso);
      expect(result).not.toHaveProperty('xmlDps');
      expect(result).not.toHaveProperty('xmlNfse');
    });

    it('starts at dpsNumero 1 when the company has no invoices', async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _max: { dpsNumero: null } });
      gateway.emit.mockResolvedValue(emitResult);
      prisma.invoice.update.mockResolvedValue({ ...pendingRow, status: 'ISSUED' });
      await service.emit(userId, dto);
      expect(prisma.invoice.create.mock.calls[0][0].data.dpsNumero).toBe(1);
    });

    it('propagates 422 from CompaniesService when there is no usable certificate', async () => {
      companies.getCompanyWithCertificate.mockRejectedValue(new UnprocessableEntityException('no cert'));
      await expect(service.emit(userId, dto)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it('marks the row REJECTED and throws 422 when the API rejects the DPS', async () => {
      gateway.emit.mockRejectedValue(new NfseRejectedError('E123', 'Tomador inválido'));
      prisma.invoice.update.mockResolvedValue({ ...pendingRow, status: 'REJECTED' });
      await expect(service.emit(userId, dto)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.invoice.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'REJECTED', rejectionReason: 'E123: Tomador inválido' } });
    });

    it('keeps the row PENDING and throws 502 when the API is unavailable', async () => {
      gateway.emit.mockRejectedValue(new NfseUnavailableError());
      await expect(service.emit(userId, dto)).rejects.toBeInstanceOf(BadGatewayException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('lists only the company invoices, paginated and filtered by status', async () => {
      prisma.invoice.findMany.mockResolvedValue([pendingRow]);
      prisma.invoice.count.mockResolvedValue(1);
      const result = await service.findAll(userId, { status: 'PENDING', page: 2, limit: 10 });
      expect(prisma.invoice.findMany).toHaveBeenCalledWith({ where: { companyId: 'c1', status: 'PENDING' }, orderBy: { createdAt: 'desc' }, skip: 10, take: 10 });
      expect(result).toEqual({ data: [expect.objectContaining({ id: 'i1', valor: '150.00' })], page: 2, limit: 10, total: 1 });
    });
  });

  describe('findOne / getXml', () => {
    it('returns the invoice scoped to the company', async () => {
      prisma.invoice.findFirst.mockResolvedValue(pendingRow);
      const result = await service.findOne(userId, 'i1');
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith({ where: { id: 'i1', companyId: 'c1' } });
      expect(result.id).toBe('i1');
    });

    it('throws 404 when the invoice belongs to another company', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      await expect(service.findOne(userId, 'other')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the NFS-e XML and 404s when there is none', async () => {
      prisma.invoice.findFirst.mockResolvedValueOnce({ ...pendingRow, status: 'ISSUED', xmlNfse: '<NFSe/>' });
      await expect(service.getXml(userId, 'i1')).resolves.toBe('<NFSe/>');
      prisma.invoice.findFirst.mockResolvedValueOnce(pendingRow);
      await expect(service.getXml(userId, 'i1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test test/modules/invoices/invoices.service.spec.ts`
Expected: FAIL — cannot resolve `@/modules/invoices/invoices.service`.

- [ ] **Step 4: Implement InvoicesService (emit/list/detail/xml)**

`src/modules/invoices/invoices.service.ts`:
```ts
import {
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Invoice } from '../../../generated/prisma/client';
import type { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { CompaniesService } from '../companies/companies.service';
import { NfseRejectedError, NfseUnavailableError } from '../nfse/errors';
import { NFSE_GATEWAY, type DpsData, type NfseAmbiente, type NfseGateway } from '../nfse/nfse-gateway';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';

export const DEFAULT_SERIE = '1';

export type InvoiceResponse = Omit<Invoice, 'xmlDps' | 'xmlNfse' | 'valor'> & { valor: string };

@Injectable()
export class InvoicesService {
  private readonly ambiente: NfseAmbiente;

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    @Inject(NFSE_GATEWAY) private readonly gateway: NfseGateway,
    config: ConfigService<Env, true>,
  ) {
    this.ambiente = config.get('NFSE_ENV', { infer: true }) === 'producao' ? 'producao' : 'homologacao';
  }

  async emit(userId: string, dto: CreateInvoiceDto): Promise<InvoiceResponse> {
    const { company, certificate } = await this.companies.getCompanyWithCertificate(userId);
    const valor = dto.valor.toFixed(2);

    const invoice = await this.prisma.$transaction(async (tx) => {
      const { _max } = await tx.invoice.aggregate({
        where: { companyId: company.id, dpsSerie: DEFAULT_SERIE },
        _max: { dpsNumero: true },
      });
      return tx.invoice.create({
        data: {
          companyId: company.id,
          status: 'PENDING',
          dpsSerie: DEFAULT_SERIE,
          dpsNumero: (_max.dpsNumero ?? 0) + 1,
          tomadorDocumento: dto.tomadorDocumento,
          tomadorNome: dto.tomadorNome,
          tomadorEmail: dto.tomadorEmail ?? null,
          descricao: dto.descricao,
          valor,
          codigoTributacao: dto.codigoTributacao,
        },
      });
    });

    const dps: DpsData = {
      ambiente: this.ambiente,
      serie: invoice.dpsSerie,
      numero: invoice.dpsNumero,
      dataEmissao: invoice.createdAt,
      prestador: { cnpj: company.cnpj, inscricaoMunicipal: company.inscricaoMunicipal, codigoMunicipio: company.codigoMunicipio },
      tomador: { documento: invoice.tomadorDocumento, nome: invoice.tomadorNome, email: invoice.tomadorEmail },
      servico: { codigoTributacao: invoice.codigoTributacao, descricao: invoice.descricao, valor },
    };

    try {
      const result = await this.gateway.emit(dps, certificate);
      const issued = await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'ISSUED', ...result },
      });
      return this.toResponse(issued);
    } catch (error) {
      if (error instanceof NfseRejectedError) {
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: { status: 'REJECTED', rejectionReason: `${error.code}: ${error.message}` },
        });
        throw new UnprocessableEntityException({
          message: 'NFS-e rejected by the national API',
          details: { invoiceId: invoice.id, code: error.code, reason: error.message },
        });
      }
      if (error instanceof NfseUnavailableError) {
        throw new BadGatewayException({
          message: 'National NFS-e API unavailable; invoice kept as PENDING',
          details: { invoiceId: invoice.id },
        });
      }
      throw error;
    }
  }

  async findAll(userId: string, query: ListInvoicesDto) {
    const { id: companyId } = await this.companies.findMine(userId);
    const where = { companyId, ...(query.status ? { status: query.status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { data: rows.map((row) => this.toResponse(row)), page: query.page, limit: query.limit, total };
  }

  async findOne(userId: string, id: string): Promise<InvoiceResponse> {
    return this.toResponse(await this.findEntity(userId, id));
  }

  async getXml(userId: string, id: string): Promise<string> {
    const invoice = await this.findEntity(userId, id);
    if (!invoice.xmlNfse) throw new NotFoundException('Invoice has no NFS-e XML (not issued)');
    return invoice.xmlNfse;
  }

  protected async findEntity(userId: string, id: string): Promise<Invoice> {
    const { id: companyId } = await this.companies.findMine(userId);
    const invoice = await this.prisma.invoice.findFirst({ where: { id, companyId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  protected toResponse(invoice: Invoice): InvoiceResponse {
    const { xmlDps: _dps, xmlNfse: _nfse, valor, ...rest } = invoice;
    return { ...rest, valor: Number(valor).toFixed(2) };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/modules/invoices/invoices.service.spec.ts`
Expected: 9 pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/invoices test/modules/invoices
git commit -m "feat(invoices): emit, list, detail and XML download"
```

---

### Task 11: Invoices — cancel, PDF, controller, module, rate limit

**Files:**
- Create: `src/modules/invoices/dto/cancel-invoice.dto.ts`, `src/modules/invoices/invoices.controller.ts`, `src/modules/invoices/invoices.module.ts`
- Modify: `src/modules/invoices/invoices.service.ts`, `src/app.module.ts`
- Test: `test/modules/invoices/invoices.service.spec.ts` (append a `describe`)

**Interfaces:**
- Produces on `InvoicesService`: `cancel(userId: string, id: string, motivo: string): Promise<InvoiceResponse>` (409 unless `ISSUED`), `getPdf(userId: string, id: string): Promise<Buffer>` (404 unless `chaveAcesso` set).
- HTTP: `POST /invoices`, `GET /invoices`, `GET /invoices/:id`, `GET /invoices/:id/xml` (`application/xml`), `GET /invoices/:id/pdf` (`application/pdf`), `POST /invoices/:id/cancel`.

- [ ] **Step 1: Append the failing tests**

Append inside the top-level `describe('InvoicesService', ...)` in `test/modules/invoices/invoices.service.spec.ts` (after the `findOne / getXml` block). Also add `ConflictException` to the `@nestjs/common` import.

```ts
  describe('cancel', () => {
    const issuedRow = { ...pendingRow, status: 'ISSUED', chaveAcesso: '1'.repeat(50), numeroNfse: '4', xmlNfse: '<NFSe/>' };

    it('sends the cancel event and marks the invoice CANCELLED', async () => {
      prisma.invoice.findFirst.mockResolvedValue(issuedRow);
      gateway.cancel.mockResolvedValue(undefined);
      prisma.invoice.update.mockImplementation(async ({ data }: any) => ({ ...issuedRow, ...data }));

      const result = await service.cancel(userId, 'i1', 'Erro de digitação');

      const [chave, motivo, dpsCtx, cert] = gateway.cancel.mock.calls[0];
      expect(chave).toBe(issuedRow.chaveAcesso);
      expect(motivo).toBe('Erro de digitação');
      expect(dpsCtx).toMatchObject({ ambiente: 'homologacao', prestador: { cnpj: '12345678000199' } });
      expect(cert).toBe(certificate);
      expect(prisma.invoice.update.mock.calls[0][0].data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Erro de digitação' });
      expect(result.status).toBe('CANCELLED');
    });

    it('throws 409 when the invoice is not ISSUED', async () => {
      prisma.invoice.findFirst.mockResolvedValue(pendingRow);
      await expect(service.cancel(userId, 'i1', 'x')).rejects.toBeInstanceOf(ConflictException);
      expect(gateway.cancel).not.toHaveBeenCalled();
    });

    it('throws 422 when the API rejects the cancellation and keeps the invoice ISSUED', async () => {
      prisma.invoice.findFirst.mockResolvedValue(issuedRow);
      gateway.cancel.mockRejectedValue(new NfseRejectedError('E200', 'Prazo expirado'));
      await expect(service.cancel(userId, 'i1', 'x')).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it('throws 502 when the API is unavailable', async () => {
      prisma.invoice.findFirst.mockResolvedValue(issuedRow);
      gateway.cancel.mockRejectedValue(new NfseUnavailableError());
      await expect(service.cancel(userId, 'i1', 'x')).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('getPdf', () => {
    it('proxies the DANFSe from the gateway', async () => {
      prisma.invoice.findFirst.mockResolvedValue({ ...pendingRow, status: 'ISSUED', chaveAcesso: '1'.repeat(50) });
      gateway.pdf.mockResolvedValue(Buffer.from('%PDF'));
      const pdf = await service.getPdf(userId, 'i1');
      expect(gateway.pdf).toHaveBeenCalledWith('1'.repeat(50), certificate);
      expect(pdf.toString()).toBe('%PDF');
    });

    it('throws 404 when the invoice has no chaveAcesso', async () => {
      prisma.invoice.findFirst.mockResolvedValue(pendingRow);
      await expect(service.getPdf(userId, 'i1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/modules/invoices/invoices.service.spec.ts`
Expected: the 6 new tests FAIL (`service.cancel is not a function`, `service.getPdf is not a function`).

- [ ] **Step 3: Add cancel and getPdf to InvoicesService**

Add `ConflictException` to the `@nestjs/common` import, then append these methods to the class (before `findEntity`):

```ts
  async cancel(userId: string, id: string, motivo: string): Promise<InvoiceResponse> {
    const invoice = await this.findEntity(userId, id);
    if (invoice.status !== 'ISSUED' || !invoice.chaveAcesso) {
      throw new ConflictException(`Only ISSUED invoices can be cancelled (current: ${invoice.status})`);
    }
    const { company, certificate } = await this.companies.getCompanyWithCertificate(userId);

    try {
      await this.gateway.cancel(
        invoice.chaveAcesso,
        motivo,
        {
          ambiente: this.ambiente,
          prestador: { cnpj: company.cnpj, inscricaoMunicipal: company.inscricaoMunicipal, codigoMunicipio: company.codigoMunicipio },
        },
        certificate,
      );
    } catch (error) {
      if (error instanceof NfseRejectedError) {
        throw new UnprocessableEntityException({
          message: 'Cancellation rejected by the national API',
          details: { invoiceId: invoice.id, code: error.code, reason: error.message },
        });
      }
      if (error instanceof NfseUnavailableError) {
        throw new BadGatewayException({ message: 'National NFS-e API unavailable', details: { invoiceId: invoice.id } });
      }
      throw error;
    }

    const cancelled = await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: motivo },
    });
    return this.toResponse(cancelled);
  }

  async getPdf(userId: string, id: string): Promise<Buffer> {
    const invoice = await this.findEntity(userId, id);
    if (!invoice.chaveAcesso) throw new NotFoundException('Invoice has no NFS-e (not issued)');
    const { certificate } = await this.companies.getCompanyWithCertificate(userId);
    try {
      return await this.gateway.pdf(invoice.chaveAcesso, certificate);
    } catch (error) {
      if (error instanceof NfseUnavailableError) {
        throw new BadGatewayException({ message: 'National NFS-e API unavailable', details: { invoiceId: invoice.id } });
      }
      throw error;
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/modules/invoices/invoices.service.spec.ts`
Expected: 15 pass.

- [ ] **Step 5: Write the cancel DTO, controller and module**

`src/modules/invoices/dto/cancel-invoice.dto.ts`:
```ts
import { IsString, Length } from 'class-validator';

export class CancelInvoiceDto {
  @IsString()
  @Length(15, 255, { message: 'motivo must have between 15 and 255 characters' })
  motivo: string;
}
```

`src/modules/invoices/invoices.controller.ts`:
```ts
import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { CancelInvoiceDto } from './dto/cancel-invoice.dto';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';
import { InvoicesService } from './invoices.service';

@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  emit(@CurrentUser() user: AuthUser, @Body() dto: CreateInvoiceDto) {
    return this.invoices.emit(user.id, dto);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListInvoicesDto) {
    return this.invoices.findAll(user.id, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.findOne(user.id, id);
  }

  @Get(':id/xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  getXml(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.getXml(user.id, id);
  }

  @Get(':id/pdf')
  async getPdf(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const pdf = await this.invoices.getPdf(user.id, id);
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `inline; filename="nfse-${id}.pdf"` });
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelInvoiceDto) {
    return this.invoices.cancel(user.id, id, dto.motivo);
  }
}
```

`src/modules/invoices/invoices.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { NfseModule } from '../nfse/nfse.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  imports: [CompaniesModule, NfseModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
})
export class InvoicesModule {}
```

- [ ] **Step 6: Register ThrottlerModule and InvoicesModule in AppModule**

`src/app.module.ts` (full file at this point):
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env';
import { AuthModule } from './modules/auth/auth.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { HealthController } from './modules/health/health.controller';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PrismaModule,
    AuthModule,
    CompaniesModule,
    InvoicesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 7: Typecheck, boot, full suite**

Run: `bunx tsc --noEmit && bun test && (bun run src/main.ts &) ; sleep 4 ; curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/invoices ; pkill -f "bun run src/main.ts"`
Expected: no type errors, all tests pass, `401`.

- [ ] **Step 8: Commit**

```bash
git add src/modules/invoices src/app.module.ts test/modules/invoices
git commit -m "feat(invoices): cancel, DANFSe download, HTTP controller and rate limit"
```

---

### Task 12: NationalNfseGateway (real API client, mTLS)

**Files:**
- Create: `src/modules/nfse/national-nfse.gateway.ts`
- Modify: `src/modules/nfse/nfse.module.ts`
- Test: `test/modules/nfse/national-nfse.gateway.spec.ts`

**Interfaces:**
- Consumes: `buildDpsXml`, `buildCancelEventXml`, `signXml`, `LoadedCertificate`, errors.
- Produces:
```ts
export interface HttpRequest { method: 'GET' | 'POST'; url: string; body?: string; accept: string; certPem: string; keyPem: string }
export interface HttpResponse { status: number; body: Buffer }
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;
export const httpsTransport: HttpTransport;          // node:https with cert/key (mTLS), 30 s timeout
export class NationalNfseGateway implements NfseGateway {
  constructor(urls: { sefin: string; adn: string }, transport?: HttpTransport)
}
```
Request/response contract with the national API (from the Swagger "Contribuintes ISSQN"): `POST {sefin}/nfse` body `{ "dpsXmlGZipB64": string }` → `{ "chaveAcesso": string, "nfseXmlGZipB64": string }`; `POST {sefin}/nfse/{chave}/eventos` body `{ "pedidoRegistroEventoXmlGZipB64": string }`; `GET {adn}/DANFSE/{chave}` → PDF bytes; errors as `{ "erros": [{ "codigo": string, "descricao": string }] }`. **Confirm these against the Swagger the first time a real certificate is available** — the gateway is the only file that knows them.

- [ ] **Step 1: Write the failing test**

`test/modules/nfse/national-nfse.gateway.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { loadCertificate } from '@/modules/nfse/certificate';
import { NfseRejectedError, NfseUnavailableError } from '@/modules/nfse/errors';
import { NationalNfseGateway, type HttpRequest, type HttpResponse } from '@/modules/nfse/national-nfse.gateway';
import type { DpsData } from '@/modules/nfse/nfse-gateway';
import { verifyXmlSignature } from '@/modules/nfse/xml-signer';
import { createTestPfx } from '../../helpers/test-certificate';

const { pfx, password, certPem } = createTestPfx();
const certificate = loadCertificate(pfx, password);
const urls = { sefin: 'https://sefin.test/SefinNacional', adn: 'https://adn.test/contribuintes' };
const dps: DpsData = {
  ambiente: 'homologacao',
  serie: '1',
  numero: 5,
  dataEmissao: new Date(),
  prestador: { cnpj: '12345678000199', codigoMunicipio: '3550308' },
  tomador: { documento: '12345678909', nome: 'Cliente' },
  servico: { codigoTributacao: '01.01.01', descricao: 'Serviço', valor: '10.00' },
};
const chave = '3'.repeat(50);
const nfseXml = `<NFSe><infNFSe Id="NFS${chave}"><nNFSe>77</nNFSe></infNFSe></NFSe>`;
const gz = (s: string) => gzipSync(Buffer.from(s, 'utf8')).toString('base64');

function fakeTransport(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const calls: HttpRequest[] = [];
  const transport = async (req: HttpRequest) => {
    calls.push(req);
    return responder(req);
  };
  return { transport, calls };
}

describe('NationalNfseGateway', () => {
  describe('emit', () => {
    it('POSTs a gzip+base64 signed DPS with the certificate and parses the NFS-e', async () => {
      const { transport, calls } = fakeTransport(() => ({
        status: 201,
        body: Buffer.from(JSON.stringify({ chaveAcesso: chave, nfseXmlGZipB64: gz(nfseXml) })),
      }));
      const gateway = new NationalNfseGateway(urls, transport);

      const result = await gateway.emit(dps, certificate);

      expect(calls[0]).toMatchObject({ method: 'POST', url: `${urls.sefin}/nfse`, certPem, accept: 'application/json' });
      expect(calls[0].keyPem).toBe(certificate.keyPem);
      const sent = JSON.parse(calls[0].body!);
      const xmlDps = gunzipSync(Buffer.from(sent.dpsXmlGZipB64, 'base64')).toString('utf8');
      expect(verifyXmlSignature(xmlDps, certPem)).toBe(true);
      expect(result).toEqual({ chaveAcesso: chave, numeroNfse: '77', xmlDps, xmlNfse: nfseXml });
    });

    it('throws NfseRejectedError with the API error code on 4xx', async () => {
      const { transport } = fakeTransport(() => ({
        status: 400,
        body: Buffer.from(JSON.stringify({ erros: [{ codigo: 'E0042', descricao: 'CNPJ do prestador inválido' }] })),
      }));
      const gateway = new NationalNfseGateway(urls, transport);
      const error = await gateway.emit(dps, certificate).catch((e) => e);
      expect(error).toBeInstanceOf(NfseRejectedError);
      expect(error.code).toBe('E0042');
      expect(error.message).toContain('CNPJ do prestador inválido');
    });

    it('throws NfseUnavailableError on 5xx and on transport failure', async () => {
      const five = new NationalNfseGateway(urls, fakeTransport(() => ({ status: 503, body: Buffer.from('') })).transport);
      await expect(five.emit(dps, certificate)).rejects.toBeInstanceOf(NfseUnavailableError);
      const down = new NationalNfseGateway(urls, async () => { throw new Error('ECONNRESET'); });
      await expect(down.emit(dps, certificate)).rejects.toBeInstanceOf(NfseUnavailableError);
    });
  });

  describe('cancel', () => {
    it('POSTs a signed pedRegEvento to /nfse/{chave}/eventos', async () => {
      const { transport, calls } = fakeTransport(() => ({ status: 201, body: Buffer.from('{}') }));
      const gateway = new NationalNfseGateway(urls, transport);
      await gateway.cancel(chave, 'Erro de digitação no valor', dps, certificate);
      expect(calls[0]).toMatchObject({ method: 'POST', url: `${urls.sefin}/nfse/${chave}/eventos` });
      const xml = gunzipSync(Buffer.from(JSON.parse(calls[0].body!).pedidoRegistroEventoXmlGZipB64, 'base64')).toString('utf8');
      expect(xml).toContain(`<chNFSe>${chave}</chNFSe>`);
      expect(xml).toContain('<e101101>');
      expect(verifyXmlSignature(xml, certPem)).toBe(true);
    });
  });

  describe('pdf', () => {
    it('GETs the DANFSe from the ADN and returns the bytes', async () => {
      const { transport, calls } = fakeTransport(() => ({ status: 200, body: Buffer.from('%PDF-1.4') }));
      const gateway = new NationalNfseGateway(urls, transport);
      const pdf = await gateway.pdf(chave, certificate);
      expect(calls[0]).toMatchObject({ method: 'GET', url: `${urls.adn}/DANFSE/${chave}`, accept: 'application/pdf' });
      expect(pdf.toString()).toBe('%PDF-1.4');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/modules/nfse/national-nfse.gateway.spec.ts`
Expected: FAIL — cannot resolve `@/modules/nfse/national-nfse.gateway`.

- [ ] **Step 3: Implement the gateway**

`src/modules/nfse/national-nfse.gateway.ts`:
```ts
import https from 'node:https';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { LoadedCertificate } from './certificate';
import { buildCancelEventXml, buildDpsXml } from './dps-builder';
import { NfseRejectedError, NfseUnavailableError } from './errors';
import type { DpsData, EmitResult, NfseGateway } from './nfse-gateway';
import { signXml } from './xml-signer';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  accept: string;
  certPem: string;
  keyPem: string;
}

export interface HttpResponse {
  status: number;
  body: Buffer;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

const TIMEOUT_MS = 30_000;

/** node:https transport with client certificate (mTLS). */
export const httpsTransport: HttpTransport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const request = https.request(
      {
        method: req.method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          accept: req.accept,
          ...(req.body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(req.body) } : {}),
        },
        cert: req.certPem,
        key: req.keyPem,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`)));
    request.on('error', reject);
    if (req.body) request.write(req.body);
    request.end();
  });

function gzipB64(xml: string): string {
  return gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
}

function gunzipB64(payload: string): string {
  return gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
}

export class NationalNfseGateway implements NfseGateway {
  constructor(
    private readonly urls: { sefin: string; adn: string },
    private readonly transport: HttpTransport = httpsTransport,
  ) {}

  async emit(dps: DpsData, certificate: LoadedCertificate): Promise<EmitResult> {
    const { xml } = buildDpsXml(dps);
    const xmlDps = signXml(xml, certificate, 'infDPS');

    const response = await this.send({
      method: 'POST',
      url: `${this.urls.sefin}/nfse`,
      body: JSON.stringify({ dpsXmlGZipB64: gzipB64(xmlDps) }),
      accept: 'application/json',
      certificate,
    });

    const json = this.parseJson(response) as { chaveAcesso?: string; nfseXmlGZipB64?: string };
    if (!json.chaveAcesso || !json.nfseXmlGZipB64) {
      throw new NfseUnavailableError('Unexpected response from national API: missing chaveAcesso/nfseXmlGZipB64');
    }
    const xmlNfse = gunzipB64(json.nfseXmlGZipB64);
    const numeroNfse = /<nNFSe>(\d+)<\/nNFSe>/.exec(xmlNfse)?.[1] ?? '';
    return { chaveAcesso: json.chaveAcesso, numeroNfse, xmlDps, xmlNfse };
  }

  async cancel(
    chaveAcesso: string,
    motivo: string,
    dps: Pick<DpsData, 'ambiente' | 'prestador'>,
    certificate: LoadedCertificate,
  ): Promise<void> {
    const { xml } = buildCancelEventXml({
      ambiente: dps.ambiente,
      chaveAcesso,
      cnpjAutor: dps.prestador.cnpj,
      motivo,
      dataEvento: new Date(),
    });
    const signed = signXml(xml, certificate, 'infPedReg');
    await this.send({
      method: 'POST',
      url: `${this.urls.sefin}/nfse/${chaveAcesso}/eventos`,
      body: JSON.stringify({ pedidoRegistroEventoXmlGZipB64: gzipB64(signed) }),
      accept: 'application/json',
      certificate,
    });
  }

  async pdf(chaveAcesso: string, certificate: LoadedCertificate): Promise<Buffer> {
    const response = await this.send({
      method: 'GET',
      url: `${this.urls.adn}/DANFSE/${chaveAcesso}`,
      accept: 'application/pdf',
      certificate,
    });
    return response.body;
  }

  private async send(input: {
    method: 'GET' | 'POST';
    url: string;
    body?: string;
    accept: string;
    certificate: LoadedCertificate;
  }): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await this.transport({
        method: input.method,
        url: input.url,
        body: input.body,
        accept: input.accept,
        certPem: input.certificate.certPem,
        keyPem: input.certificate.keyPem,
      });
    } catch (error) {
      throw new NfseUnavailableError(`National API request failed: ${(error as Error).message}`);
    }

    if (response.status >= 500 || response.status === 0) {
      throw new NfseUnavailableError(`National API responded ${response.status}`);
    }
    if (response.status >= 400) {
      throw this.toRejection(response);
    }
    return response;
  }

  private parseJson(response: HttpResponse): unknown {
    try {
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new NfseUnavailableError('National API returned a non-JSON body');
    }
  }

  private toRejection(response: HttpResponse): NfseRejectedError {
    try {
      const json = JSON.parse(response.body.toString('utf8')) as { erros?: { codigo?: string; descricao?: string }[] };
      const erros = json.erros ?? [];
      if (erros.length > 0) {
        const code = erros[0].codigo ?? String(response.status);
        const message = erros.map((e) => `${e.codigo ?? '?'}: ${e.descricao ?? ''}`).join('; ');
        return new NfseRejectedError(code, message);
      }
    } catch {
      // fall through: non-JSON 4xx body
    }
    return new NfseRejectedError(String(response.status), `National API rejected the request (HTTP ${response.status})`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/modules/nfse/national-nfse.gateway.spec.ts`
Expected: 6 pass.

- [ ] **Step 5: Wire the real gateway in NfseModule**

`src/modules/nfse/nfse.module.ts` — replace the `useFactory`:
```ts
import { NationalNfseGateway } from './national-nfse.gateway';
// ...
  useFactory: (config: ConfigService<Env, true>) => {
    const env = config.get('NFSE_ENV', { infer: true });
    if (env === 'fake') return new FakeNfseGateway();
    return new NationalNfseGateway({
      sefin: config.get('NFSE_SEFIN_URL', { infer: true })!,
      adn: config.get('NFSE_ADN_URL', { infer: true })!,
    });
  },
```

- [ ] **Step 6: Typecheck and full suite**

Run: `bunx tsc --noEmit && bun test`
Expected: no type errors, all pass.

- [ ] **Step 7: Commit**

```bash
git add src/modules/nfse test/modules/nfse
git commit -m "feat(nfse): national API gateway with mTLS transport"
```

---

### Task 13: Global error filter, end-to-end test, README

**Files:**
- Create: `src/common/http-exception.filter.ts`, `README.md`
- Modify: `src/main.ts`
- Test: `test/common/http-exception.filter.spec.ts`, `test/app.e2e.spec.ts`

**Interfaces:**
- Produces: `HttpExceptionFilter` (global) — every error becomes `{ statusCode, message, details? }`. `HttpException` responses that are objects keep `message` and `details`; class-validator errors put the messages array in `details`; unknown errors become 500 with `message: 'Internal server error'` (logged, never leaked).

- [ ] **Step 1: Write the failing filter test**

`test/common/http-exception.filter.spec.ts`:
```ts
import { describe, expect, it, mock } from 'bun:test';
import { ArgumentsHost, BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { HttpExceptionFilter } from '@/common/http-exception.filter';

function hostWithResponse() {
  const json = mock();
  const status = mock(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ url: '/x', method: 'GET' }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  it('formats a plain HttpException', () => {
    const { host, status, json } = hostWithResponse();
    filter.catch(new NotFoundException('Company not found'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ statusCode: 404, message: 'Company not found' });
  });

  it('keeps message and details from an object response', () => {
    const { host, json } = hostWithResponse();
    filter.catch(new UnprocessableEntityException({ message: 'NFS-e rejected', details: { code: 'E1' } }), host);
    expect(json).toHaveBeenCalledWith({ statusCode: 422, message: 'NFS-e rejected', details: { code: 'E1' } });
  });

  it('moves class-validator message arrays into details', () => {
    const { host, json } = hostWithResponse();
    filter.catch(new BadRequestException(['cnpj must be 14 digits', 'razaoSocial must be longer']), host);
    expect(json).toHaveBeenCalledWith({ statusCode: 400, message: 'Validation failed', details: ['cnpj must be 14 digits', 'razaoSocial must be longer'] });
  });

  it('hides unknown errors behind a 500', () => {
    const { host, status, json } = hostWithResponse();
    filter.catch(new Error('db exploded'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/common/http-exception.filter.spec.ts`
Expected: FAIL — cannot resolve `@/common/http-exception.filter`.

- [ ] **Step 3: Implement the filter and register it**

`src/common/http-exception.filter.ts`:
```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

interface ErrorBody {
  statusCode: number;
  message: string;
  details?: unknown;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const body = this.toBody(exception);
    if (body.statusCode >= 500) {
      const request = host.switchToHttp().getRequest();
      this.logger.error(`${request.method} ${request.url} → ${body.statusCode}`, exception instanceof Error ? exception.stack : String(exception));
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (!(exception instanceof HttpException)) {
      return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
    }
    const statusCode = exception.getStatus();
    const raw = exception.getResponse();

    if (typeof raw === 'string') return { statusCode, message: raw };

    const obj = raw as { message?: unknown; details?: unknown };
    if (Array.isArray(obj.message)) {
      return { statusCode, message: 'Validation failed', details: obj.message };
    }
    const body: ErrorBody = { statusCode, message: typeof obj.message === 'string' ? obj.message : exception.message };
    if (obj.details !== undefined) body.details = obj.details;
    return body;
  }
}
```

`src/main.ts` — register after the pipe:
```ts
import { HttpExceptionFilter } from './common/http-exception.filter';
// ...
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
```

- [ ] **Step 4: Run the filter test to verify it passes**

Run: `bun test test/common/http-exception.filter.spec.ts`
Expected: 4 pass.

- [ ] **Step 5: Write the e2e test (skipped unless E2E_DATABASE_URL is set)**

`test/app.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { HttpExceptionFilter } from '@/common/http-exception.filter';
import { JWKS } from '@/modules/auth/jwks.provider';
import { PrismaService } from '@/prisma/prisma.service';
import { createTestPfx } from './helpers/test-certificate';

const E2E_DB = process.env.E2E_DATABASE_URL;
const LOGTO_ENDPOINT = 'http://localhost:3001';
const API_RESOURCE = 'https://api.matheo.local';

describe.skipIf(!E2E_DB)('API e2e (fake gateway, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  const cnpj = String(Date.now()).padStart(14, '0').slice(-14);

  const tokenFor = (sub: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES384' })
      .setIssuer(`${LOGTO_ENDPOINT}/oidc`)
      .setAudience(API_RESOURCE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

  beforeAll(async () => {
    process.env.DATABASE_URL = E2E_DB;
    process.env.LOGTO_ENDPOINT = LOGTO_ENDPOINT;
    process.env.LOGTO_API_RESOURCE = API_RESOURCE;
    process.env.CERT_ENCRYPTION_KEY = process.env.CERT_ENCRYPTION_KEY ?? 'ab'.repeat(32);
    process.env.NFSE_ENV = 'fake';
    ({ privateKey, publicKey } = await generateKeyPair('ES384'));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(async () => publicKey)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { company: { cnpj } } });
    await prisma.company.deleteMany({ where: { cnpj } });
    await app.close();
  });

  it('rejects requests without a token', async () => {
    const res = await request(app.getHttpServer()).get('/companies/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ statusCode: 401, message: 'Missing bearer token' });
  });

  it('happy path: create company → upload certificate → emit → list → xml → cancel', async () => {
    const userId = `e2e-${Date.now()}`;
    const auth = { Authorization: `Bearer ${await tokenFor(userId)}` };
    const server = app.getHttpServer();

    const created = await request(server).post('/companies').set(auth).send({ cnpj, razaoSocial: 'E2E LTDA', codigoMunicipio: '3550308' });
    expect(created.status).toBe(201);
    expect(created.body.hasCertificate).toBe(false);

    const noCert = await request(server).post('/invoices').set(auth).send({ tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 100, codigoTributacao: '01.01.01' });
    expect(noCert.status).toBe(422);

    const { pfx, password } = createTestPfx();
    const uploaded = await request(server).put('/companies/me/certificate').set(auth).field('password', password).attach('file', pfx, 'cert.pfx');
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.hasCertificate).toBe(true);
    expect(uploaded.body).not.toHaveProperty('certificatePfx');

    const emitted = await request(server).post('/invoices').set(auth).send({ tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 100, codigoTributacao: '01.01.01' });
    expect(emitted.status).toBe(201);
    expect(emitted.body.status).toBe('ISSUED');
    expect(emitted.body.dpsNumero).toBe(1);
    expect(emitted.body.chaveAcesso).toMatch(/^\d{50}$/);
    const id = emitted.body.id;

    const list = await request(server).get('/invoices?status=ISSUED').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].id).toBe(id);

    const xml = await request(server).get(`/invoices/${id}/xml`).set(auth);
    expect(xml.status).toBe(200);
    expect(xml.headers['content-type']).toContain('application/xml');
    expect(xml.text).toContain('<NFSe');

    const pdf = await request(server).get(`/invoices/${id}/pdf`).set(auth).buffer().parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');

    const cancelled = await request(server).post(`/invoices/${id}/cancel`).set(auth).send({ motivo: 'Erro de digitação no valor' });
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.status).toBe('CANCELLED');

    const other = await request(server).get(`/invoices/${id}`).set({ Authorization: `Bearer ${await tokenFor('someone-else')}` });
    expect(other.status).toBe(404);
  });
});
```

- [ ] **Step 6: Run the e2e against the compose Postgres**

Run:
```bash
docker compose up -d postgres
set -a; source .env; set +a
bunx --bun prisma migrate deploy
E2E_DATABASE_URL="$DATABASE_URL" bun test test/app.e2e.spec.ts
```
Expected: 2 pass. Then `bun test` (without the env var) — the e2e block reports as skipped and every unit spec passes.

- [ ] **Step 7: Write README.md**

`README.md`:
````markdown
# MATHEO — Emissor de NFS-e para MEI (backend)

API NestJS (Bun) que emite NFS-e pela API do Sistema Nacional NFS-e. Design: `docs/superpowers/specs/2026-09-11-nfse-emitter-backend-design.md`.

## Rodar local

```bash
cp .env.example .env
# gere a chave: bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))" → CERT_ENCRYPTION_KEY
docker compose up -d postgres logto
bun install
bun run prisma:migrate
bun run dev            # http://localhost:3000/health
```

Logto admin: http://localhost:3002 — crie um **API Resource** com o indicador igual a `LOGTO_API_RESOURCE` e um app (SPA/Native) que peça esse resource; o access token emitido é o `Bearer` da API.

## Testes

```bash
bun test                                  # unitários (test/, espelho de src/)
bun run test:e2e                          # e2e com Postgres do compose e gateway fake
```

## Ambientes NFS-e

`NFSE_ENV=fake` (padrão) usa `FakeNfseGateway`. Com `producao-restrita`/`producao` a API exige `NFSE_SEFIN_URL`, `NFSE_ADN_URL` e um certificado A1 válido cadastrado em `PUT /companies/me/certificate`.

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| POST | /companies | cria a empresa do usuário |
| GET | /companies/me | dados da empresa |
| PATCH | /companies/me | atualiza dados |
| PUT | /companies/me/certificate | multipart `file` (.pfx) + `password` |
| POST | /invoices | emite NFS-e |
| GET | /invoices?status=&page=&limit= | lista |
| GET | /invoices/:id | detalhe |
| GET | /invoices/:id/xml | XML da NFS-e |
| GET | /invoices/:id/pdf | DANFSe |
| POST | /invoices/:id/cancel | `{ motivo }` |
````

- [ ] **Step 8: Final check and commit**

Run: `bunx tsc --noEmit && bun test`
Expected: no type errors; all unit specs pass; e2e skipped.

```bash
git add src/common src/main.ts test/common test/app.e2e.spec.ts README.md
git commit -m "feat: global error format, e2e happy path and README"
```

---

## Done criteria

- `bun test` green; `E2E_DATABASE_URL=... bun test test/app.e2e.spec.ts` green against the compose Postgres.
- `bun run dev` boots with `NFSE_ENV=fake`; `/health` is public, everything else returns 401 without a Logto token.
- Switching to `NFSE_ENV=producao-restrita` only requires the two URLs and a real A1 certificate — no code change.
