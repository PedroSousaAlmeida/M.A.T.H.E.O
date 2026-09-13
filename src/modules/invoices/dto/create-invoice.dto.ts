import { IsBoolean, IsEmail, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, Max, ValidateIf } from 'class-validator';
import { IsCpfOrCnpj } from '../../../common/validators/document';

export class CreateInvoiceDto {
  /** Saved customer. Mutually exclusive with tomador* — exactly one of the two must be given. */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ValidateIf((o) => !o.customerId)
  @IsCpfOrCnpj()
  tomadorDocumento?: string;

  @ValidateIf((o) => !o.customerId)
  @IsString()
  @Length(2, 150)
  tomadorNome?: string;

  @IsOptional()
  @IsEmail()
  tomadorEmail?: string;

  /** With tomador*: also store the tomador as a customer of the company. */
  @IsOptional()
  @IsBoolean()
  saveCustomer?: boolean;

  @IsString()
  @Length(1, 2000)
  descricao: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9_999_999_999.99)
  valor: number;

  @Matches(/^\d{2}\.\d{2}\.\d{2}$/, { message: 'codigoTributacao must look like 01.01.01' })
  codigoTributacao: string;
}
