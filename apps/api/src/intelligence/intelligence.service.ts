import { Inject, Injectable } from '@nestjs/common';
import { ForecastAssumptions, RISK_LABELS } from '@s360/contracts';
import {
  deliveryPredictions,
  executionPolicies,
  invitations,
  notifications,
  projectMarkets,
  projects,
  quotaCells,
  reservedRefs,
  settings,
  withTenant,
  type Db,
  type Tx,
} from '@s360/db';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, notExists, sql } from 'drizzle-orm';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { DB } from '../db/db.module.js';
import { FieldworkService } from '../fieldwork/fieldwork.service.js';
import {
  DEFAULT_ASSUMPTIONS,
  forecast,
  MODEL_VERSION,
  recommendBatch,
  underperforming,
  type Assumptions,
  type Counts,
  type Forecast,
} from './forecast.js';

const KEY = 'forecast.assumptions';
/** Invitations younger than this have not had a fair chance to start, so they are left out of the start rate. */
export const START_WINDOW_HOURS = 48;
const ACTIVE = ['live', 'paused', 'source_hold', 'ready'] as const;

type Project = typeof projects.$inferSelect;

@Injectable()
export class IntelligenceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly fieldwork: FieldworkService,
    private readonly audit: AuditService,
  ) {}

  async assumptionsTx(tx: Tx): Promise<{ value: Assumptions; configured: boolean; version: number }> {
    const [row] = await tx.select().from(settings).where(eq(settings.key, KEY)).limit(1);
    if (!row) return { value: DEFAULT_ASSUMPTIONS, configured: false, version: 0 };
    const v = row.value as {
      startRatePercent: number;
      qualificationRatePercent: number;
      qualifiedToCompletePercent: number;
    };
    return {
      value: {
        startRate: v.startRatePercent / 100,
        qualificationRate: v.qualificationRatePercent / 100,
        qualifiedToComplete: v.qualifiedToCompletePercent / 100,
      },
      configured: true,
      version: row.version,
    };
  }

  assumptions(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const a = await this.assumptionsTx(tx);
      return {
        startRatePercent: a.value.startRate * 100,
        qualificationRatePercent: a.value.qualificationRate * 100,
        qualifiedToCompletePercent: a.value.qualifiedToComplete * 100,
        configured: a.configured,
        version: a.version,
      };
    });
  }

  setAssumptions(ctx: RequestContext, b: ForecastAssumptions) {
    const { reason, ...value } = b;
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [before] = await tx.select().from(settings).where(eq(settings.key, KEY)).limit(1);
      const [row] = await tx
        .insert(settings)
        .values({ tenantId: ctx.tenantId, key: KEY, value, updatedBy: ctx.userId })
        .onConflictDoUpdate({
          target: [settings.tenantId, settings.key],
          set: { value, updatedBy: ctx.userId, updatedAt: new Date(), version: sql`${settings.version} + 1` },
        })
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'forecast.assumptions_changed',
        targetType: 'settings',
        targetId: KEY,
        reason,
        details: { before: before?.value ?? null, after: value },
      });
      return { ...value, configured: true, version: row!.version };
    });
  }

  /** Everything the forecast needs for one project, read in one transaction. */
  async inputs(tx: Tx, p: Project, now = new Date()) {
    const byProject = eq(invitations.projectId, p.id);
    const raw = (await this.fieldwork.counts(tx, byProject)) as Record<string, number | null>;
    const counts: Counts = {
      sent: raw.sent ?? 0,
      started: raw.started ?? 0,
      complete: raw.complete ?? 0,
      terminate: raw.terminate ?? 0,
      quota_full: raw.quota_full ?? 0,
      quality_fail: raw.quality_fail ?? 0,
      approved: raw.approved ?? 0,
      rejected: raw.rejected ?? 0,
    };
    const matureBefore = new Date(now.getTime() - START_WINDOW_HOURS * 3_600_000);
    const [matured] = await tx
      .select({
        sent: sql<number>`count(*)::int`,
        started: sql<number>`count(*) filter (where ${invitations.startedAt} is not null or ${invitations.outcome} is not null)::int`,
      })
      .from(invitations)
      .where(and(byProject, isNotNull(invitations.sentAt), lt(invitations.sentAt, matureBefore)));
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(
          byProject,
          eq(invitations.outcome, 'complete'),
          gte(invitations.outcomeAt, new Date(now.getTime() - 72 * 3_600_000)),
        ),
      );
    const [held] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(reservedRefs)
      .where(
        and(
          eq(reservedRefs.projectId, p.id),
          gt(reservedRefs.expiresAt, now),
          notExists(
            tx
              .select({ x: sql`1` })
              .from(invitations)
              .where(and(eq(invitations.projectId, reservedRefs.projectId), eq(invitations.ref, reservedRefs.ref))),
          ),
        ),
      );
    const markets = await tx.select().from(projectMarkets).where(eq(projectMarkets.projectId, p.id));
    const targets = markets.map((m) => m.vendorTarget).filter((x): x is number => x != null);
    const irs = markets.map((m) => m.irPercent).filter((x): x is number => x != null);
    const daysLeft = p.fieldEndAt ? Math.ceil((p.fieldEndAt.getTime() - now.getTime()) / 86_400_000) : null;
    const fieldShareUsed =
      p.fieldStartAt && p.fieldEndAt && p.fieldEndAt > p.fieldStartAt
        ? Math.min(
            1,
            Math.max(
              0,
              (now.getTime() - p.fieldStartAt.getTime()) / (p.fieldEndAt.getTime() - p.fieldStartAt.getTime()),
            ),
          )
        : null;
    return {
      counts,
      matured: matured ?? { sent: 0, started: 0 },
      target: targets.length ? targets.reduce((a, b) => a + b, 0) : null,
      daysLeft,
      fieldShareUsed,
      recentCompletes: recent?.n ?? 0,
      heldNotInvited: held?.n ?? 0,
      briefIrPercent: irs.length ? Math.round(irs.reduce((a, b) => a + b, 0) / irs.length) : null,
    };
  }

  private async compute(tx: Tx, p: Project, now = new Date()) {
    const a = await this.assumptionsTx(tx);
    const i = await this.inputs(tx, p, now);
    const f = forecast({ ...i, assumptions: a.value });
    const cells = await tx
      .select()
      .from(quotaCells)
      .where(and(eq(quotaCells.projectId, p.id), eq(quotaCells.removed, false)))
      .orderBy(asc(quotaCells.countryCode), asc(quotaCells.name));
    const cellCounts = await tx
      .select({
        cellId: invitations.cellId,
        complete: sql<number>`count(*) filter (where ${invitations.outcome} = 'complete')::int`,
        terminate: sql<number>`count(*) filter (where ${invitations.outcome} = 'terminate')::int`,
      })
      .from(invitations)
      .where(eq(invitations.projectId, p.id))
      .groupBy(invitations.cellId);
    const byCell = new Map(cellCounts.map((c) => [c.cellId, c]));
    const under = underperforming(
      cells.map((c) => ({
        id: c.id,
        name: c.name,
        countryCode: c.countryCode,
        target: c.allocationTarget,
        complete: byCell.get(c.id)?.complete ?? 0,
        terminate: byCell.get(c.id)?.terminate ?? 0,
        isOpen: c.isOpen,
      })),
      i.fieldShareUsed,
    );
    const [pol] = await tx.select().from(executionPolicies).where(eq(executionPolicies.projectId, p.id));
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const [today] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invitations)
      .where(and(eq(invitations.projectId, p.id), gte(invitations.sentAt, dayStart)));
    const recommendation = pol
      ? recommendBatch(f, { batchSize: pol.batchSize, dailyMaxLeft: Math.max(0, pol.dailyMax - (today?.n ?? 0)) })
      : { size: 0, why: 'Set an execution policy first; the recommendation stays inside its limits.' };
    return { f, i, under, recommendation, assumptionsConfigured: a.configured };
  }

  async forProject(ctx: RequestContext, projectId: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [p] = await tx.select().from(projects).where(eq(projects.id, projectId));
      if (!p) throw problem.notFound('No such project');
      const r = await this.compute(tx, p);
      const history = await tx
        .select({
          risk: deliveryPredictions.risk,
          createdAt: deliveryPredictions.createdAt,
          forecast: deliveryPredictions.forecast,
        })
        .from(deliveryPredictions)
        .where(eq(deliveryPredictions.projectId, projectId))
        .orderBy(desc(deliveryPredictions.createdAt))
        .limit(30);
      return {
        project: { id: p.id, projectCode: p.projectCode, name: p.name, lifecycle: p.lifecycle, daysLeft: r.i.daysLeft },
        ...view(r.f),
        target: r.i.target,
        complete: r.i.counts.complete,
        underperformingCells: r.under,
        recommendation: r.recommendation,
        assumptionsConfigured: r.assumptionsConfigured,
        history: history.map((h) => ({
          risk: h.risk,
          at: h.createdAt.toISOString(),
          invitationsNeeded: (h.forecast as Forecast).invitationsNeeded?.value ?? null,
        })),
      };
    });
  }

  /** Every active project, riskiest first. */
  async portfolio(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const ps = await tx
        .select()
        .from(projects)
        .where(inArray(projects.lifecycle, [...ACTIVE]))
        .orderBy(asc(projects.fieldEndAt))
        .limit(100);
      const rows = [];
      for (const p of ps) {
        const r = await this.compute(tx, p);
        rows.push({
          id: p.id,
          projectCode: p.projectCode,
          name: p.name,
          lifecycle: p.lifecycle,
          daysLeft: r.i.daysLeft,
          target: r.i.target,
          complete: r.i.counts.complete,
          risk: r.f.risk,
          riskLabel: RISK_LABELS[r.f.risk],
          invitationsNeeded: finite(r.f.invitationsNeeded),
          heldNotInvited: r.f.heldNotInvited,
          shortfall: r.f.shortfall,
          pace: r.f.pace,
          underperformingCells: r.under.length,
          usesAssumptions: r.f.assumptionsUsed.length > 0,
        });
      }
      const order = ['off_track', 'at_risk', 'not_enough_data', 'on_track', 'no_deadline', 'reached'];
      rows.sort((a, b) => order.indexOf(a.risk) - order.indexOf(b.risk));
      return { modelVersion: MODEL_VERSION, items: rows };
    });
  }

  /**
   * Module 10: how panels, countries and quota segments have performed, from Supply360's own invitations. Every rate
   * carries its denominator; groups under the minimum sample are shown but marked, never ranked.
   */
  async audience(ctx: RequestContext, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const agg = {
        sent: sql<number>`count(*) filter (where ${invitations.sentAt} is not null)::int`,
        started: sql<number>`count(*) filter (where ${invitations.startedAt} is not null or ${invitations.outcome} is not null)::int`,
        complete: sql<number>`count(*) filter (where ${invitations.outcome} = 'complete')::int`,
        terminate: sql<number>`count(*) filter (where ${invitations.outcome} = 'terminate')::int`,
        qualityFail: sql<number>`count(*) filter (where ${invitations.outcome} = 'quality_fail')::int`,
        medianLoiSeconds: sql<
          number | null
        >`percentile_cont(0.5) within group (order by ${invitations.loiSeconds}) filter (where ${invitations.outcome} = 'complete')`,
      };
      const where = gte(invitations.sentAt, since);
      const byPanel = await tx
        .select({ key: invitations.panel, ...agg })
        .from(invitations)
        .where(where)
        .groupBy(invitations.panel);
      const byCountry = await tx
        .select({ key: invitations.countryCode, ...agg })
        .from(invitations)
        .where(where)
        .groupBy(invitations.countryCode);
      const bySegment = await tx
        .select({
          key: sql<string>`${quotaCells.countryCode} || ' · ' || coalesce(nullif(${quotaCells.groupName}, '') || ' · ', '') || ${quotaCells.name}`,
          ...agg,
        })
        .from(invitations)
        .innerJoin(quotaCells, eq(quotaCells.id, invitations.cellId))
        .where(where)
        .groupBy(quotaCells.countryCode, quotaCells.groupName, quotaCells.name);
      return {
        days,
        since: since.toISOString(),
        minSample: { sent: 100, screened: 30 },
        definitions: {
          startRate: 'Sessions started ÷ invitations sent',
          incidence: 'Completes ÷ (completes + terminates), as in IR Intelligence',
          completesPerInvite: 'Completes ÷ invitations sent',
        },
        panels: byPanel.map(perf),
        countries: byCountry.map(perf),
        segments: bySegment
          .map(perf)
          .sort((a, b) => b.sent - a.sent)
          .slice(0, 100),
      };
    });
  }

  /**
   * Scheduler step: one snapshot per active project per hour, and a notification when a project's risk gets worse or
   * its target is reached. Never sends anything; people decide.
   */
  async tick(tenantId: string, now = new Date()) {
    return withTenant(this.db, tenantId, async (tx) => {
      const ps = await tx
        .select()
        .from(projects)
        .where(inArray(projects.lifecycle, ['live', 'paused', 'source_hold']));
      let written = 0;
      for (const p of ps) {
        const [last] = await tx
          .select()
          .from(deliveryPredictions)
          .where(eq(deliveryPredictions.projectId, p.id))
          .orderBy(desc(deliveryPredictions.createdAt))
          .limit(1);
        if (last && now.getTime() - last.createdAt.getTime() < 3_600_000) continue;
        const r = await this.compute(tx, p, now);
        await tx.insert(deliveryPredictions).values({
          tenantId,
          projectId: p.id,
          modelVersion: r.f.modelVersion,
          risk: r.f.risk,
          forecast: r.f as unknown as Record<string, unknown>,
          inputs: { ...r.i, assumptionsConfigured: r.assumptionsConfigured } as unknown as Record<string, unknown>,
        });
        written++;
        const n = notice(p, r.f, last?.risk ?? null, r.under.length);
        if (n)
          await tx.insert(notifications).values({ tenantId, userId: null, ...n, link: `/delivery?project=${p.id}` });
      }
      return { written };
    });
  }
}

