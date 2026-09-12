import https from 'node:https';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { LoadedCertificate } from './certificate';
import { buildCancelEventXml, buildDpsXml } from './dps-builder';
import { NfseRejectedError, NfseUnavailableError } from './errors';
import type { DpsData, EmitResult, NfseGateway } from './nfse-gateway';
import { signXml } from './xml-signer';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  accept: string;
  certPem: string;
  keyPem: string;
}

export interface HttpResponse {
  status: number;
  body: Buffer;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

const TIMEOUT_MS = 30_000;

/** node:https transport with client certificate (mTLS). */
export const httpsTransport: HttpTransport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const request = https.request(
      {
        method: req.method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          accept: req.accept,
          ...(req.body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(req.body) } : {}),
        },
        cert: req.certPem,
        key: req.keyPem,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`)));
    request.on('error', reject);
    if (req.body) request.write(req.body);
    request.end();
  });

function gzipB64(xml: string): string {
  return gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
}

function gunzipB64(payload: string): string {
  return gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
}

export class NationalNfseGateway implements NfseGateway {
  constructor(
    private readonly urls: { sefin: string; adn: string },
    private readonly transport: HttpTransport = httpsTransport,
  ) {}

  async emit(dps: DpsData, certificate: LoadedCertificate): Promise<EmitResult> {
    const { xml } = buildDpsXml(dps);
    const xmlDps = signXml(xml, certificate, 'infDPS');

    const response = await this.send({
      method: 'POST',
      url: `${this.urls.sefin}/nfse`,
      body: JSON.stringify({ dpsXmlGZipB64: gzipB64(xmlDps) }),
      accept: 'application/json',
      certificate,
    });

    const json = this.parseJson(response) as { chaveAcesso?: string; nfseXmlGZipB64?: string };
    if (!json.chaveAcesso || !json.nfseXmlGZipB64) {
      throw new NfseUnavailableError('Unexpected response from national API: missing chaveAcesso/nfseXmlGZipB64');
    }
    const xmlNfse = gunzipB64(json.nfseXmlGZipB64);
    const numeroNfse = /<nNFSe>(\d+)<\/nNFSe>/.exec(xmlNfse)?.[1] ?? '';
    return { chaveAcesso: json.chaveAcesso, numeroNfse, xmlDps, xmlNfse };
  }

  async cancel(
    chaveAcesso: string,
    motivo: string,
    dps: Pick<DpsData, 'ambiente' | 'prestador'>,
    certificate: LoadedCertificate,
  ): Promise<void> {
    const { xml } = buildCancelEventXml({
      ambiente: dps.ambiente,
      chaveAcesso,
      cnpjAutor: dps.prestador.cnpj,
      motivo,
      dataEvento: new Date(),
    });
    const signed = signXml(xml, certificate, 'infPedReg');
    await this.send({
      method: 'POST',
      url: `${this.urls.sefin}/nfse/${chaveAcesso}/eventos`,
      body: JSON.stringify({ pedidoRegistroEventoXmlGZipB64: gzipB64(signed) }),
      accept: 'application/json',
      certificate,
    });
  }

  async pdf(chaveAcesso: string, certificate: LoadedCertificate): Promise<Buffer> {
    const response = await this.send({
      method: 'GET',
      url: `${this.urls.adn}/DANFSE/${chaveAcesso}`,
      accept: 'application/pdf',
      certificate,
    });
    return response.body;
  }

  private async send(input: {
    method: 'GET' | 'POST';
    url: string;
    body?: string;
    accept: string;
    certificate: LoadedCertificate;
  }): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await this.transport({
        method: input.method,
        url: input.url,
        body: input.body,
        accept: input.accept,
        certPem: input.certificate.certPem,
        keyPem: input.certificate.keyPem,
      });
    } catch (error) {
      throw new NfseUnavailableError(`National API request failed: ${(error as Error).message}`);
    }

    if (response.status >= 500 || response.status === 0) {
      throw new NfseUnavailableError(`National API responded ${response.status}`);
    }
    if (response.status >= 400) {
      throw this.toRejection(response);
    }
    return response;
  }

  private parseJson(response: HttpResponse): unknown {
    try {
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new NfseUnavailableError('National API returned a non-JSON body');
    }
  }

  private toRejection(response: HttpResponse): NfseRejectedError {
    try {
      const json = JSON.parse(response.body.toString('utf8')) as { erros?: { codigo?: string; descricao?: string }[] };
      const erros = json.erros ?? [];
      if (erros.length > 0) {
        const code = erros[0].codigo ?? String(response.status);
        const message = erros.map((e) => `${e.codigo ?? '?'}: ${e.descricao ?? ''}`).join('; ');
        return new NfseRejectedError(code, message);
      }
    } catch {
      // fall through: non-JSON 4xx body
    }
    return new NfseRejectedError(String(response.status), `National API rejected the request (HTTP ${response.status})`);
  }
}
