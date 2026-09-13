import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
import { IsCnpj } from '../../../common/validators/document';

export class CreateCompanyDto {
  @ApiProperty({ example: '11222333000181', description: 'CNPJ da empresa, 14 dígitos, com dígito verificador válido' })
  @IsCnpj()
  cnpj: string;

  @ApiProperty({ example: 'Minha MEI LTDA', minLength: 2, maxLength: 150 })
  @IsString()
  @Length(2, 150)
  razaoSocial: string;

  @ApiPropertyOptional({ example: '123456', maxLength: 20 })
  @IsOptional()
  @IsString()
  @Length(1, 20)
  inscricaoMunicipal?: string;

  @ApiProperty({ example: '3550308', description: 'Código IBGE do município (7 dígitos)' })
  @Matches(/^\d{7}$/, { message: 'codigoMunicipio must be the 7-digit IBGE code' })
  codigoMunicipio: string;

  @ApiPropertyOptional({ example: 'contato@exemplo.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '11999999999', description: '10 ou 11 dígitos' })
  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
