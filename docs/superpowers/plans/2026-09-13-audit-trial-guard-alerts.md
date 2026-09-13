# Audit, Trial Guard, Document Validation, Alerts (v0.3.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every request is traceable (`requestId` + JSON logs), every relevant user action is written to an append-only `audit_logs` table the company can read back, the trial is enforced by a global guard with `@AllowExpiredTrial()` opt-outs, CPF/CNPJ are validated by check digit, and `GET /alerts` surfaces certificate/trial/pending warnings.

**Architecture:** Cross-cutting pieces live in `src/common/` (`RequestContext` on `AsyncLocalStorage`, `RequestIdMiddleware`, `PinoLoggerService`, `LoggingInterceptor`, document validators). New modules `audit` (global) and `alerts`; `companies` gains `TrialGuard` + decorator and loses `assertCanEmit`. Services call `AuditService.record` explicitly. Guard order: Throttler → JWT → Trial.

**Tech Stack:** unchanged + `pino` (+ `pino-pretty` dev). Bun, NestJS 11 (Express 5 — `forRoutes('*')` is accepted for middleware), Prisma 7, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-13-audit-trial-guard-alerts-design.md`

## Global Constraints

- Bun for everything. Specs only under `test/` mirroring `src/`, importing via `@/`. Code in English; fiscal/domain terms in Portuguese where they already are (`documento`, `tomador`, `chaveAcesso`, `motivo`).
- Error body becomes `{ statusCode, message, details?, requestId }`. Response header `x-request-id` on every response.
- Audit is append-only; `metadata` never contains password, pfx, XML, token or certificate material beyond `certificateExpiry`/`subjectCn`. An audit write failure never fails the main action (log `error`, continue).
- Trial policy (expired `TRIAL`): allowed = every `GET`, `PATCH /companies/me`, `PUT /companies/me/certificate`, `POST /invoices/:id/cancel`; blocked = `POST /invoices`, `POST/PATCH/DELETE /customers`. `POST /companies` is reachable because a user without a company always passes the guard.
- CPF/CNPJ check-digit validation only in DTOs (`cnpj`, `documento`, `tomadorDocumento`); repeated-digit sequences invalid. Valid fixtures: CNPJ `11222333000181` (company), `11444777000161` (customer); CPF `12345678909`, `52998224725`. Service unit tests do not go through DTOs and keep their existing fixtures.
- Version `0.3.0` in `package.json` and the Postman `info.version`; `bun run version:check` passes.
- Commit after every task, conventional message, ending with the two trailer lines:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01WMUmdMpKQNcyM9CD4NDPyX`.
- Local infra: Postgres via `podman compose` (running). Prisma CLI needs `set -a; source .env; set +a`.

## File structure

```
src/common/request-context.ts, request-id.middleware.ts, logging.interceptor.ts, common.module.ts
src/common/logger/pino-logger.service.ts
src/common/validators/document.ts
src/common/http-exception.filter.ts                 (modify: requestId in body)
src/config/env.ts                                    (modify: LOG_LEVEL, LOG_PRETTY)
src/main.ts, src/app.module.ts                       (modify)
src/modules/auth/jwt-auth.guard.ts                   (modify: RequestContext.set userId)
src/modules/audit/audit.module.ts, audit.service.ts, audit.controller.ts, dto/list-audit-logs.dto.ts
src/modules/companies/trial.guard.ts, allow-expired-trial.decorator.ts
src/modules/companies/companies.service.ts, companies.controller.ts, companies.module.ts (modify)
src/modules/customers/customers.service.ts, customers.controller.ts (modify)
src/modules/invoices/invoices.service.ts, invoices.controller.ts (modify)
src/modules/companies/dto/create-company.dto.ts, customers/dto/*.dto.ts, invoices/dto/create-invoice.dto.ts (modify)
src/modules/alerts/alerts.module.ts, alerts.service.ts, alerts.controller.ts
prisma/schema.prisma + migration
test/... mirrors; test/helpers/prisma-mock.ts (auditLog delegate); test/app.e2e.spec.ts
docs/collections/*.json, docs/frontend/api-brief.md, README.md, .env.example, package.json
```

---

### Task 1: Request context, request id, pino logger, access log, requestId in errors

**Files:**
- Create: `src/common/request-context.ts`, `src/common/request-id.middleware.ts`, `src/common/logger/pino-logger.service.ts`, `src/common/logging.interceptor.ts`, `src/common/common.module.ts`
- Modify: `src/config/env.ts`, `src/common/http-exception.filter.ts`, `src/main.ts`, `src/app.module.ts`, `src/modules/auth/jwt-auth.guard.ts`, `.env.example`
- Test: `test/common/request-context.spec.ts`, `test/common/request-id.middleware.spec.ts`, `test/common/logger/pino-logger.service.spec.ts`, `test/common/http-exception.filter.spec.ts` (modify)

**Interfaces:**
- `RequestContext`: `run(store: { requestId: string; userId?: string }, fn)`, `get(): Store | undefined`, `set(patch: Partial<Store>)`.
- `RequestIdMiddleware` (`NestMiddleware`): sets `req.id`, response header `x-request-id`, wraps `next()` in `RequestContext.run`.
- `PinoLoggerService implements LoggerService`; constructed from `{ level, pretty }`; merges `{ requestId, userId }` from the context into every line. Exposes `child(bindings)`? No — YAGNI.
- `LoggingInterceptor` (global): one `info` line per request (`debug` for `/health`).
- `Env` gains `LOG_LEVEL` (`fatal|error|warn|info|debug|trace`, default `info`) and `LOG_PRETTY` (`z.coerce.boolean().optional()` → default `NODE_ENV === 'development'`).

- [ ] **Step 1: Install pino**

Run: `bun add pino && bun add -d pino-pretty`

- [ ] **Step 2: Failing tests**

`test/common/request-context.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { RequestContext } from '@/common/request-context';

describe('RequestContext', () => {
  it('is undefined outside a run', () => {
    expect(RequestContext.get()).toBeUndefined();
  });

  it('exposes the store inside run and supports set()', () => {
    RequestContext.run({ requestId: 'r1' }, () => {
      expect(RequestContext.get()).toEqual({ requestId: 'r1' });
      RequestContext.set({ userId: 'u1' });
      expect(RequestContext.get()).toEqual({ requestId: 'r1', userId: 'u1' });
    });
  });

  it('isolates concurrent async contexts', async () => {
    const seen: string[] = [];
    await Promise.all([
      RequestContext.run({ requestId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(RequestContext.get()!.requestId);
      }),
      RequestContext.run({ requestId: 'b' }, async () => {
        seen.push(RequestContext.get()!.requestId);
      }),
    ]);
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});
```

`test/common/request-id.middleware.spec.ts`:
```ts
import { describe, expect, it, mock } from 'bun:test';
import { RequestContext } from '@/common/request-context';
import { RequestIdMiddleware } from '@/common/request-id.middleware';

function run(headers: Record<string, string>) {
  const req: any = { headers };
  const setHeader = mock();
  const res: any = { setHeader };
  let inside: string | undefined;
  new RequestIdMiddleware().use(req, res, () => {
    inside = RequestContext.get()?.requestId;
  });
  return { req, setHeader, inside };
}

describe('RequestIdMiddleware', () => {
  it('reuses a valid incoming x-request-id', () => {
    const { req, setHeader, inside } = run({ 'x-request-id': 'abc-123.XYZ_9' });
    expect(req.id).toBe('abc-123.XYZ_9');
    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'abc-123.XYZ_9');
    expect(inside).toBe('abc-123.XYZ_9');
  });

  it('generates a uuid when the header is missing or invalid', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(run({}).req.id).toMatch(uuid);
    expect(run({ 'x-request-id': 'has space' }).req.id).toMatch(uuid);
    expect(run({ 'x-request-id': 'x'.repeat(129) }).req.id).toMatch(uuid);
  });
});
```

`test/common/logger/pino-logger.service.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import { PinoLoggerService } from '@/common/logger/pino-logger.service';
import { RequestContext } from '@/common/request-context';

function capture() {
  const lines: any[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, logger: new PinoLoggerService({ level: 'debug', pretty: false }, stream) };
}

describe('PinoLoggerService', () => {
  it('writes JSON with level, msg and context', () => {
    const { lines, logger } = capture();
    logger.log('hello', 'MyContext');
    expect(lines[0]).toMatchObject({ level: 30, msg: 'hello', context: 'MyContext' });
  });

  it('merges requestId and userId from the request context', () => {
    const { lines, logger } = capture();
    RequestContext.run({ requestId: 'r1', userId: 'u1' }, () => logger.warn('inside'));
    expect(lines[0]).toMatchObject({ level: 40, msg: 'inside', requestId: 'r1', userId: 'u1' });
  });

  it('logs error with stack as a field', () => {
    const { lines, logger } = capture();
    logger.error('boom', 'Error: boom\n    at x', 'Ctx');
    expect(lines[0]).toMatchObject({ level: 50, msg: 'boom', context: 'Ctx' });
    expect(lines[0].stack).toContain('at x');
  });

  it('respects the level', () => {
    const lines: any[] = [];
    const stream = new Writable({ write(c, _e, cb) { lines.push(JSON.parse(c.toString())); cb(); } });
    const logger = new PinoLoggerService({ level: 'warn', pretty: false }, stream);
    logger.log('ignored');
    logger.warn('kept');
    expect(lines).toHaveLength(1);
  });
});
```

