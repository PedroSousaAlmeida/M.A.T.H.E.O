import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../../config/env';

export const JWKS = Symbol('JWKS');

export const jwksProvider: Provider<JWTVerifyGetKey> = {
  provide: JWKS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    createRemoteJWKSet(new URL(`${config.get('LOGTO_ENDPOINT', { infer: true })}/oidc/jwks`)),
};
