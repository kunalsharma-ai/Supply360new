import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { SampTrekProjectStatus, SourceConnectionCreate } from '@s360/contracts';
import { inboundEvents, sourceConnections, withTenant, type Db } from '@s360/db';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';
import { IngestionService, keyContext, secretContext, type Connection } from './ingestion.service.js';
import { fixtureStore } from './samptrek/fixture.js';
import { signSampTrek } from './signature.js';

const SyncBody = z.object({ full: z.boolean().default(false) });
const EnableBody = z.object({ enabled: z.boolean() });
const SimulateBody = z.object({ projectCode: z.string().regex(/^[A-Z0-9-]{3,40}$/), status: SampTrekProjectStatus });
const Page = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const webhookPath = (tenantSlug: string, id: string) => `/api/v1/webhooks/samptrek/${tenantSlug}/${id}`;

@Controller('sources')
export class SourcesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly ingestion: IngestionService,
    private readonly audit: AuditService,
  ) {}

  private view(c: Connection, tenantSlug: string) {
    const base = this.env.PUBLIC_BASE_URL ?? this.env.WEB_ORIGIN;
    return {
      id: c.id,
      kind: c.kind,
      mode: c.mode,
      name: c.name,
      baseUrl: c.baseUrl,
      hasApiKey: !!c.apiKeySealed,
      vendorCode: c.vendorCode,
      enabled: c.enabled,
      webhookUrl: `${base}${webhookPath(tenantSlug, c.id)}`,
      webhookEvents: ['project.status_changed'],
      callbackUrlTemplate: `${base}/api/v1/s2s/samptrek/${tenantSlug}/${c.id}?uid={uid}&status={status}`,
      hasCallbackSecret: !!c.callbackSecretSealed || c.mode === 'fixture',
      pollCheckpoint: c.pollCheckpoint?.toISOString() ?? null,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      lastSyncResult: c.lastSyncResult,
      rejectedCount: c.rejectedCount,
      lastRejectedAt: c.lastRejectedAt?.toISOString() ?? null,
      lastRejectedReason: c.lastRejectedReason,
      createdAt: c.createdAt.toISOString(),
    };
  }

  private async load(ctx: RequestContext, id: string) {
    const c = await this.ingestion.connection(ctx.tenantId, id);
    if (!c) throw problem.notFound('No such source connection');
    return c;
  }

  @Get()
  @RequirePermissions('integrations.read')
  async list(@Ctx() ctx: RequestContext) {
    const rows = await withTenant(this.db, ctx.tenantId, (tx) =>
      tx.select().from(sourceConnections).orderBy(desc(sourceConnections.createdAt)),
    );
    return { items: rows.map((c) => this.view(c, ctx.tenantSlug)) };
  }

  /** The webhook secret is returned once, here; afterwards only its use is visible. */
  @Post()
  @RequirePermissions('integrations.manage')
  async create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(SourceConnectionCreate)) body: SourceConnectionCreate) {
    if (body.mode === 'live' && this.env.NODE_ENV === 'production' && !body.baseUrl?.startsWith('https://')) {
      throw problem.badRequest('https_required', 'LIVE SampTrek connections must use https in production');
    }
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const row = await withTenant(this.db, ctx.tenantId, async (tx) => {
      // The id is the sealing context, so it is drawn before the insert.
      const id = (await tx.execute<{ id: string }>(sql`select uuidv7()::text as id`)).rows[0]!.id;
      const [c] = await tx
        .insert(sourceConnections)
        .values({
          id,
          tenantId: ctx.tenantId,
          kind: body.kind,
          mode: body.mode,
          name: body.name,
          baseUrl: body.baseUrl ?? null,
          apiKeySealed: body.apiKey ? this.ingestion.sealer.seal(body.apiKey, keyContext(id)) : null,
          webhookSecretSealed: this.ingestion.sealer.seal(secret, secretContext(id)),
          vendorCode: body.vendorCode.toUpperCase(),
          createdBy: ctx.userId,
        })
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'source.created',
        targetType: 'source_connection',
        targetId: id,
        details: { kind: body.kind, mode: body.mode, name: body.name, baseUrl: body.baseUrl ?? null },
      });
      return c!;
    });
    return { ...this.view(row, ctx.tenantSlug), webhookSecret: secret };
  }

  @Patch(':id')
  @RequirePermissions('integrations.manage')
  async setEnabled(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(EnableBody)) body: z.infer<typeof EnableBody>,
  ) {
    await this.load(ctx, id);
    const row = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [c] = await tx
        .update(sourceConnections)
        .set({ enabled: body.enabled })
        .where(eq(sourceConnections.id, id))
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: body.enabled ? 'source.enabled' : 'source.disabled',
        targetType: 'source_connection',
        targetId: id,
      });
      return c!;
    });
    return this.view(row, ctx.tenantSlug);
  }

  @Post(':id/rotate-secret')
  @RequirePermissions('integrations.manage')
  async rotate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.load(ctx, id);
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    await withTenant(this.db, ctx.tenantId, async (tx) => {
      await tx
        .update(sourceConnections)
        .set({ webhookSecretSealed: this.ingestion.sealer.seal(secret, secretContext(id)) })
        .where(eq(sourceConnections.id, id));
      await this.audit.write(tx, actorOf(ctx), {
        action: 'source.secret_rotated',
        targetType: 'source_connection',
        targetId: id,
      });
    });
    return { webhookSecret: secret };
  }

  @Post(':id/sync')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async sync(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SyncBody)) body: z.infer<typeof SyncBody>,
  ) {
    const c = await this.load(ctx, id);
    if (!c.enabled) throw problem.conflict('source_disabled', 'Turn the connection on first');
    const r = await this.ingestion.sync(c, body.full, ctx.correlationId);
    await withTenant(this.db, ctx.tenantId, (tx) =>
      this.audit.write(tx, actorOf(ctx), {
        action: body.full ? 'source.backfill' : 'source.sync',
        targetType: 'source_connection',
        targetId: id,
        details: { ...r },
      }),
    );
    return r;
  }

  /**
   * FIXTURE only, never in production: change a sample project the way SampTrek would and deliver the signed
   * `project.status_changed` webhook through the real inbox, so the reaction can be seen end to end.
   */
  @Post(':id/fixture/status')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async simulate(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SimulateBody)) body: z.infer<typeof SimulateBody>,
  ) {
    const c = await this.load(ctx, id);
    if (c.mode !== 'fixture' || this.env.NODE_ENV === 'production') {
      throw problem.forbidden('fixture_only', 'Simulation works on FIXTURE connections outside production only');
    }
    const p = fixtureStore(c.id).find((x) => x.projectCode === body.projectCode);
    if (!p) throw problem.notFound('No such FIXTURE project');
    const from = p.status;
    p.status = body.status;
    for (const m of p.markets) m.status = body.status === 'INVOICED' ? 'CLOSED' : body.status;
    // SampTrek's updatedAt only moves forward; the fixture keeps that property.
    p.updatedAt = new Date(Math.max(Date.now(), Date.parse(p.updatedAt) + 1)).toISOString();
    const envelope = JSON.stringify({
      id: `evt_fx_${randomBytes(8).toString('hex')}`,
      event: 'project.status_changed',
      createdAt: p.updatedAt,
      data: {
        project: { id: p.id, projectCode: p.projectCode, name: p.name },
        from,
        to: body.status,
        changedBy: { name: 'FIXTURE' },
      },
    });
    const secret = this.ingestion.sealer.open(c.webhookSecretSealed, secretContext(c.id));
    const h = signSampTrek(secret, envelope);
    return this.ingestion.receive(
      ctx.tenantSlug,
      c.id,
      { timestamp: h['x-projexa-timestamp'], signature: h['x-projexa-signature'], delivery: 'fixture' },
      Buffer.from(envelope),
      ctx.correlationId,
    );
  }

  @Get('events')
  @RequirePermissions('integrations.read')
  async events(@Ctx() ctx: RequestContext, @Query(new ZodPipe(Page)) q: z.infer<typeof Page>) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      let where = eq(inboundEvents.tenantId, ctx.tenantId);
      if (q.cursor) {
        const [at, rid] = q.cursor.split('|');
        if (at && rid) {
          const d = new Date(at);
          where = and(
            where,
            or(lt(inboundEvents.receivedAt, d), and(eq(inboundEvents.receivedAt, d), lt(inboundEvents.id, rid))),
          )!;
        }
      }
      const rows = await tx
        .select()
        .from(inboundEvents)
        .where(where)
        .orderBy(desc(inboundEvents.receivedAt), desc(inboundEvents.id))
        .limit(q.limit + 1);
      const items = rows.slice(0, q.limit);
      const last = items.at(-1);
      return {
        items: items.map((e) => ({
          id: e.id,
          connectionId: e.connectionId,
          eventId: e.eventId,
          eventType: e.eventType,
          status: e.status,
          attempts: e.attempts,
          duplicates: e.duplicates,
          error: e.error,
          signedAt: e.signedAt.toISOString(),
          receivedAt: e.receivedAt.toISOString(),
          processedAt: e.processedAt?.toISOString() ?? null,
          payload: e.payload,
        })),
        nextCursor: rows.length > q.limit && last ? `${last.receivedAt.toISOString()}|${last.id}` : null,
      };
    });
  }

  @Post('events/:id/retry')
  @HttpCode(200)
  @RequirePermissions('integrations.manage')
  async retry(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const row = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [e] = await tx.select().from(inboundEvents).where(eq(inboundEvents.id, id)).limit(1);
      return e;
    });
    if (!row) throw problem.notFound('No such event');
    if (row.status !== 'failed') throw problem.conflict('not_failed', 'Only failed events can be retried');
    const c = await this.load(ctx, row.connectionId);
    const status = await this.ingestion.process(c, row, ctx.correlationId);
    await withTenant(this.db, ctx.tenantId, (tx) =>
      this.audit.write(tx, actorOf(ctx), {
        action: 'source.event_retried',
        targetType: 'inbound_event',
        targetId: id,
        details: { status },
      }),
    );
    return { status };
  }
}
