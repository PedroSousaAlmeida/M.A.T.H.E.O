# Trial + Customers (v0.2.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every company gets a 30-day trial that blocks only invoice emission when expired (402), and companies can save customers (tomadores) and emit invoices by `customerId`.

**Architecture:** Adds `plan`/`trialEndsAt` to `Company` and a new `customers` module (`src/modules/customers/`) following the existing controller/service/module/dto pattern. `InvoicesService.emit` gains a trial gate and a tomador-resolution step (`customerId` **or** `tomador*`, optionally `saveCustomer`). Notes keep a copy of the tomador data; `Invoice.customerId` is a nullable reference (`onDelete: SetNull`).

**Tech Stack:** unchanged — Bun, NestJS 11, Prisma 7 + PostgreSQL, `bun test`, class-validator.

**Spec:** `docs/superpowers/specs/2026-09-12-trial-and-customers-design.md` (this plan) — base MVP spec: `docs/superpowers/specs/2026-09-11-nfse-emitter-backend-design.md`.

## Global Constraints

- Bun for everything (`bun test`, `bunx --bun prisma`). Specs only under `test/`, mirroring `src/`, importing via `@/`. Code in English; fiscal terms in Portuguese (`documento`, `nome`, `tomador`).
- Every query is scoped by the company resolved from the JWT `sub` (`companies.findMine(userId).id`). Never trust a company id from the request.
- Error body stays `{ statusCode, message, details? }`. New code: **402** `{ message: 'Trial expired', details: { trialEndsAt } }`.
- Trial: `TRIAL_DAYS = 30`; starts at `POST /companies`; blocks **only** `POST /invoices`; `plan` enum `TRIAL | ACTIVE`.
- Emission input: exactly one of `customerId` or (`tomadorDocumento` + `tomadorNome`); `saveCustomer` only with `tomador*`. Invoice stores a **copy** of the tomador data plus `customerId` when known.
- Customers unique per company by `documento` (`@@unique([companyId, documento])`); delete sets `Invoice.customerId = null`.
- Version bump to **0.2.0** in `package.json` and in the Postman collection `info.version` (`bun run version:check` must pass).
- Commit after every task with a conventional message ending with the two trailer lines:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01WMUmdMpKQNcyM9CD4NDPyX`.
- Local infra: Postgres runs via `podman compose` (already up). Prisma CLI needs `DATABASE_URL` exported: `set -a; source .env; set +a`.

## File structure

```
prisma/schema.prisma                         (modify: Plan enum, Company.plan/trialEndsAt/customers, Customer, Invoice.customerId/customer)
prisma/migrations/<ts>_trial_and_customers/  (create, SQL hand-edited for the backfill)
src/modules/companies/companies.service.ts   (modify: TRIAL_DAYS, create defaults, assertCanEmit, response fields)
src/modules/customers/
  customers.module.ts, customers.controller.ts, customers.service.ts
  dto/create-customer.dto.ts, dto/update-customer.dto.ts, dto/list-customers.dto.ts
src/modules/invoices/dto/create-invoice.dto.ts (modify)
src/modules/invoices/invoices.service.ts      (modify: trial gate, tomador resolution, customerId)
src/modules/invoices/invoices.module.ts       (modify: import CustomersModule)
src/app.module.ts                             (modify: import CustomersModule)
test/helpers/prisma-mock.ts                   (modify: customer delegate)
test/modules/companies/companies.service.spec.ts (modify)
test/modules/customers/customers.service.spec.ts (create)
test/modules/invoices/invoices.service.spec.ts   (modify)
test/app.e2e.spec.ts                          (modify)
docs/collections/matheo-nfse-api.postman_collection.json, docs/frontend/api-brief.md, README.md, package.json (modify)
```

---

### Task 1: Schema, migration, Prisma mock

**Files:**
- Modify: `prisma/schema.prisma`, `test/helpers/prisma-mock.ts`
- Create: `prisma/migrations/<timestamp>_trial_and_customers/migration.sql` (generated with `--create-only`, then edited)

**Interfaces:**
- Produces: generated types `Plan` (`'TRIAL' | 'ACTIVE'`), `Customer`, `Company.plan`, `Company.trialEndsAt: Date`, `Invoice.customerId: string | null`. Prisma compound unique accessor `customer.findUnique({ where: { companyId_documento: { companyId, documento } } })`.
- `createPrismaMock()` gains `customer: { findUnique, findFirst, findMany, create, update, delete, count }`.

- [ ] **Step 1: Edit prisma/schema.prisma**

Add the enum after `InvoiceStatus`:
```prisma
enum Plan {
  TRIAL
  ACTIVE
}
```
In `model Company` add (before `createdAt`):
```prisma
  plan               Plan      @default(TRIAL)
  trialEndsAt        DateTime
