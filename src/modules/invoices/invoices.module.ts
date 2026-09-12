import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { NfseModule } from '../nfse/nfse.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  imports: [CompaniesModule, NfseModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
})
export class InvoicesModule {}
