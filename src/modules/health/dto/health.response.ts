import { ApiProperty } from '@nestjs/swagger';

class RuntimeModel {
  @ApiProperty({ nullable: true, example: '1.4.0' }) bun: string | null;
  @ApiProperty({ example: 'v26.3.0' }) node: string;
  @ApiProperty({ example: 'linux' }) platform: string;
}
class DatabaseCheckModel {
  @ApiProperty({ enum: ['ok', 'error'] }) status: 'ok' | 'error';
  @ApiProperty({ nullable: true, example: 3 }) latencyMs: number | null;
}
class ChecksModel {
  @ApiProperty({ type: DatabaseCheckModel }) database: DatabaseCheckModel;
}

export class HealthResponseModel {
  @ApiProperty({ enum: ['ok', 'degraded'], description: 'degraded → HTTP 503' }) status: 'ok' | 'degraded';
  @ApiProperty({ example: 'matheo-nfse-api' }) name: string;
  @ApiProperty({ example: '0.3.2' }) version: string;
  @ApiProperty({ enum: ['alpha', 'beta', 'rc', 'stable'] }) stage: string;
  @ApiProperty({ example: 'v0' }) apiVersion: string;
  @ApiProperty({ enum: ['development', 'test', 'production'] }) environment: string;
  @ApiProperty({ enum: ['fake', 'producao-restrita', 'producao'] }) nfseEnv: string;
  @ApiProperty({ nullable: true, example: '35ae61a' }) commit: string | null;
  @ApiProperty({ type: RuntimeModel }) runtime: RuntimeModel;
  @ApiProperty({ example: 4821 }) uptimeSeconds: number;
  @ApiProperty({ format: 'date-time' }) timestamp: string;
  @ApiProperty({ type: ChecksModel }) checks: ChecksModel;
}
