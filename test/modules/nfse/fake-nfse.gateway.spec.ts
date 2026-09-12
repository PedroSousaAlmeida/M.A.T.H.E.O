import { describe, expect, it } from 'bun:test';
import { loadCertificate } from '@/modules/nfse/certificate';
import { NfseRejectedError } from '@/modules/nfse/errors';
import { FakeNfseGateway } from '@/modules/nfse/fake-nfse.gateway';
import type { DpsData } from '@/modules/nfse/nfse-gateway';
import { verifyXmlSignature } from '@/modules/nfse/xml-signer';
import { createTestPfx } from '../../helpers/test-certificate';

const { pfx, password, certPem } = createTestPfx();
const certificate = loadCertificate(pfx, password);
const dps: DpsData = {
  ambiente: 'homologacao',
  serie: '1',
  numero: 3,
  dataEmissao: new Date(),
  prestador: { cnpj: '12345678000199', codigoMunicipio: '3550308' },
  tomador: { documento: '12345678909', nome: 'Cliente' },
  servico: { codigoTributacao: '01.01.01', descricao: 'Serviço', valor: '10.00' },
};

describe('FakeNfseGateway', () => {
  it('emits a signed DPS and returns a 50-digit chaveAcesso, a numeroNfse and a fake NFS-e XML', async () => {
    const gateway = new FakeNfseGateway();
    const result = await gateway.emit(dps, certificate);
    expect(result.chaveAcesso).toMatch(/^\d{50}$/);
    expect(result.numeroNfse).toBe('3');
    expect(verifyXmlSignature(result.xmlDps, certPem)).toBe(true);
    expect(result.xmlNfse).toContain('<NFSe');
    expect(result.xmlNfse).toContain(result.chaveAcesso);
    expect(gateway.emitted.get(result.chaveAcesso)).toEqual(result);
  });

  it('throws NfseRejectedError once after rejectNext()', async () => {
    const gateway = new FakeNfseGateway();
    gateway.rejectNext('E0001', 'Tomador inválido');
    await expect(gateway.emit(dps, certificate)).rejects.toBeInstanceOf(NfseRejectedError);
    await expect(gateway.emit(dps, certificate)).resolves.toBeDefined();
  });

  it('cancels an emitted note and rejects unknown keys', async () => {
    const gateway = new FakeNfseGateway();
    const { chaveAcesso } = await gateway.emit(dps, certificate);
    await expect(gateway.cancel(chaveAcesso, 'erro', dps, certificate)).resolves.toBeUndefined();
    await expect(gateway.cancel('0'.repeat(50), 'erro', dps, certificate)).rejects.toBeInstanceOf(NfseRejectedError);
  });

  it('returns a PDF buffer for an emitted note', async () => {
    const gateway = new FakeNfseGateway();
    const { chaveAcesso } = await gateway.emit(dps, certificate);
    const pdf = await gateway.pdf(chaveAcesso, certificate);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
