import { ApiProperty } from '@nestjs/swagger';

export class CompanyResponseModel {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: '11222333000181' }) cnpj: string;
  @ApiProperty({ example: 'Minha MEI LTDA' }) razaoSocial: string;
  @ApiProperty({ nullable: true, example: '123456' }) inscricaoMunicipal: string | null;
  @ApiProperty({ example: '3550308' }) codigoMunicipio: string;
  @ApiProperty({ nullable: true, example: 'contato@exemplo.com' }) email: string | null;
  @ApiProperty({ nullable: true, example: '11999999999' }) telefone: string | null;
  @ApiProperty({ description: 'Whether an A1 certificate is stored (the certificate itself is never returned)' }) hasCertificate: boolean;
  @ApiProperty({ nullable: true, format: 'date-time' }) certificateExpiry: string | null;
  @ApiProperty({ enum: ['TRIAL', 'ACTIVE'] }) plan: 'TRIAL' | 'ACTIVE';
  @ApiProperty({ format: 'date-time', description: 'End of the 30-day trial, counted from POST /companies' }) trialEndsAt: string;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}
