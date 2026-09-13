import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
import { IsCpfOrCnpj } from '../../../common/validators/document';

export class CreateCustomerDto {
  @IsCpfOrCnpj()
  documento: string;

  @IsString()
  @Length(2, 150)
  nome: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
