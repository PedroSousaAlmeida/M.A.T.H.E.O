import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AlertModel {
  @ApiProperty({ enum: ['CERTIFICATE_MISSING', 'CERTIFICATE_EXPIRED', 'CERTIFICATE_EXPIRING', 'TRIAL_EXPIRED', 'TRIAL_ENDING', 'INVOICES_PENDING'] })
  code: string;

  @ApiProperty({ enum: ['critical', 'warning', 'info'], description: 'Alerts are ordered critical → warning → info' })
  severity: 'critical' | 'warning' | 'info';

  @ApiProperty({ example: 'Seu certificado digital vence em 12 dia(s).' })
  message: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, example: { expiresAt: '2026-10-01T00:00:00.000Z', daysLeft: 12 } })
  data?: Record<string, unknown>;
}

export class AlertsResponseModel {
  @ApiProperty({ type: [AlertModel] })
  alerts: AlertModel[];
}
