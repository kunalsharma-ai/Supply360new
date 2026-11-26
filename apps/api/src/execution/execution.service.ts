import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BatchCreate, BatchDecision, ExecutionPolicyUpdate, KillSwitch } from '@s360/contracts';
import {
  audienceConnections,
  deliveryAttempts,
  executionControls,
  executionPolicies,
  invitationBatches,
  invitations,
  notifications,
  projectMarkets,
  projects,
  quotaCells,
  reminderJobs,
  reservations,
  reservedRefs,
  routerEvents,
  tenants,
  withTenant,
  type Db,
  type Tx,
} from '@s360/db';
import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { actorOf, AuditService, type Actor } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';
import { AudienceService, type AudienceConnection } from '../audience/audience.service.js';
import { FixtureDelivery, LiveMadpDelivery, type DeliveryChannel } from '../audience/delivery.js';
import { AudienceError, type AudienceSource } from '../audience/madp/source.js';
import { dispatchAllowed, marketDispatchAllowed } from '../ingestion/lifecycle.js';
import { inQuietHours, isScanner, localParts, quietEndsAt } from './policy.js';
import { TokenSigner } from './token.js';

export type Policy = typeof executionPolicies.$inferSelect;
export type Batch = typeof invitationBatches.$inferSelect;
type Project = typeof projects.$inferSelect;
type Cell = typeof quotaCells.$inferSelect;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OPEN_BATCH = ['proposed', 'approved', 'sending'];
/** Reasons a batch waits and is tried again by the scheduler; anything else stops it as blocked. */
const TRANSIENT = new Set(['halted', 'quiet_hours', 'daily_cap', 'project_not_live', 'market_not_dispatchable', 'madp_unavailable']);

export const REASON_TEXT: Record<string, string> = {
  halted: 'The emergency stop is on',
  quiet_hours: 'Quiet hours',
  daily_cap: 'The daily maximum is reached',
  project_not_live: 'The project is not live',
  market_not_dispatchable: 'The market is not live, or its entry link is not approved',
  madp_unavailable: 'MADP could not be reached',
  madp_rejected: 'MADP refused the request',
  project_closed: 'The project is closed',
  cell_closed: 'The quota cell is closed',
  no_people_held: 'Nobody held for this cell is left to invite',
  delivery_unavailable: 'MADP cannot deliver invitations yet; nothing was sent',
  policy_missing: 'The project has no execution policy',
  high_refusal: 'Too many people were refused',
  all_refused: 'MADP refused everyone in the batch (consent or contact rules)',
};

const systemActor = (tenantId: string): Actor => ({ tenantId, userId: null, email: 'system', correlationId: null });
const short = (refs: string[]) => createHash('sha256').update(refs.join(',')).digest('hex').slice(0, 16);

export interface TickResult {
  planned: number;
  batchesTried: number;
  remindersDone: number;
  clicksReported: number;
}

/**
 * Invitations, reminders, the survey router and execution modes (spec §7 and §8).
 *
 * Safety rules, each covered by an integration test:
 * - Every send rechecks the kill switch, the project and market, the cell, quiet hours, the daily maximum and
 *   MADP consent, right before it happens. A failed check never sends; it waits or stops as blocked.
 * - One invitation per MADP reference per project (unique index), whatever mode, batch or retry led to it.
 * - Every hand-off to delivery has an idempotency key, so a retry never sends twice.
 * - A click locks the invitation row and cancels its pending reminders; a reminder locks the same row before it
 *   sends, so a click and a reminder can never both win.
 * - Semi-automatic batches wait for a person with execution.approve. Automatic mode stays within the limits and
 *   escalates to a person (and stops proposing) when a batch is blocked or too much of it is refused.
 */
