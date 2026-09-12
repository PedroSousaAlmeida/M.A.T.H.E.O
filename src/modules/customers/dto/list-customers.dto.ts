import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class ListCustomersDto {
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsString()
  @Length(1, 100)
  search?: string;

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
