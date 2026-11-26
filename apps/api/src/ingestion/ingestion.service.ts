import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Lifecycle } from '@s360/contracts';
import {
  inboundEvents,
  projectMarkets,
  projects,
  projectVersions,
  sourceConnections,
  tenants,
  withTenant,
  type Db,
  type Tx,
} from '@s360/db';
import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import type { Actor } from '../audit/audit.service.js';
import { AuditService } from '../audit/audit.service.js';
import { problem } from '../common/problem.js';
import { ENV, type Env } from '../config.js';
import { sealerFor, Sealer } from '../crypto/sealer.js';
import { DB } from '../db/db.module.js';
import { SourceError, type ProjectSource } from './adapter.js';
import { applySourceStatus } from './lifecycle.js';
import { contentHash, contentOf, normalize } from './normalize.js';
import { FixtureSampTrek } from './samptrek/fixture.js';
import { LiveSampTrek } from './samptrek/live.js';
import { StEnvelope, StStatusChanged, type StProject, type StQuotas } from './samptrek/types.js';
import { upsertCells } from '../audience/quotas.js';
import { verifySampTrek } from './signature.js';

export type Connection = typeof sourceConnections.$inferSelect;
type Via = 'poll' | 'backfill' | 'webhook' | 'manual';

export const keyContext = (id: string) => `samptrek-key:${id}`;
export const secretContext = (id: string) => `samptrek-whsec:${id}`;

const systemActor = (tenantId: string, correlationId?: string): Actor => ({
  tenantId,
  userId: null,
  email: 'system:samptrek',
  correlationId: correlationId ?? null,
});

export interface UpsertResult {
  projectId: string;
  created: boolean;
  newVersion: boolean;
  stale: boolean;
  lifecycle: { from: Lifecycle | null; to: Lifecycle };
}

export interface SyncResult {
  ok: boolean;
  via: Via;
  startedAt: string;
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: string[];
}

const MAX_ATTEMPTS = 5;

@Injectable()
export class IngestionService {
  private readonly log = new Logger('Ingestion');
  readonly sealer: Sealer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {
    this.sealer = sealerFor(env);
  }

  sourceFor(conn: Connection, timeoutMs?: number): ProjectSource {
    if (conn.mode === 'fixture') return new FixtureSampTrek(conn.id);
    if (!conn.baseUrl || !conn.apiKeySealed) throw new SourceError('LIVE connection has no base URL or key', false);
    return new LiveSampTrek(conn.baseUrl, this.sealer.open(conn.apiKeySealed, keyContext(conn.id)), fetch, timeoutMs);
  }

