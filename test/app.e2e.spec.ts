import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import request from 'supertest';
import { configureApp } from '@/app.setup';
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
  let companyId: string | undefined;
  const cnpj = '11222333000181';

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

    // Imported lazily: loading AppModule evaluates ConfigModule.forRoot({ validate }) immediately,
    // which must only happen after the env above is set (and never when the suite is skipped).
    const { AppModule } = await import('@/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWKS)
      .useValue(async () => publicKey)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // A previous run may have left rows behind (e.g. a crash before afterAll ran).
    await cleanupCompanyRows();
  });

  afterAll(async () => {
    await cleanupCompanyRows();
    await app.close();
  });

  async function cleanupCompanyRows() {
    const stale = await prisma.company.findUnique({ where: { cnpj } });
    const id = companyId ?? stale?.id;
    if (id) await prisma.auditLog.deleteMany({ where: { companyId: id } });
    await prisma.invoice.deleteMany({ where: { company: { cnpj } } });
    await prisma.customer.deleteMany({ where: { company: { cnpj } } });
    await prisma.company.deleteMany({ where: { cnpj } });
  }

  it('GET /api/v0/health returns ok without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v0/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', apiVersion: 'v0', stage: 'alpha', checks: { database: { status: 'ok' } } });
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
  });

  it('serves the OpenAPI document publicly and answers CORS preflight for the configured origin', async () => {
    const docs = await request(app.getHttpServer()).get('/api/v0/docs-json');
    expect(docs.status).toBe(200);
    expect(docs.body.openapi).toMatch(/^3\./);
    expect(Object.keys(docs.body.paths)).toEqual(expect.arrayContaining(['/api/v0/invoices', '/api/v0/companies/me', '/api/v0/customers', '/api/v0/alerts', '/api/v0/audit-logs']));
    expect(docs.body.components.securitySchemes.logto.scheme).toBe('bearer');

    const preflight = await request(app.getHttpServer())
      .options('/api/v0/invoices')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const cors = await request(app.getHttpServer()).get('/api/v0/health').set('Origin', 'http://localhost:5173');
    expect(cors.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(cors.headers['access-control-expose-headers']).toContain('x-request-id');
  });

  it('rejects requests without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v0/companies/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ statusCode: 401, message: 'Missing bearer token', requestId: expect.any(String) });
    expect(res.headers['x-request-id']).toBe(res.body.requestId);

    const alertsRes = await request(app.getHttpServer()).get('/api/v0/alerts');
    expect(alertsRes.status).toBe(401);
  });

  it('happy path: create company → upload certificate → emit → list → xml → cancel', async () => {
    const userId = `e2e-${Date.now()}`;
    const auth = { Authorization: `Bearer ${await tokenFor(userId)}` };
    const server = app.getHttpServer();

    const invalidCnpj = await request(server).post('/api/v0/companies').set(auth).send({ cnpj: '12345678000199', razaoSocial: 'E2E LTDA', codigoMunicipio: '3550308' });
    expect(invalidCnpj.status).toBe(400);
    expect(invalidCnpj.body.details).toContain('cnpj must be a valid CNPJ');

    const created = await request(server).post('/api/v0/companies').set(auth).send({ cnpj, razaoSocial: 'E2E LTDA', codigoMunicipio: '3550308' });
    expect(created.status).toBe(201);
    expect(created.body.hasCertificate).toBe(false);
    expect(created.body.plan).toBe('TRIAL');
    expect(new Date(created.body.trialEndsAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
    companyId = created.body.id;

    const noCert = await request(server).post('/api/v0/invoices').set(auth).send({ tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 100, codigoTributacao: '01.01.01' });
    expect(noCert.status).toBe(422);

    const { pfx, password } = createTestPfx();
    const uploaded = await request(server).put('/api/v0/companies/me/certificate').set(auth).field('password', password).attach('file', pfx, 'cert.pfx');
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.hasCertificate).toBe(true);
    expect(uploaded.body).not.toHaveProperty('certificatePfx');

    const customer = await request(server).post('/api/v0/customers').set(auth).send({ documento: '11444777000161', nome: 'Empresa Cliente', email: 'fin@cliente.com' });
    expect(customer.status).toBe(201);
    expect(customer.body).not.toHaveProperty('companyId');
    const customerId = customer.body.id;

    const searched = await request(server).get('/api/v0/customers?search=empresa').set(auth);
    expect(searched.status).toBe(200);
    expect(searched.body.total).toBe(1);

    const byCustomer = await request(server).post('/api/v0/invoices').set(auth).send({ customerId, descricao: 'Serviço para cliente salvo', valor: 50, codigoTributacao: '01.01.01' });
    expect(byCustomer.status).toBe(201);
    expect(byCustomer.body).toMatchObject({ status: 'ISSUED', customerId, tomadorDocumento: '11444777000161', tomadorNome: 'Empresa Cliente', dpsNumero: 1 });

    const emitted = await request(server).post('/api/v0/invoices').set(auth).send({ tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 100, codigoTributacao: '01.01.01' });
    expect(emitted.status).toBe(201);
    expect(emitted.body.status).toBe('ISSUED');
    expect(emitted.body.dpsNumero).toBe(2);
    expect(emitted.body.chaveAcesso).toMatch(/^\d{50}$/);
    const id = emitted.body.id;

    const list = await request(server).get('/api/v0/invoices?status=ISSUED').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.data[0].id).toBe(id);

    const summary = await request(server).get('/api/v0/invoices/summary').set(auth);
    expect(summary.status).toBe(200);
    expect(summary.body.byStatus.ISSUED).toBe(2);
    expect(summary.body.month.count).toBe(2);
    expect(summary.body.month.total).toBe('150.00');
    expect(summary.body.year.total).toBe('150.00');
    expect(summary.body.annualLimit).toBe('81000.00');
    expect(typeof summary.body.annualUsagePct).toBe('number');

    const byName = await request(server).get('/api/v0/invoices?search=Empresa%20Cliente').set(auth);
    expect(byName.status).toBe(200);
    expect(byName.body.total).toBe(1);
    expect(byName.body.data[0].tomadorNome).toBe('Empresa Cliente');
    const none = await request(server).get(`/api/v0/invoices?from=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`).set(auth);
    expect(none.body.total).toBe(0);

    const alertsHealthy = await request(server).get('/api/v0/alerts').set(auth);
    expect(alertsHealthy.status).toBe(200);
    expect(alertsHealthy.body.alerts).toEqual([]);

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
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    const other = await request(server).get(`/api/v0/invoices/${id}`).set({ Authorization: `Bearer ${await tokenFor('someone-else')}` });
    expect(other.status).toBe(404);

    await prisma.company.update({ where: { cnpj }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    const expired = await request(server)
      .post('/api/v0/invoices')
      .set(auth)
      .send({ tomadorDocumento: '12345678909', tomadorNome: 'Cliente', descricao: 'Serviço', valor: 100, codigoTributacao: '01.01.01' });
    expect(expired.status).toBe(402);
    expect(expired.body.statusCode).toBe(402);
    expect(expired.body.message).toBe('Trial expired');
    expect(typeof expired.body.details.trialEndsAt).toBe('string');
    expect(new Date(expired.body.details.trialEndsAt).getTime()).not.toBeNaN();

    const blockedCustomer = await request(server)
      .post('/api/v0/customers')
      .set(auth)
      .send({ documento: '11444777000161', nome: 'Outro Cliente' });
    expect(blockedCustomer.status).toBe(402);

    const listAfterExpiry = await request(server).get('/api/v0/invoices').set(auth);
    expect(listAfterExpiry.status).toBe(200);

    const updateAfterExpiry = await request(server).patch('/api/v0/companies/me').set(auth).send({ telefone: '11999998888' });
    expect(updateAfterExpiry.status).toBe(200);

    const alertsExpired = await request(server).get('/api/v0/alerts').set(auth);
    expect(alertsExpired.status).toBe(200);
    expect(alertsExpired.body.alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'TRIAL_EXPIRED', severity: 'critical' })]),
    );

    const cancelAlreadyCancelled = await request(server).post(`/api/v0/invoices/${id}/cancel`).set(auth).send({ motivo: 'Já cancelada, tentando de novo' });
    expect(cancelAlreadyCancelled.status).toBe(409);

    const auditLogs = await request(server).get('/api/v0/audit-logs?action=trial.blocked').set(auth);
    expect(auditLogs.status).toBe(200);
    expect(auditLogs.body.total).toBeGreaterThanOrEqual(2);

    const allAuditLogs = await request(server).get('/api/v0/audit-logs?limit=100').set(auth);
    expect(allAuditLogs.status).toBe(200);
    const actions = allAuditLogs.body.data.map((row: { action: string }) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['company.created', 'certificate.uploaded', 'invoice.emitted', 'invoice.cancelled', 'customer.created']),
    );
  });
});
