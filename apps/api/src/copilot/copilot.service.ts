import { Inject, Injectable } from '@nestjs/common';
import { AudienceCriteria, REPORT_LABELS, type CopilotDecision } from '@s360/contracts';
import { copilotInteractions, projects, quotaCells, reminderJobs, withTenant, type Db } from '@s360/db';
import { and, asc, count, desc, eq, min } from 'drizzle-orm';
import { actorOf, AuditService } from '../audit/audit.service.js';
import { AudienceService } from '../audience/audience.service.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { DB } from '../db/db.module.js';
import { batchView, ExecutionService } from '../execution/execution.service.js';
import { FieldworkService } from '../fieldwork/fieldwork.service.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { AI_VERSION_PREFIX, CopilotAiService } from './ai/copilot-ai.service.js';
import { extractJson, ModelUnavailable } from './ai/providers.js';
import { checkedTranslation, toParsed, translatePrompt, understandPrompt } from './ai/understand.js';
import { COPILOT_VERSION, describe, EXAMPLES, parse, PERMISSION_FOR, type Parsed } from './parse.js';

type Interaction = typeof copilotInteractions.$inferSelect;
interface Answer {
  text: string;
  data?: unknown;
  action?: {
    type: 'create_batch';
    projectId: string;
    projectCode: string;
    cellId: string;
    cellName: string;
    size: number;
    reason: string;
  };
}

const view = (r: Interaction) => ({
  id: r.id,
  prompt: r.prompt,
  intent: r.intent,
  query: r.query,
  modelVersion: r.modelVersion,
  rationale: r.rationale,
  status: r.status,
  action: r.action,
  answer: r.result,
  createdAt: r.createdAt.toISOString(),
  decidedAt: r.decidedAt?.toISOString() ?? null,
});

