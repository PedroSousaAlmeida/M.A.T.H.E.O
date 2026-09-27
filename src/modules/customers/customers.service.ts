import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Customer } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
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
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, dto: CreateCustomerDto): Promise<CustomerResponse> {
    const { id: companyId } = await this.companies.findMine(userId);
    try {
      const created = await this.prisma.customer.create({ data: { ...dto, companyId } });
      await this.audit.record({
        action: 'customer.created',
        companyId,
        entityType: 'customer',
        entityId: created.id,
        statusCode: 201,
        metadata: { documento: created.documento },
      });
      return this.toResponse(created);
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
      const updated = await this.prisma.customer.update({ where: { id: customer.id }, data: dto });
      await this.audit.record({
        action: 'customer.updated',
        companyId: customer.companyId,
        entityType: 'customer',
        entityId: customer.id,
        statusCode: 200,
        metadata: { documento: updated.documento, fields: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined) },
      });
      return this.toResponse(updated);
    } catch (error) {
      throw this.mapUniqueViolation(error);
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const customer = await this.findEntity(userId, id);
    await this.prisma.customer.delete({ where: { id: customer.id } });
    await this.audit.record({
      action: 'customer.deleted',
      companyId: customer.companyId,
      entityType: 'customer',
      entityId: customer.id,
      statusCode: 204,
      metadata: { documento: customer.documento },
    });
  }

  async findEntity(userId: string, id: string): Promise<Customer> {
    const { id: companyId } = await this.companies.findMine(userId);
    const customer = await this.prisma.customer.findFirst({ where: { id, companyId } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /** Used by invoice emission with `saveCustomer: true`. Upsert avoids a P2002 race between concurrent emissions. */
  async findOrCreateByDocumento(
    companyId: string,
    data: { documento: string; nome: string; email?: string | null },
  ): Promise<Customer> {
    return this.prisma.customer.upsert({
      where: { companyId_documento: { companyId, documento: data.documento } },
      create: { companyId, documento: data.documento, nome: data.nome, email: data.email },
      update: {},
    });
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
