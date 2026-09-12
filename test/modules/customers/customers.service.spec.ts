import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CompaniesService } from '@/modules/companies/companies.service';
import { CustomersService } from '@/modules/customers/customers.service';
import { PrismaService } from '@/prisma/prisma.service';
import { createPrismaMock } from '../../helpers/prisma-mock';

const userId = 'user-1';
const row = {
  id: 'cu1', companyId: 'c1', documento: '12345678909', nome: 'Cliente Um', email: null, telefone: null,
  createdAt: new Date(), updatedAt: new Date(),
};
const createDto = { documento: '12345678909', nome: 'Cliente Um' };

describe('CustomersService', () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: CompaniesService, useValue: { findMine: mock(async () => ({ id: 'c1' })) } },
      ],
    }).compile();
    service = moduleRef.get(CustomersService);
  });

  it('creates a customer scoped to the company', async () => {
    prisma.customer.create.mockResolvedValue(row);
    const result = await service.create(userId, createDto);
    expect(prisma.customer.create).toHaveBeenCalledWith({ data: { ...createDto, companyId: 'c1' } });
    expect(result).toEqual({ id: 'cu1', documento: '12345678909', nome: 'Cliente Um', email: null, telefone: null, createdAt: row.createdAt, updatedAt: row.updatedAt });
    expect(result).not.toHaveProperty('companyId');
  });

  it('throws 409 when the documento already exists for the company', async () => {
    prisma.customer.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create(userId, createDto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists with search on nome (insensitive) or documento prefix, paginated and ordered by nome', async () => {
    prisma.customer.findMany.mockResolvedValue([row]);
    prisma.customer.count.mockResolvedValue(1);
    const result = await service.findAll(userId, { search: 'cli', page: 2, limit: 10 });
    expect(prisma.customer.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', OR: [{ nome: { contains: 'cli', mode: 'insensitive' } }, { documento: { startsWith: 'cli' } }] },
      orderBy: { nome: 'asc' },
      skip: 10,
      take: 10,
    });
    expect(result).toEqual({ data: [expect.objectContaining({ id: 'cu1' })], page: 2, limit: 10, total: 1 });
  });

  it('lists without a search filter', async () => {
    prisma.customer.findMany.mockResolvedValue([]);
    prisma.customer.count.mockResolvedValue(0);
    await service.findAll(userId, { page: 1, limit: 20 });
    expect(prisma.customer.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1' });
  });

  it('findOne is scoped and 404s for another company', async () => {
    prisma.customer.findFirst.mockResolvedValueOnce(row);
    await expect(service.findOne(userId, 'cu1')).resolves.toMatchObject({ id: 'cu1' });
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({ where: { id: 'cu1', companyId: 'c1' } });
    prisma.customer.findFirst.mockResolvedValueOnce(null);
    await expect(service.findOne(userId, 'other')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates and maps documento collisions to 409', async () => {
    prisma.customer.findFirst.mockResolvedValue(row);
    prisma.customer.update.mockResolvedValueOnce({ ...row, nome: 'Novo' });
    await expect(service.update(userId, 'cu1', { nome: 'Novo' })).resolves.toMatchObject({ nome: 'Novo' });
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'cu1' }, data: { nome: 'Novo' } });
    prisma.customer.update.mockRejectedValueOnce({ code: 'P2002' });
    await expect(service.update(userId, 'cu1', { documento: '98765432000100' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('removes a customer of the company', async () => {
    prisma.customer.findFirst.mockResolvedValue(row);
    prisma.customer.delete.mockResolvedValue(row);
    await expect(service.remove(userId, 'cu1')).resolves.toBeUndefined();
    expect(prisma.customer.delete).toHaveBeenCalledWith({ where: { id: 'cu1' } });
  });

  it('findOrCreateByDocumento reuses an existing customer or creates one', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(row);
    await expect(service.findOrCreateByDocumento('c1', { documento: '12345678909', nome: 'Outro Nome' })).resolves.toBe(row);
    expect(prisma.customer.create).not.toHaveBeenCalled();
    prisma.customer.findUnique.mockResolvedValueOnce(null);
    prisma.customer.create.mockResolvedValueOnce({ ...row, id: 'cu2', documento: '11111111111' });
    await expect(service.findOrCreateByDocumento('c1', { documento: '11111111111', nome: 'Novo', email: 'n@x.com' })).resolves.toMatchObject({ id: 'cu2' });
    expect(prisma.customer.create).toHaveBeenCalledWith({ data: { companyId: 'c1', documento: '11111111111', nome: 'Novo', email: 'n@x.com' } });
  });
});
