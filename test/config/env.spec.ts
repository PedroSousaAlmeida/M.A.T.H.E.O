import { describe, expect, it } from 'bun:test';
import { validateEnv } from '@/config/env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  LOGTO_ENDPOINT: 'http://localhost:3001',
  LOGTO_API_RESOURCE: 'https://api.matheo.local',
  CERT_ENCRYPTION_KEY: 'a'.repeat(64),
  NFSE_ENV: 'fake',
};

describe('validateEnv', () => {
  it('accepts a valid fake-env config and applies defaults', () => {
    const env = validateEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NFSE_ENV).toBe('fake');
  });

  it('rejects a CERT_ENCRYPTION_KEY that is not 32 bytes hex', () => {
    expect(() => validateEnv({ ...valid, CERT_ENCRYPTION_KEY: 'abc' })).toThrow(/CERT_ENCRYPTION_KEY/);
  });

  it('requires NFSE_SEFIN_URL and NFSE_ADN_URL when NFSE_ENV is not fake', () => {
    expect(() => validateEnv({ ...valid, NFSE_ENV: 'producao-restrita' })).toThrow(/NFSE_SEFIN_URL/);
  });

  it('parses CORS_ORIGINS as a trimmed list with a localhost default', () => {
    expect(validateEnv(valid).CORS_ORIGINS).toEqual(['http://localhost:5173']);
    expect(validateEnv({ ...valid, CORS_ORIGINS: ' https://app.matheo.com.br, http://localhost:3000 ,' }).CORS_ORIGINS).toEqual([
      'https://app.matheo.com.br',
      'http://localhost:3000',
    ]);
  });

  it('rejects an unknown NFSE_ENV', () => {
    expect(() => validateEnv({ ...valid, NFSE_ENV: 'staging' })).toThrow(/NFSE_ENV/);
  });

  it('LOGTO_JWKS_URL is optional', () => {
    const env = validateEnv(valid);
    expect(env.LOGTO_JWKS_URL).toBeUndefined();
  });

  it('LOGTO_JWKS_URL is validated as a URL when present', () => {
    const env = validateEnv({ ...valid, LOGTO_JWKS_URL: 'http://logto:3001/oidc/jwks' });
    expect(env.LOGTO_JWKS_URL).toBe('http://logto:3001/oidc/jwks');
    expect(() => validateEnv({ ...valid, LOGTO_JWKS_URL: 'not-a-url' })).toThrow(/LOGTO_JWKS_URL/);
  });
});
