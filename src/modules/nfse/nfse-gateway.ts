import type { LoadedCertificate } from './certificate';

export const NFSE_GATEWAY = Symbol('NFSE_GATEWAY');

export type NfseAmbiente = 'producao' | 'homologacao';

export interface DpsData {
  ambiente: NfseAmbiente;
  serie: string;
  numero: number;
  dataEmissao: Date;
  prestador: { cnpj: string; inscricaoMunicipal?: string | null; codigoMunicipio: string };
  tomador: { documento: string; nome: string; email?: string | null };
  servico: { codigoTributacao: string; descricao: string; valor: string };
}

export interface EmitResult {
  chaveAcesso: string;
  numeroNfse: string;
  xmlDps: string;
  xmlNfse: string;
}

export interface NfseGateway {
  emit(dps: DpsData, certificate: LoadedCertificate): Promise<EmitResult>;
  cancel(
    chaveAcesso: string,
    motivo: string,
    dps: Pick<DpsData, 'ambiente' | 'prestador'>,
    certificate: LoadedCertificate,
  ): Promise<void>;
  pdf(chaveAcesso: string, certificate: LoadedCertificate): Promise<Buffer>;
}
