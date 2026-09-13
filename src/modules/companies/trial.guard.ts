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
