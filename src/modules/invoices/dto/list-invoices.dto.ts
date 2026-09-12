import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { InvoiceStatus } from '../../../../generated/prisma/client';

export class ListInvoicesDto {
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
