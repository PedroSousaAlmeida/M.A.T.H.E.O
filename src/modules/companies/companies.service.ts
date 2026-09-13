import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Company, Plan } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { loadCertificate, type LoadedCertificate } from '../nfse/certificate';
import { CertificateVault } from '../nfse/crypto/certificate-vault';
import { InvalidCertificateError } from '../nfse/errors';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

export const TRIAL_DAYS = 30;

export interface CompanyResponse {
  id: string;
  cnpj: string;
  razaoSocial: string;
  inscricaoMunicipal: string | null;
  codigoMunicipio: string;
  email: string | null;
  telefone: string | null;
  hasCertificate: boolean;
  certificateExpiry: Date | null;
  plan: Plan;
  trialEndsAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CertificateVault,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, dto: CreateCompanyDto): Promise<CompanyResponse> {
    const existing = await this.prisma.company.findUnique({ where: { userId } });
    if (existing) throw new ConflictException('User already has a company');

    try {
      const company = await this.prisma.company.create({ data: { ...dto, userId, plan: 'TRIAL', trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 3600 * 1000) } });
      await this.audit.record({
        action: 'company.created',
        companyId: company.id,
        entityType: 'company',
        entityId: company.id,
        statusCode: 201,
        metadata: { cnpj: company.cnpj },
      });
      return this.toResponse(company);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('CNPJ already registered');
      }
      throw error;
    }
  }

  async findMine(userId: string): Promise<CompanyResponse> {
    return this.toResponse(await this.findEntity(userId));
  }

  async update(userId: string, dto: UpdateCompanyDto): Promise<CompanyResponse> {
    const company = await this.findEntity(userId);
    const updated = await this.prisma.company.update({ where: { id: company.id }, data: dto });
    await this.audit.record({
      action: 'company.updated',
      companyId: company.id,
      entityType: 'company',
      entityId: company.id,
      statusCode: 200,
      metadata: { fields: Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined) },
    });
    return this.toResponse(updated);
  }

  async setCertificate(userId: string, pfx: Buffer, password: string): Promise<CompanyResponse> {
    const company = await this.findEntity(userId);

    let loaded: LoadedCertificate;
    try {
      loaded = loadCertificate(pfx, password);
    } catch (error) {
      if (error instanceof InvalidCertificateError) throw new UnprocessableEntityException(error.message);
      throw error;
    }

    const updated = await this.prisma.company.update({
      where: { id: company.id },
      data: {
        // Prisma 7's generated `Bytes` type wants Uint8Array<ArrayBuffer>; Buffer's
        // backing store is typed as ArrayBufferLike (SharedArrayBuffer included),
        // which is structurally incompatible. Buffer is always ArrayBuffer-backed
        // at runtime, and the test asserts Buffer.isBuffer(...) on this value, so
        // we cast rather than rewrap into a plain Uint8Array (which would lose
        // Buffer-ness).
        certificatePfx: this.vault.encrypt(pfx) as unknown as Uint8Array<ArrayBuffer>,
        certificatePass: this.vault.encryptString(password),
        certificateExpiry: loaded.notAfter,
      },
    });
    await this.audit.record({
      action: 'certificate.uploaded',
      companyId: company.id,
      entityType: 'company',
      entityId: company.id,
      statusCode: 200,
      metadata: { certificateExpiry: loaded.notAfter, subjectCn: loaded.subjectCn },
    });
    return this.toResponse(updated);
  }

  async getCompanyWithCertificate(userId: string): Promise<{ company: Company; certificate: LoadedCertificate }> {
    const company = await this.findEntity(userId);
    if (!company.certificatePfx || !company.certificatePass) {
      throw new UnprocessableEntityException('Company has no certificate');
    }
    if (company.certificateExpiry && company.certificateExpiry.getTime() < Date.now()) {
      throw new UnprocessableEntityException('Company certificate is expired');
    }
    const pfx = this.vault.decrypt(Buffer.from(company.certificatePfx));
    const password = this.vault.decryptString(company.certificatePass);
    return { company, certificate: loadCertificate(pfx, password) };
  }

  /** Emission is the only feature gated by the trial. */
  isTrialExpired(company: Pick<Company, 'plan' | 'trialEndsAt'>): boolean {
    return company.plan === 'TRIAL' && company.trialEndsAt.getTime() < Date.now();
  }

  async findByUserId(userId: string): Promise<Company | null> {
    return this.prisma.company.findUnique({ where: { userId } });
  }

  private async findEntity(userId: string): Promise<Company> {
    const company = await this.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private toResponse(company: Company): CompanyResponse {
    return {
      id: company.id,
      cnpj: company.cnpj,
      razaoSocial: company.razaoSocial,
      inscricaoMunicipal: company.inscricaoMunicipal,
      codigoMunicipio: company.codigoMunicipio,
      email: company.email,
      telefone: company.telefone,
      hasCertificate: Boolean(company.certificatePfx),
      certificateExpiry: company.certificateExpiry,
      plan: company.plan,
      trialEndsAt: company.trialEndsAt,
      createdAt: company.createdAt,
      updatedAt: company.updatedAt,
    };
  }
}
