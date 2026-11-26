import { Inject, Injectable, Logger } from '@nestjs/common';
import { OUTCOMES, type FlagReview } from '@s360/contracts';
import {
  executionPolicies,
  invitations,
  participationEvents,
  projectMarkets,
  projects,
  qualityFlags,
  quotaCells,
  reconciliationRuns,
  reminderJobs,
  rewardEvents,
  sourceConnections,
  tenants,
  withTenant,
  type Db,
  type Tx,
} from '@s360/db';
import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { actorOf, AuditService, type Actor } from '../audit/audit.service.js';
import { AudienceService } from '../audience/audience.service.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';
import { ExecutionService } from '../execution/execution.service.js';
import { SourceError } from '../ingestion/adapter.js';
import { IngestionService, type Connection } from '../ingestion/ingestion.service.js';
import type { SourceSession } from '../ingestion/samptrek/types.js';
import {
  derive,
  incidence,
  isSpeeder,
  kindOf,
  loiStats,
  verifyCallback,
  type EventKind,
  type Source,
} from './outcomes.js';

type Invitation = typeof invitations.$inferSelect;
export const callbackContext = (id: string) => `samptrek-callback:${id}`;
export const s2sPath = (tenantSlug: string, connectionId: string) =>
  `/api/v1/s2s/samptrek/${tenantSlug}/${connectionId}`;

const systemActor = (tenantId: string): Actor => ({ tenantId, userId: null, email: 'system', correlationId: null });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 500;

export interface EventIn {
  kind: EventKind;
  source: Source;
  occurredAt: Date;
  dedupeKey: string;
  sessionRef?: string | null;
  /** Survey start at the source, used for LOI when the start event itself never arrived. */
  sourceStartedAt?: Date | null;
  detail?: Record<string, unknown>;
}
export interface Recorded {
  status: 'recorded' | 'duplicate';
  effect: string;
  invitationId: string;
}

/**
 * Participation tracking, live fieldwork, quality flags, reconciliation and rewards (spec §9).
 *
 * Rules, each covered by an integration test:
 * - Outcomes come only from verified sources: SampTrek's signed S2S callbacks and its authenticated sessions API.
 *   A click is never a start and a redirect landing is never a complete.
 * - Every event is stored once per dedupe key and applied under the invitation row lock, so a retry, a replay or
 *   two sources reporting the same thing never count twice, whatever order they arrive in.
 * - Quality flags are for a person to accept or dismiss. They never reject anyone by themselves.
 * - A reward event is queued once per client-approved complete and handed to MADP with an idempotency key.
 *   Supply360 never credits a wallet.
 */
@Injectable()
export class FieldworkService {
  private readonly log = new Logger('Fieldwork');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly ingestion: IngestionService,
    private readonly audience: AudienceService,
    private readonly exec: ExecutionService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── callback secret and URL ─────────────────────────────

  callbackUrlTemplate(tenantSlug: string, connectionId: string) {
    const base = this.env.PUBLIC_BASE_URL ?? this.env.WEB_ORIGIN;
    return `${base}${s2sPath(tenantSlug, connectionId)}?uid={uid}&status={status}`;
  }

  /** The callback secret. A FIXTURE connection gets one on first use; a LIVE one needs SampTrek's, set by a person. */
  async callbackSecret(conn: Connection): Promise<string | null> {
    if (conn.callbackSecretSealed)
      return this.ingestion.sealer.open(conn.callbackSecretSealed, callbackContext(conn.id));
    if (conn.mode !== 'fixture') return null;
    const secret = `cbsec_${randomBytes(24).toString('base64url')}`;
    await withTenant(this.db, conn.tenantId, (tx) =>
      tx
        .update(sourceConnections)
        .set({ callbackSecretSealed: this.ingestion.sealer.seal(secret, callbackContext(conn.id)) })
        .where(and(eq(sourceConnections.id, conn.id), isNull(sourceConnections.callbackSecretSealed))),
    );
    const fresh = await this.ingestion.connection(conn.tenantId, conn.id);
    return this.ingestion.sealer.open(fresh!.callbackSecretSealed!, callbackContext(conn.id));
  }