```
and after `invoices           Invoice[]`:
```prisma
  customers          Customer[]
```
Add the model after `Company`:
```prisma
model Customer {
  id        String   @id @default(uuid())
  companyId String
  company   Company  @relation(fields: [companyId], references: [id])
  documento String
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
```
In `model Invoice` add after `company           Company       @relation(...)`:
```prisma
  customerId       String?
  customer         Customer?     @relation(fields: [customerId], references: [id], onDelete: SetNull)
```

- [ ] **Step 2: Create the migration without applying it, then edit the SQL**

Run:
```bash
set -a; source .env; set +a
bunx --bun prisma migrate dev --create-only --name trial_and_customers
ls prisma/migrations
```
Open the generated `migration.sql`. Replace the single `ALTER TABLE "companies" ADD COLUMN "trialEndsAt" TIMESTAMP(3) NOT NULL` (Prisma may emit it together with `plan`) so that existing rows are backfilled:
```sql
ALTER TABLE "companies" ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'TRIAL';
ALTER TABLE "companies" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
UPDATE "companies" SET "trialEndsAt" = "createdAt" + INTERVAL '30 days' WHERE "trialEndsAt" IS NULL;
ALTER TABLE "companies" ALTER COLUMN "trialEndsAt" SET NOT NULL;
```
Keep every other statement Prisma generated (enum creation, `customers` table, indexes, `invoices.customerId`, foreign keys) exactly as generated.

- [ ] **Step 3: Apply and regenerate**

Run: `bunx --bun prisma migrate dev && bunx --bun prisma generate && bunx tsc --noEmit`
Expected: migration applied, client regenerated, and `tsc` FAILS only in `src/modules/companies/companies.service.ts` (`trialEndsAt` missing on create) — that is fixed in Task 2. If `tsc` reports anything else, stop and report.

- [ ] **Step 4: Extend the Prisma mock**

`test/helpers/prisma-mock.ts` — add the `customer` delegate:
```ts
    customer: { findUnique: mock(), findFirst: mock(), findMany: mock(), create: mock(), update: mock(), delete: mock(), count: mock() },
```

- [ ] **Step 5: Run the suite (still green — nothing uses the new fields yet)**

Run: `bun test`
Expected: all pass (unit specs don't touch the DB).

- [ ] **Step 6: Commit**

```bash
git add prisma test/helpers/prisma-mock.ts
git commit -m "feat(db): plan/trialEndsAt on companies, customers table, invoice.customerId"
```

---

### Task 2: Trial in CompaniesService

**Files:**
- Modify: `src/modules/companies/companies.service.ts`
- Test: `test/modules/companies/companies.service.spec.ts`

**Interfaces:**
- Produces: `export const TRIAL_DAYS = 30`; `CompanyResponse` gains `plan: Plan` and `trialEndsAt: Date`; `assertCanEmit(company: Pick<Company, 'plan' | 'trialEndsAt'>): void` throws `HttpException({ message: 'Trial expired', details: { trialEndsAt } }, 402)`.

- [ ] **Step 1: Write the failing tests**

In `test/modules/companies/companies.service.spec.ts`: add `plan: 'TRIAL', trialEndsAt: new Date(Date.now() + 86400000),` to `baseCompany` (after `certificateExpiry`), add `HttpException` to the `@nestjs/common` import, and append inside the top-level `describe`:
```ts
  describe('trial', () => {
    it('create starts a 30-day TRIAL', async () => {
      prisma.company.findUnique.mockResolvedValue(null);
      prisma.company.create.mockImplementation(async ({ data }: any) => ({ ...baseCompany, ...data }));
      const before = Date.now();
      const result = await service.create(userId, createDto);
      const data = prisma.company.create.mock.calls[0][0].data;
      expect(data.plan).toBe('TRIAL');
      const expected = before + 30 * 24 * 3600 * 1000;
      expect(Math.abs(data.trialEndsAt.getTime() - expected)).toBeLessThan(5000);
      expect(result.plan).toBe('TRIAL');
      expect(result.trialEndsAt).toBeInstanceOf(Date);
    });

    it('assertCanEmit passes for an active trial and for ACTIVE plans', () => {
      expect(() => service.assertCanEmit({ plan: 'TRIAL', trialEndsAt: new Date(Date.now() + 1000) })).not.toThrow();
      expect(() => service.assertCanEmit({ plan: 'ACTIVE', trialEndsAt: new Date(0) })).not.toThrow();
    });

    it('assertCanEmit throws 402 for an expired trial', () => {
      const trialEndsAt = new Date(Date.now() - 1000);
      try {
        service.assertCanEmit({ plan: 'TRIAL', trialEndsAt });
        throw new Error('did not throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(402);
        expect((error as HttpException).getResponse()).toEqual({ message: 'Trial expired', details: { trialEndsAt } });
      }
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/modules/companies/companies.service.spec.ts`
Expected: the 3 new tests fail (`assertCanEmit is not a function`; `data.plan` undefined).

- [ ] **Step 3: Implement**

`src/modules/companies/companies.service.ts`:
- Import `HttpException` from `@nestjs/common` and `type Plan` from `'../../../generated/prisma/client'`.
- Add `export const TRIAL_DAYS = 30;` after the imports.
- `CompanyResponse`: add `plan: Plan;` and `trialEndsAt: Date;` after `certificateExpiry`.
- In `create`, replace `data: { ...dto, userId }` with:
```ts
        data: { ...dto, userId, plan: 'TRIAL', trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 3600 * 1000) },
```
- Add the method (after `getCompanyWithCertificate`):
```ts
  /** Emission is the only feature gated by the trial. */
  assertCanEmit(company: Pick<Company, 'plan' | 'trialEndsAt'>): void {
    if (company.plan === 'TRIAL' && company.trialEndsAt.getTime() < Date.now()) {
      throw new HttpException({ message: 'Trial expired', details: { trialEndsAt: company.trialEndsAt } }, 402);
    }
  }
```
- In `toResponse` add `plan: company.plan,` and `trialEndsAt: company.trialEndsAt,` after `certificateExpiry`.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test test/modules/companies/companies.service.spec.ts && bunx tsc --noEmit`
Expected: all pass (14 tests), `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/companies test/modules/companies
git commit -m "feat(companies): 30-day trial with emission gate"
```

---

### Task 3: Customers module

**Files:**
- Create: `src/modules/customers/dto/create-customer.dto.ts`, `dto/update-customer.dto.ts`, `dto/list-customers.dto.ts`, `customers.service.ts`, `customers.controller.ts`, `customers.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/modules/customers/customers.service.spec.ts`

**Interfaces:**
- Produces `CustomersService`: `create(userId, dto)`, `findAll(userId, query) → { data, page, limit, total }`, `findOne(userId, id)`, `update(userId, id, dto)`, `remove(userId, id)`, `findEntity(userId, id): Promise<Customer>` (404), `findOrCreateByDocumento(companyId, data: { documento; nome; email?: string | null }): Promise<Customer>`. `CustomerResponse = { id, documento, nome, email, telefone, createdAt, updatedAt }`.
- HTTP: `POST /customers` (201), `GET /customers?search=&page=&limit=`, `GET /customers/:id`, `PATCH /customers/:id`, `DELETE /customers/:id` (204).

- [ ] **Step 1: Write the failing test**

`test/modules/customers/customers.service.spec.ts`:
```ts
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CompaniesService } from '@/modules/companies/companies.service';
import { CustomersService } from '@/modules/customers/customers.service';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';

const userId = 'user-1';
const row = {
  id: 'cu1', companyId: 'c1', documento: '12345678909', nome: 'Cliente Um', email: null, telefone: null,
  createdAt: new Date(), updatedAt: new Date(),
};
const createDto = { documento: '12345678909', nome: 'Cliente Um' };

describe('CustomersService', () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: CompaniesService, useValue: { findMine: mock(async () => ({ id: 'c1' })) } },
      ],
    }).compile();
    service = moduleRef.get(CustomersService);
  });

  it('creates a customer scoped to the company', async () => {
    prisma.customer.create.mockResolvedValue(row);
    const result = await service.create(userId, createDto);
    expect(prisma.customer.create).toHaveBeenCalledWith({ data: { ...createDto, companyId: 'c1' } });
    expect(result).toEqual({ id: 'cu1', documento: '12345678909', nome: 'Cliente Um', email: null, telefone: null, createdAt: row.createdAt, updatedAt: row.updatedAt });
    expect(result).not.toHaveProperty('companyId');
  });

  it('throws 409 when the documento already exists for the company', async () => {
    prisma.customer.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create(userId, createDto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists with search on nome (insensitive) or documento prefix, paginated and ordered by nome', async () => {
    prisma.customer.findMany.mockResolvedValue([row]);
    prisma.customer.count.mockResolvedValue(1);
    const result = await service.findAll(userId, { search: 'cli', page: 2, limit: 10 });
    expect(prisma.customer.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', OR: [{ nome: { contains: 'cli', mode: 'insensitive' } }, { documento: { startsWith: 'cli' } }] },
      orderBy: { nome: 'asc' },
      skip: 10,
      take: 10,
    });
    expect(result).toEqual({ data: [expect.objectContaining({ id: 'cu1' })], page: 2, limit: 10, total: 1 });
  });

  it('lists without a search filter', async () => {
    prisma.customer.findMany.mockResolvedValue([]);
    prisma.customer.count.mockResolvedValue(0);
    await service.findAll(userId, { page: 1, limit: 20 });
    expect(prisma.customer.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1' });
  });

  it('findOne is scoped and 404s for another company', async () => {
    prisma.customer.findFirst.mockResolvedValueOnce(row);
    await expect(service.findOne(userId, 'cu1')).resolves.toMatchObject({ id: 'cu1' });
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({ where: { id: 'cu1', companyId: 'c1' } });
    prisma.customer.findFirst.mockResolvedValueOnce(null);
    await expect(service.findOne(userId, 'other')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates and maps documento collisions to 409', async () => {
    prisma.customer.findFirst.mockResolvedValue(row);
    prisma.customer.update.mockResolvedValueOnce({ ...row, nome: 'Novo' });
    await expect(service.update(userId, 'cu1', { nome: 'Novo' })).resolves.toMatchObject({ nome: 'Novo' });
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'cu1' }, data: { nome: 'Novo' } });
    prisma.customer.update.mockRejectedValueOnce({ code: 'P2002' });
    await expect(service.update(userId, 'cu1', { documento: '98765432000100' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('removes a customer of the company', async () => {
    prisma.customer.findFirst.mockResolvedValue(row);
    prisma.customer.delete.mockResolvedValue(row);
    await expect(service.remove(userId, 'cu1')).resolves.toBeUndefined();
    expect(prisma.customer.delete).toHaveBeenCalledWith({ where: { id: 'cu1' } });
  });

  it('findOrCreateByDocumento reuses an existing customer or creates one', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(row);
    await expect(service.findOrCreateByDocumento('c1', { documento: '12345678909', nome: 'Outro Nome' })).resolves.toBe(row);
    expect(prisma.customer.create).not.toHaveBeenCalled();
    prisma.customer.findUnique.mockResolvedValueOnce(null);
    prisma.customer.create.mockResolvedValueOnce({ ...row, id: 'cu2', documento: '11111111111' });
    await expect(service.findOrCreateByDocumento('c1', { documento: '11111111111', nome: 'Novo', email: 'n@x.com' })).resolves.toMatchObject({ id: 'cu2' });
    expect(prisma.customer.create).toHaveBeenCalledWith({ data: { companyId: 'c1', documento: '11111111111', nome: 'Novo', email: 'n@x.com' } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/modules/customers/customers.service.spec.ts`
Expected: FAIL — cannot resolve `@/modules/customers/customers.service`.

- [ ] **Step 3: DTOs**

`src/modules/customers/dto/create-customer.dto.ts`:
```ts
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateCustomerDto {
  @Matches(/^(\d{11}|\d{14})$/, { message: 'documento must be a CPF (11 digits) or CNPJ (14 digits)' })
  documento: string;

  @IsString()
  @Length(2, 150)
  nome: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
```
`src/modules/customers/dto/update-customer.dto.ts`:
```ts
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

export class UpdateCustomerDto {
  @IsOptional()
  @Matches(/^(\d{11}|\d{14})$/, { message: 'documento must be a CPF (11 digits) or CNPJ (14 digits)' })
  documento?: string;

  @IsOptional()
  @IsString()
  @Length(2, 150)
  nome?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
```
`src/modules/customers/dto/list-customers.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class ListCustomersDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  search?: string;

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

- [ ] **Step 4: Service**

`src/modules/customers/customers.service.ts`:
```ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Customer } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CompaniesService } from '../companies/companies.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

export interface CustomerResponse {
  id: string;
  documento: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
  ) {}

  async create(userId: string, dto: CreateCustomerDto): Promise<CustomerResponse> {
    const { id: companyId } = await this.companies.findMine(userId);
    try {
      return this.toResponse(await this.prisma.customer.create({ data: { ...dto, companyId } }));
    } catch (error) {
      throw this.mapUniqueViolation(error);
    }
  }

  async findAll(userId: string, query: ListCustomersDto) {
    const { id: companyId } = await this.companies.findMine(userId);
    const where = {
      companyId,
      ...(query.search
        ? { OR: [{ nome: { contains: query.search, mode: 'insensitive' as const } }, { documento: { startsWith: query.search } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { nome: 'asc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      this.prisma.customer.count({ where }),
    ]);
    return { data: rows.map((row) => this.toResponse(row)), page: query.page, limit: query.limit, total };
  }

  async findOne(userId: string, id: string): Promise<CustomerResponse> {
    return this.toResponse(await this.findEntity(userId, id));
  }

  async update(userId: string, id: string, dto: UpdateCustomerDto): Promise<CustomerResponse> {
    const customer = await this.findEntity(userId, id);
    try {
      return this.toResponse(await this.prisma.customer.update({ where: { id: customer.id }, data: dto }));
    } catch (error) {
      throw this.mapUniqueViolation(error);
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const customer = await this.findEntity(userId, id);
    await this.prisma.customer.delete({ where: { id: customer.id } });
  }

  async findEntity(userId: string, id: string): Promise<Customer> {
    const { id: companyId } = await this.companies.findMine(userId);
    const customer = await this.prisma.customer.findFirst({ where: { id, companyId } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /** Used by invoice emission with `saveCustomer: true`. */
  async findOrCreateByDocumento(
    companyId: string,
    data: { documento: string; nome: string; email?: string | null },
  ): Promise<Customer> {
    const existing = await this.prisma.customer.findUnique({
      where: { companyId_documento: { companyId, documento: data.documento } },
    });
    if (existing) return existing;
    return this.prisma.customer.create({ data: { companyId, documento: data.documento, nome: data.nome, email: data.email } });
  }

  private mapUniqueViolation(error: unknown): unknown {
    if ((error as { code?: string }).code === 'P2002') {
      return new ConflictException('A customer with this documento already exists');
    }
    return error;
  }

  private toResponse(customer: Customer): CustomerResponse {
    return {
      id: customer.id,
      documento: customer.documento,
      nome: customer.nome,
      email: customer.email,
      telefone: customer.telefone,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }
}
```
Note for the `findOrCreateByDocumento` test: the expected `create` call has `email: 'n@x.com'`; when `email` is `undefined` Prisma ignores it — the first assertion (`toBe(row)`) never reaches `create`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/modules/customers/customers.service.spec.ts`
Expected: 8 pass.

- [ ] **Step 6: Controller, module, AppModule**

`src/modules/customers/customers.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(user.id, dto);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListCustomersDto) {
    return this.customers.findAll(user.id, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOne(user.id, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.remove(user.id, id);
  }
}
```
`src/modules/customers/customers.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [CompaniesModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
```
`src/app.module.ts`: import `CustomersModule` from `'./modules/customers/customers.module'` and add it to `imports` after `CompaniesModule`.

- [ ] **Step 7: Typecheck, full suite, boot check**

Run: `bunx tsc --noEmit && bun test && (bun run src/main.ts &) ; sleep 4 ; curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/v0/customers ; pkill -f "bun run src/main.ts"`
Expected: clean, all pass, `401`.

- [ ] **Step 8: Commit**

```bash
git add src/modules/customers src/app.module.ts test/modules/customers
git commit -m "feat(customers): saved tomadores CRUD per company"
```

---

### Task 4: Emission by customerId, saveCustomer and trial gate

**Files:**
- Modify: `src/modules/invoices/dto/create-invoice.dto.ts`, `src/modules/invoices/invoices.service.ts`, `src/modules/invoices/invoices.module.ts`
- Test: `test/modules/invoices/invoices.service.spec.ts`

**Interfaces:**
- Consumes: `CompaniesService.assertCanEmit`, `CustomersService.findEntity/findOrCreateByDocumento`.
- Produces: `CreateInvoiceDto` with optional `customerId`, `saveCustomer`, and now-optional `tomador*` (required when `customerId` absent); `InvoiceResponse` includes `customerId` (it already does — `Invoice` now has the column; nothing to omit).

- [ ] **Step 1: Write the failing tests**

In `test/modules/invoices/invoices.service.spec.ts`:
- Add `import { CustomersService } from '@/modules/customers/customers.service';` and `BadRequestException, HttpException` to the `@nestjs/common` import.
- Add `customerId: null,` to `pendingRow` (after `companyId`).
- Extend the `companies` mock type and value with `assertCanEmit: mock()`; add a `customers` mock and provider:
```ts
  let customers: { findEntity: ReturnType<typeof mock>; findOrCreateByDocumento: ReturnType<typeof mock> };
  // in beforeEach:
    companies = {
      getCompanyWithCertificate: mock(async () => ({ company, certificate })),
      findMine: mock(async () => ({ id: 'c1' })),
      assertCanEmit: mock(),
    };
    customers = { findEntity: mock(), findOrCreateByDocumento: mock() };
  // providers: add
        { provide: CustomersService, useValue: customers },
```
- Append inside `describe('emit')`:
```ts
    it('blocks emission with 402 when the trial expired and creates nothing', async () => {
      companies.assertCanEmit.mockImplementation(() => { throw new HttpException({ message: 'Trial expired' }, 402); });
      await expect(service.emit(userId, dto)).rejects.toBeInstanceOf(HttpException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(gateway.emit).not.toHaveBeenCalled();
    });

    it('emits by customerId, copying the customer data and storing customerId', async () => {
      customers.findEntity.mockResolvedValue({ id: 'cu1', companyId: 'c1', documento: '98765432000100', nome: 'Empresa Cliente', email: 'e@x.com' });
      prisma.invoice.create.mockImplementation(async ({ data }: any) => ({ ...pendingRow, ...data }));
      gateway.emit.mockResolvedValue(emitResult);
      prisma.invoice.update.mockImplementation(async ({ data }: any) => ({ ...pendingRow, ...data }));

      await service.emit(userId, { customerId: 'cu1', descricao: 'Serviço', valor: 10, codigoTributacao: '01.01.01' });

      expect(customers.findEntity).toHaveBeenCalledWith(userId, 'cu1');
      expect(prisma.invoice.create.mock.calls[0][0].data).toMatchObject({
        customerId: 'cu1', tomadorDocumento: '98765432000100', tomadorNome: 'Empresa Cliente', tomadorEmail: 'e@x.com',
      });
      expect(gateway.emit.mock.calls[0][0].tomador).toEqual({ documento: '98765432000100', nome: 'Empresa Cliente', email: 'e@x.com' });
    });

    it('propagates 404 when the customer belongs to another company', async () => {
      customers.findEntity.mockRejectedValue(new NotFoundException());
      await expect(service.emit(userId, { customerId: 'x', descricao: 'S', valor: 1, codigoTributacao: '01.01.01' })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it('saveCustomer creates (or reuses) the customer and stores its id', async () => {
      customers.findOrCreateByDocumento.mockResolvedValue({ id: 'cu9', documento: '12345678909', nome: 'Cliente', email: null });
      gateway.emit.mockResolvedValue(emitResult);
      prisma.invoice.update.mockResolvedValue({ ...pendingRow, status: 'ISSUED', customerId: 'cu9' });

      await service.emit(userId, { ...dto, saveCustomer: true });

      expect(customers.findOrCreateByDocumento).toHaveBeenCalledWith('c1', { documento: '12345678909', nome: 'Cliente', email: null });
      expect(prisma.invoice.create.mock.calls[0][0].data.customerId).toBe('cu9');
    });

    it('rejects a body with neither customerId nor tomador*, or with both', async () => {
      await expect(service.emit(userId, { descricao: 'S', valor: 1, codigoTributacao: '01.01.01' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.emit(userId, { ...dto, customerId: 'cu1' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.emit(userId, { customerId: 'cu1', saveCustomer: true, descricao: 'S', valor: 1, codigoTributacao: '01.01.01' })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/modules/invoices/invoices.service.spec.ts`
Expected: the 5 new tests fail (DI: `CustomersService` unknown → actually Nest ignores extra providers, so failures will be on behavior: no 402, `customers.findEntity` not called, etc.).

- [ ] **Step 3: DTO**

`src/modules/invoices/dto/create-invoice.dto.ts` — replace the file:
```ts
import { IsBoolean, IsEmail, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, Max, ValidateIf } from 'class-validator';

export class CreateInvoiceDto {
  /** Saved customer. Mutually exclusive with tomador* — exactly one of the two must be given. */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ValidateIf((o) => !o.customerId)
  @Matches(/^(\d{11}|\d{14})$/, { message: 'tomadorDocumento must be a CPF (11 digits) or CNPJ (14 digits)' })
  tomadorDocumento?: string;

  @ValidateIf((o) => !o.customerId)
  @IsString()
  @Length(2, 150)
  tomadorNome?: string;

  @IsOptional()
  @IsEmail()
  tomadorEmail?: string;

  /** With tomador*: also store the tomador as a customer of the company. */
  @IsOptional()
  @IsBoolean()
  saveCustomer?: boolean;

  @IsString()
  @Length(1, 2000)
  descricao: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9_999_999_999.99)
  valor: number;

  @Matches(/^\d{2}\.\d{2}\.\d{2}$/, { message: 'codigoTributacao must look like 01.01.01' })
  codigoTributacao: string;
}
```

- [ ] **Step 4: Service**

`src/modules/invoices/invoices.service.ts`:
- Imports: add `BadRequestException` to the `@nestjs/common` list; add `import { CustomersService } from '../customers/customers.service';`.
- Constructor: add `private readonly customers: CustomersService,` after `companies`.
- Replace the beginning of `emit` (from `const { company, certificate }` through the `tx.invoice.create({ data: { ... } })` block) so it reads:
```ts
  async emit(userId: string, dto: CreateInvoiceDto): Promise<InvoiceResponse> {
    const { company, certificate } = await this.companies.getCompanyWithCertificate(userId);
    this.companies.assertCanEmit(company);
    const tomador = await this.resolveTomador(userId, company.id, dto);
    const valor = dto.valor.toFixed(2);

    let invoice: Invoice;
    try {
      invoice = await this.prisma.$transaction(async (tx) => {
        const { _max } = await tx.invoice.aggregate({
          where: { companyId: company.id, dpsSerie: DEFAULT_SERIE },
          _max: { dpsNumero: true },
        });
        return tx.invoice.create({
          data: {
            companyId: company.id,
            customerId: tomador.customerId,
            status: 'PENDING',
            dpsSerie: DEFAULT_SERIE,
            dpsNumero: (_max.dpsNumero ?? 0) + 1,
            tomadorDocumento: tomador.documento,
            tomadorNome: tomador.nome,
            tomadorEmail: tomador.email,
            descricao: dto.descricao,
            valor,
            codigoTributacao: dto.codigoTributacao,
          },
        });
      });
```
  (the rest of `emit` — P2002 catch, `dps`, gateway call, persistence — stays as is).
- Add the private method (next to `findEntity`):
```ts
  /**
   * Exactly one of `customerId` or `tomador*` identifies the tomador. The invoice always stores a copy
   * of the data; `customerId` is kept only as a reference.
   */
  private async resolveTomador(
    userId: string,
    companyId: string,
    dto: CreateInvoiceDto,
  ): Promise<{ customerId: string | null; documento: string; nome: string; email: string | null }> {
    const hasInline = Boolean(dto.tomadorDocumento || dto.tomadorNome);
    if (dto.customerId && hasInline) throw new BadRequestException('Provide either customerId or tomador* fields, not both');
    if (dto.customerId && dto.saveCustomer) throw new BadRequestException('saveCustomer only applies to tomador* fields');

    if (dto.customerId) {
      const customer = await this.customers.findEntity(userId, dto.customerId);
      return { customerId: customer.id, documento: customer.documento, nome: customer.nome, email: customer.email };
    }
    if (!dto.tomadorDocumento || !dto.tomadorNome) {
      throw new BadRequestException('Provide customerId or tomadorDocumento + tomadorNome');
    }
    const inline = { documento: dto.tomadorDocumento, nome: dto.tomadorNome, email: dto.tomadorEmail ?? null };
    if (dto.saveCustomer) {
      const customer = await this.customers.findOrCreateByDocumento(companyId, inline);
      return { customerId: customer.id, ...inline };
    }
    return { customerId: null, ...inline };
  }
```
- `src/modules/invoices/invoices.module.ts`: add `CustomersModule` (import from `'../customers/customers.module'`) to `imports`.

- [ ] **Step 5: Run tests + typecheck + boot**

Run: `bun test test/modules/invoices/invoices.service.spec.ts && bunx tsc --noEmit && bun test`
Expected: all pass (20 invoice tests), `tsc` clean, full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/modules/invoices test/modules/invoices
git commit -m "feat(invoices): emit by customerId, saveCustomer, trial gate"
```

---

### Task 5: e2e, Postman, docs, version 0.2.0

**Files:**
- Modify: `test/app.e2e.spec.ts`, `docs/collections/matheo-nfse-api.postman_collection.json`, `docs/frontend/api-brief.md`, `README.md`, `package.json`

- [ ] **Step 1: Extend the e2e**

In `test/app.e2e.spec.ts`, inside the happy-path test, right after the `uploaded` assertions and before `const emitted = ...`, insert:
```ts
    const customer = await request(server).post('/api/v0/customers').set(auth).send({ documento: '98765432000100', nome: 'Empresa Cliente', email: 'fin@cliente.com' });
    expect(customer.status).toBe(201);
    expect(customer.body).not.toHaveProperty('companyId');
    const customerId = customer.body.id;

    const searched = await request(server).get('/api/v0/customers?search=empresa').set(auth);
    expect(searched.status).toBe(200);
    expect(searched.body.total).toBe(1);

    const byCustomer = await request(server).post('/api/v0/invoices').set(auth).send({ customerId, descricao: 'Serviço para cliente salvo', valor: 50, codigoTributacao: '01.01.01' });
    expect(byCustomer.status).toBe(201);
    expect(byCustomer.body).toMatchObject({ status: 'ISSUED', customerId, tomadorDocumento: '98765432000100', tomadorNome: 'Empresa Cliente', dpsNumero: 1 });
```
Then change the existing `expect(emitted.body.dpsNumero).toBe(1);` to `toBe(2)` and `expect(list.body.total).toBe(1);` to `toBe(2)`. Also assert the company response carries the trial: after `expect(created.body.hasCertificate).toBe(false);` add `expect(created.body.plan).toBe('TRIAL'); expect(new Date(created.body.trialEndsAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);`.
In `afterAll`, before deleting invoices add `await prisma.customer.deleteMany({ where: { company: { cnpj } } });` — order: invoices first (they reference customers with SetNull, but deleting customers first is also fine); keep invoices → customers → company.

Run:
```bash
set -a; source .env; set +a
E2E_DATABASE_URL="$DATABASE_URL" bun test test/app.e2e.spec.ts
```
Expected: 3 pass.

- [ ] **Step 2: Postman collection**

Edit `docs/collections/matheo-nfse-api.postman_collection.json` with a small Bun script or by hand:
- `info.version` → `"0.2.0"`.
- Add a top-level folder **"Customers"** (after "Companies") with 5 requests: `POST /customers` (body `{ "documento": "98765432000100", "nome": "Empresa Cliente", "email": "fin@cliente.com" }`, test script saving `pm.collectionVariables.set('customerId', pm.response.json().id)` on 201), `GET /customers?search=` (query `search` disabled by default, `page`, `limit`), `GET /customers/{{customerId}}`, `PATCH /customers/{{customerId}}` (body `{ "nome": "Empresa Cliente Ltda" }`), `DELETE /customers/{{customerId}}`.
- Add collection variable `{ "key": "customerId", "value": "" }`.
- In "Invoices", add a request **"POST /invoices — emitir por customerId"** with body `{ "customerId": "{{customerId}}", "descricao": "Consultoria", "valor": 150.00, "codigoTributacao": "01.01.01" }` and the same test script that saves `invoiceId`. In the existing emit request body add `"saveCustomer": true`.
Run: `bun run version:check` → expected FAIL (package.json still 0.1.0) — fixed in Step 4.

- [ ] **Step 3: Docs**

`docs/frontend/api-brief.md`:
- Header line: v0.1.0 → v0.2.0.
- `Company` JSON: add `"plan": "TRIAL", "trialEndsAt": "2026-10-12T00:00:00.000Z",` after `certificateExpiry`.
- Error table: add row `| 402 | trial de 30 dias vencido (só ao emitir; `details.trialEndsAt`) | tela de planos |`.
- `POST /invoices`: document `customerId` (uuid, exclusivo com `tomador*`), `saveCustomer` (boolean, só com `tomador*`), and that `tomadorDocumento`/`tomadorNome` are required only without `customerId`. `Invoice` JSON: add `"customerId": null,`.
- New subsection **4.3 Tomadores (customers)** (renumber "Estados de uma nota" to 4.4) with the 5 endpoints, `Customer` JSON `{ id, documento, nome, email, telefone, createdAt, updatedAt }`, search semantics, and UI hint: autocomplete no formulário de nota + "salvar este cliente" checkbox.
- Section 8: move trial and tomadores from "planned" to done; keep the rest.

`README.md`: in the endpoint table add the 5 customer routes; add a subsection **"Planos e trial"**: every company starts with `plan=TRIAL` and `trialEndsAt = +30 dias`; expired trial → `402` on `POST /invoices`; to activate manually: `UPDATE companies SET plan = 'ACTIVE' WHERE cnpj = '...';`.

- [ ] **Step 4: Version bump and final checks**

`package.json`: `"version": "0.2.0"`.
Run: `bun run version:check && bunx tsc --noEmit && bun test && E2E_DATABASE_URL="$DATABASE_URL" bun test test/app.e2e.spec.ts`
Expected: version OK (0.2.0, 1 collection), clean, all green.

- [ ] **Step 5: Commit**

```bash
git add test/app.e2e.spec.ts docs README.md package.json
git commit -m "feat: v0.2.0 — customers in Postman/docs, trial docs, e2e coverage"
```

---

## Done criteria

- `bun test` and the e2e green; `bun run version:check` OK at 0.2.0.
- `POST /invoices` works with `customerId`, with `tomador*`, and with `saveCustomer: true`; both/neither → 400.
- Expired trial → 402 only on emission; `GET /companies/me` shows `plan`/`trialEndsAt`.
- `/customers` CRUD scoped per company; deleting a customer leaves its invoices intact with `customerId = null`.
