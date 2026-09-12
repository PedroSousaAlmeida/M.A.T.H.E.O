import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import type { Env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v0');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
