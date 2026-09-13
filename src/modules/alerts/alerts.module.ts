import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

@Module({
  imports: [CompaniesModule, InvoicesModule],
  controllers: [AlertsController],
  providers: [AlertsService],
})
export class AlertsModule {}
