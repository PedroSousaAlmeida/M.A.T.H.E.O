import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Public. 200 when every check passes, 503 (status "degraded") otherwise — usable as a container healthcheck. */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.report();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
