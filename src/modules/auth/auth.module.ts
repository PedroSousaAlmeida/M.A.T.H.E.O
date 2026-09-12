import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { jwksProvider } from './jwks.provider';

@Module({
  providers: [jwksProvider, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [jwksProvider],
})
export class AuthModule {}
