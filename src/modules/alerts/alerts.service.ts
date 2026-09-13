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
        alerts.push({
          code: 'CERTIFICATE_EXPIRED',
          severity: 'critical',
          message: 'Seu certificado digital venceu. Envie um novo para voltar a emitir.',
          data: { expiredAt: company.certificateExpiry },
        });
      } else if (msLeft <= CERTIFICATE_EXPIRING_DAYS * DAY) {
        const daysLeft = Math.ceil(msLeft / DAY);
        alerts.push({
          code: 'CERTIFICATE_EXPIRING',
          severity: 'warning',
          message: `Seu certificado digital vence em ${daysLeft} dia(s).`,
          data: { expiresAt: company.certificateExpiry, daysLeft },
        });
      }
    }

    if (this.companies.isTrialExpired(company)) {
      alerts.push({
        code: 'TRIAL_EXPIRED',
        severity: 'critical',
        message: 'Seu período de teste terminou. Escolha um plano para continuar emitindo.',
        data: { trialEndsAt: company.trialEndsAt },
      });
    } else if (company.plan === 'TRIAL') {
      const msLeft = company.trialEndsAt.getTime() - now;
      if (msLeft <= TRIAL_ENDING_DAYS * DAY) {
        const daysLeft = Math.ceil(msLeft / DAY);
        alerts.push({
          code: 'TRIAL_ENDING',
          severity: 'warning',
          message: `Seu período de teste termina em ${daysLeft} dia(s).`,
          data: { trialEndsAt: company.trialEndsAt, daysLeft },
        });
      }
    }

    const pending = await this.invoices.countStalePending(userId, PENDING_STALE_MINUTES);
    if (pending > 0) {
      alerts.push({
        code: 'INVOICES_PENDING',
        severity: 'warning',
        message: `${pending} nota(s) aguardando confirmação do fisco há mais de ${PENDING_STALE_MINUTES} minutos.`,
        data: { count: pending },
      });
    }

    alerts.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
    return { alerts };
  }
}
