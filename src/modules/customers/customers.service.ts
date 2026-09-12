import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Customer } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CompaniesService } from '../companies/companies.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

export interface CustomerResponse {
  id: string;
  documento: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
  ) {}

  async create(userId: string, dto: CreateCustomerDto): Promise<CustomerResponse> {
    const { id: companyId } = await this.companies.findMine(userId);
    try {
      return this.toResponse(await this.prisma.customer.create({ data: { ...dto, companyId } }));
    } catch (error) {
      throw this.mapUniqueViolation(error);
    }
  }

  async findAll(userId: string, query: ListCustomersDto) {
    const { id: companyId } = await this.companies.findMine(userId);
    const where = {
      companyId,
      ...(query.search
        ? { OR: [{ nome: { contains: query.search, mode: 'insensitive' as const } }, { documento: { startsWith: query.search } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { nome: 'asc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      this.prisma.customer.count({ where }),
    ]);
    return { data: rows.map((row) => this.toResponse(row)), page: query.page, limit: query.limit, total };
  }

  async findOne(userId: string, id: string): Promise<CustomerResponse> {
    return this.toResponse(await this.findEntity(userId, id));
  }

  async update(userId: string, id: string, dto: UpdateCustomerDto): Promise<CustomerResponse> {
    const customer = await this.findEntity(userId, id);
    try {
      return this.toResponse(await this.prisma.customer.update({ where: { id: customer.id }, data: dto }));
    } catch (error) {
      throw this.mapUniqueViolation(error);
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const customer = await this.findEntity(userId, id);
    await this.prisma.customer.delete({ where: { id: customer.id } });
  }

  async findEntity(userId: string, id: string): Promise<Customer> {
    const { id: companyId } = await this.companies.findMine(userId);
    const customer = await this.prisma.customer.findFirst({ where: { id, companyId } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /** Used by invoice emission with `saveCustomer: true`. */
  async findOrCreateByDocumento(
    companyId: string,
    data: { documento: string; nome: string; email?: string | null },
  ): Promise<Customer> {
    const existing = await this.prisma.customer.findUnique({
      where: { companyId_documento: { companyId, documento: data.documento } },
    });
    if (existing) return existing;
    return this.prisma.customer.create({ data: { companyId, documento: data.documento, nome: data.nome, email: data.email } });
  }

  private mapUniqueViolation(error: unknown): unknown {
    if ((error as { code?: string }).code === 'P2002') {
      return new ConflictException('A customer with this documento already exists');
    }
    return error;
  }

  private toResponse(customer: Customer): CustomerResponse {
    return {
      id: customer.id,
      documento: customer.documento,
      nome: customer.nome,
      email: customer.email,
      telefone: customer.telefone,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }
}
