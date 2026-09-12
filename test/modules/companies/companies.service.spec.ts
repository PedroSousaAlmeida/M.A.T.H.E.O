import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CompaniesService } from '@/modules/companies/companies.service';
import { CertificateVault } from '@/modules/nfse/crypto/certificate-vault';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';
import { createTestPfx } from '../../helpers/test-certificate';

const userId = 'user-1';
const baseCompany = {
  id: 'c1',
  userId,
  cnpj: '12345678000199',
  razaoSocial: 'Empresa Teste',
  inscricaoMunicipal: null,
  codigoMunicipio: '3550308',
  email: null,
  telefone: null,
  certificatePfx: null,
  certificatePass: null,
  certificateExpiry: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const createDto = { cnpj: '12345678000199', razaoSocial: 'Empresa Teste', codigoMunicipio: '3550308' };

describe('CompaniesService', () => {
  let service: CompaniesService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let vault: { encrypt: ReturnType<typeof mock>; decrypt: ReturnType<typeof mock>; encryptString: ReturnType<typeof mock>; decryptString: ReturnType<typeof mock> };

  beforeEach(async () => {
    prisma = createPrismaMock();
    vault = {
      encrypt: mock((b: Buffer) => Buffer.concat([Buffer.from('enc:'), b])),
      decrypt: mock((b: Buffer) => b.subarray(4)),
      encryptString: mock((s: string) => `enc:${s}`),
      decryptString: mock((s: string) => s.slice(4)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [CompaniesService, { provide: PrismaService, useValue: prisma }, { provide: CertificateVault, useValue: vault }],
    }).compile();
    service = moduleRef.get(CompaniesService);
  });

  describe('create', () => {
    it('creates the company for the user', async () => {
      prisma.company.findUnique.mockResolvedValue(null);
      prisma.company.create.mockResolvedValue(baseCompany);
      const result = await service.create(userId, createDto);
      expect(prisma.company.create).toHaveBeenCalledWith({ data: { ...createDto, userId } });
      expect(result.hasCertificate).toBe(false);
      expect(result).not.toHaveProperty('certificatePfx');
    });

    it('throws 409 when the user already has a company', async () => {
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      await expect(service.create(userId, createDto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws 409 when the CNPJ is already registered', async () => {
      prisma.company.findUnique.mockResolvedValue(null);
      prisma.company.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.create(userId, createDto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('findMine', () => {
    it('returns the response shape without secrets', async () => {
      prisma.company.findUnique.mockResolvedValue({ ...baseCompany, certificatePfx: Buffer.from('x'), certificatePass: 'enc:p', certificateExpiry: new Date('2030-01-01') });
      const result = await service.findMine(userId);
      expect(result.hasCertificate).toBe(true);
      expect(result).not.toHaveProperty('certificatePfx');
      expect(result).not.toHaveProperty('certificatePass');
    });

    it('throws 404 when the user has no company', async () => {
      prisma.company.findUnique.mockResolvedValue(null);
      await expect(service.findMine(userId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates only the given fields', async () => {
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      prisma.company.update.mockResolvedValue({ ...baseCompany, razaoSocial: 'Nova' });
      const result = await service.update(userId, { razaoSocial: 'Nova' });
      expect(prisma.company.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { razaoSocial: 'Nova' } });
      expect(result.razaoSocial).toBe('Nova');
    });
  });

  describe('setCertificate', () => {
    it('validates, encrypts and stores the pfx with its expiry', async () => {
      const { pfx, password } = createTestPfx();
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      prisma.company.update.mockImplementation(async ({ data }: any) => ({ ...baseCompany, ...data }));
      const result = await service.setCertificate(userId, pfx, password);
      expect(vault.encrypt).toHaveBeenCalledTimes(1);
      expect(vault.encryptString).toHaveBeenCalledWith(password);
      const data = prisma.company.update.mock.calls[0][0].data;
      expect(Buffer.isBuffer(data.certificatePfx)).toBe(true);
      expect(data.certificatePass).toBe(`enc:${password}`);
      expect(data.certificateExpiry.getTime()).toBeGreaterThan(Date.now());
      expect(result.hasCertificate).toBe(true);
      expect(result).not.toHaveProperty('certificatePfx');
    });

    it('throws 422 on wrong password', async () => {
      const { pfx } = createTestPfx();
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      await expect(service.setCertificate(userId, pfx, 'wrong')).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.company.update).not.toHaveBeenCalled();
    });
  });

  describe('getCompanyWithCertificate', () => {
    it('decrypts and loads the certificate', async () => {
      const { pfx, password } = createTestPfx();
      prisma.company.findUnique.mockResolvedValue({
        ...baseCompany,
        certificatePfx: Buffer.concat([Buffer.from('enc:'), pfx]),
        certificatePass: `enc:${password}`,
        certificateExpiry: new Date(Date.now() + 86400000),
      });
      const { company, certificate } = await service.getCompanyWithCertificate(userId);
      expect(company.id).toBe('c1');
      expect(certificate.certPem).toContain('BEGIN CERTIFICATE');
    });

    it('throws 422 when there is no certificate', async () => {
      prisma.company.findUnique.mockResolvedValue(baseCompany);
      await expect(service.getCompanyWithCertificate(userId)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('throws 422 when the certificate is expired', async () => {
      prisma.company.findUnique.mockResolvedValue({ ...baseCompany, certificatePfx: Buffer.from('x'), certificatePass: 'enc:p', certificateExpiry: new Date('2020-01-01') });
      await expect(service.getCompanyWithCertificate(userId)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });
});
