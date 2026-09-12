import forge from 'node-forge';
import { InvalidCertificateError } from './errors';

export interface LoadedCertificate {
  certPem: string;
  keyPem: string;
  /** Remaining certificates from the pfx (PEM), i.e. the chain above the leaf. */
  chainPem: string[];
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

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const keyBag =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ??
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];

  if (certBags.length === 0 || !keyBag?.key) {
    throw new InvalidCertificateError('pfx does not contain a certificate and a private key');
  }

  const privateKey = keyBag.key;
  const leafIndex = certBags.findIndex((bag) => {
    const publicKey = bag.cert?.publicKey as forge.pki.rsa.PublicKey | undefined;
    return publicKey?.n !== undefined && publicKey.n.equals(privateKey.n);
  });

  if (leafIndex === -1) {
    throw new InvalidCertificateError('pfx has no certificate matching the private key');
  }

  const leafCert = certBags[leafIndex].cert!;
  const chainCerts = certBags.filter((_, i) => i !== leafIndex).map((bag) => bag.cert!);

  const cn = leafCert.subject.getField('CN')?.value ?? '';
  return {
    certPem: forge.pki.certificateToPem(leafCert),
    keyPem: forge.pki.privateKeyToPem(privateKey),
    chainPem: chainCerts.map((cert) => forge.pki.certificateToPem(cert)),
    notBefore: leafCert.validity.notBefore,
    notAfter: leafCert.validity.notAfter,
    subjectCn: String(cn),
  };
}