  async setCallbackSecret(ctx: RequestContext, conn: Connection, secret: string) {
    await withTenant(this.db, ctx.tenantId, async (tx) => {
      await tx
        .update(sourceConnections)
        .set({ callbackSecretSealed: this.ingestion.sealer.seal(secret, callbackContext(conn.id)) })
        .where(eq(sourceConnections.id, conn.id));
      await this.audit.write(tx, actorOf(ctx), {
        action: 'source.callback_secret_set',
        targetType: 'source_connection',
        targetId: conn.id,
      });
    });
  }

  // ───────────────────────────── recording events ─────────────────────────────

  /**
   * Stores one verified event and applies it to the invitation's derived state. The caller holds the invitation
   * row lock (`for update`), which orders every event for one person.
   */
  async record(tx: Tx, inv: Invitation, e: EventIn): Promise<Recorded> {
    // Events are append-only: what the derivation does is decided first and stored with the event.
    const change = derive(inv, e.kind, e.source, e.occurredAt);
    const [row] = await tx
      .insert(participationEvents)
      .values({
        tenantId: inv.tenantId,
        projectId: inv.projectId,
        invitationId: inv.id,
        kind: e.kind,
        source: e.source,
        verified: true,
        occurredAt: e.occurredAt,
        dedupeKey: e.dedupeKey,
        sessionRef: e.sessionRef ?? null,
        effect: change.effect,
        detail: e.detail ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: participationEvents.id });
    if (!row) return { status: 'duplicate', effect: 'duplicate', invitationId: inv.id };

    const patch: Partial<Invitation> = { ...change.patch };
    if (e.sessionRef && !inv.sessionRef) patch.sessionRef = e.sessionRef;
    if (!inv.startedAt && e.sourceStartedAt) patch.startedAt = e.sourceStartedAt;
    const cur = { ...inv, ...patch };
    if (cur.outcome !== 'complete') {
      if (inv.loiSeconds !== null) patch.loiSeconds = null;
    } else if (cur.loiSeconds === null && cur.startedAt && cur.outcomeAt) {
      // LOI only from a start a source reported, never from the outcome's own time.
      patch.loiSeconds = Math.max(0, Math.round((cur.outcomeAt.getTime() - cur.startedAt.getTime()) / 1000));
    }

    if (Object.keys(patch).length) await tx.update(invitations).set(patch).where(eq(invitations.id, inv.id));
    Object.assign(inv, patch);

    const flags: { kind: string; detail: Record<string, unknown> }[] = [];
    if (change.flag) flags.push(change.flag);
    if (patch.outcome === 'duplicate' || patch.outcome === 'security_reject')
      flags.push({ kind: 'source_security', detail: { outcome: patch.outcome, source: e.source } });
    if (patch.loiSeconds != null) {
      const [pol] = await tx
        .select({ pct: executionPolicies.speederPercent })
        .from(executionPolicies)
        .where(eq(executionPolicies.projectId, inv.projectId));
      const [m] = await tx
        .select({ loi: projectMarkets.loiMinutes })
        .from(projectMarkets)
        .where(and(eq(projectMarkets.projectId, inv.projectId), eq(projectMarkets.countryCode, inv.countryCode)));
      if (pol?.pct && m?.loi && isSpeeder(patch.loiSeconds, m.loi, pol.pct))
        flags.push({
          kind: 'speeder',
          detail: { loiSeconds: patch.loiSeconds, expectedMinutes: m.loi, thresholdPercent: pol.pct },
        });
    }
    if (flags.length)
      await tx
        .insert(qualityFlags)
        .values(flags.map((f) => ({ tenantId: inv.tenantId, projectId: inv.projectId, invitationId: inv.id, ...f })))
        .onConflictDoNothing();

    // A start or an outcome means the person is in the survey or done: no more reminders.
    if (patch.startedAt || patch.outcome)
      await tx
        .update(reminderJobs)
        .set({ status: 'cancelled', reason: patch.outcome ? 'outcome' : 'started', doneAt: new Date() })
        .where(and(eq(reminderJobs.invitationId, inv.id), eq(reminderJobs.status, 'pending')));

    // Rewards follow the client's final decision on a complete.
    if (inv.outcome === 'complete' && inv.approval === 'approved')
      await tx
        .insert(rewardEvents)
        .values({
          tenantId: inv.tenantId,
          projectId: inv.projectId,
          invitationId: inv.id,
          idempotencyKey: `s360-reward-${inv.id}`,
        })
        .onConflictDoNothing();
    else if ('approval' in patch || 'outcome' in patch) {
      const [r] = await tx.select().from(rewardEvents).where(eq(rewardEvents.invitationId, inv.id));
      if (r && r.status !== 'acknowledged') await tx.delete(rewardEvents).where(eq(rewardEvents.id, r.id));
      else if (r)
        await tx
          .insert(qualityFlags)
          .values({
            tenantId: inv.tenantId,
            projectId: inv.projectId,
            invitationId: inv.id,
            kind: 'reward_after_reversal',
            detail: { outcome: inv.outcome, approval: inv.approval },
          })
          .onConflictDoNothing();
    }
    return { status: 'recorded', effect: change.effect, invitationId: inv.id };
  }

