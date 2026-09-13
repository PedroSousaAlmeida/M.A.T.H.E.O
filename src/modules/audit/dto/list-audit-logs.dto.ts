import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class ListAuditLogsDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  action?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

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
