import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Test } from '@nestjs/testing';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { CompaniesService } from '@/modules/companies/companies.service';
import { InvoicesService } from '@/modules/invoices/invoices.service';

const userId = 'user-1';
const DAY = 24 * 3600 * 1000;

const healthyCompany = {
  id: 'c1',
  hasCertificate: true,
  certificateExpiry: new Date(Date.now() + 200 * DAY),
  plan: 'ACTIVE',
  trialEndsAt: new Date(Date.now() - DAY),
};

describe('AlertsService', () => {
  let service: AlertsService;
  let companies: { findMine: ReturnType<typeof mock>; isTrialExpired: ReturnType<typeof mock> };
  let invoices: { countStalePending: ReturnType<typeof mock> };

  beforeEach(async () => {
    companies = {
      findMine: mock(async () => healthyCompany),
      isTrialExpired: mock(() => false),
    };
    invoices = { countStalePending: mock(async () => 0) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: CompaniesService, useValue: companies },
        { provide: InvoicesService, useValue: invoices },
      ],
    }).compile();
    service = moduleRef.get(AlertsService);
  });

  it('returns no alerts for a healthy company', async () => {
    const result = await service.forUser(userId);
    expect(result.alerts).toEqual([]);
  });

  it('warns CERTIFICATE_MISSING when the company has no certificate', async () => {
    companies.findMine.mockResolvedValue({ ...healthyCompany, hasCertificate: false, certificateExpiry: null });
    const { alerts } = await service.forUser(userId);
    expect(alerts).toEqual([{ code: 'CERTIFICATE_MISSING', severity: 'warning', message: 'Cadastre o certificado digital A1 para emitir notas.' }]);
  });

  it('flags CERTIFICATE_EXPIRED as critical with expiredAt when the certificate already expired', async () => {
    const expiredAt = new Date(Date.now() - DAY);
    companies.findMine.mockResolvedValue({ ...healthyCompany, certificateExpiry: expiredAt });
    const { alerts } = await service.forUser(userId);
    expect(alerts).toEqual([
      expect.objectContaining({ code: 'CERTIFICATE_EXPIRED', severity: 'critical', data: { expiredAt } }),
    ]);
  });

  it('warns CERTIFICATE_EXPIRING with daysLeft when the certificate expires within the threshold', async () => {
    const expiresAt = new Date(Date.now() + 10 * DAY - 1);
    companies.findMine.mockResolvedValue({ ...healthyCompany, certificateExpiry: expiresAt });
    const { alerts } = await service.forUser(userId);
    expect(alerts).toEqual([
      expect.objectContaining({ code: 'CERTIFICATE_EXPIRING', severity: 'warning', data: { expiresAt, daysLeft: 10 } }),
    ]);
  });

  it('flags TRIAL_EXPIRED as critical when isTrialExpired returns true', async () => {
    const trialEndsAt = new Date(Date.now() - DAY);
    companies.findMine.mockResolvedValue({ ...healthyCompany, plan: 'TRIAL', trialEndsAt });
    companies.isTrialExpired.mockReturnValue(true);
    const { alerts } = await service.forUser(userId);
    expect(alerts).toEqual([
      expect.objectContaining({ code: 'TRIAL_EXPIRED', severity: 'critical', data: { trialEndsAt } }),
    ]);
  });

  it('warns TRIAL_ENDING with daysLeft when the trial ends within the threshold', async () => {
    const trialEndsAt = new Date(Date.now() + 3 * DAY - 1);
    companies.findMine.mockResolvedValue({ ...healthyCompany, plan: 'TRIAL', trialEndsAt });
    companies.isTrialExpired.mockReturnValue(false);
    const { alerts } = await service.forUser(userId);
    expect(alerts).toEqual([
      expect.objectContaining({ code: 'TRIAL_ENDING', severity: 'warning', data: { trialEndsAt, daysLeft: 3 } }),
    ]);
  });

  it('warns INVOICES_PENDING with the stale count when there are stale pending invoices', async () => {
    invoices.countStalePending.mockResolvedValue(2);
    const { alerts } = await service.forUser(userId);
    expect(alerts).toEqual([
      expect.objectContaining({ code: 'INVOICES_PENDING', severity: 'warning', data: { count: 2 } }),
    ]);
  });

  it('orders alerts critical before warning before info', async () => {
    companies.findMine.mockResolvedValue({
      ...healthyCompany,
      certificateExpiry: new Date(Date.now() - DAY), // CERTIFICATE_EXPIRED (critical)
      plan: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 3 * DAY - 1), // TRIAL_ENDING (warning)
    });
    companies.isTrialExpired.mockReturnValue(false);
    const { alerts } = await service.forUser(userId);
    expect(alerts.map((a) => a.code)).toEqual(['CERTIFICATE_EXPIRED', 'TRIAL_ENDING']);
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[1].severity).toBe('warning');
  });
});
