import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  EntryLinkApproval,
  Lifecycle,
  LifecycleRequest,
  OutcomeStatus,
  outcomeSlug,
  type LifecycleAction,
} from '@s360/contracts';
import {
  projectMarkets,
  projects,
  projectVersions,
  redirectHits,
  sourceConnections,
  withTenant,
  type Db,
  type Tx,
} from '@s360/db';
import { and, asc, count, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';
import { launchChecks } from './launch.js';
import { dispatchAllowed, marketDispatchAllowed, RULES, transition } from './lifecycle.js';
import { redirectPath } from './redirect.controller.js';

const ListQuery = z.object({
  lifecycle: Lifecycle.optional(),
  q: z.string().trim().max(80).optional(),
});
const CC = /^[A-Z]{2}$/;

type ProjectRow = typeof projects.$inferSelect;
type MarketRow = typeof projectMarkets.$inferSelect;

@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('projects.read')
  async list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const filters = [eq(projects.tenantId, ctx.tenantId)];
      if (q.lifecycle) filters.push(eq(projects.lifecycle, q.lifecycle));
      if (q.q) filters.push(or(ilike(projects.name, `%${q.q}%`), ilike(projects.projectCode, `%${q.q}%`))!);
      const rows = await tx
        .select()
        .from(projects)
        .where(and(...filters))
        .orderBy(desc(projects.updatedAt))
        .limit(200);
      const markets = rows.length
        ? await tx
            .select()
            .from(projectMarkets)
            .where(
              inArray(
                projectMarkets.projectId,
                rows.map((r) => r.id),
              ),
            )
        : [];
      return {
        items: rows.map((p) => {
          const ms = markets.filter((m) => m.projectId === p.id && m.sourceStatus !== 'REMOVED');
          const mine = ms.filter((m) => m.vendorLinkId);
          return {
            ...this.summary(p),
            markets: ms.map((m) => m.countryCode),
            vendorTarget: mine.reduce((a, m) => a + (m.vendorTarget ?? 0), 0),
            vendorCompletes: mine.reduce((a, m) => a + (m.vendorCompletes ?? 0), 0),
          };
        }),
      };
    });
  }

  private summary(p: ProjectRow) {
    return {
      id: p.id,
      source: p.source,
      sourceProjectId: p.sourceProjectId,
      projectCode: p.projectCode,
      name: p.name,
      clientName: p.clientName,
      projectManagerName: p.projectManagerName,
      projectType: p.projectType,
      category: p.category,
      sourceStatus: p.sourceStatus,
      lifecycle: p.lifecycle,
      dispatchAllowed: dispatchAllowed(p),
      fieldStartAt: p.fieldStartAt?.toISOString() ?? null,
      fieldEndAt: p.fieldEndAt?.toISOString() ?? null,
      version: p.version,
      sourceUpdatedAt: p.sourceUpdatedAt?.toISOString() ?? null,
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  private async load(tx: Tx, id: string, lock = false) {
    const q = tx.select().from(projects).where(eq(projects.id, id)).limit(1);
    const [p] = lock ? await q.for('update') : await q;
    if (!p) throw problem.notFound('No such project');
    const ms = await tx
      .select()
      .from(projectMarkets)
      .where(eq(projectMarkets.projectId, id))
      .orderBy(asc(projectMarkets.countryCode));
    return { p, ms: ms.filter((m) => m.sourceStatus !== 'REMOVED') };
  }

  private detail(
    ctx: RequestContext,
    p: ProjectRow,
    ms: MarketRow[],
    hits: { outcome: string; n: number }[],
    mode: string,
  ) {
    const checks = launchChecks(p, ms);
    const base = this.env.PUBLIC_BASE_URL ?? this.env.WEB_ORIGIN;
    return {
      ...this.summary(p),
      sourceMode: mode,
      markets: ms.map((m) => ({
        countryCode: m.countryCode,
        language: m.language,
        targetGroup: m.targetGroup,
        sourceStatus: m.sourceStatus,
        loiMinutes: m.loiMinutes,
        irPercent: m.irPercent,
        targetCompletes: m.targetCompletes,
        completes: m.completes,
        isSupply360Vendor: !!m.vendorLinkId,
        vendorLinkStatus: m.vendorLinkStatus,
        vendorTarget: m.vendorTarget,
        vendorCompletes: m.vendorCompletes,
        entryUrl: m.entryUrl,
        entryApprovedAt: m.entryApprovedAt?.toISOString() ?? null,
        dispatchAllowed: marketDispatchAllowed(p, m),
      })),
      checks,
      actions: (Object.keys(RULES) as LifecycleAction[]).map((a) => {
        const t = transition(p, a, ctx.permissions, checks);
        return { action: a, allowed: t.ok, reason: t.ok ? null : t.detail };
      }),
      redirects: OutcomeStatus.options.map((s) => ({
        status: s,
        url: `${base}${redirectPath(ctx.tenantSlug, p.id, outcomeSlug(s))}`,
        hits: hits.find((h) => h.outcome === s)?.n ?? 0,
      })),
    };
  }

  @Get(':id')
  @RequirePermissions('projects.read')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const { p, ms } = await this.load(tx, id);
      const hits = await tx
        .select({ outcome: redirectHits.outcome, n: count() })
        .from(redirectHits)
        .where(eq(redirectHits.projectId, id))
        .groupBy(redirectHits.outcome);
      const [c] = await tx
        .select({ mode: sourceConnections.mode })
        .from(sourceConnections)
        .where(eq(sourceConnections.id, p.connectionId));
      return this.detail(ctx, p, ms, hits, c?.mode ?? 'fixture');
    });
  }

  @Get(':id/versions')
  @RequirePermissions('projects.read')
  versions(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      await this.load(tx, id);
      const rows = await tx
        .select()
        .from(projectVersions)
        .where(eq(projectVersions.projectId, id))
        .orderBy(desc(projectVersions.version))
        .limit(50);
      return {
        items: rows.map((v) => ({
          version: v.version,
          via: v.via,
          receivedAt: v.receivedAt.toISOString(),
          contentHash: v.contentHash,
          snapshot: v.snapshot,
        })),
      };
    });
  }

  /** People move a project through its lifecycle; every move needs a reason and lands in the audit log. */
  @Post(':id/lifecycle')
  @HttpCode(200)
  @RequirePermissions('projects.read')
  lifecycle(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(LifecycleRequest)) body: z.infer<typeof LifecycleRequest>,
  ) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const { p, ms } = await this.load(tx, id, true);
      const t = transition(p, body.action, ctx.permissions, launchChecks(p, ms));
      if (!t.ok) {
        if (t.code === 'permission_denied') throw problem.forbidden('permission_denied', t.detail);
        throw problem.conflict(t.code, t.detail);
      }
      const [row] = await tx
        .update(projects)
        .set({ lifecycle: t.to, updatedAt: new Date() })
        .where(eq(projects.id, id))
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'project.lifecycle_changed',
        targetType: 'project',
        targetId: id,
        reason: body.reason,
        details: { from: p.lifecycle, to: t.to, by: 'person', action: body.action, sourceStatus: p.sourceStatus },
      });
      return this.summary(row!);
    });
  }

  /** SampTrek never returns vendor entry links through its API, so a person enters and approves Supply360's own. */
  @Put(':id/markets/:cc/entry-link')
  @RequirePermissions('projects.manage')
  entryLink(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cc') cc: string,
    @Body(new ZodPipe(EntryLinkApproval)) body: z.infer<typeof EntryLinkApproval>,
  ) {
    if (!CC.test(cc)) throw problem.notFound('No such market');
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const { p, ms } = await this.load(tx, id, true);
      const m = ms.find((x) => x.countryCode === cc);
      if (!m) throw problem.notFound('No such market');
      if (!m.vendorLinkId)
        throw problem.conflict('not_a_vendor', 'Supply360 is not a vendor in this market at SampTrek');
      const [c] = await tx.select().from(sourceConnections).where(eq(sourceConnections.id, p.connectionId));
      if (c?.mode === 'live' && c.baseUrl && new URL(body.entryUrl).host !== new URL(c.baseUrl).host) {
        throw problem.badRequest('entry_host', `The entry link must be on ${new URL(c.baseUrl).host}`);
      }
      await tx
        .update(projectMarkets)
        .set({
          entryUrl: body.entryUrl,
          entryApprovedBy: ctx.userId,
          entryApprovedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectMarkets.id, m.id));
      await this.audit.write(tx, actorOf(ctx), {
        action: 'project.entry_link_approved',
        targetType: 'project',
        targetId: id,
        details: { countryCode: cc, entryUrl: body.entryUrl, previous: m.entryUrl },
      });
      return { countryCode: cc, entryUrl: body.entryUrl };
    });
  }
}
