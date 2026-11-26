import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AudienceConnectionCreate, AudienceCriteria, SegmentCreate } from '@s360/contracts';
import {
  audienceConnections,
  audienceSegments,
  audienceSelections,
  projects,
  quotaCells,
  withTenant,
  type Db,
} from '@s360/db';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';
import { AudienceService, madpSecretContext, type AudienceConnection } from './audience.service.js';

const EnableBody = z.object({ enabled: z.boolean() });

@Controller('audience')
export class AudienceController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly audience: AudienceService,
    private readonly audit: AuditService,
  ) {}

  private view(c: AudienceConnection) {
    return {
      id: c.id,
      mode: c.mode,
      name: c.name,
      baseUrl: c.baseUrl,
      clientId: c.clientId,
      hasSecret: !!c.secretSealed,
      enabled: c.enabled,
      lastCheckAt: c.lastCheckAt?.toISOString() ?? null,
      lastCheckResult: c.lastCheckResult,
      createdAt: c.createdAt.toISOString(),
    };
  }

  @Get('connections')
  @RequirePermissions('integrations.read')
  async connections(@Ctx() ctx: RequestContext) {
    const rows = await withTenant(this.db, ctx.tenantId, (tx) =>
      tx.select().from(audienceConnections).orderBy(desc(audienceConnections.createdAt)),
    );
    return { items: rows.map((c) => this.view(c)), activeId: rows.find((c) => c.enabled)?.id ?? null };
  }

  @Post('connections')
  @RequirePermissions('integrations.manage')
  async create(
    @Ctx() ctx: RequestContext,
    @Body(new ZodPipe(AudienceConnectionCreate)) body: AudienceConnectionCreate,
  ) {
    if (body.mode === 'live' && this.env.NODE_ENV === 'production' && !body.baseUrl?.startsWith('https://'))
      throw problem.badRequest('https_required', 'LIVE MADP connections must use https in production');
    const row = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const id = (await tx.execute<{ id: string }>(sql`select uuidv7()::text as id`)).rows[0]!.id;
      const [c] = await tx
        .insert(audienceConnections)
        .values({
          id,
          tenantId: ctx.tenantId,
          mode: body.mode,
          name: body.name,
          baseUrl: body.mode === 'live' ? (body.baseUrl ?? null) : null,
          clientId: body.mode === 'live' ? (body.clientId ?? null) : null,
          secretSealed:
            body.mode === 'live' && body.secret ? this.audience.sealer.seal(body.secret, madpSecretContext(id)) : null,
          createdBy: ctx.userId,
        })
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'audience_source.created',
        targetType: 'audience_connection',
        targetId: id,
        details: { mode: body.mode, name: body.name, baseUrl: body.baseUrl ?? null, clientId: body.clientId ?? null },
      });
      return c!;
    });
    return this.view(row);
  }

  @Patch('connections/:id')
  @RequirePermissions('integrations.manage')
  async setEnabled(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(EnableBody)) body: z.infer<typeof EnableBody>,
  ) {
    const row = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [c] = await tx
        .update(audienceConnections)
        .set({ enabled: body.enabled })
        .where(eq(audienceConnections.id, id))
        .returning();
      if (!c) throw problem.notFound('No such MADP connection');
      await this.audit.write(tx, actorOf(ctx), {
        action: body.enabled ? 'audience_source.enabled' : 'audience_source.disabled',
        targetType: 'audience_connection',
        targetId: id,
      });
      return c;
    });
    return this.view(row);
  }

  /** Signed round trip to MADP: reads the attribute catalogue and a total count. */
  @Post('connections/:id/check')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async check(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const c = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [x] = await tx.select().from(audienceConnections).where(eq(audienceConnections.id, id));
      return x;
    });
    if (!c) throw problem.notFound('No such MADP connection');
    const started = Date.now();
    let result: Record<string, unknown>;
    try {
      const src = this.audience.sourceFor(c);
      const a = await src.attributes();
      const n = await src.counts({});
      result = {
        ok: true,
        ms: Date.now() - started,
        attributes: a.attributes.length,
        dataMode: n.dataMode,
        uniquePeople: n.uniquePeople,
        panelMemberships: n.panelMemberships,
      };
    } catch (e) {
      result = { ok: false, ms: Date.now() - started, error: (e as Error).message };
    }
    const row = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [x] = await tx
        .update(audienceConnections)
        .set({ lastCheckAt: new Date(), lastCheckResult: result })
        .where(eq(audienceConnections.id, id))
        .returning();
      return x!;
    });
    return this.view(row);
  }

  @Get('attributes')
  @RequirePermissions('audience.read')
  async attributes(@Ctx() ctx: RequestContext) {
    const c = await withTenant(this.db, ctx.tenantId, (tx) => this.audience.activeOrThrow(tx));
    const a = await this.audience.catalogue(c);
    return { ...a, source: { name: c.name, mode: c.mode } };
  }

  /** Feasibility. MADP counts each person once across panels (uniquePeople); memberships are shown beside it. */
  @Post('counts')
  @HttpCode(200)
  @RequirePermissions('audience.read')
  async counts(@Ctx() ctx: RequestContext, @Body(new ZodPipe(AudienceCriteria)) body: AudienceCriteria) {
    const c = await withTenant(this.db, ctx.tenantId, (tx) => this.audience.activeOrThrow(tx));
    await this.audience.validate(c, body);
    const n = await this.audience.call(() => this.audience.sourceFor(c).counts(body));
    return { ...n, source: { name: c.name, mode: c.mode } };
  }

  @Get('segments')
  @RequirePermissions('audience.read')
  async segments(@Ctx() ctx: RequestContext) {
    const rows = await withTenant(this.db, ctx.tenantId, (tx) =>
      tx.select().from(audienceSegments).orderBy(desc(audienceSegments.createdAt)).limit(200),
    );
    return {
      items: rows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        criteria: s.criteria,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  }

  @Post('segments')
  @RequirePermissions('audience.select')
  async createSegment(@Ctx() ctx: RequestContext, @Body(new ZodPipe(SegmentCreate)) body: SegmentCreate) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const c = await this.audience.active(tx);
      if (c) await this.audience.validate(c, body.criteria);
      const [s] = await tx
        .insert(audienceSegments)
        .values({
          tenantId: ctx.tenantId,
          name: body.name,
          description: body.description ?? null,
          criteria: body.criteria,
          createdBy: ctx.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!s) throw problem.conflict('duplicate_name', 'A segment with this name already exists');
      await this.audit.write(tx, actorOf(ctx), {
        action: 'segment.created',
        targetType: 'segment',
        targetId: s.id,
        details: { name: body.name, criteria: body.criteria },
      });
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        criteria: s.criteria,
        createdAt: s.createdAt.toISOString(),
      };
    });
  }

  @Delete('segments/:id')
  @HttpCode(204)
  @RequirePermissions('audience.select')
  async deleteSegment(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [s] = await tx.delete(audienceSegments).where(eq(audienceSegments.id, id)).returning();
      if (!s) throw problem.notFound('No such segment');
      await this.audit.write(tx, actorOf(ctx), {
        action: 'segment.deleted',
        targetType: 'segment',
        targetId: id,
        details: { name: s.name },
      });
    });
  }

  /** Selection snapshots: what MADP returned for each reservation, newest first. References are counted, not listed. */
  @Get('selections')
  @RequirePermissions('audience.read')
  async selections(@Ctx() ctx: RequestContext) {
    const rows = await withTenant(this.db, ctx.tenantId, (tx) =>
      tx
        .select({
          id: audienceSelections.id,
          projectId: audienceSelections.projectId,
          projectCode: projects.projectCode,
          projectName: projects.name,
          countryCode: quotaCells.countryCode,
          cellName: quotaCells.name,
          dataMode: audienceSelections.dataMode,
          criteria: audienceSelections.criteria,
          eligible: audienceSelections.eligible,
          returned: audienceSelections.returned,
          excluded: audienceSelections.excluded,
          refs: sql<number>`jsonb_array_length(${audienceSelections.refs})`.mapWith(Number),
          createdAt: audienceSelections.createdAt,
        })
        .from(audienceSelections)
        .innerJoin(projects, eq(projects.id, audienceSelections.projectId))
        .innerJoin(quotaCells, eq(quotaCells.id, audienceSelections.cellId))
        .orderBy(desc(audienceSelections.createdAt))
        .limit(100),
    );
    return { items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  }
}
