import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
import { IsCpfOrCnpj } from '../../../common/validators/document';

export class CreateCustomerDto {
  @ApiProperty({ example: '11444777000161', description: 'CPF (11) ou CNPJ (14), só dígitos, com dígito verificador válido' })
  @IsCpfOrCnpj()
  documento: string;

  @ApiProperty({ example: 'Empresa Cliente', minLength: 2, maxLength: 150 })
  @IsString()
  @Length(2, 150)
  nome: string;

  @ApiPropertyOptional({ example: 'fin@cliente.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '11999999999' })
  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
