import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
import { IsCpfOrCnpj } from '../../../common/validators/document';

export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: '11444777000161' })
  @IsOptional()
  @IsCpfOrCnpj()
  documento?: string;

  @ApiPropertyOptional({ example: 'Empresa Cliente Ltda' })
  @IsOptional()
  @IsString()
  @Length(2, 150)
  nome?: string;

  @ApiPropertyOptional({ example: 'fin@cliente.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '11999999999' })
  @IsOptional()
  @Matches(/^\d{10,11}$/, { message: 'telefone must be 10 or 11 digits' })
  telefone?: string;
}
