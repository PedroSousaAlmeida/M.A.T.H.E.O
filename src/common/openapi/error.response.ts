import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Body of every error response (see HttpExceptionFilter). */
export class ErrorResponse {
  @ApiProperty({ example: 422 })
  statusCode: number;

  @ApiProperty({ example: 'NFS-e rejected by the national API' })
  message: string;

  @ApiPropertyOptional({ description: 'Validation: array of field messages. Business errors: object with context (e.g. { invoiceId, code, reason }).', oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object', additionalProperties: true }] })
  details?: unknown;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', description: 'Same value as the x-request-id response header' })
  requestId: string;
}
