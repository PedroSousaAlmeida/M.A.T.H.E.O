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
