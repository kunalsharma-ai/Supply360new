import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { QaModeUpdate, SampIntelConnectionUpdate, SyntheticQaSummary, type QaMode } from '@s360/contracts';
import { projects, sampintelConnections, withTenant, type Db, type Tx } from '@s360/db';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config.js';
import { sealerFor, Sealer } from '../crypto/sealer.js';
import { DB } from '../db/db.module.js';

type Conn = typeof sampintelConnections.$inferSelect;
const tokenContext = (tenantId: string) => `sampintel:${tenantId}`;

/** DEMO summary for FIXTURE mode: shaped like SampIntel's answer and labelled so it cannot pass for real QA. */
export function fixtureSummary(ref: string): SyntheticQaSummary {
  return {
    classification: 'synthetic_qa',
    notice: 'FIXTURE: DEMO synthetic QA summary, not from a SampIntel AI workspace. Never counted as human sample.',
    projectRef: ref,
    projects: [{ code: 'QA-DEMO', name: 'DEMO sandbox QA', status: 'active', environment: 'sandbox' }],
    sessions: 12,
    outcomes: { complete: 7, terminate: 3, quota_full: 1, navigation_stop: 1 },
    assertions: { passed: 41, failed: 2 },
    blockedRedirects: 1,
    lastSessionAt: null,
  };
}

@Injectable()
export class SampIntelService {
  readonly sealer: Sealer;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {
    this.sealer = sealerFor(env);
  }

  private async conn(tx: Tx): Promise<Conn | undefined> {
    const [c] = await tx.select().from(sampintelConnections).limit(1);
    return c;
  }

  view(c: Conn | undefined) {
    return c
      ? {
          mode: c.mode,
          baseUrl: c.baseUrl,
          hasToken: !!c.tokenSealed,
          enabled: c.enabled,
          lastCheckAt: c.lastCheckAt?.toISOString() ?? null,
          lastStatus: c.lastStatus,
          updatedAt: c.updatedAt.toISOString(),
        }
      : null;
  }

