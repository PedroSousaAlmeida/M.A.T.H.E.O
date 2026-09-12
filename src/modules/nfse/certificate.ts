import forge from 'node-forge';
import { InvalidCertificateError } from './errors';

export interface LoadedCertificate {
  certPem: string;
  keyPem: string;
  notBefore: Date;
  notAfter: Date;
  subjectCn: string;
}

export function loadCertificate(pfx: Buffer, password: string): LoadedCertificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch {
    throw new InvalidCertificateError();
  }

  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0];
  const keyBag =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ??
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];

  if (!certBag?.cert || !keyBag?.key) {
    throw new InvalidCertificateError('pfx does not contain a certificate and a private key');
  }

  const cn = certBag.cert.subject.getField('CN')?.value ?? '';
  return {
    certPem: forge.pki.certificateToPem(certBag.cert),
    keyPem: forge.pki.privateKeyToPem(keyBag.key),
    notBefore: certBag.cert.validity.notBefore,
    notAfter: certBag.cert.validity.notAfter,
    subjectCn: String(cn),
  };
}
