import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors } from '../../common/openapi/common-responses';
import { AlertsResponseModel } from './dto/alerts.response';
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AllowExpiredTrial } from '../companies/allow-expired-trial.decorator';
import { AlertsService } from './alerts.service';

@ApiTags('alerts')
@ApiBearerAuth('logto')
@ApiCommonErrors()
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'Avisos do dashboard, ordenados por severidade' })
  @ApiOkResponse({ type: AlertsResponseModel })
  @AllowExpiredTrial()
  forMine(@CurrentUser() user: AuthUser) {
    return this.alerts.forUser(user.id);
  }
}
