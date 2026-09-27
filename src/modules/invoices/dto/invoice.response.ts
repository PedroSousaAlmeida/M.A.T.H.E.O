import { ApiProperty } from '@nestjs/swagger';

export class InvoiceResponseModel {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) companyId: string;
  @ApiProperty({ nullable: true, format: 'uuid', description: 'Saved customer used on emission, if any' }) customerId: string | null;
  @ApiProperty({ enum: ['PENDING', 'ISSUED', 'REJECTED', 'CANCELLED'] }) status: 'PENDING' | 'ISSUED' | 'REJECTED' | 'CANCELLED';
  @ApiProperty({ example: 7, description: 'Sequential DPS number per company/series' }) dpsNumero: number;
  @ApiProperty({ example: '1' }) dpsSerie: string;
  @ApiProperty({ example: '12345678909' }) tomadorDocumento: string;
  @ApiProperty({ example: 'Cliente Exemplo' }) tomadorNome: string;
  @ApiProperty({ nullable: true }) tomadorEmail: string | null;
  @ApiProperty({ example: 'Consultoria em TI' }) descricao: string;
  @ApiProperty({ example: '150.00', description: 'Decimal string with 2 places' }) valor: string;
  @ApiProperty({ example: '01.01.01' }) codigoTributacao: string;
  @ApiProperty({ nullable: true, example: '35503082...', description: '50-digit access key once ISSUED' }) chaveAcesso: string | null;
  @ApiProperty({ nullable: true, example: '7' }) numeroNfse: string | null;
  @ApiProperty({ nullable: true, description: '"code: reason" from the national API when REJECTED' }) rejectionReason: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) cancelledAt: string | null;
  @ApiProperty({ nullable: true }) cancelReason: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}
