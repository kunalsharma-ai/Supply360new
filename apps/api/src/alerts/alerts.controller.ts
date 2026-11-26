import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { AlertSettingsUpdate, AlertTest } from '@s360/contracts';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AlertsService } from './alerts.service.js';

/** Alerts by email and chat webhook, and the daily digest. Configured here, never in environment files. */
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @RequirePermissions('settings.read')
  get(@Ctx() ctx: RequestContext) {
    return this.alerts.get(ctx);
  }

  @Put()
  @RequirePermissions('settings.manage')
  save(@Ctx() ctx: RequestContext, @Body(new ZodPipe(AlertSettingsUpdate)) b: AlertSettingsUpdate) {
    return this.alerts.save(ctx, b);
  }

  @Post('test')
  @HttpCode(200)
  @RequirePermissions('settings.manage')
  test(@Ctx() ctx: RequestContext, @Body(new ZodPipe(AlertTest)) b: AlertTest) {
    return this.alerts.test(ctx, b.channel);
  }

  /** Runs the alert step now for this workspace, as the scheduler would. */
  @Post('run')
  @HttpCode(200)
  @RequirePermissions('settings.manage')
  run(@Ctx() ctx: RequestContext) {
    return this.alerts.tick(ctx.tenantId);
  }
}
