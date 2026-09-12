import { describe, expect, it } from 'bun:test';
import { loadCertificate } from '@/modules/nfse/certificate';
import { buildDpsXml } from '@/modules/nfse/dps-builder';
import { signXml, verifyXmlSignature } from '@/modules/nfse/xml-signer';
import { createTestPfx } from '../../helpers/test-certificate';

const dps = buildDpsXml({
  ambiente: 'homologacao',
  serie: '1',
  numero: 1,
  dataEmissao: new Date('2026-09-11T13:00:00Z'),
  prestador: { cnpj: '12345678000199', codigoMunicipio: '3550308' },
  tomador: { documento: '12345678909', nome: 'Cliente' },
  servico: { codigoTributacao: '01.01.01', descricao: 'Serviço', valor: '10.00' },
});

describe('signXml', () => {
  const { pfx, password, certPem } = createTestPfx();
  const certificate = loadCertificate(pfx, password);

  it('produces an enveloped signature after infDPS with RSA-SHA256, SHA-256 digest and the X509 certificate', () => {
    const signed = signXml(dps.xml, certificate, 'infDPS');
    expect(signed).toContain('</infDPS><Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
    expect(signed).toContain('Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"');
    expect(signed).toContain('Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"');
    expect(signed).toContain(`<Reference URI="#${dps.id}">`);
    expect(signed).toContain('<X509Certificate>');
    expect(signed.endsWith('</DPS>')).toBe(true);
  });

  it('verifies with the signing certificate and fails after tampering', () => {
    const signed = signXml(dps.xml, certificate, 'infDPS');
    expect(verifyXmlSignature(signed, certPem)).toBe(true);
    expect(verifyXmlSignature(signed.replace('<vServ>10.00</vServ>', '<vServ>99.00</vServ>'), certPem)).toBe(false);
  });

  it('fails verification with a different certificate', () => {
    const signed = signXml(dps.xml, certificate, 'infDPS');
    const other = createTestPfx({ cn: 'OUTRA' });
    expect(verifyXmlSignature(signed, other.certPem)).toBe(false);
  });
});
