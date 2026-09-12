import {
  BadGatewayException,
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
import { CompaniesService } from '../companies/companies.service';
import { NfseRejectedError, NfseUnavailableError } from '../nfse/errors';
import { NFSE_GATEWAY, type DpsData, type NfseAmbiente, type NfseGateway } from '../nfse/nfse-gateway';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';

export const DEFAULT_SERIE = '1';

export type InvoiceResponse = Omit<Invoice, 'xmlDps' | 'xmlNfse' | 'valor'> & { valor: string };

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);
  private readonly ambiente: NfseAmbiente;

  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    @Inject(NFSE_GATEWAY) private readonly gateway: NfseGateway,
    config: ConfigService<Env, true>,
  ) {
    this.ambiente = config.get('NFSE_ENV', { infer: true }) === 'producao' ? 'producao' : 'homologacao';
  }

  async emit(userId: string, dto: CreateInvoiceDto): Promise<InvoiceResponse> {
    const { company, certificate } = await this.companies.getCompanyWithCertificate(userId);
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
            status: 'PENDING',
            dpsSerie: DEFAULT_SERIE,
            dpsNumero: (_max.dpsNumero ?? 0) + 1,
            tomadorDocumento: dto.tomadorDocumento,
            tomadorNome: dto.tomadorNome,
            tomadorEmail: dto.tomadorEmail ?? null,
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
      }
      this.mapGatewayError(error, invoice.id, 'NFS-e rejected by the national API', 'National NFS-e API unavailable; invoice kept as PENDING');
    }

    const issued = await this.persistOutcome(
      invoice.id,
      { status: 'ISSUED', ...result },
      `Invoice ${invoice.id} was issued at the national API (chaveAcesso=${result.chaveAcesso}, numeroNfse=${result.numeroNfse}) but could not be persisted; reconcile manually`,
    );
    return this.toResponse(issued);
  }

  async findAll(userId: string, query: ListInvoicesDto) {
    const { id: companyId } = await this.companies.findMine(userId);
    const where = { companyId, ...(query.status ? { status: query.status } : {}) };
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
      this.mapGatewayError(error, invoice.id, 'Cancellation rejected by the national API', 'National NFS-e API unavailable');
    }

    const cancelled = await this.persistOutcome(
      invoice.id,
      { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: motivo },
      `Invoice ${invoice.id} was cancelled at the national API (chaveAcesso=${invoice.chaveAcesso}) but could not be persisted; reconcile manually`,
    );
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
