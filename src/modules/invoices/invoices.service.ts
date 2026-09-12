import {
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Invoice } from '../../../generated/prisma/client';
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

    const invoice = await this.prisma.$transaction(async (tx) => {
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

    const dps: DpsData = {
      ambiente: this.ambiente,
      serie: invoice.dpsSerie,
      numero: invoice.dpsNumero,
      dataEmissao: invoice.createdAt,
      prestador: { cnpj: company.cnpj, inscricaoMunicipal: company.inscricaoMunicipal, codigoMunicipio: company.codigoMunicipio },
      tomador: { documento: invoice.tomadorDocumento, nome: invoice.tomadorNome, email: invoice.tomadorEmail },
      servico: { codigoTributacao: invoice.codigoTributacao, descricao: invoice.descricao, valor },
    };

    try {
      const result = await this.gateway.emit(dps, certificate);
      const issued = await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'ISSUED', ...result },
      });
      return this.toResponse(issued);
    } catch (error) {
      if (error instanceof NfseRejectedError) {
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: { status: 'REJECTED', rejectionReason: `${error.code}: ${error.message}` },
        });
        throw new UnprocessableEntityException({
          message: 'NFS-e rejected by the national API',
          details: { invoiceId: invoice.id, code: error.code, reason: error.message },
        });
      }
      if (error instanceof NfseUnavailableError) {
        throw new BadGatewayException({
          message: 'National NFS-e API unavailable; invoice kept as PENDING',
          details: { invoiceId: invoice.id },
        });
      }
      throw error;
    }
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

  protected async findEntity(userId: string, id: string): Promise<Invoice> {
    const { id: companyId } = await this.companies.findMine(userId);
    const invoice = await this.prisma.invoice.findFirst({ where: { id, companyId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  protected toResponse(invoice: Invoice): InvoiceResponse {
    const { xmlDps: _dps, xmlNfse: _nfse, valor, ...rest } = invoice;
    return { ...rest, valor: Number(valor).toFixed(2) };
  }
}
