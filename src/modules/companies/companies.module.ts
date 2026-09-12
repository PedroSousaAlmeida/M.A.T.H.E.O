import { Module } from '@nestjs/common';
import { NfseModule } from '../nfse/nfse.module';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';

@Module({
  imports: [NfseModule],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
