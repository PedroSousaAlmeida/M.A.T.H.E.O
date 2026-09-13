import { ApiProperty } from '@nestjs/swagger';

export class AuditLogResponseModel {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'date-time' }) occurredAt: string;
  @ApiProperty({ example: 'invoice.emitted', description: 'company.created | company.updated | certificate.uploaded | customer.created | customer.updated | customer.deleted | invoice.emitted | invoice.rejected | invoice.pending | invoice.cancelled | invoice.cancel_rejected | trial.blocked' }) action: string;
  @ApiProperty({ nullable: true, example: 'invoice' }) entityType: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) entityId: string | null;
  @ApiProperty({ enum: ['SUCCESS', 'FAILURE'] }) outcome: 'SUCCESS' | 'FAILURE';
  @ApiProperty({ nullable: true, example: 201 }) statusCode: number | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true, example: { dpsNumero: 7, chaveAcesso: '3550308...' } }) metadata: unknown;
  @ApiProperty({ nullable: true }) requestId: string | null;
}
