import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { CopilotAiUpdate, CopilotAsk, CopilotDecision, CopilotModelList } from '@s360/contracts';
import type { z } from 'zod';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CopilotAiService } from './ai/copilot-ai.service.js';
import { CopilotService } from './copilot.service.js';

@Controller('copilot')
export class CopilotController {
  constructor(
    private readonly svc: CopilotService,
    private readonly ai: CopilotAiService,
  ) {}

  /** The AI the Copilot uses to understand any language. Keys are sealed and never returned. */
  @Get('ai')
  @RequirePermissions('copilot.use')
  aiSettings(@Ctx() ctx: RequestContext) {
    return this.ai.get(ctx);
  }

  @Put('ai')
  @RequirePermissions('settings.manage')
  saveAi(@Ctx() ctx: RequestContext, @Body(new ZodPipe(CopilotAiUpdate)) b: CopilotAiUpdate) {
    return this.ai.save(ctx, b);
  }

  @Post('ai/test')
  @HttpCode(200)
  @RequirePermissions('settings.manage')
  testAi(@Ctx() ctx: RequestContext) {
    return this.ai.test(ctx);
  }

  @Post('ai/models')
  @HttpCode(200)
  @RequirePermissions('settings.manage')
  aiModels(@Ctx() ctx: RequestContext, @Body(new ZodPipe(CopilotModelList)) b: CopilotModelList) {
    return this.ai.models(ctx, b);
  }

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
