import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { HttpExceptionFilter } from '@/common/http-exception.filter';
import { JWKS } from '@/modules/auth/jwks.provider';
import { PrismaService } from '@/prisma/prisma.service';
import { createTestPfx } from './helpers/test-certificate';

const E2E_DB = process.env.E2E_DATABASE_URL;
const LOGTO_ENDPOINT = 'http://localhost:3001';
const API_RESOURCE = 'https://api.matheo.local';

describe.skipIf(!E2E_DB)('API e2e (fake gateway, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  const cnpj = String(Date.now()).padStart(14, '0').slice(-14);

  const tokenFor = (sub: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES384' })
      .setIssuer(`${LOGTO_ENDPOINT}/oidc`)
      .setAudience(API_RESOURCE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

  beforeAll(async () => {
    process.env.DATABASE_URL = E2E_DB;
    process.env.LOGTO_ENDPOINT = LOGTO_ENDPOINT;
    process.env.LOGTO_API_RESOURCE = API_RESOURCE;
    process.env.CERT_ENCRYPTION_KEY = process.env.CERT_ENCRYPTION_KEY ?? 'ab'.repeat(32);
    process.env.NFSE_ENV = 'fake';
    ({ privateKey, publicKey } = await generateKeyPair('ES384'));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(async () => publicKey)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v0');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { company: { cnpj } } });
    await prisma.company.deleteMany({ where: { cnpj } });
    await app.close();
  });

  it('GET /api/v0/health returns ok without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v0/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('rejects requests without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v0/companies/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ statusCode: 401, message: 'Missing bearer token' });
  });

  it('happy path: create company → upload certificate → emit → list → xml → cancel', async () => {
    const userId = `e2e-${Date.now()}`;
    const auth = { Authorization: `Bearer ${await tokenFor(userId)}` };
    const server = app.getHttpServer();

    const created = await request(server).post('/api/v0/companies').set(auth).send({ cnpj, razaoSocial: 'E2E LTDA', codigoMunicipio: '3550308' });
    expect(created.status).toBe(201);
    expect(created.body.hasCertificate).toBe(false);

    const noCert = await request(server).post('/api/v0/invoices').set(auth).send({ tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 100, codigoTributacao: '01.01.01' });
    expect(noCert.status).toBe(422);

    const { pfx, password } = createTestPfx();
    const uploaded = await request(server).put('/api/v0/companies/me/certificate').set(auth).field('password', password).attach('file', pfx, 'cert.pfx');
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.hasCertificate).toBe(true);
    expect(uploaded.body).not.toHaveProperty('certificatePfx');

    const emitted = await request(server).post('/api/v0/invoices').set(auth).send({ tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 100, codigoTributacao: '01.01.01' });
    expect(emitted.status).toBe(201);
    expect(emitted.body.status).toBe('ISSUED');
    expect(emitted.body.dpsNumero).toBe(1);
    expect(emitted.body.chaveAcesso).toMatch(/^\d{50}$/);
    const id = emitted.body.id;

    const list = await request(server).get('/api/v0/invoices?status=ISSUED').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].id).toBe(id);

    const xml = await request(server).get(`/api/v0/invoices/${id}/xml`).set(auth);
    expect(xml.status).toBe(200);
    expect(xml.headers['content-type']).toContain('application/xml');
    expect(xml.text).toContain('<NFSe');

    const pdf = await request(server).get(`/api/v0/invoices/${id}/pdf`).set(auth).buffer().parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');

    const cancelled = await request(server).post(`/api/v0/invoices/${id}/cancel`).set(auth).send({ motivo: 'Erro de digitação no valor' });
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.status).toBe('CANCELLED');

    const other = await request(server).get(`/api/v0/invoices/${id}`).set({ Authorization: `Bearer ${await tokenFor('someone-else')}` });
    expect(other.status).toBe(404);
  });
});
