import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { CompaniesModule } from './modules/companies/companies.module';
import { CustomersModule } from './modules/customers/customers.module';
import { HealthController } from './modules/health/health.controller';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PrismaModule,
    AuthModule,
    CompaniesModule,
    CustomersModule,
    InvoicesModule,
  ],
  controllers: [HealthController],
  providers: [
    // throttle first so unauthenticated floods are rate-limited before JWKS work
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