  /**
   * SampTrek's vendor S2S callback: GET to the template Supply360 gave it, signed over the full URL. A bad
   * signature is a 401 and counted on the connection. A valid one for someone Supply360 never invited is
   * acknowledged and ignored, so SampTrek stops retrying it.
   */
  async callback(
    tenantSlug: string,
    connectionId: string,
    url: string,
    h: { timestamp?: string; signature?: string; idempotencyKey?: string },
    q: { uid?: string; status?: string },
    body = '',
  ) {
    if (!/^[a-z0-9-]{2,63}$/.test(tenantSlug) || !UUID.test(connectionId)) throw problem.notFound();
    const [t] = await this.db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1);
    if (t?.status !== 'active') throw problem.notFound();
    const conn = await this.ingestion.connection(t.id, connectionId);
    if (!conn?.enabled) throw problem.notFound();
    const secret = await this.callbackSecret(conn);
    const v = secret
      ? verifyCallback(secret, h, url, body)
      : ({ ok: false, reason: 'no callback secret is set for this connection' } as const);
    if (!v.ok) {
      await withTenant(this.db, t.id, (tx) =>
        tx
          .update(sourceConnections)
          .set({
            rejectedCount: sql`${sourceConnections.rejectedCount} + 1`,
            lastRejectedAt: new Date(),
            lastRejectedReason: `callback: ${v.reason}`,
          })
          .where(eq(sourceConnections.id, conn.id)),
      );
      throw problem.unauthorized('signature_invalid', 'Callback signature did not verify');
    }
    const kind = kindOf(q.status ?? '');
    if (!kind) throw problem.badRequest('unknown_status', 'status is not a SampTrek outcome');
    const invId = q.uid ? this.exec.signer.verify(q.uid) : null;
    if (!invId) return { status: 'ignored', reason: 'unknown_respondent' };
    const occurredAt = new Date(Number(h.timestamp) * 1000);
    return withTenant(this.db, t.id, async (tx) => {
      const [inv] = await tx.select().from(invitations).where(eq(invitations.id, invId)).for('update');
      if (!inv) return { status: 'ignored', reason: 'unknown_respondent' };
      const [p] = await tx.select({ conn: projects.connectionId }).from(projects).where(eq(projects.id, inv.projectId));
      if (p?.conn !== conn.id) return { status: 'ignored', reason: 'other_connection' };
      const key =
        h.idempotencyKey && h.idempotencyKey.length <= 200 ? `cb:${h.idempotencyKey}` : `cb-${inv.id}-${kind}`;
      const r = await this.record(tx, inv, { kind, source: 'samptrek_callback', occurredAt, dedupeKey: key });
      return { status: r.status, effect: r.effect };
    });
  }

  // ───────────────────────────── reconciliation ─────────────────────────────

  /**
   * Pulls Supply360's sessions for a project from SampTrek's sessions API, the source of record, records what
   * was missing, and stores what differed. Safe to run any number of times: every event has a stable dedupe key.
   */
  async reconcile(tenantId: string, projectId: string, actor: Actor) {
    const { p, conn } = await withTenant(this.db, tenantId, async (tx) => {
      const [p] = await tx.select().from(projects).where(eq(projects.id, projectId));
      if (!p) throw problem.notFound('No such project');
      const [conn] = await tx.select().from(sourceConnections).where(eq(sourceConnections.id, p.connectionId));
      return { p, conn: conn! };
    });
    const startedAt = new Date();
    let sessions: SourceSession[] | null;
    try {
      sessions = await this.ingestion.sourceFor(conn).getSessions(p.sourceProjectId, conn.vendorCode);
    } catch (e) {
      const msg = e instanceof SourceError ? e.message : (e as Error).message;
      const run = await this.saveRun(tenantId, projectId, actor, startedAt, 'failed', { error: msg }, []);
      throw problem.badGateway('source_unavailable', `${msg} (run ${run.id})`);
    }
    if (sessions === null) throw problem.notFound('SampTrek does not know this project');

    const diffs: Record<string, unknown>[] = [];
    const tally = { sessions: sessions.length, matched: 0, applied: 0, duplicates: 0, conflicts: 0, unverified: 0 };
    const seen = new Set<string>();
    const owned = sessions
      .map((s) => ({ s, inv: s.uid ? this.exec.signer.verify(s.uid) : null }))
      .filter((x) => {
        if (!x.inv) diffs.push({ kind: 'unknown_respondent', session: x.s.id, status: x.s.status });
        return !!x.inv;
      });
    for (let i = 0; i < owned.length; i += CHUNK) {
      await withTenant(this.db, tenantId, async (tx) => {
        for (const { s, inv: id } of owned.slice(i, i + CHUNK)) {
          const [inv] = await tx.select().from(invitations).where(eq(invitations.id, id!)).for('update');
          if (inv?.projectId !== projectId) {
            diffs.push({ kind: 'unknown_respondent', session: s.id, status: s.status });
            continue;
          }
          tally.matched++;
          seen.add(inv.id);
          const kind = kindOf(s.status);
          const before = inv.outcome;
          const started = s.startedAt ? new Date(s.startedAt) : null;
          const results: Recorded[] = [];
          if (started)
            results.push(
              await this.record(tx, inv, {
                kind: 'started',
                source: 'samptrek_sessions',
                occurredAt: started,
                dedupeKey: `st-${s.id}-started`,
                sessionRef: s.id,
              }),
            );
          if (kind && kind !== 'started') {
            if (!s.verified) {
              tally.unverified++;
              diffs.push({ kind: 'unverified_at_source', invitationId: inv.id, session: s.id, status: s.status });
            } else {
              const at = s.outcomeAt ? new Date(s.outcomeAt) : startedAt;
              const r = await this.record(tx, inv, {
                kind,
                source: 'samptrek_sessions',
                occurredAt: at,
                dedupeKey: `st-${s.id}-${kind}`,
                sessionRef: s.id,
                sourceStartedAt: started,
              });
              results.push(r);
              if (before && before !== kind && r.status === 'recorded')
                diffs.push({
                  kind: 'outcome_mismatch',
                  invitationId: inv.id,
                  session: s.id,
                  had: before,
                  source: kind,
                });
            }
          }
          const decision =
            s.approval === 'APPROVED' ? 'client_approved' : s.approval === 'REJECTED' ? 'client_rejected' : null;
          if (decision)
            results.push(
              await this.record(tx, inv, {
                kind: decision,
                source: 'samptrek_sessions',
                occurredAt: startedAt,
                dedupeKey: `st-${s.id}-${decision}`,
                sessionRef: s.id,
              }),
            );
          for (const r of results) {
            if (r.status === 'duplicate') tally.duplicates++;
            else if (r.effect === 'conflict') tally.conflicts++;
            else if (r.effect === 'applied') tally.applied++;
          }
        }
      });
    }
    const missing = await withTenant(this.db, tenantId, (tx) =>
      tx
        .select({ id: invitations.id, outcome: invitations.outcome })
        .from(invitations)
        .where(and(eq(invitations.projectId, projectId), isNotNull(invitations.outcome)))
        .limit(100_000),
    );
    for (const m of missing)
      if (!seen.has(m.id)) diffs.push({ kind: 'missing_at_source', invitationId: m.id, had: m.outcome });

    const after = await withTenant(this.db, tenantId, (tx) => this.counts(tx, eq(invitations.projectId, projectId)));
    const summary = {
      ...tally,
      differences: diffs.length,
      supply360: after,
      source: {
        complete: sessions.filter((s) => s.status === 'COMPLETE').length,
        approved: sessions.filter((s) => s.approval === 'APPROVED').length,
        rejected: sessions.filter((s) => s.approval === 'REJECTED').length,
      },
    };
    const run = await this.saveRun(tenantId, projectId, actor, startedAt, 'finished', summary, diffs.slice(0, 1000));
    await this.flushOutcomes(tenantId);
    await this.flushRewards(tenantId);
    return { id: run.id, status: run.status, summary, differences: diffs.slice(0, 200) };
  }

  private async saveRun(
    tenantId: string,
    projectId: string,
    actor: Actor,
    startedAt: Date,
    status: string,
    summary: Record<string, unknown>,
    differences: unknown[],
  ) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [run] = await tx
        .insert(reconciliationRuns)
        .values({
          tenantId,
          projectId,
          status,
          summary,
          differences,
          startedBy: actor.userId,
          startedAt,
          finishedAt: new Date(),
        })
        .returning();
      await this.audit.write(tx, actor, {
        action: 'reconciliation.run',
        targetType: 'project',
        targetId: projectId,
        details: { runId: run!.id, status, ...summary },
      });
      return run!;
    });
  }

  // ───────────────────────────── outboxes: outcomes and rewards to MADP ─────────────────────────────

  /** Reports starts and outcomes to MADP. Event ids are stable, so a resend after a crash is harmless. */
  async flushOutcomes(tenantId: string, limit = 1000): Promise<number> {
    const work = await withTenant(this.db, tenantId, async (tx) => {
      const conn = await this.audience.active(tx);
      if (!conn) return null;
      const rows = await tx
        .select({
          id: invitations.id,
          madp: invitations.madpInvitationId,
          outcome: invitations.outcome,
          at: invitations.outcomeAt,
          startedAt: invitations.startedAt,
        })
        .from(invitations)
        .where(and(isNotNull(invitations.outcome), isNull(invitations.outcomeReportedAt)))
        .limit(limit);
      return { conn, rows };
    });
    if (!work?.rows.length) return 0;
    const event = (o: string) => (o === 'partial' ? 'partial' : o);
    try {
      await this.audience.sourceFor(work.conn).participation(
        work.rows.flatMap((r) => [
          ...(r.startedAt
            ? [
                {
                  eventId: `s360-start-${r.id}`,
                  invitationId: r.madp,
                  event: 'start',
                  occurredAt: r.startedAt.toISOString(),
                },
              ]
            : []),
          {
            eventId: `s360-${r.outcome}-${r.id}`,
            invitationId: r.madp,
            event: event(r.outcome!),
            occurredAt: r.at!.toISOString(),
          },
        ]),
      );
    } catch (e) {
      this.log.warn(`outcome report waits: ${(e as Error).message}`);
      return 0;
    }
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .update(invitations)
        .set({ outcomeReportedAt: new Date() })
        .where(
          and(
            inArray(
              invitations.id,
              work.rows.map((r) => r.id),
            ),
            isNotNull(invitations.outcome),
          ),
        ),
    );
    return work.rows.length;
  }

  /**
   * Hands reward events to MADP. FIXTURE acknowledges them (nothing is credited anywhere). LIVE answers
   * `unavailable`: MADP has no reward endpoint yet, and Supply360 never credits a wallet itself.
   */
  async flushRewards(
    tenantId: string,
    retryUnavailable = false,
    limit = 1000,
  ): Promise<{ acknowledged: number; unavailable: number }> {
    return withTenant(this.db, tenantId, async (tx) => {
      const conn = await this.audience.active(tx);
      const rows = await tx
        .select()
        .from(rewardEvents)
        .where(
          retryUnavailable
            ? inArray(rewardEvents.status, ['pending', 'unavailable'])
            : eq(rewardEvents.status, 'pending'),
        )
        .orderBy(asc(rewardEvents.createdAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (!rows.length || !conn) return { acknowledged: 0, unavailable: 0 };
      const ok = conn.mode === 'fixture';
      const now = new Date();
      await tx
        .update(rewardEvents)
        .set({
          status: ok ? 'acknowledged' : 'unavailable',
          detail: ok
            ? 'FIXTURE: acknowledged by the demo MADP; nothing was credited'
            : 'MADP has no reward endpoint yet; nothing was credited',
          attempts: sql`${rewardEvents.attempts} + 1`,
          sentAt: ok ? now : null,
        })
        .where(
          inArray(
            rewardEvents.id,
            rows.map((r) => r.id),
          ),
        );
      return ok ? { acknowledged: rows.length, unavailable: 0 } : { acknowledged: 0, unavailable: rows.length };
    });
  }

  /** One scheduler pass: report outcomes and hand over rewards. */
  async tick(tenantId: string) {
    const outcomesReported = await this.flushOutcomes(tenantId);
    const rewards = await this.flushRewards(tenantId);
    return { outcomesReported, rewardsAcknowledged: rewards.acknowledged };
  }

  /** Reconciles every live project whose last run is older than `minutes`. Failures wait for the next pass. */
  async autoReconcile(tenantId: string, minutes: number) {
    if (minutes <= 0) return 0;
    const due = await withTenant(this.db, tenantId, (tx) =>
      tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.lifecycle, 'live'),
            sql`not exists (select 1 from ${reconciliationRuns} r where r.project_id = ${projects.id}
              and r.started_at > now() - make_interval(mins => ${minutes}))`,
          ),
        )
        .limit(20),
    );
    let n = 0;
    for (const p of due) {
      try {
        await this.reconcile(tenantId, p.id, systemActor(tenantId));
        n++;
      } catch (e) {
        this.log.warn(`reconciliation of ${p.id} waits: ${(e as Error).message}`);
      }
    }
    return n;
  }

  // ───────────────────────────── quality flags ─────────────────────────────

  async flags(ctx: RequestContext, status?: string, projectId?: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const where = and(
        status ? eq(qualityFlags.status, status) : undefined,
        projectId ? eq(qualityFlags.projectId, projectId) : undefined,
      );
      const rows = await tx
        .select({
          f: qualityFlags,
          projectCode: projects.projectCode,
          countryCode: invitations.countryCode,
          outcome: invitations.outcome,
          loiSeconds: invitations.loiSeconds,
        })
        .from(qualityFlags)
        .innerJoin(projects, eq(projects.id, qualityFlags.projectId))
        .innerJoin(invitations, eq(invitations.id, qualityFlags.invitationId))
        .where(where)
        .orderBy(desc(qualityFlags.createdAt))
        .limit(500);
      const [{ open } = { open: 0 }] = await tx
        .select({ open: count() })
        .from(qualityFlags)
        .where(eq(qualityFlags.status, 'open'));
      return {
        open,
        items: rows.map(({ f, ...r }) => ({
          id: f.id,
          projectId: f.projectId,
          projectCode: r.projectCode,
          invitationId: f.invitationId,
          countryCode: r.countryCode,
          outcome: r.outcome,
          loiSeconds: r.loiSeconds,
          kind: f.kind,
          detail: f.detail,
          status: f.status,
          reviewReason: f.reviewReason,
          reviewedAt: f.reviewedAt?.toISOString() ?? null,
          createdAt: f.createdAt.toISOString(),
        })),
      };
    });
  }

  /** A person accepts (the concern is real) or dismisses a flag. Neither changes the outcome SampTrek reported. */
  async review(ctx: RequestContext, id: string, body: FlagReview) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [f] = await tx.select().from(qualityFlags).where(eq(qualityFlags.id, id)).for('update');
      if (!f) throw problem.notFound('No such flag');
      if (f.status !== 'open') throw problem.conflict('already_reviewed', `This flag was already ${f.status}`);
      const status = body.decision === 'accept' ? 'accepted' : 'dismissed';
      await tx
        .update(qualityFlags)
        .set({ status, reviewedBy: ctx.userId, reviewedAt: new Date(), reviewReason: body.reason })
        .where(eq(qualityFlags.id, id));
      await this.audit.write(tx, actorOf(ctx), {
        action: `quality.flag_${status}`,
        targetType: 'quality_flag',
        targetId: id,
        reason: body.reason,
        details: { kind: f.kind, projectId: f.projectId, invitationId: f.invitationId },
      });
      return { id, status };
    });
  }

  // ───────────────────────────── reads ─────────────────────────────

  /** Outcome counts for invitations matching a condition. */
  async counts(tx: Tx, where: ReturnType<typeof eq>) {
    const rows = await tx
      .select({
        sent: sql<number>`count(*) filter (where ${invitations.sentAt} is not null)::int`,
        clicked: sql<number>`count(*) filter (where ${invitations.clickedAt} is not null)::int`,
        started: sql<number>`count(*) filter (where ${invitations.startedAt} is not null or ${invitations.outcome} is not null)::int`,
        approved: sql<number>`count(*) filter (where ${invitations.approval} = 'approved')::int`,
        rejected: sql<number>`count(*) filter (where ${invitations.approval} = 'rejected')::int`,
        ...Object.fromEntries(
          OUTCOMES.map((o) => [o, sql<number>`count(*) filter (where ${invitations.outcome} = ${o})::int`]),
        ),
      })
      .from(invitations)
      .where(where);
    const r = rows[0] as Record<string, number>;
    return {
      ...r,
      pendingApproval: (r.complete ?? 0) - (r.approved ?? 0) - (r.rejected ?? 0),
      incidence: incidence(r.complete ?? 0, r.terminate ?? 0),
    } as Record<string, number | null>;
  }

  async fieldwork(ctx: RequestContext, projectId: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [p] = await tx.select().from(projects).where(eq(projects.id, projectId));
      if (!p) throw problem.notFound('No such project');
      const total = await this.counts(tx, eq(invitations.projectId, projectId));
      const markets = await tx.select().from(projectMarkets).where(eq(projectMarkets.projectId, projectId));
      const cells = await tx
        .select()
        .from(quotaCells)
        .where(and(eq(quotaCells.projectId, projectId), eq(quotaCells.removed, false)))
        .orderBy(asc(quotaCells.countryCode), asc(quotaCells.groupName), asc(quotaCells.name));
      const lois = await tx
        .select({ s: invitations.loiSeconds, cc: invitations.countryCode })
        .from(invitations)
        .where(
          and(
            eq(invitations.projectId, projectId),
            eq(invitations.outcome, 'complete'),
            isNotNull(invitations.loiSeconds),
          ),
        );
      const [pol] = await tx
        .select({ pct: executionPolicies.speederPercent })
        .from(executionPolicies)
        .where(eq(executionPolicies.projectId, projectId));
      const [run] = await tx
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.projectId, projectId))
        .orderBy(desc(reconciliationRuns.startedAt))
        .limit(1);
      const [{ openFlags } = { openFlags: 0 }] = await tx
        .select({ openFlags: count() })
        .from(qualityFlags)
        .where(and(eq(qualityFlags.projectId, projectId), eq(qualityFlags.status, 'open')));
      const now = Date.now();
      return {
        project: {
          id: p.id,
          projectCode: p.projectCode,
          name: p.name,
          lifecycle: p.lifecycle,
          fieldEndAt: p.fieldEndAt?.toISOString() ?? null,
          daysLeft: p.fieldEndAt ? Math.ceil((p.fieldEndAt.getTime() - now) / 86_400_000) : null,
        },
        total,
        loi: loiStats(lois.map((x) => x.s!)),
        speederPercent: pol?.pct ?? null,
        openFlags,
        markets: await Promise.all(
          markets.map(async (m) => {
            const c = await this.counts(
              tx,
              and(eq(invitations.projectId, projectId), eq(invitations.countryCode, m.countryCode))!,
            );
            const ml = loiStats(lois.filter((x) => x.cc === m.countryCode).map((x) => x.s!));
            return {
              countryCode: m.countryCode,
              sourceStatus: m.sourceStatus,
              target: m.vendorTarget,
              expectedLoiMinutes: m.loiMinutes,
              expectedIrPercent: m.irPercent,
              medianLoiMinutes: ml.median,
              ...c,
              remaining: m.vendorTarget ? Math.max(0, m.vendorTarget - (c.complete ?? 0)) : null,
            };
          }),
        ),
        cells: await Promise.all(
          cells.map(async (cell) => {
            const c = await this.counts(tx, eq(invitations.cellId, cell.id));
            return {
              id: cell.id,
              countryCode: cell.countryCode,
              group: cell.groupName,
              name: cell.name,
              isOpen: cell.isOpen,
              target: cell.allocationTarget,
              complete: c.complete,
              terminate: c.terminate,
              quota_full: c.quota_full,
              incidence: c.incidence,
              reached: !!cell.allocationTarget && (c.complete ?? 0) >= cell.allocationTarget,
            };
          }),
        ),
        lastReconciliation: run ? runView(run) : null,
      };
    });
  }

  /** Every project with fieldwork, for the live overview. */
  async live(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: projects.id,
          projectCode: projects.projectCode,
          name: projects.name,
          lifecycle: projects.lifecycle,
          fieldEndAt: projects.fieldEndAt,
          sent: sql<number>`count(${invitations.id}) filter (where ${invitations.sentAt} is not null)::int`,
          clicked: sql<number>`count(${invitations.id}) filter (where ${invitations.clickedAt} is not null)::int`,
          started: sql<number>`count(${invitations.id}) filter (where ${invitations.startedAt} is not null or ${invitations.outcome} is not null)::int`,
          complete: sql<number>`count(${invitations.id}) filter (where ${invitations.outcome} = 'complete')::int`,
          terminate: sql<number>`count(${invitations.id}) filter (where ${invitations.outcome} = 'terminate')::int`,
          quotaFull: sql<number>`count(${invitations.id}) filter (where ${invitations.outcome} = 'quota_full')::int`,
          target: sql<number>`(select coalesce(sum(${projectMarkets.vendorTarget}), 0)::int from ${projectMarkets} where ${projectMarkets.projectId} = ${projects.id})`,
        })
        .from(projects)
        .leftJoin(invitations, eq(invitations.projectId, projects.id))
        .groupBy(projects.id)
        .orderBy(desc(projects.updatedAt))
        .limit(200);
      return {
        items: rows.map((r) => ({
          ...r,
          fieldEndAt: r.fieldEndAt?.toISOString() ?? null,
          incidence: incidence(r.complete, r.terminate),
        })),
      };
    });
  }

  async participation(ctx: RequestContext, projectId: string, cursor?: string, limit = 100) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      let where = eq(participationEvents.projectId, projectId);
      if (cursor) {
        const [at, rid] = cursor.split('|');
        if (at && rid && UUID.test(rid)) {
          const d = new Date(at);
          where = and(
            where,
            or(
              lt(participationEvents.receivedAt, d),
              and(eq(participationEvents.receivedAt, d), lt(participationEvents.id, rid)),
            ),
          )!;
        }
      }
      const rows = await tx
        .select({ e: participationEvents, countryCode: invitations.countryCode })
        .from(participationEvents)
        .innerJoin(invitations, eq(invitations.id, participationEvents.invitationId))
        .where(where)
        .orderBy(desc(participationEvents.receivedAt), desc(participationEvents.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1)?.e;
      return {
        items: items.map(({ e, countryCode }) => ({
          id: e.id,
          invitationId: e.invitationId,
          countryCode,
          kind: e.kind,
          source: e.source,
          effect: e.effect,
          sessionRef: e.sessionRef,
          occurredAt: e.occurredAt.toISOString(),
          receivedAt: e.receivedAt.toISOString(),
        })),
        nextCursor: rows.length > limit && last ? `${last.receivedAt.toISOString()}|${last.id}` : null,
      };
    });
  }

  async runs(ctx: RequestContext, projectId?: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({ r: reconciliationRuns, projectCode: projects.projectCode })
        .from(reconciliationRuns)
        .innerJoin(projects, eq(projects.id, reconciliationRuns.projectId))
        .where(projectId ? eq(reconciliationRuns.projectId, projectId) : undefined)
        .orderBy(desc(reconciliationRuns.startedAt))
        .limit(100);
      return { items: rows.map(({ r, projectCode }) => ({ ...runView(r), projectCode })) };
    });
  }

  async run(ctx: RequestContext, id: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [r] = await tx.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, id));
      if (!r) throw problem.notFound('No such reconciliation run');
      return { ...runView(r), differences: r.differences };
    });
  }

  async rewards(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({ r: rewardEvents, projectCode: projects.projectCode, countryCode: invitations.countryCode })
        .from(rewardEvents)
        .innerJoin(projects, eq(projects.id, rewardEvents.projectId))
        .innerJoin(invitations, eq(invitations.id, rewardEvents.invitationId))
        .orderBy(desc(rewardEvents.createdAt))
        .limit(500);
      const totals = await tx
        .select({ status: rewardEvents.status, n: count() })
        .from(rewardEvents)
        .groupBy(rewardEvents.status);
      return {
        totals: Object.fromEntries(totals.map((t) => [t.status, t.n])),
        items: rows.map(({ r, projectCode, countryCode }) => ({
          id: r.id,
          projectId: r.projectId,
          projectCode,
          countryCode,
          invitationId: r.invitationId,
          idempotencyKey: r.idempotencyKey,
          status: r.status,
          detail: r.detail,
          attempts: r.attempts,
          createdAt: r.createdAt.toISOString(),
          sentAt: r.sentAt?.toISOString() ?? null,
        })),
      };
    });
  }

  systemActor(tenantId: string) {
    return systemActor(tenantId);
  }
}

export const runView = (r: typeof reconciliationRuns.$inferSelect) => ({
  id: r.id,
  projectId: r.projectId,
  status: r.status,
  summary: r.summary,
  differenceCount: Array.isArray(r.differences) ? r.differences.length : 0,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});
