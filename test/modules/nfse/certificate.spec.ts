import { describe, expect, it } from 'bun:test';
import { loadCertificate } from '@/modules/nfse/certificate';
import { buildDpsXml } from '@/modules/nfse/dps-builder';
import { InvalidCertificateError } from '@/modules/nfse/errors';
import { signXml, verifyXmlSignature } from '@/modules/nfse/xml-signer';
import { createTestPfx } from '../../helpers/test-certificate';

describe('loadCertificate', () => {
  it('extracts PEM cert, PEM key, validity and CN from a pfx', () => {
    const { pfx, password } = createTestPfx();
    const loaded = loadCertificate(pfx, password);
    expect(loaded.certPem).toContain('-----BEGIN CERTIFICATE-----');
    expect(loaded.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(loaded.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(loaded.subjectCn).toBe('EMPRESA TESTE LTDA:12345678000199');
    expect(loaded.chainPem).toEqual([]);
  });

  it('throws InvalidCertificateError on wrong password', () => {
    const { pfx } = createTestPfx();
    expect(() => loadCertificate(pfx, 'wrong')).toThrow(InvalidCertificateError);
  });

  it('throws InvalidCertificateError on garbage bytes', () => {
    expect(() => loadCertificate(Buffer.from('not a pfx'), 'x')).toThrow(InvalidCertificateError);
  });

  describe('with a chained pfx (CA + leaf, CA first)', () => {
    it('selects the leaf certificate (matching the private key), not certBags[0]', () => {
      const { pfx, password, certPem } = createTestPfx({ withChain: true, cn: 'LEAF EMPRESA LTDA:99988877000166' });
      const loaded = loadCertificate(pfx, password);
      expect(loaded.subjectCn).toBe('LEAF EMPRESA LTDA:99988877000166');
      expect(loaded.certPem).toBe(certPem);
    });

    it('returns the remaining certificate (the CA) in chainPem', () => {
      const { pfx, password } = createTestPfx({ withChain: true });
      const loaded = loadCertificate(pfx, password);
      expect(loaded.chainPem).toHaveLength(1);
      expect(loaded.chainPem[0]).toContain('-----BEGIN CERTIFICATE-----');
      expect(loaded.chainPem[0]).not.toBe(loaded.certPem);
    });

    it('signs and verifies XML with the selected leaf certificate', () => {
      const { pfx, password } = createTestPfx({ withChain: true });
      const loaded = loadCertificate(pfx, password);
      const dps = buildDpsXml({
        ambiente: 'homologacao',
        serie: '1',
        numero: 1,
        dataEmissao: new Date('2026-09-11T13:00:00Z'),
        prestador: { cnpj: '12345678000199', codigoMunicipio: '3550308' },
        tomador: { documento: '12345678909', nome: 'Cliente' },
        servico: { codigoTributacao: '01.01.01', descricao: 'Serviço', valor: '10.00' },
      });
      const signed = signXml(dps.xml, loaded, 'infDPS');
      expect(verifyXmlSignature(signed, loaded.certPem)).toBe(true);
    });
  });
});
