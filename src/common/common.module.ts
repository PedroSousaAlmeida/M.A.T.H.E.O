import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { PinoLoggerService } from './logger/pino-logger.service';

@Global()
@Module({
  providers: [
    {
      provide: PinoLoggerService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new PinoLoggerService({
          level: config.get('LOG_LEVEL', { infer: true }),
          pretty: config.get('LOG_PRETTY', { infer: true }) ?? config.get('NODE_ENV', { infer: true }) === 'development',
        }),
    },
  ],
  exports: [PinoLoggerService],
})
export class CommonModule {}
