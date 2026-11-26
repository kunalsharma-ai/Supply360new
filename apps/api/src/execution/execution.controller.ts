import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { BatchCreate, BatchDecision, ExecutionPolicyUpdate, KillSwitch } from '@s360/contracts';
import { tenants, type Db } from '@s360/db';
import { eq } from 'drizzle-orm';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';
import { batchView, ExecutionService, policyView } from './execution.service.js';

@Controller()
export class ExecutionController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly exec: ExecutionService,
  ) {}

  /** Policy, today's count against the daily maximum, cells with people left to invite, batches and totals. */
  @Get('projects/:id/execution')
  @RequirePermissions('projects.read')
  project(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.exec.projectView(ctx, id);
  }

  @Put('projects/:id/execution/policy')
  @RequirePermissions('automation.manage')
  async policy(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ExecutionPolicyUpdate)) body: ExecutionPolicyUpdate,
  ) {
    const r = await this.exec.setPolicy(ctx, id, body);
    return { policy: policyView(r.policy), cancelledSystemBatches: r.cancelledSystemBatches };
  }

  @Post('projects/:id/batches')
  @RequirePermissions('invitations.dispatch')
  async create(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(BatchCreate)) body: BatchCreate,
  ) {
    return batchView(await this.exec.createBatch(ctx, id, body));
  }

  @Post('projects/:id/batches/:bid/decision')
  @HttpCode(200)
  @RequirePermissions('invitations.dispatch')
  async decide(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bid', ParseUUIDPipe) bid: string,
    @Body(new ZodPipe(BatchDecision)) body: BatchDecision,
  ) {
    return batchView(await this.exec.decide(ctx, id, bid, body));
  }

  @Post('projects/:id/batches/:bid/send')
  @HttpCode(200)
  @RequirePermissions('invitations.dispatch')
  async send(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bid', ParseUUIDPipe) bid: string,
  ) {
    return batchView(await this.exec.sendNow(ctx, id, bid));
  }

  @Get('execution/overview')
  @RequirePermissions('projects.read')
  overview(@Ctx() ctx: RequestContext) {
    return this.exec.overview(ctx);
  }

  @Get('execution/batches')
  @RequirePermissions('projects.read')
  batches(@Ctx() ctx: RequestContext) {
    return this.exec.batches(ctx);
  }

  @Get('execution/reminders')
  @RequirePermissions('projects.read')
  reminders(@Ctx() ctx: RequestContext) {
    return this.exec.reminders(ctx);
  }

  @Get('execution/router-events')
  @RequirePermissions('projects.read')
  routerEvents(@Ctx() ctx: RequestContext) {
    return this.exec.routerEvents(ctx);
  }

  @Put('execution/kill-switch')
  @RequirePermissions('execution.emergency_stop')
  killSwitch(@Ctx() ctx: RequestContext, @Body(new ZodPipe(KillSwitch)) body: KillSwitch) {
    return this.exec.setKillSwitch(ctx, body);
  }

  /** Runs one scheduler pass for this tenant now. Not in production, where the scheduler runs on its own. */
  @Post('execution/tick')
  @HttpCode(200)
  @RequirePermissions('execution.control')
  async tick(@Ctx() ctx: RequestContext) {
    if (this.env.NODE_ENV === 'production') throw problem.notFound();
    const [t] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    return this.exec.tick(t!.id);
  }
}
