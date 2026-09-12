import { describe, expect, it } from 'bun:test';
import { loadCertificate } from '@/modules/nfse/certificate';
import { InvalidCertificateError } from '@/modules/nfse/errors';
import { createTestPfx } from '../../helpers/test-certificate';

describe('loadCertificate', () => {
  it('extracts PEM cert, PEM key, validity and CN from a pfx', () => {
    const { pfx, password } = createTestPfx();
    const loaded = loadCertificate(pfx, password);
    expect(loaded.certPem).toContain('-----BEGIN CERTIFICATE-----');
    expect(loaded.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(loaded.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(loaded.subjectCn).toBe('EMPRESA TESTE LTDA:12345678000199');
  });

  it('throws InvalidCertificateError on wrong password', () => {
    const { pfx } = createTestPfx();
    expect(() => loadCertificate(pfx, 'wrong')).toThrow(InvalidCertificateError);
  });

  it('throws InvalidCertificateError on garbage bytes', () => {
    expect(() => loadCertificate(Buffer.from('not a pfx'), 'x')).toThrow(InvalidCertificateError);
  });
});
