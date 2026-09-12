import forge from 'node-forge';

export interface TestPfx {
  pfx: Buffer;
  password: string;
  certPem: string;
  keyPem: string;
}

let cached: TestPfx | undefined;

export function createTestPfx(opts: { password?: string; cn?: string; notAfter?: Date } = {}): TestPfx {
  const custom = opts.cn !== undefined || opts.notAfter !== undefined || opts.password !== undefined;
  if (!custom && cached) return cached;

  const password = opts.password ?? 'test-password';
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: opts.cn ?? 'EMPRESA TESTE LTDA:12345678000199' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  const der = forge.asn1.toDer(p12).getBytes();
  const result: TestPfx = {
    pfx: Buffer.from(der, 'binary'),
    password,
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
  if (!custom) cached = result;
  return result;
}
