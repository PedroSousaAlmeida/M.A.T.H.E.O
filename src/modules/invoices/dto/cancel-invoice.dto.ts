import { IsString, Length } from 'class-validator';

export class CancelInvoiceDto {
  @IsString()
  @Length(15, 255, { message: 'motivo must have between 15 and 255 characters' })
  motivo: string;
}
