import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class UploadCertificateDto {
  @ApiProperty({ example: 'senha-do-certificado', description: 'Senha do arquivo .pfx (campo multipart)' })
  @IsString()
  @MinLength(1)
  password: string;
}
