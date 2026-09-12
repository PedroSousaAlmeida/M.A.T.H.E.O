import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { BadGatewayException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CompaniesService } from '@/modules/companies/companies.service';
import { InvoicesService } from '@/modules/invoices/invoices.service';
import { NfseRejectedError, NfseUnavailableError } from '@/modules/nfse/errors';
import { NFSE_GATEWAY } from '@/modules/nfse/nfse-gateway';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';

const userId = 'user-1';
const company = { id: 'c1', userId, cnpj: '12345678000199', inscricaoMunicipal: null, codigoMunicipio: '3550308' };
const certificate = { certPem: 'CERT', keyPem: 'KEY', notBefore: new Date(0), notAfter: new Date(9e12), subjectCn: 'X' };
const dto = { tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 150, codigoTributacao: '01.01.01' };
const pendingRow = {
  id: 'i1', companyId: 'c1', status: 'PENDING', dpsNumero: 4, dpsSerie: '1',
  tomadorDocumento: '12345678909', tomadorNome: 'Cliente', tomadorEmail: null,
  descricao: 'Serviço', valor: '150.00', codigoTributacao: '01.01.01',
  chaveAcesso: null, numeroNfse: null, xmlDps: null, xmlNfse: null, rejectionReason: null,
  cancelledAt: null, cancelReason: null, createdAt: new Date(), updatedAt: new Date(),
};
const emitResult = { chaveAcesso: '1'.repeat(50), numeroNfse: '4', xmlDps: '<DPS/>', xmlNfse: '<NFSe/>' };

describe('InvoicesService', () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let gateway: { emit: ReturnType<typeof mock>; cancel: ReturnType<typeof mock>; pdf: ReturnType<typeof mock> };
  let companies: { getCompanyWithCertificate: ReturnType<typeof mock>; findMine: ReturnType<typeof mock> };

  beforeEach(async () => {
    prisma = createPrismaMock();
    gateway = { emit: mock(), cancel: mock(), pdf: mock() };
    companies = {
      getCompanyWithCertificate: mock(async () => ({ company, certificate })),
      findMine: mock(async () => ({ id: 'c1' })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CompaniesService, useValue: companies },
        { provide: NFSE_GATEWAY, useValue: gateway },
        { provide: ConfigService, useValue: { get: () => 'fake' } },
      ],
    }).compile();
    service = moduleRef.get(InvoicesService);
  });

  describe('emit', () => {
    beforeEach(() => {
      prisma.invoice.aggregate.mockResolvedValue({ _max: { dpsNumero: 3 } });
      prisma.invoice.create.mockResolvedValue(pendingRow);
    });

    it('creates a PENDING row with the next dpsNumero, calls the gateway and marks it ISSUED', async () => {
      gateway.emit.mockResolvedValue(emitResult);
      prisma.invoice.update.mockResolvedValue({ ...pendingRow, status: 'ISSUED', ...emitResult });

      const result = await service.emit(userId, dto);

      expect(prisma.invoice.create.mock.calls[0][0].data).toMatchObject({ companyId: 'c1', dpsSerie: '1', dpsNumero: 4, valor: '150.00', status: 'PENDING' });
      const [dps, cert] = gateway.emit.mock.calls[0];
      expect(dps).toMatchObject({ ambiente: 'homologacao', serie: '1', numero: 4, prestador: { cnpj: '12345678000199', codigoMunicipio: '3550308' }, servico: { valor: '150.00', codigoTributacao: '01.01.01' } });
      expect(cert).toBe(certificate);
      expect(prisma.invoice.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'ISSUED', ...emitResult } });
      expect(result.status).toBe('ISSUED');
      expect(result.chaveAcesso).toBe(emitResult.chaveAcesso);
      expect(result).not.toHaveProperty('xmlDps');
      expect(result).not.toHaveProperty('xmlNfse');
    });

    it('starts at dpsNumero 1 when the company has no invoices', async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _max: { dpsNumero: null } });
      gateway.emit.mockResolvedValue(emitResult);
      prisma.invoice.update.mockResolvedValue({ ...pendingRow, status: 'ISSUED' });
      await service.emit(userId, dto);
      expect(prisma.invoice.create.mock.calls[0][0].data.dpsNumero).toBe(1);
    });

    it('propagates 422 from CompaniesService when there is no usable certificate', async () => {
      companies.getCompanyWithCertificate.mockRejectedValue(new UnprocessableEntityException('no cert'));
      await expect(service.emit(userId, dto)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it('marks the row REJECTED and throws 422 when the API rejects the DPS', async () => {
      gateway.emit.mockRejectedValue(new NfseRejectedError('E123', 'Tomador inválido'));
      prisma.invoice.update.mockResolvedValue({ ...pendingRow, status: 'REJECTED' });
      await expect(service.emit(userId, dto)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.invoice.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'REJECTED', rejectionReason: 'E123: Tomador inválido' } });
    });

    it('keeps the row PENDING and throws 502 when the API is unavailable', async () => {
      gateway.emit.mockRejectedValue(new NfseUnavailableError());
      await expect(service.emit(userId, dto)).rejects.toBeInstanceOf(BadGatewayException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('lists only the company invoices, paginated and filtered by status', async () => {
      prisma.invoice.findMany.mockResolvedValue([pendingRow]);
      prisma.invoice.count.mockResolvedValue(1);
      const result = await service.findAll(userId, { status: 'PENDING', page: 2, limit: 10 });
      expect(prisma.invoice.findMany).toHaveBeenCalledWith({ where: { companyId: 'c1', status: 'PENDING' }, orderBy: { createdAt: 'desc' }, skip: 10, take: 10 });
      expect(result).toEqual({ data: [expect.objectContaining({ id: 'i1', valor: '150.00' })], page: 2, limit: 10, total: 1 });
    });
  });

  describe('findOne / getXml', () => {
    it('returns the invoice scoped to the company', async () => {
      prisma.invoice.findFirst.mockResolvedValue(pendingRow);
      const result = await service.findOne(userId, 'i1');
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith({ where: { id: 'i1', companyId: 'c1' } });
      expect(result.id).toBe('i1');
    });

    it('throws 404 when the invoice belongs to another company', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      await expect(service.findOne(userId, 'other')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the NFS-e XML and 404s when there is none', async () => {
      prisma.invoice.findFirst.mockResolvedValueOnce({ ...pendingRow, status: 'ISSUED', xmlNfse: '<NFSe/>' });
      await expect(service.getXml(userId, 'i1')).resolves.toBe('<NFSe/>');
      prisma.invoice.findFirst.mockResolvedValueOnce(pendingRow);
      await expect(service.getXml(userId, 'i1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