Modify `test/common/http-exception.filter.spec.ts`: every expected body gains `requestId`. Change `hostWithResponse()` so `getRequest` returns `{ url: '/x', method: 'GET', id: 'req-1' }`, and update the four `toHaveBeenCalledWith` bodies to include `requestId: 'req-1'` (e.g. `{ statusCode: 404, message: 'Company not found', requestId: 'req-1' }`).

- [ ] **Step 3: Run to verify they fail**

Run: `bun test test/common`
Expected: new specs fail to resolve modules; filter spec fails on the missing `requestId`.

- [ ] **Step 4: Implement**

`src/common/request-context.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStore {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** Per-request store (request id, authenticated user) available anywhere in the request's async chain. */
export const RequestContext = {
  run<T>(store: RequestStore, fn: () => T): T {
    return storage.run({ ...store }, fn);
  },
  get(): RequestStore | undefined {
    return storage.getStore();
  },
  set(patch: Partial<RequestStore>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, patch);
  },
};
```

`src/common/request-id.middleware.ts`:
```ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { RequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction) {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = candidate && VALID_ID.test(candidate) ? candidate : randomUUID();
    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    RequestContext.run({ requestId }, () => next());
  }
}
```

`src/common/logger/pino-logger.service.ts`:
```ts
import { Injectable, LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { RequestContext } from '../request-context';

export interface PinoLoggerOptions {
  level: string;
  pretty: boolean;
}

/** Nest LoggerService over pino. Every line carries requestId/userId from RequestContext when inside a request. */
@Injectable()
export class PinoLoggerService implements LoggerService {
  private readonly logger: Logger;

  constructor(options: PinoLoggerOptions, stream?: DestinationStream) {
    const destination = stream ?? (options.pretty ? require('pino-pretty')({ colorize: true, translateTime: 'SYS:HH:MM:ss' }) : undefined);
    this.logger = destination ? pino({ level: options.level }, destination) : pino({ level: options.level });
  }

  log(message: unknown, ...optional: unknown[]) {
    this.logger.info(this.fields(optional), String(message));
  }
  error(message: unknown, ...optional: unknown[]) {
    // Nest passes (message, stack?, context?)
    const [stack, context] = optional.length === 2 ? optional : [undefined, optional[0]];
    this.logger.error({ ...this.fields([context]), ...(typeof stack === 'string' ? { stack } : {}) }, String(message));
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.logger.warn(this.fields(optional), String(message));
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.logger.debug(this.fields(optional), String(message));
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.logger.trace(this.fields(optional), String(message));
  }

  private fields(optional: unknown[]): Record<string, unknown> {
    const ctx = RequestContext.get();
    const context = typeof optional[optional.length - 1] === 'string' ? optional[optional.length - 1] : undefined;
    return { ...(ctx ? { requestId: ctx.requestId, userId: ctx.userId } : {}), ...(context ? { context } : {}) };
  }
}
```

`src/common/logging.interceptor.ts`:
```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PinoLoggerService } from './logger/pino-logger.service';

/** One access-log line per request. /health is logged at debug to keep probes out of the main stream. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const started = Date.now();
    const write = (statusCode: number) => {
      const line = `${request.method} ${request.originalUrl ?? request.url} ${statusCode} ${Date.now() - started}ms`;
      if (String(request.originalUrl ?? request.url).endsWith('/health')) this.logger.debug(line, 'HTTP');
      else this.logger.log(line, 'HTTP');
    };
    return next.handle().pipe(
      tap({
        next: () => write(http.getResponse().statusCode),
        error: (error: unknown) => write(typeof (error as { getStatus?: () => number }).getStatus === 'function' ? (error as { getStatus: () => number }).getStatus() : 500),
      }),
    );
  }
}
```

`src/common/common.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { Env } from '../config/env';
import { PinoLoggerService } from './logger/pino-logger.service';
import { LoggingInterceptor } from './logging.interceptor';

@Global()
@Module({
  providers: [
    {
      provide: PinoLoggerService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new PinoLoggerService({
          level: config.get('LOG_LEVEL', { infer: true }),
          pretty: config.get('LOG_PRETTY', { infer: true }) ?? config.get('NODE_ENV', { infer: true }) === 'development',
        }),
    },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
  exports: [PinoLoggerService],
})
export class CommonModule {}
```

`src/config/env.ts` — add inside the object (after `GIT_COMMIT`):
```ts
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_PRETTY: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
```

`src/common/http-exception.filter.ts` — add `requestId?: string` to `ErrorBody`; in `catch`, read the request once and set `body.requestId = request.id` when present:
```ts
  catch(exception: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest();
    const response = host.switchToHttp().getResponse();
    const body = this.toBody(exception);
    if (request?.id) body.requestId = request.id;
    if (body.statusCode >= 500) {
      this.logger.error(`${request.method} ${request.url} → ${body.statusCode}`, exception instanceof Error ? exception.stack : String(exception));
    }
    response.status(body.statusCode).json(body);
  }
```

`src/modules/auth/jwt-auth.guard.ts` — right after `request.user = { id: payload.sub };` add `RequestContext.set({ userId: payload.sub });` (import from `'../../common/request-context'`).

`src/app.module.ts` — import `CommonModule` (add to `imports` before `PrismaModule`), implement `NestModule`:
```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
// ...
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
```

`src/main.ts` — create with buffered logs and switch to pino:
```ts
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLoggerService));
  app.setGlobalPrefix('api/v0');
```
(import `PinoLoggerService` from `'./common/logger/pino-logger.service'`; replace the final `console.log` with `app.get(PinoLoggerService).log(\`API listening on http://localhost:${port}\`, 'Bootstrap')`).

`.env.example` — append:
```
# Logging
# LOG_LEVEL=info     # fatal | error | warn | info | debug | trace
# LOG_PRETTY=true    # human-readable output; default true only when NODE_ENV=development (JSON otherwise)
```

- [ ] **Step 5: Verify**

Run: `bun test test/common && bunx tsc --noEmit && bun test`
Expected: all green. Boot: `(bun run src/main.ts &) ; sleep 4 ; curl -s -i localhost:3000/api/v0/companies/me | grep -i "x-request-id\|requestId" ; pkill -f "bun run src/main.ts"` → header present and `"requestId"` in the 401 body.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src test .env.example
git commit -m "feat(common): request id, request context, pino JSON logger and access log"
```

---

### Task 2: CPF/CNPJ check-digit validation

**Files:**
- Create: `src/common/validators/document.ts`
- Modify: `src/modules/companies/dto/create-company.dto.ts`, `src/modules/customers/dto/create-customer.dto.ts`, `src/modules/customers/dto/update-customer.dto.ts`, `src/modules/invoices/dto/create-invoice.dto.ts`, `test/app.e2e.spec.ts`, `docs/collections/matheo-nfse-api.postman_collection.json`, `docs/frontend/api-brief.md`, `README.md`, `scripts/dev-certificate.ts`
- Test: `test/common/validators/document.spec.ts`

**Interfaces:** `isValidCpf(value: string): boolean`, `isValidCnpj(value: string): boolean`, decorators `@IsCpfOrCnpj(options?)`, `@IsCnpj(options?)`.

- [ ] **Step 1: Failing test**

`test/common/validators/document.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IsCnpj, IsCpfOrCnpj, isValidCnpj, isValidCpf } from '@/common/validators/document';

describe('isValidCpf / isValidCnpj', () => {
  it('accepts valid documents', () => {
    expect(isValidCpf('12345678909')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11444777000161')).toBe(true);
  });

  it('rejects wrong check digits, repeated sequences, wrong length and non-digits', () => {
    expect(isValidCpf('12345678900')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('1234567890')).toBe(false);
    expect(isValidCpf('123.456.789-09')).toBe(false);
    expect(isValidCnpj('12345678000199')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
    expect(isValidCnpj('1122233300018')).toBe(false);
  });
});

class Doc {
  @IsCpfOrCnpj()
  documento!: string;
}
class Cnpj {
  @IsCnpj()
  cnpj!: string;
}

describe('decorators', () => {
  it('IsCpfOrCnpj accepts a CPF or a CNPJ and rejects the rest with a clear message', () => {
    expect(validateSync(plainToInstance(Doc, { documento: '12345678909' }))).toHaveLength(0);
    expect(validateSync(plainToInstance(Doc, { documento: '11222333000181' }))).toHaveLength(0);
    const errors = validateSync(plainToInstance(Doc, { documento: '12345678000199' }));
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints!)[0]).toBe('documento must be a valid CPF or CNPJ');
  });

  it('IsCnpj rejects a valid CPF', () => {
    expect(validateSync(plainToInstance(Cnpj, { cnpj: '11222333000181' }))).toHaveLength(0);
    const errors = validateSync(plainToInstance(Cnpj, { cnpj: '12345678909' }));
    expect(Object.values(errors[0].constraints!)[0]).toBe('cnpj must be a valid CNPJ');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/common/validators` → cannot resolve module.

- [ ] **Step 3: Implement**

`src/common/validators/document.ts`:
```ts
import { registerDecorator, type ValidationOptions } from 'class-validator';

function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  const mod = sum % 11;
  return mod < 2 ? 0 : 11 - mod;
}

function allSame(value: string): boolean {
  return /^(\d)\1+$/.test(value);
}

/** CPF: 11 digits, mod-11 check digits, repeated sequences rejected. */
export function isValidCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || allSame(value)) return false;
  const d = value.split('').map(Number);
  const v1 = checkDigit(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const v2 = checkDigit(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d[9] === v1 && d[10] === v2;
}

/** CNPJ (numeric): 14 digits, mod-11 check digits, repeated sequences rejected. Alphanumeric CNPJ is not supported yet. */
export function isValidCnpj(value: string): boolean {
  if (!/^\d{14}$/.test(value) || allSame(value)) return false;
  const d = value.split('').map(Number);
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const v1 = checkDigit(d.slice(0, 12), w1);
  const v2 = checkDigit(d.slice(0, 13), [6, ...w1]);
  return d[12] === v1 && d[13] === v2;
}

export function IsCpfOrCnpj(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isCpfOrCnpj',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && (isValidCpf(value) || isValidCnpj(value)),
        defaultMessage: () => `${propertyName} must be a valid CPF or CNPJ`,
      },
    });
}

