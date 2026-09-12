import { beforeAll, describe, expect, it } from 'bun:test';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard';
import { IS_PUBLIC_KEY } from '@/modules/auth/public.decorator';

const ISSUER = 'http://localhost:3001/oidc';
const AUDIENCE = 'https://api.matheo.local';

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPrivateKey: CryptoKey;

function contextFor(authorization?: string): { ctx: ExecutionContext; request: any } {
  const request: any = { headers: authorization ? { authorization } : {} };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
  return { ctx, request };
}

function buildGuard(isPublic = false) {
  const config = {
    get: (key: string) => (key === 'LOGTO_ENDPOINT' ? 'http://localhost:3001' : AUDIENCE),
  } as unknown as ConfigService<any, true>;
  const reflector = { getAllAndOverride: (key: string) => (key === IS_PUBLIC_KEY ? isPublic : undefined) } as unknown as Reflector;
  return new JwtAuthGuard(config, reflector, async () => publicKey);
}

async function token(overrides: { issuer?: string; audience?: string; key?: CryptoKey; exp?: string; sub?: string } = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES384' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.sub ?? 'user-123')
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? '1h')
    .sign(overrides.key ?? privateKey);
}

describe('JwtAuthGuard', () => {
  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair('ES384'));
    ({ privateKey: otherPrivateKey } = await generateKeyPair('ES384'));
  });

  it('accepts a valid token and sets request.user.id from sub', async () => {
    const { ctx, request } = contextFor(`Bearer ${await token()}`);
    await expect(buildGuard().canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'user-123' });
  });

  it('rejects a missing Authorization header', async () => {
    const { ctx } = contextFor(undefined);
    await expect(buildGuard().canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token signed by another key', async () => {
    const { ctx } = contextFor(`Bearer ${await token({ key: otherPrivateKey })}`);
    await expect(buildGuard().canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an expired token', async () => {
    const { ctx } = contextFor(`Bearer ${await token({ exp: '-10s' })}`);
    await expect(buildGuard().canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects wrong issuer and wrong audience', async () => {
    const a = contextFor(`Bearer ${await token({ issuer: 'http://evil/oidc' })}`);
    const b = contextFor(`Bearer ${await token({ audience: 'https://other' })}`);
    await expect(buildGuard().canActivate(a.ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(buildGuard().canActivate(b.ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lets @Public() routes through without a token', async () => {
    const { ctx } = contextFor(undefined);
    await expect(buildGuard(true).canActivate(ctx)).resolves.toBe(true);
  });
});
