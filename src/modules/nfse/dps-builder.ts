import type { DpsData, NfseAmbiente } from './nfse-gateway';

export const NFSE_NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
export const APP_VERSION = 'MATHEO-0.1.0';
const TIME_ZONE = 'America/Sao_Paulo';

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 2026-09-11T10:00:00-03:00 (São Paulo wall-clock time with numeric offset). */
export function formatDateTimeBr(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

function tpAmb(ambiente: NfseAmbiente): '1' | '2' {
  return ambiente === 'producao' ? '1' : '2';
}

function tag(name: string, value: string | null | undefined): string {
  return value ? `<${name}>${escapeXml(value)}</${name}>` : '';
}

function assertDigits(value: string, field: string, exact?: number, max?: number): string {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must contain only digits`);
  if (exact !== undefined && value.length !== exact) throw new Error(`${field} must have exactly ${exact} digits`);
  if (max !== undefined && value.length > max) throw new Error(`${field} must have at most ${max} digits`);
  return value;
}

export function buildDpsXml(dps: DpsData): { id: string; xml: string } {
  // Validate inputs before building XML
  assertDigits(dps.prestador.codigoMunicipio, 'prestador.codigoMunicipio', 7);
  assertDigits(dps.prestador.cnpj, 'prestador.cnpj', 14);
  assertDigits(dps.serie, 'serie', undefined, 5);
  assertDigits(String(dps.numero), 'numero', undefined, 15);
  if (dps.tomador.documento.length !== 11 && dps.tomador.documento.length !== 14) {
    throw new Error('tomador.documento must have exactly 11 or 14 digits');
  }
  assertDigits(dps.tomador.documento, 'tomador.documento');
  const cTribNac = dps.servico.codigoTributacao.replace(/\D/g, '');
  assertDigits(cTribNac, 'servico.codigoTributacao (stripped)', 6);
  if (!/^\d+\.\d{2}$/.test(dps.servico.valor)) {
    throw new Error('servico.valor must match format "XXX.XX" (two decimal places)');
  }

  const id =
    'DPS' +
    dps.prestador.codigoMunicipio.padStart(7, '0') +
    '2' + // tpInsc: 2 = CNPJ
    dps.prestador.cnpj.padStart(14, '0') +
    dps.serie.padStart(5, '0') +
    String(dps.numero).padStart(15, '0');

  const dhEmi = formatDateTimeBr(dps.dataEmissao);
  const tomadorTag = dps.tomador.documento.length === 11 ? 'CPF' : 'CNPJ';

  const xml =
    `<DPS xmlns="${NFSE_NAMESPACE}" versao="1.00">` +
    `<infDPS Id="${escapeXml(id)}">` +
    tag('tpAmb', tpAmb(dps.ambiente)) +
    tag('dhEmi', dhEmi) +
    tag('verAplic', APP_VERSION) +
    tag('serie', dps.serie) +
    tag('nDPS', String(dps.numero)) +
    tag('dCompet', dhEmi.slice(0, 10)) +
    tag('tpEmit', '1') +
    tag('cLocEmi', dps.prestador.codigoMunicipio) +
    '<prest>' +
    tag('CNPJ', dps.prestador.cnpj) +
    tag('IM', dps.prestador.inscricaoMunicipal) +
    '<regTrib><opSimpNac>2</opSimpNac><regEspTrib>0</regEspTrib></regTrib>' +
    '</prest>' +
    '<toma>' +
    tag(tomadorTag, dps.tomador.documento) +
    tag('xNome', dps.tomador.nome) +
    tag('email', dps.tomador.email) +
    '</toma>' +
    '<serv>' +
    `<locPrest><cLocPrestacao>${escapeXml(dps.prestador.codigoMunicipio)}</cLocPrestacao></locPrest>` +
    '<cServ>' +
    tag('cTribNac', cTribNac) +
    tag('xDescServ', dps.servico.descricao) +
    '</cServ>' +
    '</serv>' +
    '<valores>' +
    '<vServPrest>' + tag('vServ', dps.servico.valor) + '</vServPrest>' +
    '<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun><totTrib><indTotTrib>0</indTotTrib></totTrib></trib>' +
    '</valores>' +
    '</infDPS>' +
    '</DPS>';

  return { id, xml };
}

export function buildCancelEventXml(input: {
  ambiente: NfseAmbiente;
  chaveAcesso: string;
  cnpjAutor: string;
  motivo: string;
  dataEvento: Date;
  sequencial?: number;
}): { id: string; xml: string } {
  // Validate inputs before building XML
  assertDigits(input.chaveAcesso, 'chaveAcesso', 50);
  assertDigits(input.cnpjAutor, 'cnpjAutor', 14);

  const tipoEvento = '101101'; // Cancelamento de NFS-e
  const id = `PRE${input.chaveAcesso}${tipoEvento}${String(input.sequencial ?? 1).padStart(3, '0')}`;

  const xml =
    `<pedRegEvento xmlns="${NFSE_NAMESPACE}" versao="1.00">` +
    `<infPedReg Id="${escapeXml(id)}">` +
    tag('tpAmb', tpAmb(input.ambiente)) +
    tag('verAplic', APP_VERSION) +
    tag('dhEvento', formatDateTimeBr(input.dataEvento)) +
    tag('CNPJAutor', input.cnpjAutor) +
    tag('chNFSe', input.chaveAcesso) +
    `<e${tipoEvento}>` +
    tag('xDesc', 'Cancelamento de NFS-e') +
    tag('cMotivo', '9') + // 9 = outros; the free-text reason goes in xMotivo
    tag('xMotivo', input.motivo) +
    `</e${tipoEvento}>` +
    '</infPedReg>' +
    '</pedRegEvento>';

  return { id, xml };
}
