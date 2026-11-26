import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  CallbackSecret,
  DROPOUT_KINDS,
  FixtureApproval,
  FixtureOutcome,
  FlagReview,
  Outcome,
  ParticipantQuery,
  RecontactRequest,
  ReinviteRequest,
} from '@s360/contracts';
import { invitations, projects, withTenant, type Db } from '@s360/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';
import { ExecutionService } from '../execution/execution.service.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { fixtureSessions, fixtureStore } from '../ingestion/samptrek/fixture.js';
import { FieldworkService } from './fieldwork.service.js';
import { signCallback } from './outcomes.js';
import { RecontactService } from './recontact.service.js';

const list = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .max(400)
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(item));
const ParticipantsQuery = ParticipantQuery.extend({
  outcomes: list(Outcome).optional(),
  approvedOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const DropoutsQuery = z.object({
  kinds: list(z.enum(DROPOUT_KINDS)).optional(),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});
const FlagsQuery = z.object({
  status: z.enum(['open', 'accepted', 'dismissed']).optional(),
  projectId: z.uuid().optional(),
});
const Page = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const RewardsSync = z.object({ retryUnavailable: z.boolean().default(true) });

@Controller()
export class FieldworkController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly fw: FieldworkService,
    private readonly recontacts: RecontactService,
    private readonly ingestion: IngestionService,
    private readonly exec: ExecutionService,
  ) {}

  // ── live fieldwork ──

  @Get('fieldwork/live')
  @RequirePermissions('projects.read')
  live(@Ctx() ctx: RequestContext) {
    return this.fw.live(ctx);
  }

  /** Funnel, outcomes, incidence, LOI, per-market and per-cell progress, open flags and the last reconciliation. */
  @Get('projects/:id/fieldwork')
  @RequirePermissions('projects.read')
  fieldwork(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fw.fieldwork(ctx, id);
  }

  @Get('projects/:id/participation')
  @RequirePermissions('projects.read')
  participation(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(Page)) q: z.infer<typeof Page>,
  ) {
    return this.fw.participation(ctx, id, q.cursor, q.limit);
  }

  // ── quality ──

  @Get('quality/flags')
  @RequirePermissions('projects.read')
  flags(@Ctx() ctx: RequestContext, @Query(new ZodPipe(FlagsQuery)) q: z.infer<typeof FlagsQuery>) {
    return this.fw.flags(ctx, q.status, q.projectId);
  }

  @Post('quality/flags/:id/review')
  @HttpCode(200)
  @RequirePermissions('quality.review')
  review(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(FlagReview)) body: FlagReview,
  ) {
    return this.fw.review(ctx, id, body);
  }

  // ── reconciliation ──

  @Post('projects/:id/reconciliation')
  @HttpCode(200)
  @RequirePermissions('reconciliation.manage')
  reconcile(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fw.reconcile(ctx.tenantId, id, actorOf(ctx));
  }

  @Get('reconciliation/runs')
  @RequirePermissions('projects.read')
  runs(@Ctx() ctx: RequestContext, @Query('projectId') projectId?: string) {
    if (projectId && !z.uuid().safeParse(projectId).success) throw problem.badRequest('invalid_project', 'Bad id');
    return this.fw.runs(ctx, projectId);
  }

  @Get('reconciliation/runs/:id')
  @RequirePermissions('projects.read')
  run(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fw.run(ctx, id);
  }

  // ── rewards ──

  @Get('rewards')
  @RequirePermissions('projects.read')
  rewards(@Ctx() ctx: RequestContext) {
    return this.fw.rewards(ctx);
  }

  @Post('rewards/sync')
  @HttpCode(200)
  @RequirePermissions('rewards.sync')
  syncRewards(@Ctx() ctx: RequestContext, @Body(new ZodPipe(RewardsSync)) body: z.infer<typeof RewardsSync>) {
    return this.fw.flushRewards(ctx.tenantId, body.retryUnavailable);
  }

  // ── recontact and reinvite ──

  /** Past participants by when they took part (a week, a month, a year back, or any range), outcome and market. */
  @Get('recontact/participants')
  @RequirePermissions('audience.read')
  participants(
    @Ctx() ctx: RequestContext,
    @Query(new ZodPipe(ParticipantsQuery)) q: z.infer<typeof ParticipantsQuery>,
  ) {
    const { cursor, limit, ...filter } = q;
    return this.recontacts.participants(ctx, filter, cursor, limit);
  }

  @Post('projects/:id/quotas/:cellId/recontact')
  @RequirePermissions('audience.select')
  recontact(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cellId', ParseUUIDPipe) cellId: string,
    @Body(new ZodPipe(RecontactRequest)) body: RecontactRequest,
  ) {
    return this.recontacts.recontact(ctx, id, cellId, body);
  }

  @Get('projects/:id/dropouts')
  @RequirePermissions('projects.read')
  dropouts(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(DropoutsQuery)) q: z.infer<typeof DropoutsQuery>,
  ) {
    return this.recontacts.dropouts(ctx, id, q.kinds, q.countryCode);
  }

  @Post('projects/:id/reinvite')
  @HttpCode(200)
  @RequirePermissions('invitations.dispatch')
  reinvite(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ReinviteRequest)) body: ReinviteRequest,
  ) {
    return this.recontacts.reinvite(ctx, id, body);
  }

  // ── source callback set-up ──

  @Get('sources/:id/callback')
  @RequirePermissions('integrations.read')
  async callbackInfo(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.connection(ctx, id);
    return {
      callbackUrlTemplate: this.fw.callbackUrlTemplate(ctx.tenantSlug, c.id),
      hasCallbackSecret: !!c.callbackSecretSealed || c.mode === 'fixture',
      method: 'GET',
      macros: ['{uid}', '{status}'],
      note: 'Paste this into the Supply360 vendor in SampTrek as its callback URL, and the vendor callback secret here.',
    };
  }

  @Put('sources/:id/callback-secret')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async setSecret(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CallbackSecret)) body: z.infer<typeof CallbackSecret>,
  ) {
    const c = await this.connection(ctx, id);
    await this.fw.setCallbackSecret(ctx, c, body.secret);
    return { hasCallbackSecret: true };
  }

  // ── FIXTURE simulators, never in production ──

  /**
   * Plays a respondent: opens their link through the real router if they have not yet, then finishes the survey
   * at SampTrek, which adds the session to the FIXTURE sessions API and sends the signed S2S callback through the
   * real verification path.
   */
  @Post('sources/:id/fixture/outcome')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async simulateOutcome(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(FixtureOutcome)) body: z.infer<typeof FixtureOutcome>,
  ) {
    const c = await this.fixture(ctx, id);
    const inv = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [row] = await tx
        .select({ i: invitations, conn: projects.connectionId, code: projects.projectCode })
        .from(invitations)
        .innerJoin(projects, eq(projects.id, invitations.projectId))
        .where(eq(invitations.id, body.invitationId));
      return row;
    });
    if (!inv || inv.conn !== c.id) throw problem.notFound('No such invitation on this connection');
    const uid = this.exec.signer.sign(inv.i.id);
    // The respondent opens their link first, through the real survey router, as they would before SampTrek.
    if (!inv.i.clickedAt) {
      const r = await this.exec.route(ctx.tenantSlug, uid, 'GET', 'Mozilla/5.0 (FIXTURE respondent)');
      if (r.kind !== 'click')
        throw problem.conflict('link_refused', 'The survey router refused this link, so SampTrek has no session');
    }
    const now = Date.now();
    const loi = (body.loiMinutes ?? 12) * 60_000;
    const sessionId = `fx-ses-${inv.i.id.slice(-12)}`;
    const store = fixtureSessions(c.id);
    const prior = store.get(sessionId);
    store.set(sessionId, {
      id: sessionId,
      status: body.status.toUpperCase(),
      approval: body.status === 'complete' ? (prior?.approval ?? 'PENDING') : 'NOT_APPLICABLE',
      verified: true,
      uid,
      startedAt: prior?.startedAt ?? new Date(now - loi).toISOString(),
      outcomeAt: new Date(now).toISOString(),
      countryCode: inv.i.countryCode,
      projectCode: inv.code,
      vendorCode: c.vendorCode,
    });
    const url = this.fw
      .callbackUrlTemplate(ctx.tenantSlug, c.id)
      .replace('{uid}', encodeURIComponent(uid))
      .replace('{status}', body.status);
    const secret = (await this.fw.callbackSecret(c))!;
    const h = signCallback(secret, url);
    const r = await this.fw.callback(
      ctx.tenantSlug,
      c.id,
      url,
      {
        timestamp: h['x-projexa-timestamp'],
        signature: h['x-projexa-signature'],
        idempotencyKey: `cb:${sessionId}:${body.status}:vendor`,
      },
      { uid, status: body.status },
    );
    return { ...r, sessionId };
  }

  /** Plays the client approving or rejecting completes at SampTrek, then reconciles the project to pick it up. */
  @Post('sources/:id/fixture/approve')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async simulateApproval(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(FixtureApproval)) body: z.infer<typeof FixtureApproval>,
  ) {
    const c = await this.fixture(ctx, id);
    const fx = fixtureStore(c.id).find((p) => p.projectCode === body.projectCode);
    if (!fx) throw problem.notFound('No such FIXTURE project');
    let changed = 0;
    for (const s of fixtureSessions(c.id).values()) {
      if (body.count && changed >= body.count) break;
      if (s.projectCode === fx.projectCode && s.status === 'COMPLETE' && s.approval === 'PENDING') {
        s.approval = body.decision;
        changed++;
      }
    }
    const [p] = await withTenant(this.db, ctx.tenantId, (tx) =>
      tx.select({ id: projects.id }).from(projects).where(eq(projects.sourceProjectId, fx.id)),
    );
    const run = p ? await this.fw.reconcile(ctx.tenantId, p.id, actorOf(ctx)) : null;
    return { changed, reconciliation: run && { id: run.id, summary: run.summary } };
  }

  private async connection(ctx: RequestContext, id: string) {
    const c = await this.ingestion.connection(ctx.tenantId, id);
    if (!c) throw problem.notFound('No such source connection');
    return c;
  }

  private async fixture(ctx: RequestContext, id: string) {
    const c = await this.connection(ctx, id);
    if (c.mode !== 'fixture' || this.env.NODE_ENV === 'production')
      throw problem.forbidden('fixture_only', 'Simulation works on FIXTURE connections outside production only');
    return c;
  }
}
