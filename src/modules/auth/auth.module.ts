import { Module } from '@nestjs/common';
import { jwksProvider } from './jwks.provider';

@Module({
  providers: [jwksProvider],
  exports: [jwksProvider],
})
export class AuthModule {}
