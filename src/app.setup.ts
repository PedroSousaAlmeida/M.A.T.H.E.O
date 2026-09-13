import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpExceptionFilter } from './common/http-exception.filter';
import type { Env } from './config/env';
import { REQUEST_ID_HEADER } from './common/request-id.middleware';

export const API_PREFIX = 'api/v0';
export const DOCS_PATH = `${API_PREFIX}/docs`;

/**
 * Everything main.ts and the e2e bootstrap must share: prefix, validation, error format, CORS, OpenAPI.
 * Call before `app.init()`/`app.listen()`.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string; version: string };

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER, 'Content-Disposition'],
    maxAge: 600,
  });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('MATHEO NFS-e API')
      .setDescription(
        'Emissor de NFS-e para MEI. Todas as rotas exigem Bearer token do Logto (audience https://api.matheo.local), exceto /health e esta documentação. ' +
          'Erros seguem { statusCode, message, details?, requestId }. Ver docs/frontend/api-brief.md para fluxos e estados.',
      )
      .setVersion(pkg.version)
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'logto')
      .addTag('health', 'Estado da API')
      .addTag('companies', 'Empresa do usuário e certificado A1')
      .addTag('customers', 'Tomadores salvos')
      .addTag('invoices', 'Emissão, consulta e cancelamento de NFS-e')
      .addTag('alerts', 'Avisos para o dashboard')
      .addTag('audit', 'Extrato de ações da empresa')
      .build(),
  );
  // Swagger UI + JSON are served by express directly (not Nest handlers), so the global guards do not apply.
  SwaggerModule.setup(DOCS_PATH, app, document, { jsonDocumentUrl: `${DOCS_PATH}-json`, customSiteTitle: 'MATHEO API docs' });
}
