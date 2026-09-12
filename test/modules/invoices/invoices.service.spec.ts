import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { BadGatewayException, BadRequestException, ConflictException, HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CompaniesService } from '@/modules/companies/companies.service';
import { CustomersService } from '@/modules/customers/customers.service';
import { InvoicesService } from '@/modules/invoices/invoices.service';
import { NfseRejectedError, NfseUnavailableError } from '@/modules/nfse/errors';
import { NFSE_GATEWAY } from '@/modules/nfse/nfse-gateway';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';

const userId = 'user-1';
const company = { id: 'c1', userId, cnpj: '12345678000199', inscricaoMunicipal: null, codigoMunicipio: '3550308' };
const certificate = { certPem: 'CERT', keyPem: 'KEY', chainPem: [], notBefore: new Date(0), notAfter: new Date(9e12), subjectCn: 'X' };
const dto = { tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 150, codigoTributacao: '01.01.01' };
const pendingRow = {
  id: 'i1', companyId: 'c1', customerId: null, status: 'PENDING', dpsNumero: 4, dpsSerie: '1',
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
  let companies: { getCompanyWithCertificate: ReturnType<typeof mock>; findMine: ReturnType<typeof mock>; assertCanEmit: ReturnType<typeof mock> };
  let customers: { findEntity: ReturnType<typeof mock>; findOrCreateByDocumento: ReturnType<typeof mock> };

  beforeEach(async () => {
    prisma = createPrismaMock();
    gateway = { emit: mock(), cancel: mock(), pdf: mock() };
    companies = {
      getCompanyWithCertificate: mock(async () => ({ company, certificate })),
      findMine: mock(async () => ({ id: 'c1' })),
      assertCanEmit: mock(),
    };
    customers = { findEntity: mock(), findOrCreateByDocumento: mock() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CompaniesService, useValue: companies },
        { provide: CustomersService, useValue: customers },
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

    it('maps a dpsNumero unique-constraint race to 409', async () => {
      prisma.invoice.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.emit(userId, dto)).rejects.toBeInstanceOf(ConflictException);
      expect(gateway.emit).not.toHaveBeenCalled();
    });

    it('retries the ISSUED update once and still returns ISSUED when the retry succeeds', async () => {
      gateway.emit.mockResolvedValue(emitResult);
      prisma.invoice.update.mockRejectedValueOnce(new Error('connection reset'));
      prisma.invoice.update.mockResolvedValueOnce({ ...pendingRow, status: 'ISSUED', ...emitResult });

      const result = await service.emit(userId, dto);

      expect(result.status).toBe('ISSUED');
      expect(prisma.invoice.update).toHaveBeenCalledTimes(2);
      expect(gateway.emit).toHaveBeenCalledTimes(1);
    });

    it('rethrows the original error when the ISSUED update fails twice, without calling the gateway again', async () => {
      gateway.emit.mockResolvedValue(emitResult);
      const persistError = new Error('db is down');
      prisma.invoice.update.mockRejectedValue(persistError);

      await expect(service.emit(userId, dto)).rejects.toBe(persistError);
      expect(prisma.invoice.update).toHaveBeenCalledTimes(2);
      expect(gateway.emit).toHaveBeenCalledTimes(1);
    });

    it('blocks emission with 402 when the trial expired and creates nothing', async () => {
      companies.assertCanEmit.mockImplementation(() => { throw new HttpException({ message: 'Trial expired' }, 402); });
      await expect(service.emit(userId, dto)).rejects.toBeInstanceOf(HttpException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(gateway.emit).not.toHaveBeenCalled();
    });

    it('emits by customerId, copying the customer data and storing customerId', async () => {
      customers.findEntity.mockResolvedValue({ id: 'cu1', companyId: 'c1', documento: '98765432000100', nome: 'Empresa Cliente', email: 'e@x.com' });
      prisma.invoice.create.mockImplementation(async ({ data }: any) => ({ ...pendingRow, ...data }));
      gateway.emit.mockResolvedValue(emitResult);
      prisma.invoice.update.mockImplementation(async ({ data }: any) => ({ ...pendingRow, ...data }));

      await service.emit(userId, { customerId: 'cu1', descricao: 'Serviço', valor: 10, codigoTributacao: '01.01.01' });

      expect(customers.findEntity).toHaveBeenCalledWith(userId, 'cu1');
      expect(prisma.invoice.create.mock.calls[0][0].data).toMatchObject({
        customerId: 'cu1', tomadorDocumento: '98765432000100', tomadorNome: 'Empresa Cliente', tomadorEmail: 'e@x.com',
      });
      expect(gateway.emit.mock.calls[0][0].tomador).toEqual({ documento: '98765432000100', nome: 'Empresa Cliente', email: 'e@x.com' });
    });

    it('propagates 404 when the customer belongs to another company', async () => {
      customers.findEntity.mockRejectedValue(new NotFoundException());
      await expect(service.emit(userId, { customerId: 'x', descricao: 'S', valor: 1, codigoTributacao: '01.01.01' })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it('saveCustomer creates (or reuses) the customer and stores its id', async () => {
      customers.findOrCreateByDocumento.mockResolvedValue({ id: 'cu9', documento: '12345678909', nome: 'Cliente', email: null });
      gateway.emit.mockResolvedValue(emitResult);
      prisma.invoice.update.mockResolvedValue({ ...pendingRow, status: 'ISSUED', customerId: 'cu9' });

      await service.emit(userId, { ...dto, saveCustomer: true });

      expect(customers.findOrCreateByDocumento).toHaveBeenCalledWith('c1', { documento: '12345678909', nome: 'Cliente', email: null });
      expect(prisma.invoice.create.mock.calls[0][0].data.customerId).toBe('cu9');
    });

    it('rejects a body with neither customerId nor tomador*, or with both', async () => {
      await expect(service.emit(userId, { descricao: 'S', valor: 1, codigoTributacao: '01.01.01' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.emit(userId, { ...dto, customerId: 'cu1' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.emit(userId, { customerId: 'cu1', saveCustomer: true, descricao: 'S', valor: 1, codigoTributacao: '01.01.01' })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it('rejects customerId combined with only tomadorEmail', async () => {
      await expect(
        service.emit(userId, { customerId: 'cu1', tomadorEmail: 'x@y.com', descricao: 'S', valor: 1, codigoTributacao: '01.01.01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
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

  describe('cancel', () => {
    const issuedRow = { ...pendingRow, status: 'ISSUED', chaveAcesso: '1'.repeat(50), numeroNfse: '4', xmlNfse: '<NFSe/>' };

    it('sends the cancel event and marks the invoice CANCELLED', async () => {
      prisma.invoice.findFirst.mockResolvedValue(issuedRow);
      gateway.cancel.mockResolvedValue(undefined);
      prisma.invoice.update.mockImplementation(async ({ data }: any) => ({ ...issuedRow, ...data }));

      const result = await service.cancel(userId, 'i1', 'Erro de digitação');

      const [chave, motivo, dpsCtx, cert] = gateway.cancel.mock.calls[0];
      expect(chave).toBe(issuedRow.chaveAcesso);
      expect(motivo).toBe('Erro de digitação');
      expect(dpsCtx).toMatchObject({ ambiente: 'homologacao', prestador: { cnpj: '12345678000199' } });
      expect(cert).toBe(certificate);
      expect(prisma.invoice.update.mock.calls[0][0].data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Erro de digitação' });
      expect(result.status).toBe('CANCELLED');
    });

    it('throws 409 when the invoice is not ISSUED', async () => {
      prisma.invoice.findFirst.mockResolvedValue(pendingRow);
      await expect(service.cancel(userId, 'i1', 'x')).rejects.toBeInstanceOf(ConflictException);
      expect(gateway.cancel).not.toHaveBeenCalled();
    });

    it('throws 422 when the API rejects the cancellation and keeps the invoice ISSUED', async () => {
      prisma.invoice.findFirst.mockResolvedValue(issuedRow);
      gateway.cancel.mockRejectedValue(new NfseRejectedError('E200', 'Prazo expirado'));
      await expect(service.cancel(userId, 'i1', 'x')).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it('throws 502 when the API is unavailable', async () => {
      prisma.invoice.findFirst.mockResolvedValue(issuedRow);
      gateway.cancel.mockRejectedValue(new NfseUnavailableError());
      await expect(service.cancel(userId, 'i1', 'x')).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('retries the CANCELLED update once and still returns CANCELLED when the retry succeeds', async () => {
      prisma.invoice.findFirst.mockResolvedValue(issuedRow);
      gateway.cancel.mockResolvedValue(undefined);
      prisma.invoice.update.mockRejectedValueOnce(new Error('connection reset'));
      prisma.invoice.update.mockImplementationOnce(async ({ data }: any) => ({ ...issuedRow, ...data }));

      const result = await service.cancel(userId, 'i1', 'x');

      expect(result.status).toBe('CANCELLED');
      expect(prisma.invoice.update).toHaveBeenCalledTimes(2);
      expect(gateway.cancel).toHaveBeenCalledTimes(1);
    });

    it('rethrows the original error when the CANCELLED update fails twice, without calling the gateway again', async () => {
      prisma.invoice.findFirst.mockResolvedValue(issuedRow);
      gateway.cancel.mockResolvedValue(undefined);
      const persistError = new Error('db is down');
      prisma.invoice.update.mockRejectedValue(persistError);

      await expect(service.cancel(userId, 'i1', 'x')).rejects.toBe(persistError);
      expect(prisma.invoice.update).toHaveBeenCalledTimes(2);
      expect(gateway.cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPdf', () => {
    it('proxies the DANFSe from the gateway', async () => {
      prisma.invoice.findFirst.mockResolvedValue({ ...pendingRow, status: 'ISSUED', chaveAcesso: '1'.repeat(50) });
      gateway.pdf.mockResolvedValue(Buffer.from('%PDF'));
      const pdf = await service.getPdf(userId, 'i1');
      expect(gateway.pdf).toHaveBeenCalledWith('1'.repeat(50), certificate);
      expect(pdf.toString()).toBe('%PDF');
    });

    it('throws 404 when the invoice has no chaveAcesso', async () => {
      prisma.invoice.findFirst.mockResolvedValue(pendingRow);
      await expect(service.getPdf(userId, 'i1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws 502 when the API is unavailable', async () => {
      prisma.invoice.findFirst.mockResolvedValue({ ...pendingRow, status: 'ISSUED', chaveAcesso: '1'.repeat(50) });
      gateway.pdf.mockRejectedValue(new NfseUnavailableError());
      await expect(service.getPdf(userId, 'i1')).rejects.toBeInstanceOf(BadGatewayException);
    });
  });
});
