import forge from 'node-forge';

export interface TestPfx {
  pfx: Buffer;
  password: string;
  certPem: string;
  keyPem: string;
}

let cached: TestPfx | undefined;

function makeCert(opts: {
  publicKey: forge.pki.rsa.PublicKey;
  subjectCn: string;
  issuerCn: string;
  serialNumber: string;
  notAfter: Date;
  isCa?: boolean;
}): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = opts.publicKey;
  cert.serialNumber = opts.serialNumber;
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = opts.notAfter;
  cert.setSubject([{ name: 'commonName', value: opts.subjectCn }]);
  cert.setIssuer([{ name: 'commonName', value: opts.issuerCn }]);
  if (opts.isCa) {
    cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  }
  return cert;
}

/**
 * Builds a test pfx. By default it contains a single self-signed certificate.
 * With `withChain: true` it packs a CA certificate FIRST and a leaf certificate
 * (signed by that CA) SECOND — mirroring how real ICP-Brasil A1 pfx files bundle
 * the chain — so callers can exercise leaf-selection logic.
 */
export function createTestPfx(opts: { password?: string; cn?: string; notAfter?: Date; withChain?: boolean } = {}): TestPfx {
  const custom = opts.cn !== undefined || opts.notAfter !== undefined || opts.password !== undefined || opts.withChain !== undefined;
  if (!custom && cached) return cached;

  const password = opts.password ?? 'test-password';
  const cn = opts.cn ?? 'EMPRESA TESTE LTDA:12345678000199';
  const notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);

  let result: TestPfx;
  if (opts.withChain) {
    const caKeys = forge.pki.rsa.generateKeyPair(2048);
    const caCert = makeCert({
      publicKey: caKeys.publicKey,
      subjectCn: 'Test CA',
      issuerCn: 'Test CA',
      serialNumber: '01',
      notAfter: new Date(Date.now() + 3650 * 24 * 3600 * 1000),
      isCa: true,
    });
    caCert.sign(caKeys.privateKey, forge.md.sha256.create());

    const leafKeys = forge.pki.rsa.generateKeyPair(2048);
    const leafCert = makeCert({
      publicKey: leafKeys.publicKey,
      subjectCn: cn,
      issuerCn: 'Test CA',
      serialNumber: '02',
      notAfter,
    });
    leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

    // CA first, leaf second — matches real-world A1 pfx bundling.
    const p12 = forge.pkcs12.toPkcs12Asn1(leafKeys.privateKey, [caCert, leafCert], password, { algorithm: '3des' });
    const der = forge.asn1.toDer(p12).getBytes();
    result = {
      pfx: Buffer.from(der, 'binary'),
      password,
      certPem: forge.pki.certificateToPem(leafCert),
      keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
    };
  } else {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = makeCert({ publicKey: keys.publicKey, subjectCn: cn, issuerCn: cn, serialNumber: '01', notAfter });
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
    const der = forge.asn1.toDer(p12).getBytes();
    result = {
      pfx: Buffer.from(der, 'binary'),
      password,
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
  }

  if (!custom) cached = result;
  return result;
}
