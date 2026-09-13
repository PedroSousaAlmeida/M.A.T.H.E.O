import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, Max, ValidateIf } from 'class-validator';
import { IsCpfOrCnpj } from '../../../common/validators/document';

export class CreateInvoiceDto {
  /** Saved customer. Mutually exclusive with tomador* — exactly one of the two must be given. */
  @ApiPropertyOptional({ format: 'uuid', description: 'Cliente salvo. Exclusivo com tomadorDocumento/tomadorNome' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ example: '12345678909', description: 'Obrigatório sem customerId. CPF (11) ou CNPJ (14)' })
  @ValidateIf((o) => !o.customerId)
  @IsCpfOrCnpj()
  tomadorDocumento?: string;

  @ApiPropertyOptional({ example: 'Cliente Exemplo', description: 'Obrigatório sem customerId' })
  @ValidateIf((o) => !o.customerId)
  @IsString()
  @Length(2, 150)
  tomadorNome?: string;

  @ApiPropertyOptional({ example: 'cliente@x.com' })
  @IsOptional()
  @IsEmail()
  tomadorEmail?: string;

  @ApiPropertyOptional({ default: false, description: 'Só com tomador*: salva o tomador como cliente da empresa' })
  /** With tomador*: also store the tomador as a customer of the company. */
  @IsOptional()
  @IsBoolean()
  saveCustomer?: boolean;

  @ApiProperty({ example: 'Consultoria em tecnologia da informação', maxLength: 2000 })
  @IsString()
  @Length(1, 2000)
  descricao: string;

  @ApiProperty({ example: 150.0, description: 'Valor do serviço, até 2 casas decimais' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9_999_999_999.99)
  valor: number;

  @ApiProperty({ example: '01.01.01', description: 'Código nacional de tributação (NN.NN.NN)' })
  @Matches(/^\d{2}\.\d{2}\.\d{2}$/, { message: 'codigoTributacao must look like 01.01.01' })
  codigoTributacao: string;
}