@Injectable()
export class ExecutionService {
  private readonly log = new Logger('Execution');
  readonly signer: TokenSigner;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly audience: AudienceService,
    private readonly audit: AuditService,
  ) {
    this.signer = new TokenSigner(env.PARTICIPATION_TOKEN_SECRET ?? env.SESSION_SECRET);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  delivery(c: AudienceConnection): DeliveryChannel {
    return c.mode === 'fixture' ? new FixtureDelivery(c.id) : new LiveMadpDelivery();
  }

  linkFor(tenantSlug: string, invitationId: string) {
    const base = this.env.PUBLIC_BASE_URL ?? this.env.WEB_ORIGIN;
    return `${base}/api/v1/i/${tenantSlug}/${this.signer.sign(invitationId)}`;
  }

  private async notify(tx: Tx, tenantId: string, kind: string, severity: string, title: string, body: string, link: string) {
    await tx.insert(notifications).values({ tenantId, userId: null, kind, severity, title, body, link });
  }

  private async lockProject(tx: Tx, id: string): Promise<Project> {
    const [p] = await tx.select().from(projects).where(eq(projects.id, id)).for('update');
    if (!p) throw problem.notFound('No such project');
    return p;
  }

  async halted(tx: Tx): Promise<{ halted: boolean; reason: string | null }> {
    const [c] = await tx.select().from(executionControls).limit(1);
    return { halted: !!c?.halted, reason: c?.reason ?? null };
  }

  private async policyOf(tx: Tx, projectId: string) {
    const [p] = await tx.select().from(executionPolicies).where(eq(executionPolicies.projectId, projectId));
    return p ?? null;
  }

  private async sentToday(tx: Tx, projectId: string, policy: Policy, now: Date) {
    const { midnight } = localParts(policy.timezone, now);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(invitations)
      .where(and(eq(invitations.projectId, projectId), gte(invitations.createdAt, midnight)));
    return n;
  }

  /** People held for a cell who can still be invited, oldest hold first. */
  private candidates(tx: Tx, cellId: string, projectId: string, panels: string[], now: Date, limit: number) {
    return tx
      .select({
        ref: reservedRefs.ref,
        panel: reservedRefs.panel,
        reservationId: reservedRefs.reservationId,
        externalId: reservations.externalId,
        connectionId: reservations.connectionId,
      })
      .from(reservedRefs)
      .innerJoin(reservations, eq(reservations.id, reservedRefs.reservationId))
      .where(
        and(
          eq(reservedRefs.cellId, cellId),
          gt(reservedRefs.expiresAt, now),
          inArray(reservedRefs.panel, panels.length ? panels : ['-']),
          sql`not exists (select 1 from ${invitations} where ${invitations.projectId} = ${projectId} and ${invitations.ref} = ${reservedRefs.ref})`,
        ),
      )
      .orderBy(asc(reservedRefs.ref))
      .limit(limit);
  }

  private async available(tx: Tx, cell: Cell, policy: Policy, now: Date) {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(reservedRefs)
      .where(
        and(
          eq(reservedRefs.cellId, cell.id),
          gt(reservedRefs.expiresAt, now),
          inArray(reservedRefs.panel, (policy.allowedPanels as string[]).length ? (policy.allowedPanels as string[]) : ['-']),
          sql`not exists (select 1 from ${invitations} where ${invitations.projectId} = ${cell.projectId} and ${invitations.ref} = ${reservedRefs.ref})`,
        ),
      );
    return n;
  }

  /**
   * The checks run right before anything is sent for a project and cell. Returns null when sending may go ahead,
   * or the reason it may not.
   */
  private async gate(tx: Tx, p: Project, cell: Cell, policy: Policy | null, now: Date): Promise<string | null> {
    if ((await this.halted(tx)).halted) return 'halted';
    if (!policy) return 'policy_missing';
    if (p.lifecycle === 'closed') return 'project_closed';
    if (!dispatchAllowed(p)) return 'project_not_live';
    if (cell.removed || !cell.isOpen) return 'cell_closed';
    const [m] = await tx
      .select()
      .from(projectMarkets)
      .where(and(eq(projectMarkets.projectId, p.id), eq(projectMarkets.countryCode, cell.countryCode)));
    if (!m || !marketDispatchAllowed(p, m)) return 'market_not_dispatchable';
    if (inQuietHours(policy, now)) return 'quiet_hours';
    return null;
  }

  private async connection(tx: Tx, id: string) {
    const [c] = await tx.select().from(audienceConnections).where(eq(audienceConnections.id, id));
    if (!c) throw new AudienceError('The MADP connection of this reservation is gone', false);
    return c;
  }

  // ───────────────────────────── policy and kill switch ─────────────────────────────

  async setPolicy(ctx: RequestContext, projectId: string, body: ExecutionPolicyUpdate) {
    if (body.mode === 'auto' && !ctx.permissions.includes('execution.approve'))
      throw problem.forbidden('approval_required', 'Turning on automatic mode needs the execution.approve permission');
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      await this.lockProject(tx, projectId);
      const prev = await this.policyOf(tx, projectId);
      const values = {
        mode: body.mode,
        batchSize: body.batchSize,
        dailyMax: body.dailyMax,
        reviewIntervalMinutes: body.reviewIntervalMinutes,
        quietStartHour: body.quietStartHour,
        quietEndHour: body.quietEndHour,
        timezone: body.timezone,
        reminderOffsetsHours: body.reminderOffsetsHours,
        allowedPanels: body.allowedPanels,
        linkValidDays: body.linkValidDays,
        escalateRefusalPercent: body.escalateRefusalPercent,
        escalatedAt: null,
        escalationReason: null,
        // A saved policy is reviewed at the next scheduler pass, not after the old interval.
        lastReviewAt: null,
        version: (prev?.version ?? 0) + 1,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      };
      const [policy] = await tx
        .insert(executionPolicies)
        .values({ projectId, tenantId: ctx.tenantId, ...values })
        .onConflictDoUpdate({ target: executionPolicies.projectId, set: values })
        .returning();
      let cancelled = 0;
      if (prev && prev.mode !== body.mode) {
        // Batches the system proposed under the old mode no longer apply. Everything sent stays as it is.
        const gone = await tx
          .update(invitationBatches)
          .set({ status: 'cancelled', reason: `Mode changed to ${body.mode}`, finishedAt: new Date() })
          .where(
            and(
              eq(invitationBatches.projectId, projectId),
              eq(invitationBatches.origin, 'system'),
              inArray(invitationBatches.status, ['proposed', 'approved']),
            ),
          )
          .returning({ id: invitationBatches.id });
        cancelled = gone.length;
      }
      await this.audit.write(tx, actorOf(ctx), {
        action: prev && prev.mode !== body.mode ? 'execution.mode_changed' : 'execution.policy_updated',
        targetType: 'project',
        targetId: projectId,
        reason: body.reason,
        details: {
          from: prev ? { mode: prev.mode, version: prev.version } : null,
          to: { ...values, updatedAt: undefined },
          cancelledSystemBatches: cancelled,
          clearedEscalation: prev?.escalationReason ?? null,
        },
      });
      return { policy: policy!, cancelledSystemBatches: cancelled };
    });
  }

  async setKillSwitch(ctx: RequestContext, body: KillSwitch) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const values = { halted: body.halted, reason: body.reason, updatedBy: ctx.userId, updatedAt: new Date() };
      await tx
        .insert(executionControls)
        .values({ tenantId: ctx.tenantId, ...values })
        .onConflictDoUpdate({ target: executionControls.tenantId, set: values });
      await this.audit.write(tx, actorOf(ctx), {
        action: body.halted ? 'execution.emergency_stop' : 'execution.resumed',
        targetType: 'tenant',
        targetId: ctx.tenantId,
        reason: body.reason,
      });
      await this.notify(
        tx,
        ctx.tenantId,
        'execution.kill_switch',
        body.halted ? 'critical' : 'info',
        body.halted ? 'Emergency stop: all sending halted' : 'Sending resumed',
        `${ctx.name}: ${body.reason}`,
        '/automation',
      );
      return { halted: body.halted, reason: body.reason };
    });
  }

  // ───────────────────────────── batches ─────────────────────────────

  async createBatch(ctx: RequestContext, projectId: string, body: BatchCreate) {
    const b = await withTenant(this.db, ctx.tenantId, async (tx) => {
      await this.lockProject(tx, projectId);
      const policy = await this.policyOf(tx, projectId);
      if (!policy) throw problem.conflict('no_policy', 'Set the execution policy for this project first');
      const [cell] = await tx
        .select()
        .from(quotaCells)
        .where(and(eq(quotaCells.id, body.cellId), eq(quotaCells.projectId, projectId)));
      if (!cell) throw problem.notFound('No such quota cell');
      if (cell.removed || !cell.isOpen) throw problem.conflict('cell_closed', 'This cell is closed at SampTrek');
      if (body.size > policy.batchSize)
        throw problem.badRequest('batch_too_large', `The policy allows at most ${policy.batchSize} in one batch`);
      const approves = ctx.permissions.includes('execution.approve');
      const status = policy.mode === 'semi_auto' && !approves ? 'proposed' : 'approved';
      const [b] = await tx
        .insert(invitationBatches)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          cellId: cell.id,
          size: body.size,
          status,
          mode: policy.mode,
          policyVersion: policy.version,
          origin: 'person',
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          approvedBy: status === 'approved' ? ctx.userId : null,
          approvedAt: status === 'approved' ? new Date() : null,
          reason: body.reason,
          createdBy: ctx.userId,
        })
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'invitations.batch_created',
        targetType: 'invitation_batch',
        targetId: b!.id,
        reason: body.reason,
        details: { projectId, cellId: cell.id, size: body.size, status, mode: policy.mode, scheduledAt: body.scheduledAt ?? null },
      });
      return b!;
    });
    if (b.status === 'approved' && (!b.scheduledAt || b.scheduledAt <= new Date()))
      return this.sendBatch(ctx.tenantId, b.id, actorOf(ctx));
    return b;
  }

  async decide(ctx: RequestContext, projectId: string, batchId: string, body: BatchDecision) {
    if (body.decision !== 'cancel' && !ctx.permissions.includes('execution.approve'))
      throw problem.forbidden('approval_required', 'Approving or rejecting a batch needs the execution.approve permission');
    const b = await withTenant(this.db, ctx.tenantId, async (tx) => {
      await this.lockProject(tx, projectId);
      const [b] = await tx
        .select()
        .from(invitationBatches)
        .where(and(eq(invitationBatches.id, batchId), eq(invitationBatches.projectId, projectId)))
        .for('update');
      if (!b) throw problem.notFound('No such batch');
      const allowed = body.decision === 'cancel' ? ['proposed', 'approved'] : ['proposed'];
      if (!allowed.includes(b.status)) throw problem.conflict('batch_state', `This batch is ${b.status}`);
      const now = new Date();
      const set =
        body.decision === 'approve'
          ? { status: 'approved', approvedBy: ctx.userId, approvedAt: now }
          : { status: body.decision === 'reject' ? 'rejected' : 'cancelled', finishedAt: now, reason: body.reason };
      const [u] = await tx.update(invitationBatches).set(set).where(eq(invitationBatches.id, b.id)).returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: `invitations.batch_${body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : 'cancelled'}`,
        targetType: 'invitation_batch',
        targetId: b.id,
        reason: body.reason,
        details: { projectId, size: b.size, origin: b.origin },
      });
      return u!;
    });
    if (b.status === 'approved' && (!b.scheduledAt || b.scheduledAt <= new Date()))
      return this.sendBatch(ctx.tenantId, b.id, actorOf(ctx));
    return b;
  }

  /** A person presses Send on an approved batch: it goes now, scheduled or not, if every check passes. */
  async sendNow(ctx: RequestContext, projectId: string, batchId: string) {
    const [b] = await withTenant(this.db, ctx.tenantId, (tx) =>
      tx
        .select()
        .from(invitationBatches)
        .where(and(eq(invitationBatches.id, batchId), eq(invitationBatches.projectId, projectId))),
    );
    if (!b) throw problem.notFound('No such batch');
    if (b.status !== 'approved' && b.status !== 'sending')
      throw problem.conflict('batch_state', `This batch is ${b.status}`);
    return this.sendBatch(ctx.tenantId, b.id, actorOf(ctx), true);
  }

  /**
   * Sends one batch in two steps, each under the project row lock:
   *   1. checks, consent, MADP authorisation, and the invitations recorded as `authorized`;
   *   2. hand-off to delivery for every `authorized` invitation, with an idempotency key per invitation.
   * A crash between the steps leaves the batch `sending`; the scheduler finishes step 2 without re-authorising.
   */
  async sendBatch(tenantId: string, batchId: string, actor: Actor, ignoreSchedule = false): Promise<Batch> {
    try {
      await this.authorizeStep(tenantId, batchId, actor, ignoreSchedule);
    } catch (e) {
      if (!(e instanceof AudienceError)) throw e;
      const reason = e.retryable || (e.status ?? 0) >= 500 ? 'madp_unavailable' : 'madp_rejected';
      this.log.warn(`batch ${batchId}: ${e.message}`);
      await this.stop(tenantId, batchId, reason, e.message);
    }
    await this.deliverStep(tenantId, batchId);
    const [b] = await withTenant(this.db, tenantId, (tx) =>
      tx.select().from(invitationBatches).where(eq(invitationBatches.id, batchId)),
    );
    return b!;
  }

  /** Records why a batch did not go: it waits (transient) or stops as blocked, and a person hears about a stop. */
  private async stop(tenantId: string, batchId: string, reason: string, detail?: string, tx?: Tx) {
    const run = async (t: Tx) => {
      const transient = TRANSIENT.has(reason);
      const [b] = await t
        .update(invitationBatches)
        .set(transient ? { blockedReason: reason } : { status: 'blocked', blockedReason: reason, finishedAt: new Date() })
        .where(and(eq(invitationBatches.id, batchId), inArray(invitationBatches.status, ['approved', 'sending'])))
        .returning();
      if (!b || transient) return;
      await this.notify(
        t,
        tenantId,
        'execution.batch_blocked',
        'warning',
        'An invitation batch was stopped',
        `${REASON_TEXT[reason] ?? reason}${detail ? ` (${detail})` : ''}. Nothing more is sent from it.`,
        `/invitations?project=${b.projectId}`,
      );
      if (b.origin === 'system') await this.escalate(t, b.projectId, reason);
    };
    return tx ? run(tx) : withTenant(this.db, tenantId, run);
  }

  /** Automatic and semi-automatic modes stop proposing for the project until a person saves its policy again. */
  private async escalate(tx: Tx, projectId: string, reason: string) {
    const [p] = await tx
      .update(executionPolicies)
      .set({ escalatedAt: new Date(), escalationReason: reason })
      .where(and(eq(executionPolicies.projectId, projectId), isNull(executionPolicies.escalatedAt)))
      .returning();
    if (!p) return;
    await this.notify(
      tx,
      p.tenantId,
      'execution.escalated',
      'critical',
      'Automation needs a person',
      `${REASON_TEXT[reason] ?? reason}. ${p.mode === 'auto' ? 'Automatic' : 'Semi-automatic'} mode proposes nothing more for this project until someone reviews and saves its policy.`,
      `/automation?project=${projectId}`,
    );
  }

  private async authorizeStep(tenantId: string, batchId: string, actor: Actor, ignoreSchedule: boolean) {
    await withTenant(this.db, tenantId, async (tx) => {
      const [peek] = await tx.select().from(invitationBatches).where(eq(invitationBatches.id, batchId));
      if (!peek) throw problem.notFound('No such batch');
      const p = await this.lockProject(tx, peek.projectId);
      const [b] = await tx.select().from(invitationBatches).where(eq(invitationBatches.id, batchId)).for('update');
      if (b!.status !== 'approved') return;
      const now = new Date();
      if (!ignoreSchedule && b!.scheduledAt && b!.scheduledAt > now) return;
      const [cell] = await tx.select().from(quotaCells).where(eq(quotaCells.id, b!.cellId));
      const policy = await this.policyOf(tx, p.id);
      const blocked = await this.gate(tx, p, cell!, policy, now);
      if (blocked) return this.stop(tenantId, b!.id, blocked, undefined, tx);
      const room = policy!.dailyMax - (await this.sentToday(tx, p.id, policy!, now));
      if (room <= 0) return this.stop(tenantId, b!.id, 'daily_cap', undefined, tx);
      const want = Math.min(b!.size, policy!.batchSize, room);
      const cands = await this.candidates(tx, cell!.id, p.id, policy!.allowedPanels as string[], now, want);
      if (!cands.length) return this.stop(tenantId, b!.id, 'no_people_held', undefined, tx);

      // Consent is checked at MADP right before authorising, per connection.
      let refused = 0;
      const sources = new Map<string, AudienceSource>();
      const sourceOf = async (id: string) => {
        let s = sources.get(id);
        if (!s) sources.set(id, (s = this.audience.sourceFor(await this.connection(tx, id))));
        return s;
      };
      const ok = new Set<string>();
      for (const connId of new Set(cands.map((c) => c.connectionId))) {
        const refs = cands.filter((c) => c.connectionId === connId).map((c) => c.ref);
        const r = await (await sourceOf(connId)).consent(refs);
        for (const x of r.results) if (x.eligible) ok.add(x.ref);
      }
      refused += cands.length - ok.size;
      const dropped = cands.filter((c) => !ok.has(c.ref)).map((c) => c.ref);

      const byRes = new Map<string, typeof cands>();
      for (const c of cands.filter((c) => ok.has(c.ref))) byRes.set(c.reservationId, [...(byRes.get(c.reservationId) ?? []), c]);
      const expiresAt = new Date(now.getTime() + policy!.linkValidDays * DAY);
      let authorized = 0;
      for (const [resId, group] of byRes) {
        const refs = group.map((c) => c.ref);
        const a = await (
          await sourceOf(group[0]!.connectionId)
        ).authorize({ reservationId: group[0]!.externalId, refs }, `s360-auth-${b!.id}-${short([resId, ...refs])}`);
        refused += a.refused.length;
        dropped.push(...a.refused.map((x) => x.ref));
        const panelOf = new Map(group.map((c) => [c.ref, c.panel]));
        const rows = a.authorized
          .filter((x) => panelOf.has(x.ref))
          .map((x) => ({
            tenantId,
            projectId: p.id,
            cellId: cell!.id,
            batchId: b!.id,
            ref: x.ref,
            panel: panelOf.get(x.ref)!,
            countryCode: cell!.countryCode,
            madpInvitationId: x.invitationId,
            status: 'authorized',
            expiresAt,
          }));
        if (rows.length) {
          const ins = await tx.insert(invitations).values(rows).onConflictDoNothing().returning({ id: invitations.id });
          authorized += ins.length;
        }
      }
      // People MADP turns away leave the hold, so they never block the queue or count against the cell cap.
      for (let i = 0; i < dropped.length; i += 1000)
        await tx
          .delete(reservedRefs)
          .where(and(eq(reservedRefs.projectId, p.id), inArray(reservedRefs.ref, dropped.slice(i, i + 1000))));
      await tx
        .update(invitationBatches)
        .set({ status: 'sending', authorized, refused, blockedReason: null, policyVersion: policy!.version })
        .where(eq(invitationBatches.id, b!.id));
      await this.audit.write(tx, actor, {
        action: 'invitations.authorized',
        targetType: 'invitation_batch',
        targetId: b!.id,
        details: { projectId: p.id, cellId: cell!.id, candidates: cands.length, authorized, refused, droppedFromHold: dropped.length, mode: policy!.mode },
      });
      if (!authorized) return this.stop(tenantId, b!.id, 'all_refused', undefined, tx);
      const total = authorized + refused;
      if (b!.origin === 'system' && total > 0 && (refused * 100) / total > policy!.escalateRefusalPercent)
        await this.escalate(tx, p.id, 'high_refusal');
    });
  }

  private async deliverStep(tenantId: string, batchId: string) {
    await withTenant(this.db, tenantId, async (tx) => {
      const [peek] = await tx.select().from(invitationBatches).where(eq(invitationBatches.id, batchId));
      if (peek?.status !== 'sending') return;
      const p = await this.lockProject(tx, peek.projectId);
      const [b] = await tx.select().from(invitationBatches).where(eq(invitationBatches.id, batchId)).for('update');
      if (b!.status !== 'sending') return;
      const now = new Date();
      const [cell] = await tx.select().from(quotaCells).where(eq(quotaCells.id, b!.cellId));
      const policy = await this.policyOf(tx, p.id);
      // Rechecked right before the hand-off: the kill switch or a source hold may have arrived since step 1.
      const blocked = await this.gate(tx, p, cell!, policy, now);
      if (blocked) return this.stop(tenantId, b!.id, blocked, undefined, tx);
      const conn = await this.audience.active(tx);
      if (!conn) return this.stop(tenantId, b!.id, 'madp_unavailable', 'no MADP connection', tx);
      const channel = this.delivery(conn);
      const [t] = await this.db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId));
      const todo = await tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.batchId, b!.id), eq(invitations.status, 'authorized')));
      const done = new Set(
        (
          await tx
            .select({ key: deliveryAttempts.idempotencyKey })
            .from(deliveryAttempts)
            .where(
              inArray(
                deliveryAttempts.idempotencyKey,
                todo.length ? todo.map((i) => `inv-${i.id}`) : ['-'],
              ),
            )
        ).map((x) => x.key),
      );
      const sent: string[] = [];
      const attempts: (typeof deliveryAttempts.$inferInsert)[] = [];
      let unavailable: string | null = null;
      for (const inv of todo) {
        const key = `inv-${inv.id}`;
        if (done.has(key)) {
          sent.push(inv.id); // handed off before a crash; never hand it off twice
          continue;
        }
        const r = await channel.send({
          idempotencyKey: key,
          kind: 'invitation',
          madpInvitationId: inv.madpInvitationId,
          link: this.linkFor(t!.slug, inv.id),
        });
        attempts.push({
          tenantId,
          invitationId: inv.id,
          kind: 'invitation',
          idempotencyKey: key,
          status: r.status,
          detail: r.status === 'unavailable' ? r.detail : null,
        });
        if (r.status === 'unavailable') {
          unavailable = r.detail;
          await tx.update(invitations).set({ status: 'delivery_unavailable' }).where(eq(invitations.id, inv.id));
          break; // a missing channel stops the batch safely; the rest stay authorized and unsent
        }
        sent.push(inv.id);
      }
      if (attempts.length) await tx.insert(deliveryAttempts).values(attempts).onConflictDoNothing();
      for (let i = 0; i < sent.length; i += 1000) {
        const ids = sent.slice(i, i + 1000);
        await tx.update(invitations).set({ status: 'sent', sentAt: now }).where(inArray(invitations.id, ids));
        const offsets = policy!.reminderOffsetsHours as number[];
        if (offsets.length)
          await tx
            .insert(reminderJobs)
            .values(
              ids.flatMap((invitationId) =>
                offsets.map((h, n) => ({
                  tenantId,
                  projectId: p.id,
                  invitationId,
                  attempt: n + 1,
                  dueAt: new Date(now.getTime() + h * HOUR),
                })),
              ),
            )
            .onConflictDoNothing();
      }
      await tx
        .update(invitationBatches)
        .set({ sent: sql`${invitationBatches.sent} + ${sent.length}` })
        .where(eq(invitationBatches.id, b!.id));
      if (unavailable) return this.stop(tenantId, b!.id, 'delivery_unavailable', unavailable, tx);
      await tx
        .update(invitationBatches)
        .set({ status: 'sent', finishedAt: now, blockedReason: null })
        .where(eq(invitationBatches.id, b!.id));
    });
  }

  // ───────────────────────────── reminders ─────────────────────────────

  /**
   * Sends due reminders. Each one locks its invitation row first, so a click that arrives at the same moment
   * either cancels it before it goes or happens after it went; never both.
   */
  async processReminders(tenantId: string, now = new Date(), limit = 200): Promise<number> {
    const due = await withTenant(this.db, tenantId, async (tx) => {
      if ((await this.halted(tx)).halted) return null;
      const conn = await this.audience.active(tx);
      if (!conn) return null;
      const jobs = await tx
        .select({ id: reminderJobs.id, ref: invitations.ref })
        .from(reminderJobs)
        .innerJoin(invitations, eq(invitations.id, reminderJobs.invitationId))
        .where(and(eq(reminderJobs.status, 'pending'), lte(reminderJobs.dueAt, now)))
        .orderBy(asc(reminderJobs.dueAt))
        .limit(limit);
      return { conn, jobs };
    });
    if (!due?.jobs.length) return 0;
    const [t] = await this.db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId));
    let consent: Map<string, boolean>;
    try {
      const r = await this.audience.sourceFor(due.conn).consent([...new Set(due.jobs.map((j) => j.ref))]);
      consent = new Map(r.results.map((x) => [x.ref, x.eligible]));
    } catch (e) {
      this.log.warn(`reminders wait: MADP consent check failed: ${(e as Error).message}`);
      return 0;
    }
    const channel = this.delivery(due.conn);
    let done = 0;
    for (const j of due.jobs) {
      await withTenant(this.db, tenantId, async (tx) => {
        const [job] = await tx.select().from(reminderJobs).where(eq(reminderJobs.id, j.id));
        if (!job) return;
        const [inv] = await tx.select().from(invitations).where(eq(invitations.id, job.invitationId)).for('update');
        const [fresh] = await tx.select().from(reminderJobs).where(eq(reminderJobs.id, j.id)).for('update');
        if (!inv || fresh?.status !== 'pending') return;
        const finish = (status: string, reason: string | null) =>
          tx.update(reminderJobs).set({ status, reason, doneAt: new Date() }).where(eq(reminderJobs.id, j.id));
        const wait = (reason: string, until: Date) =>
          tx.update(reminderJobs).set({ reason, dueAt: until }).where(eq(reminderJobs.id, j.id));
        if (inv.clickedAt) return finish('cancelled', 'clicked');
        if (inv.expiresAt <= now) return finish('skipped', 'link_expired');
        const [p] = await tx.select().from(projects).where(eq(projects.id, inv.projectId));
        const [cell] = await tx.select().from(quotaCells).where(eq(quotaCells.id, inv.cellId));
        const policy = await this.policyOf(tx, inv.projectId);
        const blocked = await this.gate(tx, p!, cell!, policy, now);
        if (blocked === 'quiet_hours') return wait(blocked, quietEndsAt(policy!, now));
        if (blocked && TRANSIENT.has(blocked)) return wait(blocked, new Date(now.getTime() + 15 * 60_000));
        if (blocked) return finish('skipped', blocked);
        if (!consent.get(inv.ref)) return finish('skipped', 'no_consent');
        const key = `rem-${inv.id}-${job.attempt}`;
        const r = await channel.send({
          idempotencyKey: key,
          kind: 'reminder',
          madpInvitationId: inv.madpInvitationId,
          link: this.linkFor(t!.slug, inv.id),
        });
        await tx
          .insert(deliveryAttempts)
          .values({
            tenantId,
            invitationId: inv.id,
            kind: 'reminder',
            idempotencyKey: key,
            status: r.status,
            detail: r.status === 'unavailable' ? r.detail : null,
          })
          .onConflictDoNothing();
        await finish(r.status === 'accepted' ? 'sent' : 'blocked', r.status === 'accepted' ? null : 'delivery_unavailable');
        done++;
      });
    }
    return done;
  }

  // ───────────────────────────── survey router ─────────────────────────────

  /**
   * One participation link visit. Returns where to send the browser. Link scanners are recorded as prefetch and
   * never count as clicks. A click is recorded before any routing decision, so reminders stop even when the
   * project has closed since.
   */
  async route(tenantSlug: string, token: string, method: string, userAgent: string | undefined) {
    const done = (slug: string) => `${this.env.WEB_ORIGIN}/done/${slug}`;
    if (!/^[a-z0-9-]{2,63}$/.test(tenantSlug)) return { location: done('invalid'), kind: 'invalid' };
    const [t] = await this.db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1);
    if (t?.status !== 'active') return { location: done('invalid'), kind: 'invalid' };
    const id = this.signer.verify(token);
    return withTenant(this.db, t.id, async (tx) => {
      const event = (kind: string, reason: string | null, inv?: { id: string; projectId: string }) =>
        tx.insert(routerEvents).values({
          tenantId: t.id,
          projectId: inv?.projectId ?? null,
          invitationId: inv?.id ?? null,
          kind,
          reason,
        });
      const [inv] = id ? await tx.select().from(invitations).where(eq(invitations.id, id)).for('update') : [];
      if (!inv) {
        await event('invalid', id ? 'unknown_invitation' : 'bad_token');
        return { location: done('invalid'), kind: 'invalid' };
      }
      if (isScanner(method, userAgent)) {
        await event('prefetch', method === 'HEAD' ? 'head' : userAgent ? 'scanner' : 'no_user_agent', inv);
        return { location: done('link-check'), kind: 'prefetch' };
      }
      const now = new Date();
      const first = !inv.clickedAt;
      if (first) {
        await tx.update(invitations).set({ clickedAt: now, status: 'clicked' }).where(eq(invitations.id, inv.id));
        await tx
          .update(reminderJobs)
          .set({ status: 'cancelled', reason: 'clicked', doneAt: now })
          .where(and(eq(reminderJobs.invitationId, inv.id), eq(reminderJobs.status, 'pending')));
      }
      if (inv.expiresAt <= now) {
        await event('refused', 'link_expired', inv);
        return { location: done('link-expired'), kind: 'refused' };
      }
      const [p] = await tx.select().from(projects).where(eq(projects.id, inv.projectId));
      const [cell] = await tx.select().from(quotaCells).where(eq(quotaCells.id, inv.cellId));
      const [m] = await tx
        .select()
        .from(projectMarkets)
        .where(and(eq(projectMarkets.projectId, inv.projectId), eq(projectMarkets.countryCode, inv.countryCode)));
      if (!p || !cell || !m || cell.removed || !cell.isOpen || !marketDispatchAllowed(p, m)) {
        await event('refused', 'closed', inv);
        return { location: done('closed'), kind: 'refused' };
      }
      await event('click', first ? null : 'repeat', inv);
      return { location: m.entryUrl!.replaceAll('[UID]', token), kind: 'click' };
    });
  }

  /** Reports clicks to MADP (outbox): each click is sent until MADP acknowledges it; its event id makes a resend harmless. */
  async flushClicks(tenantId: string, limit = 1000): Promise<number> {
    const work = await withTenant(this.db, tenantId, async (tx) => {
      const conn = await this.audience.active(tx);
      if (!conn) return null;
      const rows = await tx
        .select({ id: invitations.id, madp: invitations.madpInvitationId, at: invitations.clickedAt })
        .from(invitations)
        .where(and(isNotNull(invitations.clickedAt), isNull(invitations.clickReportedAt)))
        .limit(limit);
      return { conn, rows };
    });
    if (!work?.rows.length) return 0;
    try {
      await this.audience.sourceFor(work.conn).participation(
        work.rows.map((r) => ({ eventId: `s360-click-${r.id}`, invitationId: r.madp, event: 'click', occurredAt: r.at!.toISOString() })),
      );
    } catch (e) {
      this.log.warn(`click report waits: ${(e as Error).message}`);
      return 0;
    }
    await withTenant(this.db, tenantId, (tx) =>
      tx
        .update(invitations)
        .set({ clickReportedAt: new Date() })
        .where(inArray(invitations.id, work.rows.map((r) => r.id))),
    );
    return work.rows.length;
  }

  // ───────────────────────────── modes: the scheduler's planner ─────────────────────────────

  /**
   * Semi-automatic and automatic modes, once per review interval per project: for each open, mapped cell with
   * people held and not yet invited, and no batch already open, propose one batch (semi-automatic, waits for a
   * person) or approve one (automatic, sent by the scheduler within the limits).
   */
  async plan(tenantId: string, now = new Date()): Promise<number> {
    const due = await withTenant(this.db, tenantId, async (tx) => {
      if ((await this.halted(tx)).halted) return [];
      return tx
        .select()
        .from(executionPolicies)
        .where(
          and(
            inArray(executionPolicies.mode, ['semi_auto', 'auto']),
            isNull(executionPolicies.escalatedAt),
            or(
              isNull(executionPolicies.lastReviewAt),
              lte(
                executionPolicies.lastReviewAt,
                sql`${now.toISOString()}::timestamptz - make_interval(mins => ${executionPolicies.reviewIntervalMinutes})`,
              ),
            ),
          ),
        );
    });
    let planned = 0;
    for (const pol of due) {
      planned += await withTenant(this.db, tenantId, async (tx) => {
        const p = await this.lockProject(tx, pol.projectId);
        const [policy] = await tx
          .update(executionPolicies)
          .set({ lastReviewAt: now })
          .where(eq(executionPolicies.projectId, p.id))
          .returning();
        if (!policy || policy.escalatedAt || policy.mode === 'manual' || !dispatchAllowed(p)) return 0;
        let room = policy.dailyMax - (await this.sentToday(tx, p.id, policy, now));
        const open = new Set(
          (
            await tx
              .select({ cellId: invitationBatches.cellId })
              .from(invitationBatches)
              .where(and(eq(invitationBatches.projectId, p.id), inArray(invitationBatches.status, OPEN_BATCH)))
          ).map((x) => x.cellId),
        );
        const cells = await tx
          .select()
          .from(quotaCells)
          .where(and(eq(quotaCells.projectId, p.id), eq(quotaCells.removed, false), eq(quotaCells.isOpen, true), isNotNull(quotaCells.criteria)));
        let n = 0;
        for (const cell of cells) {
          if (open.has(cell.id) || room <= 0) continue;
          const avail = await this.available(tx, cell, policy, now);
          const size = Math.min(policy.batchSize, avail, room);
          if (size <= 0) continue;
          const auto = policy.mode === 'auto';
          const [b] = await tx
            .insert(invitationBatches)
            .values({
              tenantId,
              projectId: p.id,
              cellId: cell.id,
              size,
              status: auto ? 'approved' : 'proposed',
              mode: policy.mode,
              policyVersion: policy.version,
              origin: 'system',
              approvedAt: auto ? now : null,
              reason: auto ? 'Automatic mode, within the policy limits' : 'Proposed by semi-automatic mode',
            })
            .returning();
          await this.audit.write(tx, systemActor(tenantId), {
            action: 'invitations.batch_created',
            targetType: 'invitation_batch',
            targetId: b!.id,
            details: { projectId: p.id, cellId: cell.id, size, status: b!.status, mode: policy.mode, origin: 'system' },
          });
          if (!auto)
            await this.notify(
              tx,
              tenantId,
              'execution.approval_needed',
              'info',
              'An invitation batch waits for approval',
              `${p.projectCode} ${cell.countryCode} ${cell.name}: ${size} invitations proposed.`,
              `/automation?project=${p.id}`,
            );
          room -= size;
          n++;
        }
        return n;
      });
    }
    return planned;
  }

  /** One scheduler pass for a tenant: plan, send what is due, send due reminders, report clicks. */
  async tick(tenantId: string, now = new Date()): Promise<TickResult> {
    const planned = await this.plan(tenantId, now);
    const due = await withTenant(this.db, tenantId, (tx) =>
      tx
        .select({ id: invitationBatches.id })
        .from(invitationBatches)
        .where(
          or(
            eq(invitationBatches.status, 'sending'),
            and(
              eq(invitationBatches.status, 'approved'),
              or(isNull(invitationBatches.scheduledAt), lte(invitationBatches.scheduledAt, now)),
            ),
          ),
        )
        .orderBy(asc(invitationBatches.createdAt))
        .limit(50),
    );
    for (const b of due) await this.sendBatch(tenantId, b.id, systemActor(tenantId));
    const remindersDone = await this.processReminders(tenantId, now);
    const clicksReported = await this.flushClicks(tenantId);
    return { planned, batchesTried: due.length, remindersDone, clicksReported };
  }

  // ───────────────────────────── reads ─────────────────────────────

  async projectView(ctx: RequestContext, projectId: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [p] = await tx.select().from(projects).where(eq(projects.id, projectId));
      if (!p) throw problem.notFound('No such project');
      const policy = await this.policyOf(tx, projectId);
      const now = new Date();
      const batches = await tx
        .select()
        .from(invitationBatches)
        .where(eq(invitationBatches.projectId, projectId))
        .orderBy(desc(invitationBatches.createdAt))
        .limit(50);
      const inv = await tx
        .select({ status: invitations.status, n: count() })
        .from(invitations)
        .where(eq(invitations.projectId, projectId))
        .groupBy(invitations.status);
      const rem = await tx
        .select({ status: reminderJobs.status, n: count() })
        .from(reminderJobs)
        .where(eq(reminderJobs.projectId, projectId))
        .groupBy(reminderJobs.status);
      const cells = await tx
        .select()
        .from(quotaCells)
        .where(and(eq(quotaCells.projectId, projectId), eq(quotaCells.removed, false)))
        .orderBy(asc(quotaCells.countryCode), asc(quotaCells.name));
      const cellRows = [];
      for (const c of cells)
        cellRows.push({
          id: c.id,
          countryCode: c.countryCode,
          name: c.name,
          isOpen: c.isOpen,
          mapped: !!c.criteria,
          available: policy ? await this.available(tx, c, policy, now) : 0,
        });
      const control = await this.halted(tx);
      return {
        projectId,
        projectCode: p.projectCode,
        name: p.name,
        lifecycle: p.lifecycle,
        dispatchAllowed: dispatchAllowed(p),
        halted: control.halted,
        haltReason: control.reason,
        policy: policy ? policyView(policy) : null,
        today: policy ? { sent: await this.sentToday(tx, projectId, policy, now), max: policy.dailyMax } : null,
        quietNow: policy ? inQuietHours(policy, now) : false,
        invitations: Object.fromEntries(inv.map((x) => [x.status, x.n])),
        reminders: Object.fromEntries(rem.map((x) => [x.status, x.n])),
        cells: cellRows,
        batches: batches.map(batchView),
      };
    });
  }

  async overview(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const control = await this.halted(tx);
      const rows = await tx
        .select({ policy: executionPolicies, code: projects.projectCode, name: projects.name, lifecycle: projects.lifecycle })
        .from(executionPolicies)
        .innerJoin(projects, eq(projects.id, executionPolicies.projectId))
        .orderBy(asc(projects.projectCode));
      const queue = await tx
        .select({ b: invitationBatches, code: projects.projectCode, cell: quotaCells.name, cc: quotaCells.countryCode })
        .from(invitationBatches)
        .innerJoin(projects, eq(projects.id, invitationBatches.projectId))
        .innerJoin(quotaCells, eq(quotaCells.id, invitationBatches.cellId))
        .where(eq(invitationBatches.status, 'proposed'))
        .orderBy(asc(invitationBatches.createdAt))
        .limit(100);
      return {
        halted: control.halted,
        haltReason: control.reason,
        projects: rows.map((r) => ({
          projectId: r.policy.projectId,
          projectCode: r.code,
          name: r.name,
          lifecycle: r.lifecycle,
          ...policyView(r.policy),
        })),
        approvals: queue.map((q) => ({ ...batchView(q.b), projectCode: q.code, cellName: q.cell, countryCode: q.cc })),
      };
    });
  }

  async batches(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const rows = await tx
        .select({ b: invitationBatches, code: projects.projectCode, cell: quotaCells.name, cc: quotaCells.countryCode })
        .from(invitationBatches)
        .innerJoin(projects, eq(projects.id, invitationBatches.projectId))
        .innerJoin(quotaCells, eq(quotaCells.id, invitationBatches.cellId))
        .orderBy(desc(invitationBatches.createdAt))
        .limit(100);
      return { items: rows.map((q) => ({ ...batchView(q.b), projectCode: q.code, cellName: q.cell, countryCode: q.cc })) };
    });
  }

  async reminders(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const totals = await tx.select({ status: reminderJobs.status, n: count() }).from(reminderJobs).groupBy(reminderJobs.status);
      const rows = await tx
        .select({ r: reminderJobs, code: projects.projectCode, cc: invitations.countryCode })
        .from(reminderJobs)
        .innerJoin(invitations, eq(invitations.id, reminderJobs.invitationId))
        .innerJoin(projects, eq(projects.id, reminderJobs.projectId))
        .orderBy(desc(reminderJobs.dueAt))
        .limit(100);
      return {
        totals: Object.fromEntries(totals.map((x) => [x.status, x.n])),
        items: rows.map(({ r, code, cc }) => ({
          id: r.id,
          projectId: r.projectId,
          projectCode: code,
          countryCode: cc,
          attempt: r.attempt,
          dueAt: r.dueAt.toISOString(),
          status: r.status,
          reason: r.reason,
          doneAt: r.doneAt?.toISOString() ?? null,
        })),
      };
    });
  }

  async routerEvents(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const since = new Date(Date.now() - 7 * DAY);
      const totals = await tx
        .select({ kind: routerEvents.kind, n: count() })
        .from(routerEvents)
        .where(gte(routerEvents.at, since))
        .groupBy(routerEvents.kind);
      const rows = await tx
        .select({ e: routerEvents, code: projects.projectCode })
        .from(routerEvents)
        .leftJoin(projects, eq(projects.id, routerEvents.projectId))
        .orderBy(desc(routerEvents.at))
        .limit(100);
      return {
        since: since.toISOString(),
        totals: Object.fromEntries(totals.map((x) => [x.kind, x.n])),
        items: rows.map(({ e, code }) => ({
          id: e.id,
          projectCode: code,
          kind: e.kind,
          reason: e.reason,
          at: e.at.toISOString(),
        })),
      };
    });
  }
}