export function IsCnpj(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isCnpj',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidCnpj(value),
        defaultMessage: () => `${propertyName} must be a valid CNPJ`,
      },
    });
}
```

DTOs — replace the `@Matches` on documents:
- `create-company.dto.ts`: `cnpj` → `@IsCnpj()` (import from `'../../../common/validators/document'`).
- `create-customer.dto.ts` and `update-customer.dto.ts`: `documento` → `@IsCpfOrCnpj()` (keep `@IsOptional()` in update).
- `create-invoice.dto.ts`: `tomadorDocumento` → keep `@ValidateIf((o) => !o.customerId)` and replace `@Matches(...)` with `@IsCpfOrCnpj()`.

- [ ] **Step 4: Update fixtures**

Replace `12345678000199` → `11222333000181` and `98765432000100` → `11444777000161` in: `test/app.e2e.spec.ts` (note: the e2e computes `cnpj` from `Date.now()` — replace that with a valid CNPJ that is unique per run: keep `const cnpj = '11222333000181'` and make `afterAll` delete by that cnpj; since a previous run may have left rows, `beforeAll` must first `deleteMany` invoices/customers/company for that cnpj), `docs/collections/matheo-nfse-api.postman_collection.json`, `docs/frontend/api-brief.md`, `README.md` (if present), `scripts/dev-certificate.ts` default CNPJ. Add an e2e assertion right before creating the company: `POST /api/v0/companies` with `cnpj: '12345678000199'` → `400` and `details` contains `'cnpj must be a valid CNPJ'`.

- [ ] **Step 5: Verify** — `bun test && bunx tsc --noEmit && set -a; source .env; set +a; E2E_DATABASE_URL="$DATABASE_URL" bun test test/app.e2e.spec.ts` → green.

- [ ] **Step 6: Commit** — `git commit -m "feat(validation): CPF/CNPJ check-digit validation on company, customer and invoice DTOs"`

---

### Task 3: Audit module (schema, service, controller)

**Files:**
- Modify: `prisma/schema.prisma` (+ migration), `test/helpers/prisma-mock.ts`, `src/app.module.ts`
- Create: `src/modules/audit/audit.module.ts`, `audit.service.ts`, `audit.controller.ts`, `dto/list-audit-logs.dto.ts`
- Test: `test/modules/audit/audit.service.spec.ts`

**Interfaces:**
- `AuditService.record(entry: AuditEntry): Promise<void>` — `AuditEntry = { action: string; companyId?: string | null; entityType?: string; entityId?: string; outcome?: 'SUCCESS' | 'FAILURE'; statusCode?: number; metadata?: Record<string, unknown>; userId?: string }` (`userId` falls back to `RequestContext.get()?.userId`; if neither, the entry is written with `userId: 'system'`). `ip`/`userAgent` come from `RequestContext` store fields added here: extend `RequestStore` with `ip?: string; userAgent?: string` and set them in `RequestIdMiddleware` (`req.ip`, `req.headers['user-agent']`).
- `AuditService.findAll(companyId, query)` → `{ data, page, limit, total }`. `AuditService` depends only on `PrismaService` + `PinoLoggerService` (so `CompaniesService` can inject it without a module cycle); the controller resolves `companyId` via `CompaniesService.findMine(user.id)`.
- `GET /audit-logs?page=&limit=&action=&from=&to=`.

- [ ] **Step 1: Schema + migration**

Append to `prisma/schema.prisma`:
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
  action     String
  entityType String?
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
Run: `set -a; source .env; set +a; bunx --bun prisma migrate dev --name audit_logs && bunx --bun prisma generate`.
`test/helpers/prisma-mock.ts`: add `auditLog: { create: mock(), findMany: mock(), count: mock() },`.

- [ ] **Step 2: Failing test**

`test/modules/audit/audit.service.spec.ts`:
```ts
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Test } from '@nestjs/testing';
import { PinoLoggerService } from '@/common/logger/pino-logger.service';
import { RequestContext } from '@/common/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';

const row = {
  id: 'a1', occurredAt: new Date(), requestId: 'r1', userId: 'u1', companyId: 'c1', action: 'invoice.emitted',
  entityType: 'invoice', entityId: 'i1', outcome: 'SUCCESS', statusCode: 201, metadata: { dpsNumero: 1 }, ip: '127.0.0.1', userAgent: 'ua',
};

