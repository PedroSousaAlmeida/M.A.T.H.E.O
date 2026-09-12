import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import xpath from 'xpath';
import type { LoadedCertificate } from './certificate';

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const SIGNATURE_XPATH = "//*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']";

export function signXml(xml: string, certificate: LoadedCertificate, referenceLocalName: string): string {
  const referenceXpath = `//*[local-name(.)='${referenceLocalName}']`;
  const sig = new SignedXml({
    privateKey: certificate.keyPem,
    publicCert: certificate.certPem,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({
    xpath: referenceXpath,
    digestAlgorithm: SHA256,
    transforms: [ENVELOPED, C14N],
  });
  sig.computeSignature(xml, { location: { reference: referenceXpath, action: 'after' } });
  return sig.getSignedXml();
}

/**
 * Verify an XML signature against a certificate.
 * Returns false unless the document contains exactly one Signature element.
 * Callers must only trust data inside the element the signature references (the `Reference URI` target),
 * never sibling elements.
 */
export function verifyXmlSignature(signedXml: string, certPem: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(signedXml, 'text/xml');
    const signatureNodes = xpath.select(SIGNATURE_XPATH, doc as unknown as Node);
    if (!Array.isArray(signatureNodes) || signatureNodes.length !== 1) return false;
    const sig = new SignedXml({ publicCert: certPem });
    sig.loadSignature(signatureNodes[0] as unknown as Node);
    return sig.checkSignature(signedXml);
  } catch {
    return false;
  }
}
