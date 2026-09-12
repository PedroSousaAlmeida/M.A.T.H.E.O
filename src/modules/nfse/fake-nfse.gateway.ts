import { Injectable } from '@nestjs/common';
import type { LoadedCertificate } from './certificate';
import { buildDpsXml, escapeXml, formatDateTimeBr, NFSE_NAMESPACE } from './dps-builder';
import { NfseRejectedError } from './errors';
import type { DpsData, EmitResult, NfseGateway } from './nfse-gateway';
import { signXml } from './xml-signer';

/** Builds a minimal but valid single-page PDF (so viewers can open it) with the given lines of text. */
export function buildMinimalPdf(lines: string[]): Buffer {
  const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ['BT', '/F1 14 Tf', '50 780 Td', '18 TL', ...lines.map((l) => `(${escape(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

@Injectable()
export class FakeNfseGateway implements NfseGateway {
  readonly emitted = new Map<string, EmitResult>();
  private pendingRejection: NfseRejectedError | null = null;

  rejectNext(code: string, message: string) {
    this.pendingRejection = new NfseRejectedError(code, message);
  }

  async emit(dps: DpsData, certificate: LoadedCertificate): Promise<EmitResult> {
    this.consumeRejection();
    const { xml } = buildDpsXml(dps);
    const xmlDps = signXml(xml, certificate, 'infDPS');
    const chaveAcesso = this.fakeChave(dps);
    const numeroNfse = String(dps.numero);
    const xmlNfse =
      `<NFSe xmlns="${NFSE_NAMESPACE}" versao="1.00"><infNFSe Id="NFS${chaveAcesso}">` +
      `<nNFSe>${numeroNfse}</nNFSe><dhProc>${formatDateTimeBr(new Date())}</dhProc>` +
      `<emit><CNPJ>${dps.prestador.cnpj}</CNPJ></emit>` +
      `<toma><xNome>${escapeXml(dps.tomador.nome)}</xNome></toma>` +
      `</infNFSe>${xmlDps}</NFSe>`;
    const result = { chaveAcesso, numeroNfse, xmlDps, xmlNfse };
    this.emitted.set(chaveAcesso, result);
    return result;
  }

  async cancel(
    chaveAcesso: string,
    _motivo: string,
    _dps: Pick<DpsData, 'ambiente' | 'prestador'>,
    _certificate: LoadedCertificate,
  ): Promise<void> {
    this.consumeRejection();
    if (!this.emitted.has(chaveAcesso)) {
      throw new NfseRejectedError('E9999', 'NFS-e não encontrada');
    }
  }

  async pdf(chaveAcesso: string, _certificate: LoadedCertificate): Promise<Buffer> {
    if (!this.emitted.has(chaveAcesso)) {
      throw new NfseRejectedError('E9999', 'NFS-e não encontrada');
    }
    return buildMinimalPdf(['DANFSe (FAKE - NFSE_ENV=fake)', `Chave de acesso: ${chaveAcesso}`, 'Documento sem valor fiscal.']);
  }

  private consumeRejection() {
    if (this.pendingRejection) {
      const error = this.pendingRejection;
      this.pendingRejection = null;
      throw error;
    }
  }

  /** cMun(7) + tpAmb(1) + AAMM(4) + CNPJ(14) + serie... — 50 digits, deterministic per DPS. */
  private fakeChave(dps: DpsData): string {
    const now = new Date();
    const aamm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const head = dps.prestador.codigoMunicipio + (dps.ambiente === 'producao' ? '1' : '2') + aamm + dps.prestador.cnpj;
    const tail = String(dps.numero).padStart(15, '0') + String(Date.now()).slice(-9);
    return (head + tail).padEnd(50, '0').slice(0, 50);
  }
}