export const policyView = (p: Policy) => ({
  mode: p.mode,
  batchSize: p.batchSize,
  dailyMax: p.dailyMax,
  reviewIntervalMinutes: p.reviewIntervalMinutes,
  quietStartHour: p.quietStartHour,
  quietEndHour: p.quietEndHour,
  timezone: p.timezone,
  reminderOffsetsHours: p.reminderOffsetsHours as number[],
  allowedPanels: p.allowedPanels as string[],
  linkValidDays: p.linkValidDays,
  escalateRefusalPercent: p.escalateRefusalPercent,
  escalatedAt: p.escalatedAt?.toISOString() ?? null,
  escalationReason: p.escalationReason,
  version: p.version,
  lastReviewAt: p.lastReviewAt?.toISOString() ?? null,
  updatedAt: p.updatedAt.toISOString(),
});

export const batchView = (b: Batch) => ({
  id: b.id,
  projectId: b.projectId,
  cellId: b.cellId,
  size: b.size,
  status: b.status,
  mode: b.mode,
  origin: b.origin,
  policyVersion: b.policyVersion,
  scheduledAt: b.scheduledAt?.toISOString() ?? null,
  approvedAt: b.approvedAt?.toISOString() ?? null,
  reason: b.reason,
  blockedReason: b.blockedReason,
  blockedText: b.blockedReason ? (REASON_TEXT[b.blockedReason] ?? b.blockedReason) : null,
  authorized: b.authorized,
  refused: b.refused,
  sent: b.sent,
  createdAt: b.createdAt.toISOString(),
  finishedAt: b.finishedAt?.toISOString() ?? null,
});