describe('AuditService', () => {
  let service: AuditService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let logger: { error: ReturnType<typeof mock> };

  beforeEach(async () => {
    prisma = createPrismaMock();
    logger = { error: mock() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: PinoLoggerService, useValue: logger },
      ],
    }).compile();
    service = moduleRef.get(AuditService);
  });

  it('record fills user, request id, ip and user agent from the request context', async () => {
    prisma.auditLog.create.mockResolvedValue(row);
    await RequestContext.run({ requestId: 'r1', userId: 'u1', ip: '127.0.0.1', userAgent: 'ua' }, () =>
      service.record({ action: 'invoice.emitted', companyId: 'c1', entityType: 'invoice', entityId: 'i1', statusCode: 201, metadata: { dpsNumero: 1 } }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'invoice.emitted', companyId: 'c1', entityType: 'invoice', entityId: 'i1', outcome: 'SUCCESS', statusCode: 201,
        metadata: { dpsNumero: 1 }, userId: 'u1', requestId: 'r1', ip: '127.0.0.1', userAgent: 'ua',
      },
    });
  });

  it('record outside a request uses "system" and nulls', async () => {
    prisma.auditLog.create.mockResolvedValue(row);
    await service.record({ action: 'x', outcome: 'FAILURE' });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ userId: 'system', requestId: null, ip: null, userAgent: null, outcome: 'FAILURE' });
  });

  it('record never throws when the write fails; it logs an error', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    await expect(service.record({ action: 'x' })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('findAll scopes by company, filters by action and period, paginates, and hides ip/userAgent', async () => {
    prisma.auditLog.findMany.mockResolvedValue([row]);
    prisma.auditLog.count.mockResolvedValue(1);
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-30T00:00:00Z');
    const result = await service.findAll('c1', { action: 'invoice.emitted', from, to, page: 2, limit: 10 });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', action: 'invoice.emitted', occurredAt: { gte: from, lte: to } },
      orderBy: { occurredAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(result.total).toBe(1);
    expect(result.data[0]).toEqual({
      id: 'a1', occurredAt: row.occurredAt, action: 'invoice.emitted', entityType: 'invoice', entityId: 'i1',
      outcome: 'SUCCESS', statusCode: 201, metadata: { dpsNumero: 1 }, requestId: 'r1',
    });
    expect(result.data[0]).not.toHaveProperty('ip');
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `bun test test/modules/audit`.

- [ ] **Step 4: Implement**

Extend `src/common/request-context.ts` `RequestStore` with `ip?: string; userAgent?: string;` and in `RequestIdMiddleware` run with `{ requestId, ip: req.ip, userAgent: req.headers['user-agent'] }` (cast header to string if array).

`src/modules/audit/dto/list-audit-logs.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class ListAuditLogsDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  action?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

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

`src/modules/audit/audit.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { AuditLog, AuditOutcome, Prisma } from '../../../generated/prisma/client';
import { PinoLoggerService } from '../../common/logger/pino-logger.service';
import { RequestContext } from '../../common/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

export interface AuditEntry {
  action: string;
  companyId?: string | null;
  entityType?: string;
  entityId?: string;
  outcome?: AuditOutcome;
  statusCode?: number;
  metadata?: Record<string, unknown>;
  userId?: string;
}

export interface AuditLogResponse {
  id: string;
  occurredAt: Date;
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: AuditOutcome;
  statusCode: number | null;
  metadata: unknown;
  requestId: string | null;
}

export const SYSTEM_USER = 'system';

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLoggerService,
  ) {}

  /** Append-only. Never throws: a failed audit write is logged and the caller's action proceeds. */
  async record(entry: AuditEntry): Promise<void> {
    const ctx = RequestContext.get();
    const data: Prisma.AuditLogCreateInput = {
      action: entry.action,
      companyId: entry.companyId ?? null,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      outcome: entry.outcome ?? 'SUCCESS',
      statusCode: entry.statusCode ?? null,
      metadata: (entry.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
      userId: entry.userId ?? ctx?.userId ?? SYSTEM_USER,
      requestId: ctx?.requestId ?? null,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
    };
    try {
      await this.prisma.auditLog.create({ data });
    } catch (error) {
      this.logger.error(`Audit write failed for ${entry.action}`, error instanceof Error ? error.stack : String(error), AuditService.name);
    }
  }

  async findAll(companyId: string, query: ListAuditLogsDto) {
    const where: Prisma.AuditLogWhereInput = {
      companyId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to ? { occurredAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data: rows.map((row) => this.toResponse(row)), page: query.page, limit: query.limit, total };
  }

  private toResponse(row: AuditLog): AuditLogResponse {
    return {
      id: row.id,
      occurredAt: row.occurredAt,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      outcome: row.outcome,
      statusCode: row.statusCode,
      metadata: row.metadata,
      requestId: row.requestId,
    };
  }
}
```
If the test's `toHaveBeenCalledWith` fails only because `metadata: undefined` vs missing key in the "system" case, keep the implementation and adjust that one assertion to `toMatchObject` — the contract is the stored fields, not `undefined` keys.

`src/modules/audit/audit.controller.ts`:
```ts
import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { CompaniesService } from '../companies/companies.service';
import { AuditService } from './audit.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@Controller('audit-logs')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly companies: CompaniesService,
  ) {}

  @Get()
  async findAll(@CurrentUser() user: AuthUser, @Query() query: ListAuditLogsDto) {
    const { id: companyId } = await this.companies.findMine(user.id);
    return this.audit.findAll(companyId, query);
  }
}
```

`src/modules/audit/audit.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Global()
@Module({
  imports: [CompaniesModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```
Add `AuditModule` to `AppModule.imports` after `CompaniesModule`.

- [ ] **Step 5: Verify** — `bun test test/modules/audit && bunx tsc --noEmit && bun test`; boot check `GET /api/v0/audit-logs` → 401.

- [ ] **Step 6: Commit** — `git add prisma src test && git commit -m "feat(audit): append-only audit log table, service and company-scoped listing"`

---

### Task 4: Record audit events in companies, customers and invoices

**Files:**
- Modify: `src/modules/companies/companies.service.ts`, `src/modules/customers/customers.service.ts`, `src/modules/invoices/invoices.service.ts`
- Test: the three matching specs (add `AuditService` mock `{ record: mock() }` to each testing module; assert calls)

`AuditService` is provided by the global `AuditModule` and depends only on Prisma + logger (Task 3), so `CompaniesService`, `CustomersService` and `InvoicesService` can inject it directly.

- [ ] **Step 1: Confirm `bun test` is green before starting.**

- [ ] **Step 2: Failing tests**

`test/common/request-context.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { RequestContext } from '@/common/request-context';

describe('RequestContext', () => {
  it('is undefined outside a run', () => {
    expect(RequestContext.get()).toBeUndefined();
  });

  it('exposes the store inside run and supports set()', () => {
    RequestContext.run({ requestId: 'r1' }, () => {
      expect(RequestContext.get()).toEqual({ requestId: 'r1' });
      RequestContext.set({ userId: 'u1' });
      expect(RequestContext.get()).toEqual({ requestId: 'r1', userId: 'u1' });
    });
  });

  it('isolates concurrent async contexts', async () => {
    const seen: string[] = [];
    await Promise.all([
      RequestContext.run({ requestId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(RequestContext.get()!.requestId);
      }),
      RequestContext.run({ requestId: 'b' }, async () => {
        seen.push(RequestContext.get()!.requestId);
      }),
    ]);
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});
```

`test/common/request-id.middleware.spec.ts`:
```ts
import { describe, expect, it, mock } from 'bun:test';
import { RequestContext } from '@/common/request-context';
import { RequestIdMiddleware } from '@/common/request-id.middleware';

function run(headers: Record<string, string>) {
  const req: any = { headers };
  const setHeader = mock();
  const res: any = { setHeader };
  let inside: string | undefined;
  new RequestIdMiddleware().use(req, res, () => {
    inside = RequestContext.get()?.requestId;
  });
  return { req, setHeader, inside };
}

describe('RequestIdMiddleware', () => {
  it('reuses a valid incoming x-request-id', () => {
    const { req, setHeader, inside } = run({ 'x-request-id': 'abc-123.XYZ_9' });
    expect(req.id).toBe('abc-123.XYZ_9');
    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'abc-123.XYZ_9');
    expect(inside).toBe('abc-123.XYZ_9');
  });

  it('generates a uuid when the header is missing or invalid', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(run({}).req.id).toMatch(uuid);
    expect(run({ 'x-request-id': 'has space' }).req.id).toMatch(uuid);
    expect(run({ 'x-request-id': 'x'.repeat(129) }).req.id).toMatch(uuid);
  });
});
```

`test/common/logger/pino-logger.service.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import { PinoLoggerService } from '@/common/logger/pino-logger.service';
import { RequestContext } from '@/common/request-context';

function capture() {
  const lines: any[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, logger: new PinoLoggerService({ level: 'debug', pretty: false }, stream) };
}

describe('PinoLoggerService', () => {
  it('writes JSON with level, msg and context', () => {
    const { lines, logger } = capture();
    logger.log('hello', 'MyContext');
    expect(lines[0]).toMatchObject({ level: 30, msg: 'hello', context: 'MyContext' });
  });

  it('merges requestId and userId from the request context', () => {
    const { lines, logger } = capture();
    RequestContext.run({ requestId: 'r1', userId: 'u1' }, () => logger.warn('inside'));
    expect(lines[0]).toMatchObject({ level: 40, msg: 'inside', requestId: 'r1', userId: 'u1' });
  });

  it('logs error with stack as a field', () => {
    const { lines, logger } = capture();
    logger.error('boom', 'Error: boom\n    at x', 'Ctx');
    expect(lines[0]).toMatchObject({ level: 50, msg: 'boom', context: 'Ctx' });
    expect(lines[0].stack).toContain('at x');
  });

  it('respects the level', () => {
    const lines: any[] = [];
    const stream = new Writable({ write(c, _e, cb) { lines.push(JSON.parse(c.toString())); cb(); } });
    const logger = new PinoLoggerService({ level: 'warn', pretty: false }, stream);
    logger.log('ignored');
    logger.warn('kept');
    expect(lines).toHaveLength(1);
  });
});
```

Modify `test/common/http-exception.filter.spec.ts`: every expected body gains `requestId`. Change `hostWithResponse()` so `getRequest` returns `{ url: '/x', method: 'GET', id: 'req-1' }`, and update the four `toHaveBeenCalledWith` bodies to include `requestId: 'req-1'` (e.g. `{ statusCode: 404, message: 'Company not found', requestId: 'req-1' }`).

- [ ] **Step 3: Run to verify they fail**

Run: `bun test test/common`
Expected: new specs fail to resolve modules; filter spec fails on the missing `requestId`.

- [ ] **Step 4: Implement**

`src/common/request-context.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStore {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** Per-request store (request id, authenticated user) available anywhere in the request's async chain. */
export const RequestContext = {
  run<T>(store: RequestStore, fn: () => T): T {
    return storage.run({ ...store }, fn);
  },
  get(): RequestStore | undefined {
    return storage.getStore();
  },
  set(patch: Partial<RequestStore>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, patch);
  },
};
```

`src/common/request-id.middleware.ts`:
```ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { RequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction) {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = candidate && VALID_ID.test(candidate) ? candidate : randomUUID();
    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    RequestContext.run({ requestId }, () => next());
  }
}
```

`src/common/logger/pino-logger.service.ts`:
```ts
import { Injectable, LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { RequestContext } from '../request-context';

export interface PinoLoggerOptions {
  level: string;
  pretty: boolean;
}

/** Nest LoggerService over pino. Every line carries requestId/userId from RequestContext when inside a request. */
@Injectable()
export class PinoLoggerService implements LoggerService {
  private readonly logger: Logger;

  constructor(options: PinoLoggerOptions, stream?: DestinationStream) {
    const destination = stream ?? (options.pretty ? require('pino-pretty')({ colorize: true, translateTime: 'SYS:HH:MM:ss' }) : undefined);
    this.logger = destination ? pino({ level: options.level }, destination) : pino({ level: options.level });
  }

  log(message: unknown, ...optional: unknown[]) {
    this.logger.info(this.fields(optional), String(message));
  }
  error(message: unknown, ...optional: unknown[]) {
    // Nest passes (message, stack?, context?)
    const [stack, context] = optional.length === 2 ? optional : [undefined, optional[0]];
    this.logger.error({ ...this.fields([context]), ...(typeof stack === 'string' ? { stack } : {}) }, String(message));
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.logger.warn(this.fields(optional), String(message));
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.logger.debug(this.fields(optional), String(message));
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.logger.trace(this.fields(optional), String(message));
  }

  private fields(optional: unknown[]): Record<string, unknown> {
    const ctx = RequestContext.get();
    const context = typeof optional[optional.length - 1] === 'string' ? optional[optional.length - 1] : undefined;
    return { ...(ctx ? { requestId: ctx.requestId, userId: ctx.userId } : {}), ...(context ? { context } : {}) };
  }
}
```

`src/common/logging.interceptor.ts`:
```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PinoLoggerService } from './logger/pino-logger.service';

/** One access-log line per request. /health is logged at debug to keep probes out of the main stream. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const started = Date.now();
    const write = (statusCode: number) => {
      const line = `${request.method} ${request.originalUrl ?? request.url} ${statusCode} ${Date.now() - started}ms`;
      if (String(request.originalUrl ?? request.url).endsWith('/health')) this.logger.debug(line, 'HTTP');
      else this.logger.log(line, 'HTTP');
    };
    return next.handle().pipe(
      tap({
        next: () => write(http.getResponse().statusCode),
        error: (error: unknown) => write(typeof (error as { getStatus?: () => number }).getStatus === 'function' ? (error as { getStatus: () => number }).getStatus() : 500),
      }),
    );
  }
}
```

`src/common/common.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { Env } from '../config/env';
import { PinoLoggerService } from './logger/pino-logger.service';
import { LoggingInterceptor } from './logging.interceptor';

@Global()
@Module({
  providers: [
    {
      provide: PinoLoggerService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new PinoLoggerService({
          level: config.get('LOG_LEVEL', { infer: true }),
          pretty: config.get('LOG_PRETTY', { infer: true }) ?? config.get('NODE_ENV', { infer: true }) === 'development',
        }),
    },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
  exports: [PinoLoggerService],
})
export class CommonModule {}
```

`src/config/env.ts` — add inside the object (after `GIT_COMMIT`):
```ts
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_PRETTY: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
```

`src/common/http-exception.filter.ts` — add `requestId?: string` to `ErrorBody`; in `catch`, read the request once and set `body.requestId = request.id` when present:
```ts
  catch(exception: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest();
    const response = host.switchToHttp().getResponse();
    const body = this.toBody(exception);
    if (request?.id) body.requestId = request.id;
    if (body.statusCode >= 500) {
      this.logger.error(`${request.method} ${request.url} → ${body.statusCode}`, exception instanceof Error ? exception.stack : String(exception));
    }
    response.status(body.statusCode).json(body);
  }
```

`src/modules/auth/jwt-auth.guard.ts` — right after `request.user = { id: payload.sub };` add `RequestContext.set({ userId: payload.sub });` (import from `'../../common/request-context'`).

`src/app.module.ts` — import `CommonModule` (add to `imports` before `PrismaModule`), implement `NestModule`:
```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
// ...
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
```

`src/main.ts` — create with buffered logs and switch to pino:
```ts
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLoggerService));
  app.setGlobalPrefix('api/v0');
```
(import `PinoLoggerService` from `'./common/logger/pino-logger.service'`; replace the final `console.log` with `app.get(PinoLoggerService).log(\`API listening on http://localhost:${port}\`, 'Bootstrap')`).

`.env.example` — append:
```
# Logging
# LOG_LEVEL=info     # fatal | error | warn | info | debug | trace
# LOG_PRETTY=true    # human-readable output; default true only when NODE_ENV=development (JSON otherwise)
```

- [ ] **Step 5: Verify**

Run: `bun test test/common && bunx tsc --noEmit && bun test`
Expected: all green. Boot: `(bun run src/main.ts &) ; sleep 4 ; curl -s -i localhost:3000/api/v0/companies/me | grep -i "x-request-id\|requestId" ; pkill -f "bun run src/main.ts"` → header present and `"requestId"` in the 401 body.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src test .env.example
git commit -m "feat(common): request id, request context, pino JSON logger and access log"
```

---

### Task 2: CPF/CNPJ check-digit validation

**Files:**
- Create: `src/common/validators/document.ts`
- Modify: `src/modules/companies/dto/create-company.dto.ts`, `src/modules/customers/dto/create-customer.dto.ts`, `src/modules/customers/dto/update-customer.dto.ts`, `src/modules/invoices/dto/create-invoice.dto.ts`, `test/app.e2e.spec.ts`, `docs/collections/matheo-nfse-api.postman_collection.json`, `docs/frontend/api-brief.md`, `README.md`, `scripts/dev-certificate.ts`
- Test: `test/common/validators/document.spec.ts`

**Interfaces:** `isValidCpf(value: string): boolean`, `isValidCnpj(value: string): boolean`, decorators `@IsCpfOrCnpj(options?)`, `@IsCnpj(options?)`.

- [ ] **Step 1: Failing test**

`test/common/validators/document.spec.ts`:
```ts
import { describe, expect, it } from 'bun:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IsCnpj, IsCpfOrCnpj, isValidCnpj, isValidCpf } from '@/common/validators/document';

describe('isValidCpf / isValidCnpj', () => {
  it('accepts valid documents', () => {
    expect(isValidCpf('12345678909')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11444777000161')).toBe(true);
  });

  it('rejects wrong check digits, repeated sequences, wrong length and non-digits', () => {
    expect(isValidCpf('12345678900')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('1234567890')).toBe(false);
    expect(isValidCpf('123.456.789-09')).toBe(false);
    expect(isValidCnpj('12345678000199')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
    expect(isValidCnpj('1122233300018')).toBe(false);
  });
});

class Doc {
  @IsCpfOrCnpj()
  documento!: string;
}
class Cnpj {
  @IsCnpj()
  cnpj!: string;
}

describe('decorators', () => {
  it('IsCpfOrCnpj accepts a CPF or a CNPJ and rejects the rest with a clear message', () => {
    expect(validateSync(plainToInstance(Doc, { documento: '12345678909' }))).toHaveLength(0);
    expect(validateSync(plainToInstance(Doc, { documento: '11222333000181' }))).toHaveLength(0);
    const errors = validateSync(plainToInstance(Doc, { documento: '12345678000199' }));
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints!)[0]).toBe('documento must be a valid CPF or CNPJ');
  });

  it('IsCnpj rejects a valid CPF', () => {
    expect(validateSync(plainToInstance(Cnpj, { cnpj: '11222333000181' }))).toHaveLength(0);
    const errors = validateSync(plainToInstance(Cnpj, { cnpj: '12345678909' }));
    expect(Object.values(errors[0].constraints!)[0]).toBe('cnpj must be a valid CNPJ');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/common/validators` → cannot resolve module.

- [ ] **Step 3: Implement**

`src/common/validators/document.ts`:
```ts
import { registerDecorator, type ValidationOptions } from 'class-validator';

function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  const mod = sum % 11;
  return mod < 2 ? 0 : 11 - mod;
}

function allSame(value: string): boolean {
  return /^(\d)\1+$/.test(value);
}

/** CPF: 11 digits, mod-11 check digits, repeated sequences rejected. */
export function isValidCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || allSame(value)) return false;
  const d = value.split('').map(Number);
  const v1 = checkDigit(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const v2 = checkDigit(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d[9] === v1 && d[10] === v2;
}

/** CNPJ (numeric): 14 digits, mod-11 check digits, repeated sequences rejected. Alphanumeric CNPJ is not supported yet. */
export function isValidCnpj(value: string): boolean {
  if (!/^\d{14}$/.test(value) || allSame(value)) return false;
  const d = value.split('').map(Number);
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const v1 = checkDigit(d.slice(0, 12), w1);
  const v2 = checkDigit(d.slice(0, 13), [6, ...w1]);
  return d[12] === v1 && d[13] === v2;
}

export function IsCpfOrCnpj(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isCpfOrCnpj',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && (isValidCpf(value) || isValidCnpj(value)),
        defaultMessage: () => `${propertyName} must be a valid CPF or CNPJ`,
      },
    });
}

export function IsCnpj(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isCnpj',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidCnpj(value),
        defaultMessage: () => `${propertyName} must be a valid CNPJ`,
      },
    });
}
```

DTOs — replace the `@Matches` on documents:
- `create-company.dto.ts`: `cnpj` → `@IsCnpj()` (import from `'../../../common/validators/document'`).
- `create-customer.dto.ts` and `update-customer.dto.ts`: `documento` → `@IsCpfOrCnpj()` (keep `@IsOptional()` in update).
- `create-invoice.dto.ts`: `tomadorDocumento` → keep `@ValidateIf((o) => !o.customerId)` and replace `@Matches(...)` with `@IsCpfOrCnpj()`.

- [ ] **Step 4: Update fixtures**

Replace `12345678000199` → `11222333000181` and `98765432000100` → `11444777000161` in: `test/app.e2e.spec.ts` (note: the e2e computes `cnpj` from `Date.now()` — replace that with a valid CNPJ that is unique per run: keep `const cnpj = '11222333000181'` and make `afterAll` delete by that cnpj; since a previous run may have left rows, `beforeAll` must first `deleteMany` invoices/customers/company for that cnpj), `docs/collections/matheo-nfse-api.postman_collection.json`, `docs/frontend/api-brief.md`, `README.md` (if present), `scripts/dev-certificate.ts` default CNPJ. Add an e2e assertion right before creating the company: `POST /api/v0/companies` with `cnpj: '12345678000199'` → `400` and `details` contains `'cnpj must be a valid CNPJ'`.

- [ ] **Step 5: Verify** — `bun test && bunx tsc --noEmit && set -a; source .env; set +a; E2E_DATABASE_URL="$DATABASE_URL" bun test test/app.e2e.spec.ts` → green.

- [ ] **Step 6: Commit** — `git commit -m "feat(validation): CPF/CNPJ check-digit validation on company, customer and invoice DTOs"`

---

### Task 3: Audit module (schema, service, controller)

**Files:**
- Modify: `prisma/schema.prisma` (+ migration), `test/helpers/prisma-mock.ts`, `src/app.module.ts`
- Create: `src/modules/audit/audit.module.ts`, `audit.service.ts`, `audit.controller.ts`, `dto/list-audit-logs.dto.ts`
- Test: `test/modules/audit/audit.service.spec.ts`

**Interfaces:**
- `AuditService.record(entry: AuditEntry): Promise<void>` — `AuditEntry = { action: string; companyId?: string | null; entityType?: string; entityId?: string; outcome?: 'SUCCESS' | 'FAILURE'; statusCode?: number; metadata?: Record<string, unknown>; userId?: string }` (`userId` falls back to `RequestContext.get()?.userId`; if neither, the entry is written with `userId: 'system'`). `ip`/`userAgent` come from `RequestContext` store fields added here: extend `RequestStore` with `ip?: string; userAgent?: string` and set them in `RequestIdMiddleware` (`req.ip`, `req.headers['user-agent']`).
- `AuditService.findAll(companyId, query)` → `{ data, page, limit, total }`. `AuditService` depends only on `PrismaService` + `PinoLoggerService` (so `CompaniesService` can inject it without a module cycle); the controller resolves `companyId` via `CompaniesService.findMine(user.id)`.
- `GET /audit-logs?page=&limit=&action=&from=&to=`.

- [ ] **Step 1: Schema + migration**

Append to `prisma/schema.prisma`:
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
  action     String
  entityType String?
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
Run: `set -a; source .env; set +a; bunx --bun prisma migrate dev --name audit_logs && bunx --bun prisma generate`.
`test/helpers/prisma-mock.ts`: add `auditLog: { create: mock(), findMany: mock(), count: mock() },`.

- [ ] **Step 2: Failing test**

`test/modules/audit/audit.service.spec.ts`:
```ts
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Test } from '@nestjs/testing';
import { PinoLoggerService } from '@/common/logger/pino-logger.service';
import { RequestContext } from '@/common/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';

