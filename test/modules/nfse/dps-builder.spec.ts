import { describe, expect, it } from 'bun:test';
import { buildCancelEventXml, buildDpsXml, escapeXml, formatDateTimeBr } from '@/modules/nfse/dps-builder';
import type { DpsData } from '@/modules/nfse/nfse-gateway';

const dps: DpsData = {
  ambiente: 'homologacao',
  serie: '1',
  numero: 7,
  dataEmissao: new Date('2026-09-11T13:00:00Z'),
  prestador: { cnpj: '12345678000199', inscricaoMunicipal: '123', codigoMunicipio: '3550308' },
  tomador: { documento: '12345678909', nome: 'Cliente & Cia', email: 'c@x.com' },
  servico: { codigoTributacao: '01.01.01', descricao: 'Consultoria <TI>', valor: '150.00' },
};

describe('buildDpsXml', () => {
  it('builds a 45-char Id: DPS + cMun(7) + tpInsc(1) + inscricao(14) + serie(5) + numero(15)', () => {
    const { id } = buildDpsXml(dps);
    expect(id).toBe('DPS355030821234567800019900001000000000000007');
    expect(id).toHaveLength(45);
  });

  it('contains the mandatory DPS fields with the national namespace', () => {
    const { xml, id } = buildDpsXml(dps);
    expect(xml).toContain('<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">');
    expect(xml).toContain(`<infDPS Id="${id}">`);
    expect(xml).toContain('<tpAmb>2</tpAmb>');
    expect(xml).toContain('<serie>1</serie>');
    expect(xml).toContain('<nDPS>7</nDPS>');
    expect(xml).toContain('<cLocEmi>3550308</cLocEmi>');
    expect(xml).toContain('<prest><CNPJ>12345678000199</CNPJ><IM>123</IM>');
    expect(xml).toContain('<opSimpNac>2</opSimpNac>');
    expect(xml).toContain('<toma><CPF>12345678909</CPF>');
    expect(xml).toContain('<cTribNac>010101</cTribNac>');
    expect(xml).toContain('<vServ>150.00</vServ>');
    expect(xml).toContain('<dhEmi>2026-09-11T10:00:00-03:00</dhEmi>');
    expect(xml).toContain('<dCompet>2026-09-11</dCompet>');
  });

  it('uses <CNPJ> for a 14-digit tomador and omits <IM> when absent', () => {
    const { xml } = buildDpsXml({
      ...dps,
      prestador: { ...dps.prestador, inscricaoMunicipal: null },
      tomador: { documento: '98765432000100', nome: 'Empresa' },
    });
    expect(xml).toContain('<toma><CNPJ>98765432000100</CNPJ>');
    expect(xml).not.toContain('<IM>');
  });

  it('uses tpAmb 1 for producao and escapes text', () => {
    const { xml } = buildDpsXml({ ...dps, ambiente: 'producao' });
    expect(xml).toContain('<tpAmb>1</tpAmb>');
    expect(xml).toContain('<xNome>Cliente &amp; Cia</xNome>');
    expect(xml).toContain('<xDescServ>Consultoria &lt;TI&gt;</xDescServ>');
  });
});

describe('buildCancelEventXml', () => {
  it('builds the pedRegEvento with e101101 and a PRE id', () => {
    const chave = '1'.repeat(50);
    const { id, xml } = buildCancelEventXml({
      ambiente: 'homologacao',
      chaveAcesso: chave,
      cnpjAutor: '12345678000199',
      motivo: 'Erro de digitação',
      dataEvento: new Date('2026-09-11T13:00:00Z'),
    });
    expect(id).toBe(`PRE${chave}101101001`);
    expect(xml).toContain('<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">');
    expect(xml).toContain(`<infPedReg Id="${id}">`);
    expect(xml).toContain(`<chNFSe>${chave}</chNFSe>`);
    expect(xml).toContain('<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>9</cMotivo><xMotivo>Erro de digitação</xMotivo></e101101>');
  });
});

describe('helpers', () => {
  it('formatDateTimeBr renders São Paulo local time with offset', () => {
    expect(formatDateTimeBr(new Date('2026-01-15T03:05:09Z'))).toBe('2026-01-15T00:05:09-03:00');
  });

  it('escapeXml escapes the five XML entities', () => {
    expect(escapeXml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
  });
});
