import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Invoice, Prisma } from '../../../generated/prisma/client';
import type { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CompaniesService } from '../companies/companies.service';
import { CustomersService } from '../customers/customers.service';
import { NfseRejectedError, NfseUnavailableError } from '../nfse/errors';
import { NFSE_GATEWAY, type DpsData, type NfseAmbiente, type NfseGateway } from '../nfse/nfse-gateway';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';

export const DEFAULT_SERIE = '1';

export type InvoiceResponse = Omit<Invoice, 'xmlDps' | 'xmlNfse' | 'valor'> & { valor: string };

export interface InvoiceSummary {
  month: { count: number; total: string; start: string };
  year: { count: number; total: string; start: string };
  byStatus: Record<'PENDING' | 'ISSUED' | 'REJECTED' | 'CANCELLED', number>;
  annualLimit: string;
  annualUsagePct: number;
}

const FISCAL_TIME_ZONE = 'America/Sao_Paulo';

/** First instant of the current month and year in the fiscal time zone (Brazil has no DST since 2019: fixed -03:00). */
export function fiscalPeriodStarts(now: Date): { monthStart: Date; yearStart: Date } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: FISCAL_TIME_ZONE, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  return { monthStart: new Date(`${year}-${month}-01T00:00:00-03:00`), yearStart: new Date(`${year}-01-01T00:00:00-03:00`) };
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);
  private readonly ambiente: NfseAmbiente;
  private readonly annualLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
    @Inject(NFSE_GATEWAY) private readonly gateway: NfseGateway,
    config: ConfigService<Env, true>,
  ) {
    this.ambiente = config.get('NFSE_ENV', { infer: true }) === 'producao' ? 'producao' : 'homologacao';
    this.annualLimit = config.get('MEI_ANNUAL_LIMIT', { infer: true });
  }

  async emit(userId: string, dto: CreateInvoiceDto): Promise<InvoiceResponse> {
    const { company, certificate } = await this.companies.getCompanyWithCertificate(userId);
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
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Concurrent emission for this company; retry the request');
      }
      throw error;
    }

    const dps: DpsData = {
      ambiente: this.ambiente,
      serie: invoice.dpsSerie,
      numero: invoice.dpsNumero,
      dataEmissao: invoice.createdAt,
      prestador: { cnpj: company.cnpj, inscricaoMunicipal: company.inscricaoMunicipal, codigoMunicipio: company.codigoMunicipio },
      tomador: { documento: invoice.tomadorDocumento, nome: invoice.tomadorNome, email: invoice.tomadorEmail },
      servico: { codigoTributacao: invoice.codigoTributacao, descricao: invoice.descricao, valor },
    };

    let result: Awaited<ReturnType<NfseGateway['emit']>>;
    try {
      result = await this.gateway.emit(dps, certificate);
    } catch (error) {
      if (error instanceof NfseRejectedError) {
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: { status: 'REJECTED', rejectionReason: `${error.code}: ${error.message}` },
        });
        await this.audit.record({
          action: 'invoice.rejected',
          companyId: company.id,
          entityType: 'invoice',
          entityId: invoice.id,
          outcome: 'FAILURE',
          statusCode: 422,
          metadata: { dpsNumero: invoice.dpsNumero, code: error.code, reason: error.message },
        });
      } else if (error instanceof NfseUnavailableError) {
        await this.audit.record({
          action: 'invoice.pending',
          companyId: company.id,
          entityType: 'invoice',
          entityId: invoice.id,
          outcome: 'FAILURE',
          statusCode: 502,
          metadata: { dpsNumero: invoice.dpsNumero },
        });
      }
      this.mapGatewayError(error, invoice.id, 'NFS-e rejected by the national API', 'National NFS-e API unavailable; invoice kept as PENDING');
    }

    let issued: Invoice;
    try {
      issued = await this.persistOutcome(
        invoice.id,
        { status: 'ISSUED', ...result },
        `Invoice ${invoice.id} was issued at the national API (chaveAcesso=${result.chaveAcesso}, numeroNfse=${result.numeroNfse}) but could not be persisted; reconcile manually`,
      );
    } catch (error) {
      await this.audit.record({
        action: 'invoice.emitted',
        companyId: company.id,
        entityType: 'invoice',
        entityId: invoice.id,
        outcome: 'FAILURE',
        statusCode: 500,
        metadata: { dpsNumero: invoice.dpsNumero, chaveAcesso: result.chaveAcesso, numeroNfse: result.numeroNfse, persisted: false },
      });
      throw error;
    }
    await this.audit.record({
      action: 'invoice.emitted',
      companyId: company.id,
      entityType: 'invoice',
      entityId: issued.id,
      statusCode: 201,
      metadata: {
        dpsNumero: issued.dpsNumero,
        chaveAcesso: issued.chaveAcesso,
        numeroNfse: issued.numeroNfse,
        valor: Number(issued.valor).toFixed(2),
        tomadorDocumento: issued.tomadorDocumento,
        customerId: issued.customerId,
      },
    });
    return this.toResponse(issued);
  }

  async findAll(userId: string, query: ListInvoicesDto) {
    const { id: companyId } = await this.companies.findMine(userId);
    const where: Prisma.InvoiceWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { tomadorNome: { contains: query.search, mode: 'insensitive' } },
              { tomadorDocumento: { startsWith: query.search } },
              { numeroNfse: query.search },
            ],
          }
        : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { data: rows.map((row) => this.toResponse(row)), page: query.page, limit: query.limit, total };
  }

  async countStalePending(userId: string, olderThanMinutes: number): Promise<number> {
    const { id: companyId } = await this.companies.findMine(userId);
    return this.prisma.invoice.count({
      where: { companyId, status: 'PENDING', createdAt: { lt: new Date(Date.now() - olderThanMinutes * 60_000) } },
    });
  }

  /**
   * Dashboard KPIs. Revenue counts only ISSUED invoices (cancelled/rejected/pending never count),
   * with month/year boundaries in America/Sao_Paulo (the fiscal calendar).
   */
  async getSummary(userId: string): Promise<InvoiceSummary> {
    const { id: companyId } = await this.companies.findMine(userId);
    const { monthStart, yearStart } = fiscalPeriodStarts(new Date());
    const issued = { companyId, status: 'ISSUED' as const };
    const [month, year, groups] = await Promise.all([
      this.prisma.invoice.aggregate({ where: { ...issued, createdAt: { gte: monthStart } }, _count: { _all: true }, _sum: { valor: true } }),
      this.prisma.invoice.aggregate({ where: { ...issued, createdAt: { gte: yearStart } }, _count: { _all: true }, _sum: { valor: true } }),
      this.prisma.invoice.groupBy({ by: ['status'], where: { companyId }, _count: { _all: true } }),
    ]);
    const byStatus = { PENDING: 0, ISSUED: 0, REJECTED: 0, CANCELLED: 0 };
    for (const g of groups) byStatus[g.status] = g._count._all;
    const yearTotal = Number(year._sum.valor ?? 0);
    const annualLimit = this.annualLimit;
    return {
      month: { count: month._count._all, total: Number(month._sum.valor ?? 0).toFixed(2), start: monthStart.toISOString() },
      year: { count: year._count._all, total: yearTotal.toFixed(2), start: yearStart.toISOString() },
      byStatus,
      annualLimit: annualLimit.toFixed(2),
      annualUsagePct: Math.round((yearTotal / annualLimit) * 1000) / 10,
    };
  }

  async findOne(userId: string, id: string): Promise<InvoiceResponse> {
    return this.toResponse(await this.findEntity(userId, id));
  }

  async getXml(userId: string, id: string): Promise<string> {
    const invoice = await this.findEntity(userId, id);
    if (!invoice.xmlNfse) throw new NotFoundException('Invoice has no NFS-e XML (not issued)');
    return invoice.xmlNfse;
  }

  async cancel(userId: string, id: string, motivo: string): Promise<InvoiceResponse> {
    const invoice = await this.findEntity(userId, id);
    if (invoice.status !== 'ISSUED' || !invoice.chaveAcesso) {
      throw new ConflictException(`Only ISSUED invoices can be cancelled (current: ${invoice.status})`);
    }
    const { company, certificate } = await this.companies.getCompanyWithCertificate(userId);

    try {
      await this.gateway.cancel(
        invoice.chaveAcesso,
        motivo,
        {
          ambiente: this.ambiente,
          prestador: { cnpj: company.cnpj, inscricaoMunicipal: company.inscricaoMunicipal, codigoMunicipio: company.codigoMunicipio },
        },
        certificate,
      );
    } catch (error) {
      if (error instanceof NfseRejectedError) {
        await this.audit.record({
          action: 'invoice.cancel_rejected',
          companyId: company.id,
          entityType: 'invoice',
          entityId: invoice.id,
          outcome: 'FAILURE',
          statusCode: 422,
          metadata: { chaveAcesso: invoice.chaveAcesso, code: error.code, reason: error.message },
        });
      }
      this.mapGatewayError(error, invoice.id, 'Cancellation rejected by the national API', 'National NFS-e API unavailable');
    }

    let cancelled: Invoice;
    try {
      cancelled = await this.persistOutcome(
        invoice.id,
        { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: motivo },
        `Invoice ${invoice.id} was cancelled at the national API (chaveAcesso=${invoice.chaveAcesso}) but could not be persisted; reconcile manually`,
      );
    } catch (error) {
      await this.audit.record({
        action: 'invoice.cancelled',
        companyId: company.id,
        entityType: 'invoice',
        entityId: invoice.id,
        outcome: 'FAILURE',
        statusCode: 500,
        metadata: { chaveAcesso: invoice.chaveAcesso, motivo, persisted: false },
      });
      throw error;
    }
    await this.audit.record({
      action: 'invoice.cancelled',
      companyId: company.id,
      entityType: 'invoice',
      entityId: cancelled.id,
      statusCode: 200,
      metadata: { chaveAcesso: cancelled.chaveAcesso, motivo },
    });
    return this.toResponse(cancelled);
  }

  async getPdf(userId: string, id: string): Promise<Buffer> {
    const invoice = await this.findEntity(userId, id);
    if (!invoice.chaveAcesso) throw new NotFoundException('Invoice has no NFS-e (not issued)');
    const { certificate } = await this.companies.getCompanyWithCertificate(userId);
    try {
      return await this.gateway.pdf(invoice.chaveAcesso, certificate);
    } catch (error) {
      this.mapGatewayError(error, invoice.id, 'PDF request rejected by the national API', 'National NFS-e API unavailable');
    }
  }

  protected async findEntity(userId: string, id: string): Promise<Invoice> {
    const { id: companyId } = await this.companies.findMine(userId);
    const invoice = await this.prisma.invoice.findFirst({ where: { id, companyId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  /**
   * Exactly one of `customerId` or `tomador*` identifies the tomador. The invoice always stores a copy
   * of the data; `customerId` is kept only as a reference.
   */
  private async resolveTomador(
    userId: string,
    companyId: string,
    dto: CreateInvoiceDto,
  ): Promise<{ customerId: string | null; documento: string; nome: string; email: string | null }> {
    const hasInline = Boolean(dto.tomadorDocumento || dto.tomadorNome || dto.tomadorEmail);
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

  /**
   * Persists a status update after a national API call already succeeded (ISSUED/CANCELLED).
   * Retries once; if it still fails, logs an alert for manual reconciliation and rethrows.
   * Never logs XML.
   */
  private async persistOutcome(invoiceId: string, data: Prisma.InvoiceUpdateInput, unrecoverableLogMessage: string): Promise<Invoice> {
    try {
      return await this.prisma.invoice.update({ where: { id: invoiceId }, data });
    } catch {
      try {
        return await this.prisma.invoice.update({ where: { id: invoiceId }, data });
      } catch (error) {
        this.logger.error(unrecoverableLogMessage, error instanceof Error ? error.stack : String(error));
        throw error;
      }
    }
  }

  private mapGatewayError(error: unknown, invoiceId: string, rejectedMessage: string, unavailableMessage: string): never {
    if (error instanceof NfseRejectedError) {
      throw new UnprocessableEntityException({
        message: rejectedMessage,
        details: { invoiceId, code: error.code, reason: error.message },
      });
    }
    if (error instanceof NfseUnavailableError) {
      throw new BadGatewayException({ message: unavailableMessage, details: { invoiceId } });
    }
    throw error;
  }

  protected toResponse(invoice: Invoice): InvoiceResponse {
    const { xmlDps: _dps, xmlNfse: _nfse, valor, ...rest } = invoice;
    return { ...rest, valor: Number(valor).toFixed(2) };
  }
}
