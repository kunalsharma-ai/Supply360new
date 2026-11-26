import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ReportRequest } from '@s360/contracts';
import type { Response } from 'express';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config.js';
import { ReportsService } from './reports.service.js';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly svc: ReportsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Builds queued exports and expires old ones now. Not in production, where the scheduler does it. */
  @Post('tick')
  @HttpCode(200)
  @RequirePermissions('execution.control')
  tick(@Ctx() ctx: RequestContext) {
    if (this.env.NODE_ENV === 'production') throw problem.notFound();
    return this.svc.tick(ctx.tenantId);
  }

  @Get('exports')
  @RequirePermissions('reports.read')
  list(@Ctx() ctx: RequestContext) {
    return this.svc.list(ctx);
  }

  @Post('exports')
  @HttpCode(202)
  @RequirePermissions('reports.export')
  request(@Ctx() ctx: RequestContext, @Body(new ZodPipe(ReportRequest)) b: ReportRequest) {
    return this.svc.request(ctx, b);
  }

  @Get('exports/:id')
  @RequirePermissions('reports.read')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(ctx, id);
  }

  @Get('exports/:id/download')
  @RequirePermissions('reports.export')
  async download(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await this.svc.download(ctx, id);
    res.setHeader('content-type', f.contentType);
    res.setHeader('content-disposition', `attachment; filename="${f.fileName.replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(f.content);
  }
}
