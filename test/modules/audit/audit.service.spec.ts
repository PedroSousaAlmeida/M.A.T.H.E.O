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