@Injectable()
export class CopilotService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly audience: AudienceService,
    private readonly exec: ExecutionService,
    private readonly fieldwork: FieldworkService,
    private readonly intelligence: IntelligenceService,
    private readonly reports: ReportsService,
    private readonly ai: CopilotAiService,
  ) {}

  history(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(copilotInteractions)
        .where(eq(copilotInteractions.userId, ctx.userId))
        .orderBy(desc(copilotInteractions.createdAt))
        .limit(30);
      return { items: rows.map(view), examples: EXAMPLES, modelVersion: COPILOT_VERSION };
    });
  }

  async ask(ctx: RequestContext, prompt: string) {
    const codes = await withTenant(this.db, ctx.tenantId, async (tx) =>
      (await tx.select({ c: projects.projectCode }).from(projects)).map((x) => x.c),
    );
    let parsed = parse(prompt, codes);
    let modelVersion = COPILOT_VERSION;
    let language = 'en';
    // The rules always run first: a refusal stands whatever the model says. With an AI set up, the model reads the
    // question (in any language) into the same typed, read-only questions, and the answer is put back in that language.
    const conn = parsed.intent === 'refused' ? null : await this.ai.active(ctx.tenantId);
    if (conn) {
      try {
        const c = await this.ai.complete(conn, understandPrompt(prompt, codes));
        const r = toParsed(extractJson(c.text), codes);
        modelVersion = `${AI_VERSION_PREFIX}${c.modelVersion}`;
        if (r) {
          parsed = r.parsed;
          language = r.language;
        } else parsed = { ...parsed, rationale: `${parsed.rationale} (The AI reply did not fit; the rules answered.)` };
      } catch (e) {
        const why = e instanceof ModelUnavailable ? e.reason.replaceAll('_', ' ') : 'error';
        parsed = { ...parsed, rationale: `${parsed.rationale} (The AI was unavailable: ${why}; the rules answered.)` };
      }
    }
    let status = 'answered';
    let answer: Answer;
    const need = PERMISSION_FOR[parsed.intent];
    if (parsed.intent === 'refused') {
      status = 'refused';
      answer = { text: `I can't help with that. ${parsed.rationale}` };
    } else if (need && !ctx.permissions.includes(need)) {
      status = 'refused';
      answer = { text: `That needs the ${need} permission, which your role does not have.` };
    } else {
      try {
        answer = await this.run(ctx, parsed);
        if (answer.action) status = 'proposed';
      } catch (e) {
        status = 'failed';
        const detail = (e as { response?: { detail?: string } }).response?.detail ?? (e as Error).message;
        answer = { text: `That could not be answered: ${detail}` };
      }
    }
    let textEn: string | null = null;
    if (conn && language !== 'en' && status !== 'refused') {
      try {
        const t = checkedTranslation(answer.text, await this.ai.complete(conn, translatePrompt(answer.text, language)));
        if (t) {
          textEn = answer.text;
          answer = { ...answer, text: t };
        }
      } catch {
        // The English answer stands.
      }
    }
    const row = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [r] = await tx
        .insert(copilotInteractions)
        .values({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          prompt,
          intent: parsed.intent,
          query: queryOf(parsed),
          modelVersion,
          rationale: parsed.rationale,
          status,
          action: answer.action ?? null,
          result: { text: answer.text, ...(textEn ? { textEn, language } : {}), data: answer.data ?? null },
        })
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'copilot.asked',
        targetType: 'copilot_interaction',
        targetId: r!.id,
        details: { intent: parsed.intent, status, modelVersion, language },
      });
      return r!;
    });
    return view(row);
  }

  /** A proposed action runs only when a person with the permission approves it, through the normal service and its checks. */
  async decide(ctx: RequestContext, id: string, b: CopilotDecision) {
    const r = await withTenant(this.db, ctx.tenantId, async (tx) => {
      const [r] = await tx.select().from(copilotInteractions).where(eq(copilotInteractions.id, id)).for('update');
      if (!r) throw problem.notFound('No such Copilot request');
      if (r.status !== 'proposed') throw problem.conflict('not_proposed', `This request is ${r.status}`);
      if (b.decision === 'reject') {
        await tx
          .update(copilotInteractions)
          .set({ status: 'rejected', decidedBy: ctx.userId, decidedAt: new Date() })
          .where(eq(copilotInteractions.id, id));
        await this.audit.write(tx, actorOf(ctx), {
          action: 'copilot.rejected',
          targetType: 'copilot_interaction',
          targetId: id,
          reason: b.reason,
        });
      }
      return r;
    });
    if (b.decision === 'reject') return this.one(ctx, id);
    const a = r.action as NonNullable<Answer['action']>;
    if (!ctx.permissions.includes('invitations.dispatch'))
      throw problem.forbidden('forbidden', 'Approving a batch needs invitations.dispatch');
    const batch = batchView(
      await this.exec.createBatch(ctx, a.projectId, {
        cellId: a.cellId,
        size: a.size,
        reason: `Copilot recommendation approved: ${b.reason}`,
      }),
    );
    await withTenant(this.db, ctx.tenantId, async (tx) => {
      await tx
        .update(copilotInteractions)
        .set({
          status: 'approved',
          decidedBy: ctx.userId,
          decidedAt: new Date(),
          result: {
            ...(r.result as object),
            batch: { id: batch.id, status: batch.status, blockedReason: batch.blockedReason },
          },
        })
        .where(eq(copilotInteractions.id, id));
      await this.audit.write(tx, actorOf(ctx), {
        action: 'copilot.approved',
        targetType: 'copilot_interaction',
        targetId: id,
        reason: b.reason,
        details: { batchId: batch.id, size: a.size, cellId: a.cellId },
      });
    });
    return { ...(await this.one(ctx, id)), batch };
  }

  private one(ctx: RequestContext, id: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [r] = await tx.select().from(copilotInteractions).where(eq(copilotInteractions.id, id));
      return view(r!);
    });
  }

  private async projectId(ctx: RequestContext, code?: string) {
    if (!code) throw problem.badRequest('project_required', 'Name the project, for example PRX10001');
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [p] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.projectCode, code));
      if (!p) throw problem.notFound('No such project');
      return p.id;
    });
  }

  private async run(ctx: RequestContext, q: Parsed): Promise<Answer> {
    switch (q.intent) {
      case 'audience_count': {
        const criteria = AudienceCriteria.parse(q.audience ?? {});
        const c = await withTenant(this.db, ctx.tenantId, (tx) => this.audience.activeOrThrow(tx));
        await this.audience.validate(c, criteria);
        const n = await this.audience.call(() => this.audience.sourceFor(c).counts(criteria));
        return {
          text: `${n.uniquePeople.toLocaleString('en')} unique people match (${describe(q.audience ?? {})}). People in several panels are counted once.${c.mode === 'fixture' ? ' This is the FIXTURE DEMO population.' : ''}`,
          data: { criteria, counts: n, source: { name: c.name, mode: c.mode } },
        };
      }
      case 'risk_summary': {
        if (q.projectCode) {
          const f = await this.intelligence.forProject(ctx, await this.projectId(ctx, q.projectCode));
          const need = f.invitationsNeeded;
          return {
            text: `${f.project.projectCode} is ${(f.riskLabel ?? f.risk).toLowerCase()}: ${f.complete} of ${f.target ?? '—'} completes, ${f.pace.perDay} a day against ${f.pace.neededPerDay ?? '—'} needed. ${need ? `About ${need.value.toLocaleString('en')} more invitations (${need.low.toLocaleString('en')} to ${need.high.toLocaleString('en')}).` : ''}${f.assumptionsUsed.length ? ` Uses assumptions: ${f.assumptionsUsed.join('; ')}.` : ''}`,
            data: f,
          };
        }
        const pf = await this.intelligence.portfolio(ctx);
        const risky = pf.items.filter((r) => r.risk === 'off_track' || r.risk === 'at_risk');
        return {
          text: risky.length
            ? `${risky.length} project${risky.length === 1 ? ' is' : 's are'} at risk or off track: ${risky.map((r) => `${r.projectCode} (${r.riskLabel})`).join(', ')}.`
            : `No active project is at risk right now (${pf.items.length} checked).`,
          data: pf,
        };
      }
      case 'remaining_quota': {
        const fw = await this.fieldwork.fieldwork(ctx, await this.projectId(ctx, q.projectCode));
        const cells = fw.cells.filter((c) => c.isOpen && c.target);
        const left = cells.map((c) => ({ ...c, remaining: Math.max(0, (c.target ?? 0) - (c.complete ?? 0)) }));
        const open = left.filter((c) => c.remaining > 0);
        return {
          text: open.length
            ? `${open.length} open cell${open.length === 1 ? '' : 's'} still need completes: ${open
                .slice(0, 6)
                .map((c) => `${c.countryCode} ${c.name} ${c.remaining}`)
                .join(', ')}${open.length > 6 ? ', …' : ''}.`
            : 'Every open cell with a target has its completes.',
          data: { project: fw.project, cells: left },
        };
      }
      case 'recommend_batch': {
        const pid = await this.projectId(ctx, q.projectCode);
        const f = await this.intelligence.forProject(ctx, pid);
        const cell = await withTenant(this.db, ctx.tenantId, async (tx) => {
          const behind = f.underperformingCells.find(Boolean);
          if (behind) return (await tx.select().from(quotaCells).where(eq(quotaCells.id, behind.id)))[0];
          return (
            await tx
              .select()
              .from(quotaCells)
              .where(and(eq(quotaCells.projectId, pid), eq(quotaCells.isOpen, true), eq(quotaCells.removed, false)))
              .orderBy(asc(quotaCells.countryCode), asc(quotaCells.name))
              .limit(1)
          )[0];
        });
        const size = Math.max(0, f.recommendation.size);
        const text = `${f.recommendation.why}${cell ? ` Suggested cell: ${cell.countryCode} ${cell.name}${f.underperformingCells.length ? ', the furthest behind' : ''}.` : ''}`;
        if (!size || !cell) return { text: `${text} Nothing to propose right now.`, data: f.recommendation };
        return {
          text: `${text} Approve to create a batch of ${size}; the normal checks and the project's mode still apply.`,
          data: {
            recommendation: f.recommendation,
            forecast: { risk: f.risk, invitationsNeeded: f.invitationsNeeded },
          },
          action: {
            type: 'create_batch',
            projectId: pid,
            projectCode: q.projectCode!,
            cellId: cell.id,
            cellName: `${cell.countryCode} ${cell.name}`,
            size,
            reason: f.recommendation.why,
          },
        };
      }
      case 'reminder_preview': {
        const pid = await this.projectId(ctx, q.projectCode);
        const rows = await withTenant(this.db, ctx.tenantId, (tx) =>
          tx
            .select({ attempt: reminderJobs.attempt, n: count(), next: min(reminderJobs.dueAt) })
            .from(reminderJobs)
            .where(and(eq(reminderJobs.projectId, pid), eq(reminderJobs.status, 'pending')))
            .groupBy(reminderJobs.attempt)
            .orderBy(asc(reminderJobs.attempt)),
        );
        return {
          text: rows.length
            ? `Pending reminders for ${q.projectCode}: ${rows.map((r) => `${r.n} for reminder ${r.attempt}, first due ${r.next?.toISOString().slice(0, 16).replace('T', ' ')} UTC`).join('; ')}. Each one rechecks consent and the emergency stop before it goes; a click cancels it.`
            : `No reminders are pending for ${q.projectCode}.`,
          data: rows.map((r) => ({ attempt: r.attempt, pending: r.n, firstDue: r.next?.toISOString() ?? null })),
        };
      }
      case 'report': {
        const r = q.report!;
        const projectId = q.projectCode ? await this.projectId(ctx, q.projectCode) : undefined;
        const e = await this.reports.request(ctx, {
          kind: r.kind,
          format: r.format,
          projectId,
          timezone: 'UTC',
        });
        return {
          text: `The ${REPORT_LABELS[r.kind]} export (${r.format.toUpperCase()}) is being built. Download it from Reports and Analytics; it expires in 24 hours.`,
          data: { exportId: e.id },
        };
      }
      default:
        return { text: `Try one of these: ${EXAMPLES.join(' · ')}` };
    }
  }
}

function queryOf(p: Parsed) {
  return {
    ...(p.projectCode ? { projectCode: p.projectCode } : {}),
    ...(p.audience ? { audience: p.audience } : {}),
    ...(p.report ? { report: p.report } : {}),
  };
}
