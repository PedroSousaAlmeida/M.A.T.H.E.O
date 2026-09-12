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

  it('rejects an unknown NFSE_ENV', () => {
    expect(() => validateEnv({ ...valid, NFSE_ENV: 'staging' })).toThrow(/NFSE_ENV/);
  });
});
