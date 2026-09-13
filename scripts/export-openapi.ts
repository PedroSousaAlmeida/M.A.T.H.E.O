/**
 * Writes the OpenAPI document to docs/openapi.json without starting the HTTP server or touching the database.
 * Usage: bun run openapi:export      (CI fails if the committed file is stale)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { AppModule } from '../src/app.module';
import { buildOpenApiConfig, configureApp } from '../src/app.setup';

// Env validation requires these; placeholders are fine because nothing connects.
const placeholders: Record<string, string> = {
  DATABASE_URL: 'postgresql://openapi:openapi@localhost:5432/openapi',
  LOGTO_ENDPOINT: 'http://localhost:3001',
  LOGTO_API_RESOURCE: 'https://api.matheo.local',
  CERT_ENCRYPTION_KEY: '00'.repeat(32),
  NFSE_ENV: 'fake',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
};
for (const [key, value] of Object.entries(placeholders)) process.env[key] ??= value;

const OUTPUT = 'docs/openapi.json';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  writeFileSync(OUTPUT, JSON.stringify(document, null, 2) + '\n');
  console.log(`wrote ${OUTPUT} (version ${document.info.version}, ${Object.keys(document.paths).length} paths)`);
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