const row = {
  id: 'a1', occurredAt: new Date(), requestId: 'r1', userId: 'u1', companyId: 'c1', action: 'invoice.emitted',
  entityType: 'invoice', entityId: 'i1', outcome: 'SUCCESS', statusCode: 201, metadata: { dpsNumero: 1 }, ip: '127.0.0.1', userAgent: 'ua',
};

describe('AuditService', () => {
  let service: AuditService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let logger: { error: ReturnType<typeof mock> };

  beforeEach(async () => {
    prisma = createPrismaMock();
    logger = { error: mock() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: PinoLoggerService, useValue: logger },
      ],
    }).compile();
    service = moduleRef.get(AuditService);
  });

  it('record fills user, request id, ip and user agent from the request context', async () => {
    prisma.auditLog.create.mockResolvedValue(row);
    await RequestContext.run({ requestId: 'r1', userId: 'u1', ip: '127.0.0.1', userAgent: 'ua' }, () =>
      service.record({ action: 'invoice.emitted', companyId: 'c1', entityType: 'invoice', entityId: 'i1', statusCode: 201, metadata: { dpsNumero: 1 } }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'invoice.emitted', companyId: 'c1', entityType: 'invoice', entityId: 'i1', outcome: 'SUCCESS', statusCode: 201,
        metadata: { dpsNumero: 1 }, userId: 'u1', requestId: 'r1', ip: '127.0.0.1', userAgent: 'ua',
      },
    });
  });

  it('record outside a request uses "system" and nulls', async () => {
    prisma.auditLog.create.mockResolvedValue(row);
    await service.record({ action: 'x', outcome: 'FAILURE' });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ userId: 'system', requestId: null, ip: null, userAgent: null, outcome: 'FAILURE' });
  });

  it('record never throws when the write fails; it logs an error', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    await expect(service.record({ action: 'x' })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('findAll scopes by company, filters by action and period, paginates, and hides ip/userAgent', async () => {
    prisma.auditLog.findMany.mockResolvedValue([row]);
    prisma.auditLog.count.mockResolvedValue(1);
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-30T00:00:00Z');
    const result = await service.findAll('c1', { action: 'invoice.emitted', from, to, page: 2, limit: 10 });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', action: 'invoice.emitted', occurredAt: { gte: from, lte: to } },
      orderBy: { occurredAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(result.total).toBe(1);
    expect(result.data[0]).toEqual({
      id: 'a1', occurredAt: row.occurredAt, action: 'invoice.emitted', entityType: 'invoice', entityId: 'i1',
      outcome: 'SUCCESS', statusCode: 201, metadata: { dpsNumero: 1 }, requestId: 'r1',
    });
    expect(result.data[0]).not.toHaveProperty('ip');
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `bun test test/modules/audit`.

- [ ] **Step 4: Implement**

Extend `src/common/request-context.ts` `RequestStore` with `ip?: string; userAgent?: string;` and in `RequestIdMiddleware` run with `{ requestId, ip: req.ip, userAgent: req.headers['user-agent'] }` (cast header to string if array).

`src/modules/audit/dto/list-audit-logs.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class ListAuditLogsDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  action?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

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

`src/modules/audit/audit.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { AuditLog, AuditOutcome, Prisma } from '../../../generated/prisma/client';
import { PinoLoggerService } from '../../common/logger/pino-logger.service';
import { RequestContext } from '../../common/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

export interface AuditEntry {
  action: string;
  companyId?: string | null;
  entityType?: string;
  entityId?: string;
  outcome?: AuditOutcome;
  statusCode?: number;
  metadata?: Record<string, unknown>;
  userId?: string;
}

export interface AuditLogResponse {
  id: string;
  occurredAt: Date;
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: AuditOutcome;
  statusCode: number | null;
  metadata: unknown;
  requestId: string | null;
}

export const SYSTEM_USER = 'system';

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLoggerService,
  ) {}

  /** Append-only. Never throws: a failed audit write is logged and the caller's action proceeds. */
  async record(entry: AuditEntry): Promise<void> {
    const ctx = RequestContext.get();
    const data: Prisma.AuditLogCreateInput = {
      action: entry.action,
      companyId: entry.companyId ?? null,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      outcome: entry.outcome ?? 'SUCCESS',
      statusCode: entry.statusCode ?? null,
      metadata: (entry.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
      userId: entry.userId ?? ctx?.userId ?? SYSTEM_USER,
      requestId: ctx?.requestId ?? null,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
    };
    try {
      await this.prisma.auditLog.create({ data });
    } catch (error) {
      this.logger.error(`Audit write failed for ${entry.action}`, error instanceof Error ? error.stack : String(error), AuditService.name);
    }
  }

  async findAll(companyId: string, query: ListAuditLogsDto) {
    const where: Prisma.AuditLogWhereInput = {
      companyId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to ? { occurredAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data: rows.map((row) => this.toResponse(row)), page: query.page, limit: query.limit, total };
  }

  private toResponse(row: AuditLog): AuditLogResponse {
    return {
      id: row.id,
      occurredAt: row.occurredAt,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      outcome: row.outcome,
      statusCode: row.statusCode,
      metadata: row.metadata,
      requestId: row.requestId,
    };
  }
}
```
If the test's `toHaveBeenCalledWith` fails only because `metadata: undefined` vs missing key in the "system" case, keep the implementation and adjust that one assertion to `toMatchObject` — the contract is the stored fields, not `undefined` keys.

`src/modules/audit/audit.controller.ts`:
```ts
import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { CompaniesService } from '../companies/companies.service';
import { AuditService } from './audit.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@Controller('audit-logs')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly companies: CompaniesService,
  ) {}

  @Get()
  async findAll(@CurrentUser() user: AuthUser, @Query() query: ListAuditLogsDto) {
    const { id: companyId } = await this.companies.findMine(user.id);
    return this.audit.findAll(companyId, query);
  }
}
```

`src/modules/audit/audit.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Global()
@Module({
  imports: [CompaniesModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```
Add `AuditModule` to `AppModule.imports` after `CompaniesModule`.

- [ ] **Step 5: Verify** — `bun test test/modules/audit && bunx tsc --noEmit && bun test`; boot check `GET /api/v0/audit-logs` → 401.

- [ ] **Step 6: Commit** — `git add prisma src test && git commit -m "feat(audit): append-only audit log table, service and company-scoped listing"`

---

### Task 4: Record audit events in companies, customers and invoices

**Files:**
- Modify: `src/modules/companies/companies.service.ts`, `src/modules/customers/customers.service.ts`, `src/modules/invoices/invoices.service.ts`
- Test: the three matching specs (add `AuditService` mock `{ record: mock() }` to each testing module; assert calls)

Because `AuditModule` imports `CompaniesModule`, `CompaniesService` cannot inject `AuditService` through the module graph without a cycle. Resolution: `AuditModule` must NOT import `CompaniesModule`; instead `AuditService.findAll` resolves the company through `PrismaService` directly is forbidden by the boundary rule… so: move the company lookup out of `AuditService` — `AuditController` injects `CompaniesService` (from `CompaniesModule`, imported by `AuditModule`) and passes `companyId` to `AuditService.findAll(companyId, query)`. `AuditService` then depends only on `PrismaService` + logger, and `CompaniesService` can inject `AuditService` (global) without a cycle. **Apply this refactor first** (update Task 3's service/controller/spec accordingly: `findAll(companyId, query)`, controller does `const { id } = await this.companies.findMine(user.id)`).

- [ ] **Step 1: Refactor per the note above; run `bun test test/modules/audit`** (adjust the spec's `findAll` call to `service.findAll('c1', {...})` and drop the `CompaniesService` provider from the audit spec).

- [ ] **Step 2: Failing tests** — add to each spec a `audit = { record: mock() }` provider (`{ provide: AuditService, useValue: audit }`) and these cases:

`companies.service.spec.ts`:
```ts
  describe('audit', () => {
    it('records company.created', async () => {
      prisma.company.findUnique.mockResolvedValue(null);
      prisma.company.create.mockResolvedValue(baseCompany);
      await service.create(userId, createDto);
      expect(audit.record).toHaveBeenCalledWith({ action: 'company.created', companyId: 'c1', entityType: 'company', entityId: 'c1', statusCode: 201, metadata: { cnpj: '12345678000199' } });
    });
    it('records company.updated with the changed fields', async () => {
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      prisma.company.update.mockResolvedValue({ ...baseCompany, razaoSocial: 'Nova' });
      await service.update(userId, { razaoSocial: 'Nova' });
      expect(audit.record).toHaveBeenCalledWith({ action: 'company.updated', companyId: 'c1', entityType: 'company', entityId: 'c1', statusCode: 200, metadata: { fields: ['razaoSocial'] } });
    });
    it('records certificate.uploaded with expiry and CN only', async () => {
      const { pfx, password } = createTestPfx();
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      prisma.company.update.mockImplementation(async ({ data }: any) => ({ ...baseCompany, ...data }));
      await service.setCertificate(userId, pfx, password);
      const call = audit.record.mock.calls[0][0];
      expect(call).toMatchObject({ action: 'certificate.uploaded', companyId: 'c1', statusCode: 200 });
      expect(Object.keys(call.metadata)).toEqual(['certificateExpiry', 'subjectCn']);
    });
  });
```
`customers.service.spec.ts` — `customer.created` (`metadata: { documento }`, `entityId: 'cu1'`, `statusCode: 201`), `customer.updated` (`metadata: { documento: '12345678909', fields: ['nome'] }`), `customer.deleted` (`metadata: { documento }`, `statusCode: 204`).
`invoices.service.spec.ts` — `invoice.emitted` (`entityId: 'i1'`, `statusCode: 201`, `metadata: { dpsNumero: 4, chaveAcesso, numeroNfse: '4', valor: '150.00', tomadorDocumento: '12345678909', customerId: null }`), `invoice.rejected` (`outcome: 'FAILURE'`, `statusCode: 422`, `metadata: { dpsNumero: 4, code: 'E123', reason: 'Tomador inválido' }`), `invoice.pending` (`FAILURE`, 502, `metadata: { dpsNumero: 4 }`), `invoice.cancelled` (`metadata: { chaveAcesso, motivo }`), `invoice.cancel_rejected` (`FAILURE`, 422, `metadata: { chaveAcesso, code: 'E200', reason: 'Prazo expirado' }`). Also assert `emit` no longer calls `companies.assertCanEmit` (remove that mock and the 402 test — the guard owns it now; Task 5 removes the method).

- [ ] **Step 3: Implement** — inject `AuditService` in the three services (constructor `private readonly audit: AuditService`) and call `await this.audit.record({...})` right after each successful persistence / in the rejection branches:
- `CompaniesService.create`: after create. `update`: `metadata: { fields: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined) }`. `setCertificate`: `metadata: { certificateExpiry: loaded.notAfter, subjectCn: loaded.subjectCn }`. Remove `assertCanEmit` and its import of `HttpException` if unused; add `isTrialExpired(company: Pick<Company, 'plan' | 'trialEndsAt'>): boolean { return company.plan === 'TRIAL' && company.trialEndsAt.getTime() < Date.now(); }` (update the two `assertCanEmit` tests to `isTrialExpired` returning false/false/true).
- `CustomersService.create/update/remove`: as specified; `remove` returns after recording with `statusCode: 204`.
- `InvoicesService.emit`: remove `this.companies.assertCanEmit(company)`; in the gateway catch: `NfseRejectedError` → after the REJECTED update, `await this.audit.record({ action: 'invoice.rejected', companyId: company.id, entityType: 'invoice', entityId: invoice.id, outcome: 'FAILURE', statusCode: 422, metadata: { dpsNumero: invoice.dpsNumero, code: error.code, reason: error.message } })`; `NfseUnavailableError` → `invoice.pending` (FAILURE, 502); after `persistOutcome` → `invoice.emitted` with the metadata listed. `cancel`: rejected → `invoice.cancel_rejected`; unavailable → no audit (nothing changed); success → `invoice.cancelled`.

- [ ] **Step 4: Verify** — `bun test && bunx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git commit -m "feat(audit): record company, customer and invoice actions"`

---

### Task 5: Trial guard

**Files:**
- Create: `src/modules/companies/allow-expired-trial.decorator.ts`, `src/modules/companies/trial.guard.ts`
- Modify: `src/modules/companies/companies.service.ts` (add `findByUserId(userId): Promise<Company | null>`), `companies.controller.ts`, `src/modules/invoices/invoices.controller.ts`, `src/modules/customers/customers.controller.ts`, `src/modules/audit/audit.controller.ts`, `src/app.module.ts`
- Test: `test/modules/companies/trial.guard.spec.ts`, `test/app.e2e.spec.ts`

- [ ] **Step 1: Failing test**

`test/modules/companies/trial.guard.spec.ts`:
```ts
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '@/modules/audit/audit.service';
import { ALLOW_EXPIRED_TRIAL_KEY } from '@/modules/companies/allow-expired-trial.decorator';
import { CompaniesService } from '@/modules/companies/companies.service';
import { TrialGuard } from '@/modules/companies/trial.guard';
import { IS_PUBLIC_KEY } from '@/modules/auth/public.decorator';

const active = { id: 'c1', plan: 'TRIAL', trialEndsAt: new Date(Date.now() + 86400000) };
const expired = { id: 'c1', plan: 'TRIAL', trialEndsAt: new Date(Date.now() - 1000) };
const paid = { id: 'c1', plan: 'ACTIVE', trialEndsAt: new Date(0) };

function ctx(user: { id: string } | undefined, meta: Record<string, boolean> = {}) {
  const request: any = { user, method: 'POST', originalUrl: '/api/v0/invoices' };
  const context = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => 'h', getClass: () => 'c' } as unknown as ExecutionContext;
  const reflector = { getAllAndOverride: (key: string) => meta[key] } as unknown as Reflector;
  return { context, request, reflector };
}

describe('TrialGuard', () => {
  let companies: { findByUserId: ReturnType<typeof mock>; isTrialExpired: (c: any) => boolean };
  let audit: { record: ReturnType<typeof mock> };

  beforeEach(() => {
    companies = { findByUserId: mock(), isTrialExpired: (c) => c.plan === 'TRIAL' && c.trialEndsAt.getTime() < Date.now() };
    audit = { record: mock() };
  });

  const build = (reflector: Reflector) => new TrialGuard(reflector, companies as unknown as CompaniesService, audit as unknown as AuditService);

  it('lets public routes through without touching the database', async () => {
    const { context, reflector } = ctx(undefined, { [IS_PUBLIC_KEY]: true });
    await expect(build(reflector).canActivate(context)).resolves.toBe(true);
    expect(companies.findByUserId).not.toHaveBeenCalled();
  });

  it('lets users without a company through (onboarding)', async () => {
    companies.findByUserId.mockResolvedValue(null);
    const { context, reflector } = ctx({ id: 'u1' });
    await expect(build(reflector).canActivate(context)).resolves.toBe(true);
  });

  it('attaches the company to the request and passes for active trial and ACTIVE plan', async () => {
    companies.findByUserId.mockResolvedValueOnce(active);
    const a = ctx({ id: 'u1' });
    await expect(build(a.reflector).canActivate(a.context)).resolves.toBe(true);
    expect(a.request.company).toBe(active);
    companies.findByUserId.mockResolvedValueOnce(paid);
    const b = ctx({ id: 'u1' });
    await expect(build(b.reflector).canActivate(b.context)).resolves.toBe(true);
  });

  it('passes an expired trial on routes marked @AllowExpiredTrial', async () => {
    companies.findByUserId.mockResolvedValue(expired);
    const { context, reflector } = ctx({ id: 'u1' }, { [ALLOW_EXPIRED_TRIAL_KEY]: true });
    await expect(build(reflector).canActivate(context)).resolves.toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('blocks an expired trial with 402 and records trial.blocked', async () => {
    companies.findByUserId.mockResolvedValue(expired);
    const { context, reflector } = ctx({ id: 'u1' });
    const error = await build(reflector).canActivate(context).catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(402);
    expect(error.getResponse()).toEqual({ message: 'Trial expired', details: { trialEndsAt: expired.trialEndsAt } });
    expect(audit.record).toHaveBeenCalledWith({
      action: 'trial.blocked', companyId: 'c1', outcome: 'FAILURE', statusCode: 402,
      metadata: { method: 'POST', path: '/api/v0/invoices', trialEndsAt: expired.trialEndsAt },
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

`src/modules/companies/allow-expired-trial.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const ALLOW_EXPIRED_TRIAL_KEY = 'allowExpiredTrial';
/** Route stays available after the trial expired (read-only paths, cancel, company/certificate updates). */
export const AllowExpiredTrial = () => SetMetadata(ALLOW_EXPIRED_TRIAL_KEY, true);
```

`src/modules/companies/trial.guard.ts`:
```ts
import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { ALLOW_EXPIRED_TRIAL_KEY } from './allow-expired-trial.decorator';
import { CompaniesService } from './companies.service';

/**
 * Global guard (after JwtAuthGuard). Loads the caller's company onto `request.company`.
 * Expired TRIAL → 402 unless the route is marked @AllowExpiredTrial(). No company → pass (onboarding).
 */
@Injectable()
export class TrialGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly companies: CompaniesService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request.user?.id;
    if (!userId) return true;

    const company = await this.companies.findByUserId(userId);
    if (!company) return true;
    request.company = company;

    if (!this.companies.isTrialExpired(company)) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_EXPIRED_TRIAL_KEY, targets)) return true;

    await this.audit.record({
      action: 'trial.blocked',
      companyId: company.id,
      outcome: 'FAILURE',
      statusCode: 402,
      metadata: { method: request.method, path: request.originalUrl ?? request.url, trialEndsAt: company.trialEndsAt },
    });
    throw new HttpException({ message: 'Trial expired', details: { trialEndsAt: company.trialEndsAt } }, 402);
  }
}
```

`CompaniesService`: add `async findByUserId(userId: string): Promise<Company | null> { return this.prisma.company.findUnique({ where: { userId } }); }` (and make `findEntity` use it).

Controllers — add `@AllowExpiredTrial()` (import from `'../companies/allow-expired-trial.decorator'`) on: `CompaniesController.findMine`, `update`, `setCertificate`; `InvoicesController.findAll`, `findOne`, `getXml`, `getPdf`, `cancel`; `CustomersController.findAll`, `findOne`; `AuditController.findAll` (and later `AlertsController`).

`src/app.module.ts` providers — add `{ provide: APP_GUARD, useClass: TrialGuard }` after the JWT guard (import from `'./modules/companies/trial.guard'`).

- [ ] **Step 4: e2e** — the existing 402 assertion still holds (now produced by the guard). Extend it: after the 402 on `POST /invoices`, assert `POST /api/v0/customers` → 402, `GET /api/v0/invoices` → 200, `PATCH /api/v0/companies/me` → 200, `POST /api/v0/invoices/${id}/cancel` on an already-cancelled invoice → 409 (guard passed; service refused), and `GET /api/v0/audit-logs?action=trial.blocked` → 200 with `total >= 2`.

- [ ] **Step 5: Verify** — `bun test && bunx tsc --noEmit && E2E... bun test test/app.e2e.spec.ts`.

- [ ] **Step 6: Commit** — `git commit -m "feat(companies): global trial guard with @AllowExpiredTrial opt-outs"`

---

### Task 6: Alerts

**Files:**
- Create: `src/modules/alerts/alerts.module.ts`, `alerts.service.ts`, `alerts.controller.ts`
- Modify: `src/modules/invoices/invoices.service.ts` (`countStalePending(userId, olderThanMinutes)`), `src/modules/invoices/invoices.module.ts` (export service — already does), `src/app.module.ts`
- Test: `test/modules/alerts/alerts.service.spec.ts`, `test/modules/invoices/invoices.service.spec.ts` (count)

**Interfaces:** `Alert = { code: 'CERTIFICATE_MISSING' | 'CERTIFICATE_EXPIRED' | 'CERTIFICATE_EXPIRING' | 'TRIAL_EXPIRED' | 'TRIAL_ENDING' | 'INVOICES_PENDING'; severity: 'info' | 'warning' | 'critical'; message: string; data?: Record<string, unknown> }`; `AlertsService.forUser(userId): Promise<{ alerts: Alert[] }>`; `GET /alerts` (`@AllowExpiredTrial()`). Thresholds: `CERTIFICATE_EXPIRING_DAYS = 30`, `TRIAL_ENDING_DAYS = 5`, `PENDING_STALE_MINUTES = 10`.

- [ ] **Step 1: Failing tests**

`test/modules/alerts/alerts.service.spec.ts` — build `AlertsService` with mocks `companies.findMine` (returns a `CompanyResponse`-like object with `hasCertificate`, `certificateExpiry`, `plan`, `trialEndsAt`) and `companies.isTrialExpired`, `invoices.countStalePending`. Cases: no certificate → `CERTIFICATE_MISSING` warning; expired certificate → critical with `data.expiredAt`; expiring in 10 days → warning with `daysLeft: 10`; trial expired → critical; trial ending in 3 days → warning `daysLeft: 3`; 2 stale pending → warning `data.count: 2`; healthy company → `[]`; ordering critical → warning → info (build a company that triggers `TRIAL_ENDING` (warning) and `CERTIFICATE_EXPIRED` (critical) and assert the critical comes first). `invoices.service.spec.ts`: `countStalePending('u1', 10)` calls `prisma.invoice.count({ where: { companyId: 'c1', status: 'PENDING', createdAt: { lt: expect.any(Date) } } })`.

- [ ] **Step 2: Implement**

`src/modules/alerts/alerts.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { CompaniesService } from '../companies/companies.service';
import { InvoicesService } from '../invoices/invoices.service';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export interface Alert {
  code: 'CERTIFICATE_MISSING' | 'CERTIFICATE_EXPIRED' | 'CERTIFICATE_EXPIRING' | 'TRIAL_EXPIRED' | 'TRIAL_ENDING' | 'INVOICES_PENDING';
  severity: AlertSeverity;
  message: string;
  data?: Record<string, unknown>;
}

export const CERTIFICATE_EXPIRING_DAYS = 30;
export const TRIAL_ENDING_DAYS = 5;
export const PENDING_STALE_MINUTES = 10;
const ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
const DAY = 24 * 3600 * 1000;

@Injectable()
export class AlertsService {
  constructor(
    private readonly companies: CompaniesService,
    private readonly invoices: InvoicesService,
  ) {}

  async forUser(userId: string): Promise<{ alerts: Alert[] }> {
    const company = await this.companies.findMine(userId);
    const now = Date.now();
    const alerts: Alert[] = [];

    if (!company.hasCertificate) {
      alerts.push({ code: 'CERTIFICATE_MISSING', severity: 'warning', message: 'Cadastre o certificado digital A1 para emitir notas.' });
    } else if (company.certificateExpiry) {
      const msLeft = company.certificateExpiry.getTime() - now;
      if (msLeft < 0) {
        alerts.push({ code: 'CERTIFICATE_EXPIRED', severity: 'critical', message: 'Seu certificado digital venceu. Envie um novo para voltar a emitir.', data: { expiredAt: company.certificateExpiry } });
      } else if (msLeft <= CERTIFICATE_EXPIRING_DAYS * DAY) {
        const daysLeft = Math.ceil(msLeft / DAY);
        alerts.push({ code: 'CERTIFICATE_EXPIRING', severity: 'warning', message: `Seu certificado digital vence em ${daysLeft} dia(s).`, data: { expiresAt: company.certificateExpiry, daysLeft } });
      }
    }

    if (this.companies.isTrialExpired(company)) {
      alerts.push({ code: 'TRIAL_EXPIRED', severity: 'critical', message: 'Seu período de teste terminou. Escolha um plano para continuar emitindo.', data: { trialEndsAt: company.trialEndsAt } });
    } else if (company.plan === 'TRIAL') {
      const msLeft = company.trialEndsAt.getTime() - now;
      if (msLeft <= TRIAL_ENDING_DAYS * DAY) {
        const daysLeft = Math.ceil(msLeft / DAY);
        alerts.push({ code: 'TRIAL_ENDING', severity: 'warning', message: `Seu período de teste termina em ${daysLeft} dia(s).`, data: { trialEndsAt: company.trialEndsAt, daysLeft } });
      }
    }

    const pending = await this.invoices.countStalePending(userId, PENDING_STALE_MINUTES);
    if (pending > 0) {
      alerts.push({ code: 'INVOICES_PENDING', severity: 'warning', message: `${pending} nota(s) aguardando confirmação do fisco há mais de ${PENDING_STALE_MINUTES} minutos.`, data: { count: pending } });
    }

    alerts.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
    return { alerts };
  }
}
```
`InvoicesService.countStalePending(userId, olderThanMinutes)`: `const { id: companyId } = await this.companies.findMine(userId); return this.prisma.invoice.count({ where: { companyId, status: 'PENDING', createdAt: { lt: new Date(Date.now() - olderThanMinutes * 60_000) } } });`
Controller `@Controller('alerts')` with `@Get() @AllowExpiredTrial()` → `this.alerts.forUser(user.id)`. Module imports `CompaniesModule`, `InvoicesModule`; add to `AppModule`.
`isTrialExpired` must accept `Pick<Company | CompanyResponse, 'plan' | 'trialEndsAt'>` — it already types on `plan`/`trialEndsAt` only.

- [ ] **Step 3: Verify + commit** — `bun test && bunx tsc --noEmit`; `git commit -m "feat(alerts): GET /alerts with certificate, trial and pending-invoice warnings"`

---

### Task 7: e2e, Postman, docs, version 0.3.0

- e2e: assert `x-request-id` header on a 200 and on the 401 (and `requestId` in the 401 body); `GET /api/v0/alerts` after expiring the trial contains `TRIAL_EXPIRED` (critical first); `GET /api/v0/audit-logs` contains `company.created`, `certificate.uploaded`, `invoice.emitted`, `invoice.cancelled`, `customer.created`; cleanup also `deleteMany` audit logs by `companyId`.
- Postman: `info.version` `0.3.0`; folders **Alerts** (`GET /alerts`) and **Audit** (`GET /audit-logs?action=&page=&limit=`); fixtures already replaced in Task 2.
- `docs/frontend/api-brief.md`: `requestId` in errors/headers, trial policy table (allowed vs blocked), `GET /alerts` with the codes/severities and UI hints, `GET /audit-logs` ("extrato de ações"), CPF/CNPJ validation + 400 message, section 8/9 updates.
- README: rastreabilidade (`x-request-id`, `LOG_LEVEL`, `LOG_PRETTY`), auditoria (append-only, 5 anos, nunca segredos), política do trial, alertas, validação de documento.
- `package.json` `0.3.0`; `bun run version:check`; full suite; e2e; commit `feat: v0.3.0 — audit, trial guard, document validation and alerts in docs/collection/e2e`.

## Done criteria

- Every response carries `x-request-id`; error bodies carry `requestId`; logs are JSON (pretty in dev) with `requestId`/`userId`.
- `audit_logs` receives the actions in the spec table; `GET /audit-logs` lists them per company; a failed audit write never fails the action.
- Expired trial: 402 on `POST /invoices` and `POST/PATCH/DELETE /customers`; everything marked `@AllowExpiredTrial()` still works; `trial.blocked` audited.
- Invalid CPF/CNPJ → 400 with a field-named message; valid fixtures everywhere.
- `GET /alerts` returns the documented codes ordered by severity.
- `bun test`, e2e, `tsc`, `version:check` green at 0.3.0.
