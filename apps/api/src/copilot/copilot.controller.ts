import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CopilotAsk, CopilotDecision } from '@s360/contracts';
import type { z } from 'zod';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CopilotService } from './copilot.service.js';

@Controller('copilot')
export class CopilotController {
  constructor(private readonly svc: CopilotService) {}

  @Get()
  @RequirePermissions('copilot.use')
  history(@Ctx() ctx: RequestContext) {
    return this.svc.history(ctx);
  }

  @Post('ask')
  @HttpCode(200)
  @RequirePermissions('copilot.use')
  ask(@Ctx() ctx: RequestContext, @Body(new ZodPipe(CopilotAsk)) b: z.infer<typeof CopilotAsk>) {
    return this.svc.ask(ctx, b.prompt);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @RequirePermissions('copilot.use')
  decide(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CopilotDecision)) b: z.infer<typeof CopilotDecision>,
  ) {
    return this.svc.decide(ctx, id, b);
  }
}
