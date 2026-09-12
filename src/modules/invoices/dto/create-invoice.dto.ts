import { IsEmail, IsNumber, IsOptional, IsPositive, IsString, Length, Matches } from 'class-validator';

export class CreateInvoiceDto {
  @Matches(/^(\d{11}|\d{14})$/, { message: 'tomadorDocumento must be a CPF (11 digits) or CNPJ (14 digits)' })
  tomadorDocumento: string;

  @IsString()
  @Length(2, 150)
  tomadorNome: string;

  @IsOptional()
  @IsEmail()
  tomadorEmail?: string;

  @IsString()
  @Length(1, 2000)
  descricao: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  valor: number;

  @Matches(/^\d{2}\.\d{2}\.\d{2}$/, { message: 'codigoTributacao must look like 01.01.01' })
  codigoTributacao: string;
}
