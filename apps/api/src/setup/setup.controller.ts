import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { SetupApply, SetupPreview, SetupTemplateCreate } from '@s360/contracts';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { SetupService } from './setup.service.js';

/** Copy a project's Supply360 setup from another project or a saved template. */
@Controller()
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Post('projects/:id/setup/preview')
  @HttpCode(200)
  @RequirePermissions('projects.read')
  preview(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SetupPreview)) b: SetupPreview,
  ) {
    return this.setup.preview(ctx, id, b.source, b.parts);
  }

  /** Each part needs its own permission (the same one as setting it by hand); the API names any that are missing. */
  @Post('projects/:id/setup/apply')
  @HttpCode(200)
  @RequirePermissions('projects.read')
  apply(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SetupApply)) b: SetupApply,
  ) {
    return this.setup.apply(ctx, id, b);
  }

  @Get('setup-templates')
  @RequirePermissions('projects.read')
  list(@Ctx() ctx: RequestContext) {
    return this.setup.list(ctx);
  }

  @Post('setup-templates')
  @RequirePermissions('projects.manage')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(SetupTemplateCreate)) b: SetupTemplateCreate) {
    return this.setup.create(ctx, b);
  }

  @Delete('setup-templates/:id')
  @RequirePermissions('projects.manage')
  remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.setup.remove(ctx, id);
  }
}
