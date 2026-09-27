import { registerDecorator, type ValidationOptions } from 'class-validator';

function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  const mod = sum % 11;
  return mod < 2 ? 0 : 11 - mod;
}

function allSame(value: string): boolean {
  return /^(\d)\1+$/.test(value);
}

/** CPF: 11 digits, mod-11 check digits, repeated sequences rejected. */
export function isValidCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || allSame(value)) return false;
  const d = value.split('').map(Number);
  const v1 = checkDigit(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const v2 = checkDigit(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d[9] === v1 && d[10] === v2;
}

/** CNPJ (numeric): 14 digits, mod-11 check digits, repeated sequences rejected. Alphanumeric CNPJ is not supported yet. */
export function isValidCnpj(value: string): boolean {
  if (!/^\d{14}$/.test(value) || allSame(value)) return false;
  const d = value.split('').map(Number);
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const v1 = checkDigit(d.slice(0, 12), w1);
  const v2 = checkDigit(d.slice(0, 13), [6, ...w1]);
  return d[12] === v1 && d[13] === v2;
}

export function IsCpfOrCnpj(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isCpfOrCnpj',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && (isValidCpf(value) || isValidCnpj(value)),
        defaultMessage: () => `${propertyName} must be a valid CPF or CNPJ`,
      },
    });
}

export function IsCnpj(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isCnpj',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidCnpj(value),
        defaultMessage: () => `${propertyName} must be a valid CNPJ`,
      },
    });
}
