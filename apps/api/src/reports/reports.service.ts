import { Inject, Injectable, Logger } from '@nestjs/common';
import { REPORT_LABELS, type ReportKind, type ReportRequest } from '@s360/contracts';
import {
  audienceSelections,
  auditLogs,
  invitations,
  projectMarkets,
  projects,
  qualityFlags,
  quotaCells,
  reconciliationRuns,
  redirectHits,
  reportExports,
  reservedRefs,
  rewardEvents,
  withTenant,
  type Db,
  type Tx,
} from '@s360/db';
import { and, asc, desc, eq, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { DB } from '../db/db.module.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { SampIntelService } from '../sampintel/sampintel.js';
import { toCsv, toJson, toXlsx, validZone, type Table } from './render.js';

/** Exports are kept this long, then the file is removed and the row marked expired. */
export const EXPORT_TTL_HOURS = 24;
export const MAX_ROWS = 100_000;
const CONTENT_TYPE = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

type Row = typeof reportExports.$inferSelect;
const view = (r: Row) => ({
  id: r.id,
  kind: r.kind,
  label: REPORT_LABELS[r.kind as ReportKind] ?? r.kind,
  format: r.format,
  filters: r.filters,
  timezone: r.timezone,
  status: r.status,
  rows: r.rows,
  fileName: r.fileName,
  error: r.error,
  downloads: r.downloads,
  expiresAt: r.expiresAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
  completedAt: r.completedAt?.toISOString() ?? null,
});

@Injectable()
export class ReportsService {
  private readonly log = new Logger('Reports');
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly intelligence: IntelligenceService,
    private readonly sampintel: SampIntelService,
  ) {}

  async request(ctx: RequestContext, b: ReportRequest) {
    if (!validZone(b.timezone)) throw problem.badRequest('bad_timezone', 'Unknown time zone');
    if (b.kind === 'audit' && !ctx.permissions.includes('audit.read'))
      throw problem.forbidden('forbidden', 'The audit report needs audit.read');
    const row = await withTenant(this.db, ctx.tenantId, async (tx) => {
      if (b.projectId) {
        const [p] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, b.projectId));
        if (!p) throw problem.notFound('No such project');
      }
      const [r] = await tx
        .insert(reportExports)
        .values({
          tenantId: ctx.tenantId,
          requestedBy: ctx.userId,
          kind: b.kind,
          format: b.format,
          filters: { projectId: b.projectId ?? null, from: b.from ?? null, to: b.to ?? null },
          timezone: b.timezone,
          expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000),
        })
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'report.requested',
        targetType: 'report_export',
        targetId: r!.id,
        details: { kind: b.kind, format: b.format, projectId: b.projectId ?? null },
      });
      return r!;
    });
    // Built in the background; the scheduler picks up anything left queued.
    setImmediate(() => void this.process(ctx.tenantId, row.id, ctx));
    return view(row);
  }

  list(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(reportExports)
        .where(eq(reportExports.requestedBy, ctx.userId))
        .orderBy(desc(reportExports.createdAt))
        .limit(100);
      return { items: rows.map(view), ttlHours: EXPORT_TTL_HOURS };
    });
  }

  get(ctx: RequestContext, id: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [r] = await tx.select().from(reportExports).where(eq(reportExports.id, id));
      if (!r || r.requestedBy !== ctx.userId) throw problem.notFound('No such export');
      return view(r);
    });
  }

  /** Only the person who asked for an export can download it, and only until it expires. */
  download(ctx: RequestContext, id: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [r] = await tx.select().from(reportExports).where(eq(reportExports.id, id)).for('update');
      if (!r || r.requestedBy !== ctx.userId) throw problem.notFound('No such export');
      if (r.status === 'expired' || r.expiresAt <= new Date())
        throw problem.gone('This export has expired; ask for it again');
      if (r.status !== 'ready' || !r.content) throw problem.conflict('not_ready', `This export is ${r.status}`);
      await tx
        .update(reportExports)
        .set({ downloads: sql`${reportExports.downloads} + 1` })
        .where(eq(reportExports.id, id));
      await this.audit.write(tx, actorOf(ctx), {
        action: 'report.downloaded',
        targetType: 'report_export',
        targetId: id,
        details: { kind: r.kind, format: r.format },
      });
      return {
        fileName: r.fileName!,
        contentType: CONTENT_TYPE[r.format as keyof typeof CONTENT_TYPE],
        content: r.content,
      };
    });
  }

  async process(tenantId: string, id: string, ctx?: RequestContext) {
    const claimed = await withTenant(this.db, tenantId, async (tx) => {
      const [r] = await tx
        .update(reportExports)
        .set({ status: 'building' })
        .where(and(eq(reportExports.id, id), eq(reportExports.status, 'queued')))
        .returning();
      return r;
    });
    if (!claimed) return;
    try {
      const f = claimed.filters as { projectId: string | null; from: string | null; to: string | null };
      const table = await this.build(tenantId, claimed.kind as ReportKind, f, ctx);
      const code = f.projectId
        ? await withTenant(
            this.db,
            tenantId,
            async (tx) =>
              (await tx.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, f.projectId!)))[0]?.c,
          )
        : null;
      const stamp = new Date().toISOString().slice(0, 10);
      const prefix = claimed.kind === 'synthetic_qa' ? 'SYNTHETIC-QA-' : '';
      const fileName = `${prefix}${claimed.kind}${code ? `-${code}` : ''}-${stamp}.${claimed.format}`;
      const content =
        claimed.format === 'csv'
          ? Buffer.from(toCsv(table, claimed.timezone), 'utf8')
          : claimed.format === 'json'
            ? Buffer.from(
                toJson(table, claimed.timezone, { kind: claimed.kind, generatedAt: new Date().toISOString() }),
                'utf8',
              )
            : await toXlsx(table, claimed.timezone, REPORT_LABELS[claimed.kind as ReportKind] ?? 'Report');
      await withTenant(this.db, tenantId, (tx) =>
        tx
          .update(reportExports)
          .set({ status: 'ready', rows: table.rows.length, fileName, content, completedAt: new Date() })
          .where(eq(reportExports.id, id)),
      );
    } catch (e) {
      this.log.warn(`export ${id}: ${(e as Error).message}`);
      await withTenant(this.db, tenantId, (tx) =>
        tx
          .update(reportExports)
          .set({ status: 'failed', error: (e as Error).message.slice(0, 300), completedAt: new Date() })
          .where(eq(reportExports.id, id)),
      );
    }
  }

  /** Scheduler step: build anything left queued, and expire old files. */
  async tick(tenantId: string) {
    const now = new Date();
    const { queued, expired } = await withTenant(this.db, tenantId, async (tx) => {
      const expired = await tx
        .update(reportExports)
        .set({ status: 'expired', content: null })
        .where(and(lte(reportExports.expiresAt, now), sql`${reportExports.status} <> 'expired'`))
        .returning({ id: reportExports.id });
      const queued = await tx
        .select({ id: reportExports.id })
        .from(reportExports)
        .where(and(eq(reportExports.status, 'queued'), lt(reportExports.createdAt, new Date(now.getTime() - 30_000))))
        .limit(20);
      return { queued, expired };
    });
    for (const q of queued) await this.process(tenantId, q.id);
    return { built: queued.length, expired: expired.length };
  }

  private async build(
    tenantId: string,
    kind: ReportKind,
    f: { projectId: string | null; from: string | null; to: string | null },
    ctx?: RequestContext,
  ): Promise<Table> {
    const sysCtx = ctx ?? ({ tenantId } as RequestContext);
    if (kind === 'synthetic_qa') {
      const s = await this.sampintel.forProject(sysCtx, f.projectId!);
      const notice =
        'SYNTHETIC QA from SampIntel AI. Never counted in human quotas, IR, LOI, rewards, invoices or delivery.';
      if (!s.summary)
        return {
          notice,
          columns: ['qa_mode', 'connection', 'error'],
          rows: [[s.qaMode, s.connection, s.error ?? 'No synthetic QA summary']],
        };
      const sm = s.summary;
      return {
        notice: `${notice} ${sm.notice}`,
        columns: ['metric', 'value'],
        rows: [
          ['classification', sm.classification],
          ['project_ref', sm.projectRef],
          ['synthetic_sessions', sm.sessions],
          ...Object.entries(sm.outcomes).map(([k, v]) => [`outcome_${k}`, v] as [string, number]),
          ['assertions_passed', sm.assertions.passed],
          ['assertions_failed', sm.assertions.failed],
          ['blocked_redirects', sm.blockedRedirects],
          ['last_session_at', sm.lastSessionAt ? new Date(sm.lastSessionAt) : null],
        ],
      };
    }
    if (kind === 'delivery_forecast') {
      const pf = await this.intelligence.portfolio(sysCtx);
      return {
        notice:
          'Forecasts are ranges from observed rates, or labelled assumptions where data is thin. Not a guarantee.',
        columns: [
          'project',
          'name',
          'lifecycle',
          'days_left',
          'target',
          'complete',
          'risk',
          'invitations_needed',
          'needed_low',
          'needed_high',
          'held_not_invited',
          'shortfall',
          'completes_per_day',
          'needed_per_day',
          'cells_behind',
          'uses_assumptions',
        ],
        rows: pf.items.map((r) => [
          r.projectCode,
          r.name,
          r.lifecycle,
          r.daysLeft,
          r.target,
          r.complete,
          r.riskLabel ?? r.risk,
          r.invitationsNeeded?.value ?? null,
          r.invitationsNeeded?.low ?? null,
          r.invitationsNeeded?.high ?? null,
          r.heldNotInvited,
          r.shortfall,
          r.pace.perDay,
          r.pace.neededPerDay,
          r.underperformingCells,
          r.usesAssumptions,
        ]),
      };
    }
    return withTenant(this.db, tenantId, (tx) => this.query(tx, kind, f));
  }

  private async query(
    tx: Tx,
    kind: ReportKind,
    f: { projectId: string | null; from: string | null; to: string | null },
  ): Promise<Table> {
    const range = (col: Parameters<typeof gte>[0]) =>
      [f.from ? gte(col, new Date(f.from)) : undefined, f.to ? lt(col, new Date(f.to)) : undefined].filter(
        Boolean,
      ) as SQL[];
    const proj = (col: Parameters<typeof eq>[0]) => (f.projectId ? [eq(col, f.projectId)] : []);
    const funnel = {
      sent: sql<number>`count(${invitations.id}) filter (where ${invitations.sentAt} is not null)::int`,
      clicked: sql<number>`count(${invitations.id}) filter (where ${invitations.clickedAt} is not null)::int`,
      started: sql<number>`count(${invitations.id}) filter (where ${invitations.startedAt} is not null or ${invitations.outcome} is not null)::int`,
      complete: sql<number>`count(${invitations.id}) filter (where ${invitations.outcome} = 'complete')::int`,
      terminate: sql<number>`count(${invitations.id}) filter (where ${invitations.outcome} = 'terminate')::int`,
      quotaFull: sql<number>`count(${invitations.id}) filter (where ${invitations.outcome} = 'quota_full')::int`,
      qualityFail: sql<number>`count(${invitations.id}) filter (where ${invitations.outcome} = 'quality_fail')::int`,
      approved: sql<number>`count(${invitations.id}) filter (where ${invitations.approval} = 'approved')::int`,
      rejected: sql<number>`count(${invitations.id}) filter (where ${invitations.approval} = 'rejected')::int`,
    };
    const ir = (c: number, t: number) => (c + t ? Math.round((c / (c + t)) * 1000) / 10 : null);
    switch (kind) {
      case 'project_summary':
      case 'invitation_funnel': {
        const byMarket = kind === 'project_summary';
        const rows = await tx
          .select({
            code: projects.projectCode,
            name: projects.name,
            cc: byMarket ? invitations.countryCode : sql<string>`''`,
            ...funnel,
          })
          .from(invitations)
          .innerJoin(projects, eq(projects.id, invitations.projectId))
          .where(and(...proj(invitations.projectId), ...range(invitations.sentAt)))
          .groupBy(projects.projectCode, projects.name, ...(byMarket ? [invitations.countryCode] : []))
          .orderBy(asc(projects.projectCode));
        return {
          columns: [
            'project',
            'name',
            ...(byMarket ? ['country'] : []),
            'sent',
            'clicked',
            'started',
            'complete',
            'terminate',
            'quota_full',
            'quality_fail',
            'client_approved',
            'client_rejected',
            'incidence_pct',
          ],
          rows: rows.map((r) => [
            r.code,
            r.name,
            ...(byMarket ? [r.cc] : []),
            r.sent,
            r.clicked,
            r.started,
            r.complete,
            r.terminate,
            r.quotaFull,
            r.qualityFail,
            r.approved,
            r.rejected,
            ir(r.complete, r.terminate),
          ]),
        };
      }
      case 'participation': {
        const rows = await tx
          .select({ i: invitations, code: projects.projectCode })
          .from(invitations)
          .innerJoin(projects, eq(projects.id, invitations.projectId))
          .where(and(...proj(invitations.projectId), ...range(invitations.sentAt)))
          .orderBy(asc(invitations.sentAt))
          .limit(MAX_ROWS);
        return {
          columns: [
            'invitation_id',
            'project',
            'country',
            'panel',
            'status',
            'sent_at',
            'clicked_at',
            'started_at',
            'outcome',
            'outcome_at',
            'outcome_source',
            'loi_minutes',
            'client_approval',
            'reinvites',
          ],
          rows: rows.map(({ i, code }) => [
            i.id,
            code,
            i.countryCode,
            i.panel,
            i.status,
            i.sentAt,
            i.clickedAt,
            i.startedAt,
            i.outcome,
            i.outcomeAt,
            i.outcomeSource,
            i.loiSeconds == null ? null : Math.round(i.loiSeconds / 6) / 10,
            i.approval,
            i.reinviteCount,
          ]),
        };
      }
      case 'quotas':
      case 'allocations': {
        const rows = await tx
          .select({
            c: quotaCells,
            code: projects.projectCode,
            complete: sql<number>`(select count(*)::int from ${invitations} where ${invitations.cellId} = ${quotaCells.id} and ${invitations.outcome} = 'complete')`,
            held: sql<number>`(select count(*)::int from ${reservedRefs} where ${reservedRefs.cellId} = ${quotaCells.id} and ${reservedRefs.expiresAt} > now())`,
          })
          .from(quotaCells)
          .innerJoin(projects, eq(projects.id, quotaCells.projectId))
          .where(and(...proj(quotaCells.projectId), eq(quotaCells.removed, false)))
          .orderBy(asc(projects.projectCode), asc(quotaCells.countryCode), asc(quotaCells.name));
        return kind === 'quotas'
          ? {
              columns: [
                'project',
                'country',
                'group',
                'cell',
                'open',
                'source_target_all_vendors',
                'source_completes_all_vendors',
                'supply360_target',
                'supply360_complete',
                'remaining',
              ],
              rows: rows.map(({ c, code, complete }) => [
                code,
                c.countryCode,
                c.groupName,
                c.name,
                c.isOpen,
                c.sourceTarget,
                c.sourceCompletes,
                c.allocationTarget,
                complete,
                c.allocationTarget == null ? null : Math.max(0, c.allocationTarget - complete),
              ]),
            }
          : {
              columns: [
                'project',
                'country',
                'group',
                'cell',
                'supply360_target',
                'invite_cap',
                'people_held_now',
                'mapped_to_madp',
              ],
              rows: rows.map(({ c, code, held }) => [
                code,
                c.countryCode,
                c.groupName,
                c.name,
                c.allocationTarget,
                c.inviteCap,
                held,
                c.criteria != null,
              ]),
            };
      }
      case 'audience_selections': {
        const rows = await tx
          .select({
            s: audienceSelections,
            code: projects.projectCode,
            cell: quotaCells.name,
            cc: quotaCells.countryCode,
          })
          .from(audienceSelections)
          .innerJoin(projects, eq(projects.id, audienceSelections.projectId))
          .innerJoin(quotaCells, eq(quotaCells.id, audienceSelections.cellId))
          .where(and(...proj(audienceSelections.projectId), ...range(audienceSelections.createdAt)))
          .orderBy(desc(audienceSelections.createdAt))
          .limit(MAX_ROWS);
        // References are counted, never listed.
        return {
          columns: [
            'selection_id',
            'project',
            'country',
            'cell',
            'data_mode',
            'criteria',
            'eligible',
            'returned',
            'created_at',
          ],
          rows: rows.map(({ s, code, cell, cc }) => [
            s.id,
            code,
            cc,
            cell,
            s.dataMode,
            JSON.stringify(s.criteria),
            s.eligible,
            s.returned,
            s.createdAt,
          ]),
        };
      }
      case 'redirects': {
        const rows = await tx
          .select({
            code: projects.projectCode,
            outcome: redirectHits.outcome,
            n: sql<number>`count(*)::int`,
            last: sql<Date>`max(${redirectHits.receivedAt})`,
          })
          .from(redirectHits)
          .innerJoin(projects, eq(projects.id, redirectHits.projectId))
          .where(and(...proj(redirectHits.projectId), ...range(redirectHits.receivedAt)))
          .groupBy(projects.projectCode, redirectHits.outcome)
          .orderBy(asc(projects.projectCode), asc(redirectHits.outcome));
        return {
          notice: 'Redirect arrivals are unverified until SampTrek’s signed callback confirms them.',
          columns: ['project', 'outcome', 'arrivals', 'last_arrival'],
          rows: rows.map((r) => [r.code, r.outcome, r.n, r.last ? new Date(r.last) : null]),
        };
      }
      case 'ir_loi': {
        const rows = await tx
          .select({
            code: projects.projectCode,
            cc: invitations.countryCode,
            complete: funnel.complete,
            terminate: funnel.terminate,
            median: sql<
              number | null
            >`percentile_cont(0.5) within group (order by ${invitations.loiSeconds}) filter (where ${invitations.outcome} = 'complete')`,
            briefIr: sql<number | null>`max(${projectMarkets.irPercent})`,
            briefLoi: sql<number | null>`max(${projectMarkets.loiMinutes})`,
          })
          .from(invitations)
          .innerJoin(projects, eq(projects.id, invitations.projectId))
          .leftJoin(
            projectMarkets,
            and(
              eq(projectMarkets.projectId, invitations.projectId),
              eq(projectMarkets.countryCode, invitations.countryCode),
            ),
          )
          .where(and(...proj(invitations.projectId), ...range(invitations.sentAt)))
          .groupBy(projects.projectCode, invitations.countryCode)
          .orderBy(asc(projects.projectCode), asc(invitations.countryCode));
        return {
          notice:
            'Incidence = completes ÷ (completes + terminates). LOI from SampTrek’s reported start and outcome times, completes only.',
          columns: [
            'project',
            'country',
            'complete',
            'terminate',
            'incidence_pct',
            'brief_ir_pct',
            'median_loi_min',
            'brief_loi_min',
          ],
          rows: rows.map((r) => [
            r.code,
            r.cc,
            r.complete,
            r.terminate,
            ir(r.complete, r.terminate),
            r.briefIr,
            r.median == null ? null : Math.round((Number(r.median) / 60) * 10) / 10,
            r.briefLoi,
          ]),
        };
      }
      case 'quality': {
        const rows = await tx
          .select({ q: qualityFlags, code: projects.projectCode })
          .from(qualityFlags)
          .innerJoin(projects, eq(projects.id, qualityFlags.projectId))
          .where(and(...proj(qualityFlags.projectId), ...range(qualityFlags.createdAt)))
          .orderBy(desc(qualityFlags.createdAt))
          .limit(MAX_ROWS);
        return {
          columns: [
            'flag_id',
            'project',
            'invitation_id',
            'kind',
            'status',
            'detail',
            'review_reason',
            'created_at',
            'reviewed_at',
          ],
          rows: rows.map(({ q, code }) => [
            q.id,
            code,
            q.invitationId,
            q.kind,
            q.status,
            JSON.stringify(q.detail),
            q.reviewReason,
            q.createdAt,
            q.reviewedAt,
          ]),
        };
      }
      case 'reconciliation': {
        const rows = await tx
          .select({ r: reconciliationRuns, code: projects.projectCode })
          .from(reconciliationRuns)
          .innerJoin(projects, eq(projects.id, reconciliationRuns.projectId))
          .where(and(...proj(reconciliationRuns.projectId), ...range(reconciliationRuns.startedAt)))
          .orderBy(desc(reconciliationRuns.startedAt))
          .limit(MAX_ROWS);
        return {
          columns: ['run_id', 'project', 'status', 'summary', 'differences', 'started_at', 'finished_at'],
          rows: rows.map(({ r, code }) => [
            r.id,
            code,
            r.status,
            JSON.stringify(r.summary),
            Array.isArray(r.differences) ? r.differences.length : null,
            r.startedAt,
            r.finishedAt,
          ]),
        };
      }
      case 'reward_events': {
        const rows = await tx
          .select({ r: rewardEvents, code: projects.projectCode })
          .from(rewardEvents)
          .innerJoin(projects, eq(projects.id, rewardEvents.projectId))
          .where(and(...proj(rewardEvents.projectId), ...range(rewardEvents.createdAt)))
          .orderBy(desc(rewardEvents.createdAt))
          .limit(MAX_ROWS);
        return {
          notice: 'Reward events handed to MADP. Supply360 never credits a wallet.',
          columns: [
            'event_id',
            'project',
            'invitation_id',
            'idempotency_key',
            'status',
            'detail',
            'attempts',
            'created_at',
            'sent_at',
          ],
          rows: rows.map(({ r, code }) => [
            r.id,
            code,
            r.invitationId,
            r.idempotencyKey,
            r.status,
            r.detail,
            r.attempts,
            r.createdAt,
            r.sentAt,
          ]),
        };
      }
      case 'audit': {
        const rows = await tx
          .select()
          .from(auditLogs)
          .where(and(...range(auditLogs.at), ...(f.projectId ? [eq(auditLogs.targetId, f.projectId)] : [])))
          .orderBy(desc(auditLogs.at))
          .limit(MAX_ROWS);
        return {
          columns: ['at', 'actor', 'action', 'target_type', 'target_id', 'reason', 'correlation_id', 'details'],
          rows: rows.map((a) => [
            a.at,
            a.actorEmail,
            a.action,
            a.targetType,
            a.targetId,
            a.reason,
            a.correlationId,
            JSON.stringify(a.details),
          ]),
        };
      }
      default:
        throw new Error(`Unknown report ${kind}`);
    }
  }
}
