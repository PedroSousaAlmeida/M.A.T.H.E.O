import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class CancelInvoiceDto {
  @ApiProperty({ example: 'Erro de digitação no valor do serviço', minLength: 15, maxLength: 255 })
  @IsString()
  @Length(15, 255, { message: 'motivo must have between 15 and 255 characters' })
  motivo: string;
}
