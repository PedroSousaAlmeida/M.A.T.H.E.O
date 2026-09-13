import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AllowExpiredTrial } from '../companies/allow-expired-trial.decorator';
import { CompaniesService } from '../companies/companies.service';
import { AuditService } from './audit.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@Controller('audit-logs')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly companies: CompaniesService,
  ) {}

  @Get()
  @AllowExpiredTrial()
  async findAll(@CurrentUser() user: AuthUser, @Query() query: ListAuditLogsDto) {
    const { id: companyId } = await this.companies.findMine(user.id);
    return this.audit.findAll(companyId, query);
  }
}