  get(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => ({ connection: this.view(await this.conn(tx)) }));
  }

  set(ctx: RequestContext, b: SampIntelConnectionUpdate) {
    if (b.mode === 'live' && b.baseUrl) {
      const u = new URL(b.baseUrl);
      const local = ['localhost', '127.0.0.1'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(local && this.env.NODE_ENV !== 'production'))
        throw problem.badRequest('https_required', 'SampIntel must be reached over HTTPS');
    }
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const prev = await this.conn(tx);
      const tokenSealed = b.token ? this.sealer.seal(b.token, tokenContext(ctx.tenantId)) : (prev?.tokenSealed ?? null);
      if (b.mode === 'live' && b.enabled && !tokenSealed)
        throw problem.badRequest('token_required', 'Paste a SampIntel service token before turning the live link on');
      const values = {
        mode: b.mode,
        baseUrl: b.mode === 'live' ? b.baseUrl!.replace(/\/+$/, '') : null,
        tokenSealed,
        enabled: b.enabled,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      };
      const [row] = await tx
        .insert(sampintelConnections)
        .values({ tenantId: ctx.tenantId, ...values })
        .onConflictDoUpdate({ target: sampintelConnections.tenantId, set: values })
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'sampintel.connection_saved',
        targetType: 'sampintel_connection',
        targetId: row!.id,
        details: { mode: b.mode, baseUrl: values.baseUrl, enabled: b.enabled, tokenChanged: !!b.token },
      });
      return this.view(row);
    });
  }

  /** Reads one SampTrek project's synthetic summary. Validated against the contract; nothing is stored. */
  async fetchSummary(c: Conn, tenantId: string, ref: string): Promise<SyntheticQaSummary> {
    if (c.mode === 'fixture') return fixtureSummary(ref);
    const token = this.sealer.open(c.tokenSealed!, tokenContext(tenantId));
    const res = await fetch(`${c.baseUrl}/api/v1/integration/qa-summary?projectRef=${encodeURIComponent(ref)}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`SampIntel answered ${res.status}`);
    const parsed = SyntheticQaSummary.safeParse(await res.json());
    if (!parsed.success) throw new Error('SampIntel answered with an unexpected shape');
    return parsed.data;
  }

  check(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const c = await this.conn(tx);
      if (!c) throw problem.badRequest('not_configured', 'Save a SampIntel connection first');
      let status: string;
      try {
        await this.fetchSummary(c, ctx.tenantId, 'CHECK');
        status = 'ok';
      } catch (e) {
        status = `failed: ${(e as Error).message}`.slice(0, 200);
      }
      await tx
        .update(sampintelConnections)
        .set({ lastCheckAt: new Date(), lastStatus: status })
        .where(eq(sampintelConnections.id, c.id));
      return { status };
    });
  }

  projects(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, (tx) =>
      tx
        .select({
          id: projects.id,
          projectCode: projects.projectCode,
          name: projects.name,
          lifecycle: projects.lifecycle,
          qaMode: projects.qaMode,
        })
        .from(projects)
        .orderBy(asc(projects.projectCode)),
    );
  }

  setMode(ctx: RequestContext, id: string, mode: QaMode, reason: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [p] = await tx.select({ qaMode: projects.qaMode }).from(projects).where(eq(projects.id, id)).for('update');
      if (!p) throw problem.notFound('No such project');
      await tx.update(projects).set({ qaMode: mode }).where(eq(projects.id, id));
      await this.audit.write(tx, actorOf(ctx), {
        action: 'project.qa_mode',
        targetType: 'project',
        targetId: id,
        reason,
        details: { before: p.qaMode, after: mode },
      });
      return { id, qaMode: mode };
    });
  }

  /** The project page's synthetic card. Human-only projects never call SampIntel. */
  async forProject(ctx: RequestContext, id: string) {
    const { p, c } = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [p] = await tx
        .select({ code: projects.projectCode, qaMode: projects.qaMode })
        .from(projects)
        .where(eq(projects.id, id));
      if (!p) throw problem.notFound('No such project');
      return { p, c: await this.conn(tx) };
    });
    if (p.qaMode === 'human_only') return { qaMode: p.qaMode, connection: null, summary: null, error: null };
    if (!c || !c.enabled) return { qaMode: p.qaMode, connection: c ? 'off' : 'missing', summary: null, error: null };
    try {
      return {
        qaMode: p.qaMode,
        connection: c.mode,
        summary: await this.fetchSummary(c, ctx.tenantId, p.code),
        error: null,
      };
    } catch (e) {
      return { qaMode: p.qaMode, connection: c.mode, summary: null, error: (e as Error).message };
    }
  }
}

@Controller()
export class SampIntelController {
  constructor(private readonly svc: SampIntelService) {}

  @Get('sampintel/connection')
  @RequirePermissions('integrations.read')
  get(@Ctx() ctx: RequestContext) {
    return this.svc.get(ctx);
  }

  @Put('sampintel/connection')
  @RequirePermissions('sampintel.manage')
  set(@Ctx() ctx: RequestContext, @Body(new ZodPipe(SampIntelConnectionUpdate)) b: SampIntelConnectionUpdate) {
    return this.svc.set(ctx, b);
  }

  @Post('sampintel/connection/check')
  @HttpCode(200)
  @RequirePermissions('sampintel.manage')
  check(@Ctx() ctx: RequestContext) {
    return this.svc.check(ctx);
  }

  @Get('sampintel/projects')
  @RequirePermissions('projects.read')
  projects(@Ctx() ctx: RequestContext) {
    return this.svc.projects(ctx);
  }

  @Put('projects/:id/qa-mode')
  @RequirePermissions('sampintel.manage')
  mode(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(QaModeUpdate)) b: z.infer<typeof QaModeUpdate>,
  ) {
    return this.svc.setMode(ctx, id, b.mode, b.reason);
  }

  @Get('projects/:id/synthetic-qa')
  @RequirePermissions('projects.read')
  forProject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.forProject(ctx, id);
  }
}
