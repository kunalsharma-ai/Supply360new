import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ForecastAssumptions } from '@s360/contracts';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config.js';
import { IntelligenceService } from './intelligence.service.js';

@Controller()
export class IntelligenceController {
  constructor(
    private readonly svc: IntelligenceService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('intelligence/delivery')
  @RequirePermissions('projects.read')
  portfolio(@Ctx() ctx: RequestContext) {
    return this.svc.portfolio(ctx);
  }

  @Get('projects/:id/forecast')
  @RequirePermissions('projects.read')
  forecast(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.forProject(ctx, id);
  }

  @Get('intelligence/assumptions')
  @RequirePermissions('projects.read')
  assumptions(@Ctx() ctx: RequestContext) {
    return this.svc.assumptions(ctx);
  }

  @Put('intelligence/assumptions')
  @RequirePermissions('settings.manage')
  setAssumptions(@Ctx() ctx: RequestContext, @Body(new ZodPipe(ForecastAssumptions)) b: ForecastAssumptions) {
    return this.svc.setAssumptions(ctx, b);
  }

  @Get('intelligence/audience')
  @RequirePermissions('audience.read')
  audience(@Ctx() ctx: RequestContext, @Query('days', new DefaultValuePipe(90), ParseIntPipe) days: number) {
    if (days < 1 || days > 730) throw problem.badRequest('bad_range', 'Days must be 1 to 730');
    return this.svc.audience(ctx, days);
  }

  /** Records forecast snapshots and risk notifications now. Not in production, where the scheduler does it. */
  @Post('intelligence/tick')
  @HttpCode(200)
  @RequirePermissions('execution.control')
  tick(@Ctx() ctx: RequestContext) {
    if (this.env.NODE_ENV === 'production') throw problem.notFound();
    return this.svc.tick(ctx.tenantId);
  }
}