  /**
   * Creates or updates one project from the source's full detail, inside the caller's transaction. Safe under
   * concurrency: the unique (tenant, source, source id) index decides who creates, and the row lock orders updates.
   */
  async upsert(
    tx: Tx,
    conn: Connection,
    raw: StProject,
    via: Via,
    correlationId?: string,
    quotas?: StQuotas | null,
  ): Promise<UpsertResult> {
    const n = normalize(raw, conn.vendorCode);
    const hash = contentHash(n);
    const actor = systemActor(conn.tenantId, correlationId);
    const fields = {
      projectCode: n.projectCode,
      name: n.name,
      clientName: n.clientName,
      projectManagerName: n.projectManagerName,
      projectType: n.projectType,
      category: n.category,
      sourceStatus: n.sourceStatus,
      fieldStartAt: n.fieldStartAt,
      fieldEndAt: n.fieldEndAt,
      sourceUpdatedAt: n.sourceUpdatedAt,
    };

    const initial = applySourceStatus('imported', n.sourceStatus);
    const [inserted] = await tx
      .insert(projects)
      .values({
        tenantId: conn.tenantId,
        connectionId: conn.id,
        source: conn.kind,
        sourceProjectId: n.sourceProjectId,
        lifecycle: initial,
        contentHash: hash,
        ...fields,
      })
      .onConflictDoNothing({ target: [projects.tenantId, projects.source, projects.sourceProjectId] })
      .returning({ id: projects.id });

    if (inserted) {
      await tx.insert(projectVersions).values({
        tenantId: conn.tenantId,
        projectId: inserted.id,
        version: 1,
        contentHash: hash,
        snapshot: contentOf(n),
        via,
      });
      await this.upsertMarkets(tx, conn.tenantId, inserted.id, n.markets);
      if (quotas) await upsertCells(tx, conn.tenantId, inserted.id, n.markets, quotas);
      await this.audit.write(tx, actor, {
        action: 'project.imported',
        targetType: 'project',
        targetId: inserted.id,
        details: { projectCode: n.projectCode, via, sourceStatus: n.sourceStatus, lifecycle: initial },
      });
      return {
        projectId: inserted.id,
        created: true,
        newVersion: true,
        stale: false,
        lifecycle: { from: null, to: initial },
      };
    }

    const [cur] = await tx
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.tenantId, conn.tenantId),
          eq(projects.source, conn.kind),
          eq(projects.sourceProjectId, n.sourceProjectId),
        ),
      )
      .for('update')
      .limit(1);
    if (!cur) throw new Error('project vanished during upsert');

    // An older copy (a slow poll page racing a webhook-triggered fetch) never overwrites a newer one.
    if (cur.sourceUpdatedAt && cur.sourceUpdatedAt > n.sourceUpdatedAt) {
      return {
        projectId: cur.id,
        created: false,
        newVersion: false,
        stale: true,
        lifecycle: { from: cur.lifecycle, to: cur.lifecycle },
      };
    }

    const to = applySourceStatus(cur.lifecycle, n.sourceStatus);
    const changed = hash !== cur.contentHash;
    const version = changed ? cur.version + 1 : cur.version;
    await tx
      .update(projects)
      .set({ ...fields, lifecycle: to, contentHash: hash, version, updatedAt: new Date() })
      .where(eq(projects.id, cur.id));
    if (changed) {
      await tx.insert(projectVersions).values({
        tenantId: conn.tenantId,
        projectId: cur.id,
        version,
        contentHash: hash,
        snapshot: contentOf(n),
        via,
      });
      await this.audit.write(tx, actor, {
        action: 'project.version_created',
        targetType: 'project',
        targetId: cur.id,
        details: { projectCode: n.projectCode, version, via },
      });
    }
    await this.upsertMarkets(tx, conn.tenantId, cur.id, n.markets);
    // Quotas that could not be fetched leave the cells as they were; the next sync tries again.
    if (quotas) await upsertCells(tx, conn.tenantId, cur.id, n.markets, quotas);
    if (to !== cur.lifecycle) {
      await this.audit.write(tx, actor, {
        action: 'project.lifecycle_changed',
        targetType: 'project',
        targetId: cur.id,
        reason: `SampTrek status ${n.sourceStatus}`,
        details: { from: cur.lifecycle, to, by: 'source', sourceStatus: n.sourceStatus, via },
      });
    }
    return {
      projectId: cur.id,
      created: false,
      newVersion: changed,
      stale: false,
      lifecycle: { from: cur.lifecycle, to },
    };
  }

  private async upsertMarkets(
    tx: Tx,
    tenantId: string,
    projectId: string,
    markets: ReturnType<typeof normalize>['markets'],
  ) {
    for (const m of markets) {
      await tx
        .insert(projectMarkets)
        .values({ tenantId, projectId, ...m })
        .onConflictDoUpdate({
          target: [projectMarkets.projectId, projectMarkets.countryCode],
          set: {
            language: m.language,
            targetGroup: m.targetGroup,
            sourceStatus: m.sourceStatus,
            loiMinutes: m.loiMinutes,
            irPercent: m.irPercent,
            targetCompletes: m.targetCompletes,
            completes: m.completes,
            vendorLinkId: m.vendorLinkId,
            vendorLinkStatus: m.vendorLinkStatus,
            vendorTarget: m.vendorTarget,
            vendorCompletes: m.vendorCompletes,
            // A different vendor link means a different entry link: the approval no longer applies.
            entryUrl: sql`case when ${projectMarkets.vendorLinkId} is distinct from excluded.vendor_link_id then null else ${projectMarkets.entryUrl} end`,
            entryApprovedBy: sql`case when ${projectMarkets.vendorLinkId} is distinct from excluded.vendor_link_id then null else ${projectMarkets.entryApprovedBy} end`,
            entryApprovedAt: sql`case when ${projectMarkets.vendorLinkId} is distinct from excluded.vendor_link_id then null else ${projectMarkets.entryApprovedAt} end`,
            updatedAt: new Date(),
          },
        });
    }
    const codes = markets.map((m) => m.countryCode);
    await tx
      .update(projectMarkets)
      .set({ sourceStatus: 'REMOVED', updatedAt: new Date() })
      .where(
        and(
          eq(projectMarkets.projectId, projectId),
          codes.length ? notInArray(projectMarkets.countryCode, codes) : sql`true`,
        ),
      );
  }

  async connection(tenantId: string, id: string): Promise<Connection | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [c] = await tx.select().from(sourceConnections).where(eq(sourceConnections.id, id)).limit(1);
      return c ?? null;
    });
  }

  /** Poll (changed since the checkpoint) or backfill (everything). The checkpoint only moves after a clean run. */
  async sync(conn: Connection, full: boolean, correlationId?: string): Promise<SyncResult> {
    const via: Via = full ? 'backfill' : 'poll';
    const started = new Date();
    const r: SyncResult = {
      ok: true,
      via,
      startedAt: started.toISOString(),
      seen: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      errors: [],
    };
    let newest = conn.pollCheckpoint;
    try {
      const src = this.sourceFor(conn);
      const since = full ? undefined : (conn.pollCheckpoint ?? undefined);
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await src.listProjects({ updatedSince: since, cursor });
        for (const item of page.data) {
          r.seen++;
          try {
            const detail = await src.getProject(item.id);
            if (!detail) continue;
            let quotas: StQuotas | null = null;
            try {
              quotas = await src.getQuotas(item.id);
            } catch (e) {
              r.errors.push(`${item.projectCode} quotas: ${(e as Error).message}`);
            }
            const u = await withTenant(this.db, conn.tenantId, (tx) =>
              this.upsert(tx, conn, detail, via, correlationId, quotas),
            );
            if (u.created) r.created++;
            else if (u.newVersion || u.lifecycle.from !== u.lifecycle.to) r.updated++;
            else r.unchanged++;
            const at = new Date(item.updatedAt);
            if (!newest || at > newest) newest = at;
          } catch (e) {
            r.errors.push(`${item.projectCode}: ${(e as Error).message}`);
          }
        }
        cursor = page.nextCursor;
      } while (cursor && ++pages < 1000);
    } catch (e) {
      r.errors.push((e as Error).message);
    }
    r.ok = r.errors.length === 0;
    await withTenant(this.db, conn.tenantId, (tx) =>
      tx
        .update(sourceConnections)
        .set({ lastSyncAt: started, lastSyncResult: r, ...(r.ok ? { pollCheckpoint: newest } : {}) })
        .where(eq(sourceConnections.id, conn.id)),
    );
    return r;
  }

  /** Signed webhook from SampTrek: verify, record once in the inbox, then process. */
  async receive(
    tenantSlug: string,
    connectionId: string,
    h: { timestamp?: string; signature?: string; delivery?: string },
    raw: Buffer,
    correlationId?: string,
  ): Promise<{ status: 'processed' | 'ignored' | 'failed' | 'duplicate' }> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID.test(connectionId)) throw problem.notFound();
    const [t] = await this.db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1);
    if (!t || t.status !== 'active') throw problem.notFound();
    const conn = await this.connection(t.id, connectionId);
    if (!conn || !conn.enabled) throw problem.notFound();

    const v = verifySampTrek(this.sealer.open(conn.webhookSecretSealed, secretContext(conn.id)), h, raw);
    if (!v.ok) {
      await withTenant(this.db, t.id, (tx) =>
        tx
          .update(sourceConnections)
          .set({
            rejectedCount: sql`${sourceConnections.rejectedCount} + 1`,
            lastRejectedAt: new Date(),
            lastRejectedReason: v.reason,
          })
          .where(eq(sourceConnections.id, conn.id)),
      );
      throw problem.unauthorized('signature_invalid', 'Webhook signature did not verify');
    }

    let env: StEnvelope;
    try {
      env = StEnvelope.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      throw problem.badRequest('invalid_envelope', 'Body is not a SampTrek webhook envelope');
    }
    const payload = sanitize(env);

    const row = await withTenant(this.db, t.id, async (tx) => {
      const [ins] = await tx
        .insert(inboundEvents)
        .values({
          tenantId: t.id,
          connectionId: conn.id,
          source: conn.kind,
          eventId: env.id,
          eventType: env.event,
          deliveryId: h.delivery?.slice(0, 200) ?? null,
          signedAt: v.signedAt,
          payload,
        })
        .onConflictDoNothing({ target: [inboundEvents.tenantId, inboundEvents.source, inboundEvents.eventId] })
        .returning();
      if (!ins) {
        await tx
          .update(inboundEvents)
          .set({ duplicates: sql`${inboundEvents.duplicates} + 1` })
          .where(and(eq(inboundEvents.source, conn.kind), eq(inboundEvents.eventId, env.id)));
      }
      return ins ?? null;
    });
    if (!row) return { status: 'duplicate' };
    return { status: await this.process(conn, row, correlationId) };
  }

  /** Applies one inbox event. Never throws: a failure is recorded on the row and retried by the poller. */
  async process(
    conn: Connection,
    row: typeof inboundEvents.$inferSelect,
    correlationId?: string,
  ): Promise<'processed' | 'ignored' | 'failed'> {
    const mark = (status: 'processed' | 'ignored' | 'failed', error: string | null, tx?: Tx) => {
      const q = (x: Tx) =>
        x
          .update(inboundEvents)
          .set({
            status,
            error,
            attempts: sql`${inboundEvents.attempts} + 1`,
            processedAt: status === 'failed' ? null : new Date(),
          })
          .where(eq(inboundEvents.id, row.id));
      return tx ? q(tx) : withTenant(this.db, conn.tenantId, q);
    };
    try {
      const env = row.payload as StEnvelope;
      switch (row.eventType) {
        case 'project.status_changed': {
          const d = StStatusChanged.parse(env.data);
          let detail: StProject | null = null;
          let quotas: StQuotas | null = null;
          let fetchError: string | null = null;
          try {
            const src = this.sourceFor(conn, 4000);
            detail = await src.getProject(d.project.id);
            if (detail) quotas = await src.getQuotas(d.project.id).catch(() => null);
          } catch (e) {
            fetchError = (e as Error).message;
          }
          await withTenant(this.db, conn.tenantId, async (tx) => {
            if (detail) {
              await this.upsert(tx, conn, detail, 'webhook', correlationId, quotas);
            } else {
              // Source unreachable or project not visible: apply the signed status itself, newest event wins.
              const [cur] = await tx
                .select()
                .from(projects)
                .where(and(eq(projects.source, conn.kind), eq(projects.sourceProjectId, d.project.id)))
                .for('update')
                .limit(1);
              if (!cur) throw new Error(fetchError ?? 'project not found at source');
              const at = new Date(env.createdAt);
              if (!cur.sourceUpdatedAt || at >= cur.sourceUpdatedAt) {
                const to = applySourceStatus(cur.lifecycle, d.to);
                await tx
                  .update(projects)
                  .set({ sourceStatus: d.to, lifecycle: to, sourceUpdatedAt: at, updatedAt: new Date() })
                  .where(eq(projects.id, cur.id));
                if (to !== cur.lifecycle) {
                  await this.audit.write(tx, systemActor(conn.tenantId, correlationId), {
                    action: 'project.lifecycle_changed',
                    targetType: 'project',
                    targetId: cur.id,
                    reason: `SampTrek status ${d.to}`,
                    details: { from: cur.lifecycle, to, by: 'source', sourceStatus: d.to, via: 'webhook-status-only' },
                  });
                }
              }
            }
            await mark('processed', fetchError ? `Applied the signed status only: ${fetchError}` : null, tx);
          });
          return 'processed';
        }
        case 'ping':
          await mark('ignored', 'Test delivery');
          return 'ignored';
        case 'session.completed':
        case 'alert.opened':
          await mark('ignored', 'Participation events are handled from Phase 5');
          return 'ignored';
        case 'invoice.status_changed':
        case 'bill.status_changed':
          await mark('ignored', 'Finance is out of scope for Supply360');
          return 'ignored';
        default:
          await mark('ignored', `Unknown event ${row.eventType}`);
          return 'ignored';
      }
    } catch (e) {
      this.log.warn(`event ${row.eventId} failed: ${(e as Error).message}`);
      await mark('failed', (e as Error).message.slice(0, 500));
      return 'failed';
    }
  }

  /** Retries failed inbox rows (bounded attempts), oldest first. */
  async retryFailed(tenantId: string): Promise<number> {
    const rows = await withTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(inboundEvents)
        .where(and(inArray(inboundEvents.status, ['failed', 'pending']), lt(inboundEvents.attempts, MAX_ATTEMPTS)))
        .orderBy(inboundEvents.receivedAt)
        .limit(50),
    );
    let n = 0;
    for (const row of rows) {
      const conn = await this.connection(tenantId, row.connectionId);
      if (conn?.enabled && (await this.process(conn, row)) === 'processed') n++;
    }
    return n;
  }
}

/** Drops what Supply360 must not keep: the changer's e-mail, and any price fields. */
function sanitize(env: StEnvelope) {
  // Only project status events are used in Phase 2; others keep the envelope without data (no session details).
  if (env.event !== 'project.status_changed')
    return { id: env.id, event: env.event, createdAt: env.createdAt, data: {} };
  const data = structuredClone(env.data) as Record<string, unknown>;
  const by = data.changedBy as { name?: unknown } | undefined;
  if (by && typeof by === 'object') data.changedBy = { name: typeof by.name === 'string' ? by.name : null };
  for (const k of ['revenue', 'payout', 'cpi']) delete data[k];
  return { id: env.id, event: env.event, createdAt: env.createdAt, data };
}