const finite = (x: { value: number; low: number; high: number } | null) => (x && Number.isFinite(x.value) ? x : null);

export function view(f: Forecast) {
  return {
    modelVersion: f.modelVersion,
    risk: f.risk,
    riskLabel: RISK_LABELS[f.risk],
    rates: f.rates,
    completesPerInvite: f.completesPerInvite,
    remaining: f.remaining,
    invitationsNeeded: finite(f.invitationsNeeded),
    heldNotInvited: f.heldNotInvited,
    shortfall: f.shortfall,
    pace: f.pace,
    projectedCompletesByDeadline: f.projectedCompletesByDeadline,
    assumptionsUsed: f.assumptionsUsed,
    sampleSizes: f.sampleSizes,
  };
}

/** The notification for a change in delivery risk, or null when nothing changed that a person needs to know. */
export function notice(
  p: { projectCode: string; name: string },
  f: Forecast,
  before: string | null,
  underCells: number,
): { kind: string; severity: string; title: string; body: string } | null {
  if (f.risk === before) return null;
  if (f.risk === 'reached')
    return {
      kind: 'target_achieved',
      severity: 'info',
      title: `${p.projectCode} reached its target`,
      body: `${p.name} has all the completes Supply360 was asked for. Sending stops by itself.`,
    };
  if (f.risk === 'off_track' || (f.risk === 'at_risk' && before !== 'off_track'))
    return {
      kind: f.risk === 'off_track' ? 'low_delivery' : 'quota_risk',
      severity: f.risk === 'off_track' ? 'danger' : 'warning',
      title: `${p.projectCode} is ${RISK_LABELS[f.risk]!.toLowerCase()}`,
      body: `${f.pace.perDay} completes a day against ${f.pace.neededPerDay ?? '—'} needed${underCells ? `; ${underCells} quota cell${underCells === 1 ? ' is' : 's are'} behind` : ''}.`,
    };
  return null;
}

function perf(r: {
  key: string;
  sent: number;
  started: number;
  complete: number;
  terminate: number;
  qualityFail: number;
  medianLoiSeconds: number | null;
}) {
  const r1 = (x: number) => Math.round(x * 1000) / 10;
  const screened = r.complete + r.terminate;
  return {
    key: r.key,
    sent: r.sent,
    started: r.started,
    complete: r.complete,
    terminate: r.terminate,
    qualityFail: r.qualityFail,
    startRate: r.sent ? r1(r.started / r.sent) : null,
    incidence: screened ? r1(r.complete / screened) : null,
    completesPerInvite: r.sent ? r1(r.complete / r.sent) : null,
    medianLoiMinutes: r.medianLoiSeconds == null ? null : Math.round((Number(r.medianLoiSeconds) / 60) * 10) / 10,
    enoughData: r.sent >= 100 && screened >= 30,
  };
}
