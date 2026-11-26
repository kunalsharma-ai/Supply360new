import { Inject, Injectable } from '@nestjs/common';
import {
  DROPOUT_KINDS,
  MAX_REINVITES,
  type DropoutKind,
  type ParticipantQuery,
  type RecontactRequest,
  type ReinviteRequest,
} from '@s360/contracts';
import {
  deliveryAttempts,
  invitations,
  projects,
  quotaCells,
  reminderJobs,
  tenants,
  withTenant,
  type Db,
} from '@s360/db';
import { type SQL, and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { actorOf, AuditService } from '../audit/audit.service.js';
import { AudienceService } from '../audience/audience.service.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { DB } from '../db/db.module.js';
import { ExecutionService, REASON_TEXT } from '../execution/execution.service.js';

const DAY = 86_400_000;
/** At least this long between two invitations of one person to the same survey. */
const REINVITE_GAP_MS = DAY;
/** When someone took part: their latest verified outcome, else their survey start, else their click. */
const participatedAt = sql<Date>`coalesce(${invitations.outcomeAt}, ${invitations.startedAt}, ${invitations.clickedAt})`;

/** Each dropout kind as a condition on invitations. Final outcomes are never dropouts. */
const DROPOUT: Record<DropoutKind, SQL> = {
  not_clicked: and(isNotNull(invitations.sentAt), isNull(invitations.clickedAt), isNull(invitations.outcome))!,
  not_started: and(isNotNull(invitations.clickedAt), isNull(invitations.startedAt), isNull(invitations.outcome))!,
  not_finished: and(isNotNull(invitations.startedAt), isNull(invitations.outcome))!,
  partial: eq(invitations.outcome, 'partial'),
  technical_error: eq(invitations.outcome, 'technical_error'),
};
export const dropoutOf = (i: {
  sentAt: Date | null;
  clickedAt: Date | null;
  startedAt: Date | null;
  outcome: string | null;
}): DropoutKind | null => {
  if (i.outcome === 'partial' || i.outcome === 'technical_error') return i.outcome;
  if (i.outcome) return null;
  if (i.startedAt) return 'not_finished';
  if (i.clickedAt) return 'not_started';
  return i.sentAt ? 'not_clicked' : null;
};

/**
 * Recontact and reinvite.
 *
 * - Recontact: people who took part in earlier projects (by when, outcome, market and panel) are held for a cell
 *   of another project through MADP, which re-checks every reference, and are then invited by the normal batch
 *   path: the project's mode (manual, semi-automatic or automatic), limits and kill switch all apply.
 * - Reinvite: people in a project who did not finish (never opened, never started, left part way, or hit a
 *   technical error) get their same participation link again. Every send rechecks the kill switch, the project,
 *   cell, quiet hours, daily maximum and MADP consent, and each person is reinvited at most MAX_REINVITES times,
 *   a day apart. People with a final outcome are never reinvited.
 *
 * Supply360 only ever handles MADP references: no names, emails or phone numbers.
 */
@Injectable()
export class RecontactService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audience: AudienceService,
    private readonly exec: ExecutionService,
    private readonly audit: AuditService,
  ) {}

  private participantWhere(q: ParticipantQuery): SQL {
    return and(
      isNotNull(invitations.clickedAt),
      q.fromProjectId ? eq(invitations.projectId, q.fromProjectId) : undefined,
      q.participatedFrom ? gte(participatedAt, new Date(q.participatedFrom)) : undefined,
      q.participatedTo ? lte(participatedAt, new Date(q.participatedTo)) : undefined,
      q.outcomes?.length ? inArray(invitations.outcome, q.outcomes) : undefined,
      q.approvedOnly ? eq(invitations.approval, 'approved') : undefined,
      q.countryCode ? eq(invitations.countryCode, q.countryCode) : undefined,
      q.panel ? eq(invitations.panel, q.panel) : undefined,
    )!;
  }

  /** Past participants matching a filter, newest first, with how many distinct people that is. */
  async participants(ctx: RequestContext, q: ParticipantQuery, cursor?: string, limit = 100) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const where = this.participantWhere(q);
      let page = where;
      if (cursor) {
        const [at, id] = cursor.split('|');
        if (at && id)
          page = and(
            where,
            or(lt(participatedAt, new Date(at)), and(eq(participatedAt, new Date(at)), lt(invitations.id, id))),
          )!;
      }
      const rows = await tx
        .select({
          id: invitations.id,
          projectId: invitations.projectId,
          projectCode: projects.projectCode,
          projectName: projects.name,
          ref: invitations.ref,
          panel: invitations.panel,
          countryCode: invitations.countryCode,
          outcome: invitations.outcome,
          approval: invitations.approval,
          participatedAt,
        })
        .from(invitations)
        .innerJoin(projects, eq(projects.id, invitations.projectId))
        .where(page)
        .orderBy(desc(participatedAt), desc(invitations.id))
        .limit(limit + 1);
      const [{ total, people } = { total: 0, people: 0 }] = await tx
        .select({ total: count(), people: sql<number>`count(distinct ${invitations.ref})::int` })
        .from(invitations)
        .where(where);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        total,
        people,
        items: items.map((r) => ({
          invitationId: r.id,
          projectId: r.projectId,
          projectCode: r.projectCode,
          projectName: r.projectName,
          /** Opaque MADP reference, shortened: enough to tell people apart, nothing about who they are. */
          person: `…${r.ref.slice(-8)}`,
          panel: r.panel,
          countryCode: r.countryCode,
          outcome: r.outcome ?? (r.participatedAt ? 'no_outcome' : null),
          approval: r.approval,
          participatedAt: new Date(r.participatedAt).toISOString(),
        })),
        nextCursor: rows.length > limit && last ? `${new Date(last.participatedAt).toISOString()}|${last.id}` : null,
      };
    });
  }

  /**
   * Holds past participants for a cell of a project. Only people on the cell's panel and in its market qualify,
   * nobody already invited to or held for the project, and never more than the cell's cap. MADP re-checks each
   * one when it holds them, and again (consent and contact rules) right before any invitation is sent.
   */
  async recontact(ctx: RequestContext, projectId: string, cellId: string, body: RecontactRequest) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const now = new Date();
      const h = await this.audience.prepareHold(tx, projectId, cellId, now);
      const source = body.invitationIds
        ? inArray(invitations.id, body.invitationIds)
        : this.participantWhere(body.filter!);
      const rows = await tx
        .selectDistinctOn([invitations.ref], {
          ref: invitations.ref,
          panel: invitations.panel,
          countryCode: invitations.countryCode,
          projectId: invitations.projectId,
        })
        .from(invitations)
        .where(and(source, isNotNull(invitations.clickedAt)))
        .orderBy(asc(invitations.ref))
        .limit(20_000);
      const invited = new Set(
        (
          await tx
            .select({ ref: invitations.ref })
            .from(invitations)
            .where(
              and(
                eq(invitations.projectId, projectId),
                inArray(invitations.ref, rows.length ? rows.map((r) => r.ref) : ['-']),
              ),
            )
        ).map((r) => r.ref),
      );
      const skipped = { otherPanel: 0, otherMarket: 0, alreadyInProject: 0, overCap: 0 };
      const picked: { ref: string; panel: string }[] = [];
      const want = Math.min(body.max, h.room);
      for (const r of rows) {
        if (r.panel !== h.panel) skipped.otherPanel++;
        else if (r.countryCode !== h.cell.countryCode) skipped.otherMarket++;
        else if (invited.has(r.ref) || h.mine.has(r.ref)) skipped.alreadyInProject++;
        else if (picked.length >= want) skipped.overCap++;
        else picked.push({ ref: r.ref, panel: r.panel });
      }
      if (!picked.length)
        throw problem.conflict(
          'no_one_to_recontact',
          rows.length
            ? `None of the ${rows.length} people can be recontacted for this cell: ${describe(skipped, h.panel, h.cell.countryCode)}`
            : 'Nobody who took part matches this selection',
        );
      const r = await this.audience.hold(
        tx,
        ctx,
        h,
        picked,
        {
          requested: picked.length,
          expiresInDays: body.expiresInDays,
          origin: 'recontact',
          criteria: { recontact: body.invitationIds ? { picked: body.invitationIds.length } : body.filter },
          dataMode: 'recontact',
          eligible: null,
          returned: picked.length,
          excluded: skipped,
        },
        now,
      );
      return {
        ...r,
        considered: rows.length,
        skipped,
        cellHeld: h.held + r.held,
        cap: h.cell.inviteCap,
        next: 'Create a batch for this cell, or let semi-automatic or automatic mode propose one',
      };
    });
  }

  /** People in a project who did not finish and could be invited again, with the kind of dropout. */
  async dropouts(ctx: RequestContext, projectId: string, kinds?: DropoutKind[], countryCode?: string, limit = 500) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [p] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
      if (!p) throw problem.notFound('No such project');
      const ks = kinds?.length ? kinds : [...DROPOUT_KINDS];
      const where = and(
        eq(invitations.projectId, projectId),
        or(...ks.map((k) => DROPOUT[k])),
        countryCode ? eq(invitations.countryCode, countryCode) : undefined,
      )!;
      const counts = await Promise.all(
        DROPOUT_KINDS.map(async (k) => {
          const [{ n } = { n: 0 }] = await tx
            .select({ n: count() })
            .from(invitations)
            .where(
              and(
                eq(invitations.projectId, projectId),
                DROPOUT[k],
                countryCode ? eq(invitations.countryCode, countryCode) : undefined,
              ),
            );
          return [k, n] as const;
        }),
      );
      const rows = await tx
        .select()
        .from(invitations)
        .where(where)
        .orderBy(desc(invitations.sentAt), desc(invitations.id))
        .limit(limit);
      const gap = Date.now() - REINVITE_GAP_MS;
      return {
        counts: Object.fromEntries(counts),
        maxReinvites: MAX_REINVITES,
        items: rows.map((i) => ({
          invitationId: i.id,
          person: `…${i.ref.slice(-8)}`,
          countryCode: i.countryCode,
          dropout: dropoutOf(i),
          sentAt: i.sentAt?.toISOString() ?? null,
          clickedAt: i.clickedAt?.toISOString() ?? null,
          startedAt: i.startedAt?.toISOString() ?? null,
          reinviteCount: i.reinviteCount,
          lastReinvitedAt: i.lastReinvitedAt?.toISOString() ?? null,
          canReinvite: i.reinviteCount < MAX_REINVITES && (!i.lastReinvitedAt || i.lastReinvitedAt.getTime() <= gap),
        })),
      };
    });
  }

  /**
   * Sends selected dropouts their participation link again. Under the project lock, so two people pressing
   * Reinvite at once cannot send twice; each hand-off also has its own idempotency key.
   */
  async reinvite(ctx: RequestContext, projectId: string, body: ReinviteRequest) {
    const prep = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [p] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
      if (!p) throw problem.notFound('No such project');
      if ((await this.exec.halted(tx)).halted) throw problem.conflict('halted', REASON_TEXT.halted!);
      const policy = await this.exec.policyOf(tx, projectId);
      if (!policy) throw problem.conflict('policy_missing', REASON_TEXT.policy_missing!);
      const conn = await this.audience.activeOrThrow(tx);
      const now = new Date();
      const pick = body.invitationIds
        ? inArray(invitations.id, body.invitationIds)
        : or(...body.dropouts!.map((k) => DROPOUT[k]))!;
      const rows = await tx
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.projectId, projectId),
            pick,
            body.countryCode ? eq(invitations.countryCode, body.countryCode) : undefined,
          ),
        )
        .orderBy(asc(invitations.sentAt))
        .limit(5000);
      const skipped: Record<string, number> = {};
      const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
      const gateOf = new Map<string, string | null>();
      const ok: typeof rows = [];
      for (const i of rows) {
        if (!dropoutOf(i)) {
          skip(i.outcome ? 'final_outcome' : 'not_sent');
          continue;
        }
        if (i.reinviteCount >= MAX_REINVITES) {
          skip('reinvite_limit');
          continue;
        }
        if (i.lastReinvitedAt && now.getTime() - i.lastReinvitedAt.getTime() < REINVITE_GAP_MS) {
          skip('reinvited_recently');
          continue;
        }
        if (!gateOf.has(i.cellId)) {
          const [cell] = await tx.select().from(quotaCells).where(eq(quotaCells.id, i.cellId));
          gateOf.set(i.cellId, await this.exec.gate(tx, p, cell!, policy, now));
        }
        const g = gateOf.get(i.cellId);
        if (g) {
          skip(g);
          continue;
        }
        ok.push(i);
      }
      const [{ n: reinvitedToday } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(deliveryAttempts)
        .innerJoin(invitations, eq(invitations.id, deliveryAttempts.invitationId))
        .where(
          and(
            eq(invitations.projectId, projectId),
            eq(deliveryAttempts.kind, 'reinvite'),
            gte(deliveryAttempts.at, new Date(now.getTime() - DAY)),
          ),
        );
      const room = Math.max(
        0,
        policy.dailyMax - (await this.exec.sentToday(tx, projectId, policy, now)) - reinvitedToday,
      );
      for (const _ of ok.slice(room)) skip('daily_cap');
      return { p, policy, conn, now, todo: ok.slice(0, room), skipped, selected: rows.length };
    });
    if (!prep.todo.length)
      return {
        selected: prep.selected,
        reinvited: 0,
        skipped: prep.skipped,
        refused: 0,
        stopped: null as string | null,
      };

    // Consent and contact rules are checked at MADP right before sending.
    const consent = await this.audience.call(() =>
      this.audience.sourceFor(prep.conn).consent([...new Set(prep.todo.map((i) => i.ref))]),
    );
    const eligible = new Set(consent.results.filter((x) => x.eligible).map((x) => x.ref));
    const channel = this.exec.delivery(prep.conn);
    const [t] = await this.db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    let reinvited = 0;
    let refused = 0;
    let stopped: string | null = null;
    await withTenant(this.db, ctx.tenantId, async (tx) => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      if ((await this.exec.halted(tx)).halted) {
        stopped = 'halted';
        return;
      }
      for (const i of prep.todo) {
        if (!eligible.has(i.ref)) {
          refused++;
          continue;
        }
        const [cur] = await tx.select().from(invitations).where(eq(invitations.id, i.id)).for('update');
        if (!cur || !dropoutOf(cur) || cur.reinviteCount !== i.reinviteCount) continue; // changed meanwhile
        const n = cur.reinviteCount + 1;
        const key = `reinv-${cur.id}-${n}`;
        const r = await channel.send({
          idempotencyKey: key,
          kind: 'reinvite',
          madpInvitationId: cur.madpInvitationId,
          link: this.exec.linkFor(t!.slug, cur.id),
        });
        await tx
          .insert(deliveryAttempts)
          .values({
            tenantId: ctx.tenantId,
            invitationId: cur.id,
            kind: 'reinvite',
            idempotencyKey: key,
            status: r.status,
            detail: r.status === 'unavailable' ? r.detail : null,
          })
          .onConflictDoNothing();
        if (r.status === 'unavailable') {
          stopped = 'delivery_unavailable';
          break;
        }
        const validTo = new Date(prep.now.getTime() + prep.policy.linkValidDays * DAY);
        await tx
          .update(invitations)
          .set({
            reinviteCount: n,
            lastReinvitedAt: prep.now,
            expiresAt: cur.expiresAt > validTo ? cur.expiresAt : validTo,
          })
          .where(eq(invitations.id, cur.id));
        // The reinvite replaces any reminder still waiting for this person.
        await tx
          .update(reminderJobs)
          .set({ status: 'cancelled', reason: 'reinvited', doneAt: prep.now })
          .where(and(eq(reminderJobs.invitationId, cur.id), eq(reminderJobs.status, 'pending')));
        reinvited++;
      }
      await this.audit.write(tx, actorOf(ctx), {
        action: 'invitations.reinvited',
        targetType: 'project',
        targetId: projectId,
        reason: body.reason,
        details: {
          selected: prep.selected,
          reinvited,
          refused,
          skipped: prep.skipped,
          stopped,
          by: body.invitationIds ? 'selection' : { dropouts: body.dropouts },
        },
      });
    });
    return {
      selected: prep.selected,
      reinvited,
      refused,
      skipped: prep.skipped,
      stopped: stopped as string | null,
      stoppedText: stopped ? REASON_TEXT[stopped] : null,
    };
  }
}

function describe(s: Record<string, number>, panel: string, cc: string) {
  const parts = [
    s.otherPanel && `${s.otherPanel} are on another panel than ${panel}`,
    s.otherMarket && `${s.otherMarket} are outside ${cc}`,
    s.alreadyInProject && `${s.alreadyInProject} are already invited to or held for this project`,
  ].filter(Boolean);
  return parts.join('; ') || 'the cell is full';
}
