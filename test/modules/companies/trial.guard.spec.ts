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
