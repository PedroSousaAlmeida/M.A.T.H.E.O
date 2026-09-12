import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

export class UpdateCustomerDto {
  @IsOptional()
  @Matches(/^(\d{11}|\d{14})$/, { message: 'documento must be a CPF (11 digits) or CNPJ (14 digits)' })
  documento?: string;

  @IsOptional()
  @IsString()
  @Length(2, 150)
  nome?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
