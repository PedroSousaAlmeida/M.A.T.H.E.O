import { describe, expect, it } from 'bun:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IsCnpj, IsCpfOrCnpj, isValidCnpj, isValidCpf } from '@/common/validators/document';

describe('isValidCpf / isValidCnpj', () => {
  it('accepts valid documents', () => {
    expect(isValidCpf('12345678909')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11444777000161')).toBe(true);
  });

  it('rejects wrong check digits, repeated sequences, wrong length and non-digits', () => {
    expect(isValidCpf('12345678900')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('1234567890')).toBe(false);
    expect(isValidCpf('123.456.789-09')).toBe(false);
    expect(isValidCnpj('12345678000199')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
    expect(isValidCnpj('1122233300018')).toBe(false);
  });
});

class Doc {
  @IsCpfOrCnpj()
  documento!: string;
}
class Cnpj {
  @IsCnpj()
  cnpj!: string;
}

describe('decorators', () => {
  it('IsCpfOrCnpj accepts a CPF or a CNPJ and rejects the rest with a clear message', () => {
    expect(validateSync(plainToInstance(Doc, { documento: '12345678909' }))).toHaveLength(0);
    expect(validateSync(plainToInstance(Doc, { documento: '11222333000181' }))).toHaveLength(0);
    const errors = validateSync(plainToInstance(Doc, { documento: '12345678000199' }));
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints!)[0]).toBe('documento must be a valid CPF or CNPJ');
  });

  it('IsCnpj rejects a valid CPF', () => {
    expect(validateSync(plainToInstance(Cnpj, { cnpj: '11222333000181' }))).toHaveLength(0);
    const errors = validateSync(plainToInstance(Cnpj, { cnpj: '12345678909' }));
    expect(Object.values(errors[0].constraints!)[0]).toBe('cnpj must be a valid CNPJ');
  });
});
