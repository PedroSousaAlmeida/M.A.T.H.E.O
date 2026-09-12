import { describe, expect, it } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { loadCertificate } from '@/modules/nfse/certificate';
import { NfseRejectedError, NfseUnavailableError } from '@/modules/nfse/errors';
import { NationalNfseGateway, type HttpRequest, type HttpResponse } from '@/modules/nfse/national-nfse.gateway';
import type { DpsData } from '@/modules/nfse/nfse-gateway';
import { verifyXmlSignature } from '@/modules/nfse/xml-signer';
import { createTestPfx } from '../../helpers/test-certificate';

const { pfx, password, certPem } = createTestPfx();
const certificate = loadCertificate(pfx, password);
const urls = { sefin: 'https://sefin.test/SefinNacional', adn: 'https://adn.test/contribuintes' };
const dps: DpsData = {
  ambiente: 'homologacao',
  serie: '1',
  numero: 5,
  dataEmissao: new Date(),
  prestador: { cnpj: '12345678000199', codigoMunicipio: '3550308' },
  tomador: { documento: '12345678909', nome: 'Cliente' },
  servico: { codigoTributacao: '01.01.01', descricao: 'Serviço', valor: '10.00' },
};
const chave = '3'.repeat(50);
const nfseXml = `<NFSe><infNFSe Id="NFS${chave}"><nNFSe>77</nNFSe></infNFSe></NFSe>`;
const gz = (s: string) => gzipSync(Buffer.from(s, 'utf8')).toString('base64');

function fakeTransport(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const calls: HttpRequest[] = [];
  const transport = async (req: HttpRequest) => {
    calls.push(req);
    return responder(req);
  };
  return { transport, calls };
}

describe('NationalNfseGateway', () => {
  describe('emit', () => {
    it('POSTs a gzip+base64 signed DPS with the certificate and parses the NFS-e', async () => {
      const { transport, calls } = fakeTransport(() => ({
        status: 201,
        body: Buffer.from(JSON.stringify({ chaveAcesso: chave, nfseXmlGZipB64: gz(nfseXml) })),
      }));
      const gateway = new NationalNfseGateway(urls, transport);

      const result = await gateway.emit(dps, certificate);

      expect(calls[0]).toMatchObject({ method: 'POST', url: `${urls.sefin}/nfse`, certPem, accept: 'application/json' });
      expect(calls[0].keyPem).toBe(certificate.keyPem);
      const sent = JSON.parse(calls[0].body!);
      const xmlDps = gunzipSync(Buffer.from(sent.dpsXmlGZipB64, 'base64')).toString('utf8');
      expect(verifyXmlSignature(xmlDps, certPem)).toBe(true);
      expect(result).toEqual({ chaveAcesso: chave, numeroNfse: '77', xmlDps, xmlNfse: nfseXml });
    });

    it('throws NfseRejectedError with the API error code on 4xx', async () => {
      const { transport } = fakeTransport(() => ({
        status: 400,
        body: Buffer.from(JSON.stringify({ erros: [{ codigo: 'E0042', descricao: 'CNPJ do prestador inválido' }] })),
      }));
      const gateway = new NationalNfseGateway(urls, transport);
      const error = await gateway.emit(dps, certificate).catch((e) => e);
      expect(error).toBeInstanceOf(NfseRejectedError);
      expect(error.code).toBe('E0042');
      expect(error.message).toContain('CNPJ do prestador inválido');
    });

    it('throws NfseUnavailableError on 5xx and on transport failure', async () => {
      const five = new NationalNfseGateway(urls, fakeTransport(() => ({ status: 503, body: Buffer.from('') })).transport);
      await expect(five.emit(dps, certificate)).rejects.toBeInstanceOf(NfseUnavailableError);
      const down = new NationalNfseGateway(urls, async () => { throw new Error('ECONNRESET'); });
      await expect(down.emit(dps, certificate)).rejects.toBeInstanceOf(NfseUnavailableError);
    });
  });

  describe('cancel', () => {
    it('POSTs a signed pedRegEvento to /nfse/{chave}/eventos', async () => {
      const { transport, calls } = fakeTransport(() => ({ status: 201, body: Buffer.from('{}') }));
      const gateway = new NationalNfseGateway(urls, transport);
      await gateway.cancel(chave, 'Erro de digitação no valor', dps, certificate);
      expect(calls[0]).toMatchObject({ method: 'POST', url: `${urls.sefin}/nfse/${chave}/eventos` });
      const xml = gunzipSync(Buffer.from(JSON.parse(calls[0].body!).pedidoRegistroEventoXmlGZipB64, 'base64')).toString('utf8');
      expect(xml).toContain(`<chNFSe>${chave}</chNFSe>`);
      expect(xml).toContain('<e101101>');
      expect(verifyXmlSignature(xml, certPem)).toBe(true);
    });
  });

  describe('pdf', () => {
    it('GETs the DANFSe from the ADN and returns the bytes', async () => {
      const { transport, calls } = fakeTransport(() => ({ status: 200, body: Buffer.from('%PDF-1.4') }));
      const gateway = new NationalNfseGateway(urls, transport);
      const pdf = await gateway.pdf(chave, certificate);
      expect(calls[0]).toMatchObject({ method: 'GET', url: `${urls.adn}/DANFSE/${chave}`, accept: 'application/pdf' });
      expect(pdf.toString()).toBe('%PDF-1.4');
    });
  });
});
