import { beforeEach, describe, expect, it } from 'bun:test';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { API_VERSION, HealthService, deriveStage } from '@/modules/health/health.service';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';

const pkg = JSON.parse(await Bun.file('package.json').text()) as { name: string; version: string };

function configWith(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as unknown as ConfigService<any, true>;
}

describe('deriveStage', () => {
  it('uses the explicit stage when given', () => {
    expect(deriveStage('0.2.0', 'beta')).toBe('beta');
  });
  it('derives alpha for major 0 and stable otherwise', () => {
    expect(deriveStage('0.2.0')).toBe('alpha');
    expect(deriveStage('1.0.0')).toBe('stable');
  });
});

describe('HealthService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  async function build(values: Record<string, unknown> = {}) {
    prisma = createPrismaMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: configWith({ NODE_ENV: 'test', NFSE_ENV: 'fake', ...values }) },
      ],
    }).compile();
    return moduleRef.get(HealthService);
  }

  beforeEach(() => {
    // fresh instance per test via build()
  });

  it('reports ok with version, stage, api version, runtime and a passing database check', async () => {
    const service = await build();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const report = await service.report();
    expect(report.status).toBe('ok');
    expect(report.name).toBe(pkg.name);
    expect(report.version).toBe(pkg.version);
    expect(report.stage).toBe('alpha');
    expect(report.apiVersion).toBe(API_VERSION);
    expect(report.environment).toBe('test');
    expect(report.nfseEnv).toBe('fake');
    expect(report.commit).toBeNull();
    expect(report.runtime.bun).toBe(Bun.version);
    expect(report.runtime.node).toBe(process.version);
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(report.timestamp))).toBe(false);
    expect(report.checks.database.status).toBe('ok');
    expect(report.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('exposes APP_STAGE and GIT_COMMIT when configured', async () => {
    const service = await build({ APP_STAGE: 'beta', GIT_COMMIT: 'abc1234' });
    prisma.$queryRaw.mockResolvedValue([]);
    const report = await service.report();
    expect(report.stage).toBe('beta');
    expect(report.commit).toBe('abc1234');
  });

  it('is degraded when the database check fails', async () => {
    const service = await build();
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    const report = await service.report();
    expect(report.status).toBe('degraded');
    expect(report.checks.database).toEqual({ status: 'error', latencyMs: null });
  });
});
