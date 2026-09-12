import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateCompanyDto {
  @Matches(/^\d{14}$/, { message: 'cnpj must be 14 digits' })
  cnpj: string;

  @IsString()
  @Length(2, 150)
  razaoSocial: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  inscricaoMunicipal?: string;

  @Matches(/^\d{7}$/, { message: 'codigoMunicipio must be the 7-digit IBGE code' })
  codigoMunicipio: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
