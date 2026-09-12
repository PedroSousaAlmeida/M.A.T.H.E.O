import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @Length(2, 150)
  razaoSocial?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  inscricaoMunicipal?: string;

  @IsOptional()
  @Matches(/^\d{7}$/, { message: 'codigoMunicipio must be the 7-digit IBGE code' })
  codigoMunicipio?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
