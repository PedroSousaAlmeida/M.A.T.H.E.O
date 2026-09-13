import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AllowExpiredTrial } from '../companies/allow-expired-trial.decorator';
import { AlertsService } from './alerts.service';

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @AllowExpiredTrial()
  forMine(@CurrentUser() user: AuthUser) {
    return this.alerts.forUser(user.id);
  }
}
