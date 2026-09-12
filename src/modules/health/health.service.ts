import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';

export const API_VERSION = 'v0';
const DB_CHECK_TIMEOUT_MS = 2000;

export type Stage = NonNullable<Env['APP_STAGE']>;

export interface HealthReport {
  status: 'ok' | 'degraded';
  name: string;
  version: string;
  stage: Stage;
  apiVersion: string;
  environment: Env['NODE_ENV'];
  nfseEnv: Env['NFSE_ENV'];
  commit: string | null;
  runtime: { bun: string | null; node: string; platform: string };
  uptimeSeconds: number;
  timestamp: string;
  checks: { database: { status: 'ok' | 'error'; latencyMs: number | null } };
}

/** Stage is explicit via APP_STAGE; otherwise derived from semver: major 0 = alpha, ≥1 = stable. */
export function deriveStage(version: string, explicit?: Stage): Stage {
  if (explicit) return explicit;
  return version.startsWith('0.') ? 'alpha' : 'stable';
}

@Injectable()
export class HealthService {
  private readonly pkg: { name: string; version: string };
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  }

  async report(): Promise<HealthReport> {
    const database = await this.checkDatabase();
    return {
      status: database.status === 'ok' ? 'ok' : 'degraded',
      name: this.pkg.name,
      version: this.pkg.version,
      stage: deriveStage(this.pkg.version, this.config.get('APP_STAGE', { infer: true })),
      apiVersion: API_VERSION,
      environment: this.config.get('NODE_ENV', { infer: true }),
      nfseEnv: this.config.get('NFSE_ENV', { infer: true }),
      commit: this.config.get('GIT_COMMIT', { infer: true }) ?? null,
      runtime: { bun: typeof Bun !== 'undefined' ? Bun.version : null, node: process.version, platform: process.platform },
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
      checks: { database },
    };
  }

  private async checkDatabase(): Promise<HealthReport['checks']['database']> {
    const started = Date.now();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_CHECK_TIMEOUT_MS));
    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
      return { status: 'ok', latencyMs: Date.now() - started };
    } catch {
      return { status: 'error', latencyMs: null };
    }
  }
}
