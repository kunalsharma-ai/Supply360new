import { Inject, Injectable } from '@nestjs/common';
import {
  AllocationMode,
  ExecutionPolicyUpdate,
  QaMode,
  SETUP_PART_LABELS,
  type Permission,
  type SetupApply,
  type SetupPart,
  type SetupSource,
  type SetupTemplateCreate,
} from '@s360/contracts';
import {
  allocationPlans,
  executionPolicies,
  projects,
  quotaCells,
  reservedRefs,
  setupTemplates,
  withTenant,
  type Db,
  type Tx,
} from '@s360/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AudienceService } from '../audience/audience.service.js';
import { allocate, criteriaFor, MARKET_CELL, vendorTarget } from '../audience/quotas.js';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { DB } from '../db/db.module.js';
import { ExecutionService } from '../execution/execution.service.js';
import { matchCells, type CellKey } from './match.js';

type PolicyFields = Omit<ExecutionPolicyUpdate, 'reason'>;

interface CellSetup extends CellKey {
  criteria: Record<string, unknown> | null;
  inviteCap: number | null;
}

/** What a setup copy carries. Stored as a template's content, or read live from a source project. */
export interface SetupContent {
  version: 1;
  sourceProjectCode: string;
  policy: PolicyFields | null;
  allocationMode: AllocationMode | null;
  qaMode: QaMode;
  cells: CellSetup[];
}

const PART_PERMISSION: Record<SetupPart, Permission> = {
  policy: 'automation.manage',
  allocation: 'allocation.manage',
  criteria: 'quotas.manage',
  caps: 'allocation.manage',
  qaMode: 'sampintel.manage',
};

interface Line {
  part: SetupPart;
  text: string;
}
interface Skip {
  part: SetupPart;
  cell: string | null;
  reason: string;
}

const cellLabel = (c: { countryCode: string; group?: string; groupName?: string; name: string }) => {
  const g = c.group ?? c.groupName ?? '';
  return `${c.countryCode} ${g ? `${g} / ` : ''}${c.name}`;
};

@Injectable()
export class SetupService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audience: AudienceService,
    private readonly exec: ExecutionService,
    private readonly audit: AuditService,
  ) {}

  private async project(tx: Tx, id: string, lock = false) {
    const q = tx.select().from(projects).where(eq(projects.id, id));
    const [p] = lock ? await q.for('update') : await q;
    if (!p) throw problem.notFound('No such project');
    return p;
  }

  /** A project's setup as it is now. */
  async snapshot(tx: Tx, projectId: string): Promise<SetupContent> {
    const p = await this.project(tx, projectId);
    const [pol] = await tx.select().from(executionPolicies).where(eq(executionPolicies.projectId, projectId));
    const [plan] = await tx.select().from(allocationPlans).where(eq(allocationPlans.projectId, projectId));
    const cells = await tx
      .select()
      .from(quotaCells)
      .where(eq(quotaCells.projectId, projectId))
      .orderBy(asc(quotaCells.countryCode), asc(quotaCells.groupName), asc(quotaCells.name));
    return {
      version: 1,
      sourceProjectCode: p.projectCode,
      policy: pol
        ? {
            mode: pol.mode as PolicyFields['mode'],
            batchSize: pol.batchSize,
            dailyMax: pol.dailyMax,
            reviewIntervalMinutes: pol.reviewIntervalMinutes,
            quietStartHour: pol.quietStartHour,
            quietEndHour: pol.quietEndHour,
            timezone: pol.timezone,
            reminderOffsetsHours: pol.reminderOffsetsHours as number[],
            allowedPanels: pol.allowedPanels as PolicyFields['allowedPanels'],
            linkValidDays: pol.linkValidDays,
            escalateRefusalPercent: pol.escalateRefusalPercent,
            speederPercent: pol.speederPercent,
          }
        : null,
      allocationMode: (plan?.mode as AllocationMode | undefined) ?? null,
      qaMode: p.qaMode as QaMode,
      cells: cells
        .filter((c) => !c.removed)
        .map((c) => ({
          countryCode: c.countryCode,
          group: c.groupName,
          name: c.name,
          isMarketCell: c.sourceCellId === MARKET_CELL,
          conditionsHash: c.conditionsHash,
          criteria: (c.criteria as Record<string, unknown> | null) ?? null,
          inviteCap: c.inviteCap,
        })),
    };
  }

  private async contentOf(tx: Tx, source: SetupSource, targetId: string) {
    if ('projectId' in source) {
      if (source.projectId === targetId)
        throw problem.badRequest('same_project', 'Pick a different project to copy from');
      const c = await this.snapshot(tx, source.projectId);
      return { content: c, from: `project ${c.sourceProjectCode}` };
    }
    const [t] = await tx.select().from(setupTemplates).where(eq(setupTemplates.id, source.templateId));
    if (!t) throw problem.notFound('No such template');
    return { content: t.content as SetupContent, from: `template “${t.name}”` };
  }

  /**
   * What applying a setup would do, part by part, without changing anything. Apply runs the same plan, so what a
   * person reads in the preview is what happens.
   */
  private async plan(tx: Tx, projectId: string, content: SetupContent, parts: SetupPart[]) {
    const target = await this.snapshot(tx, projectId);
    const cells = (await tx.select().from(quotaCells).where(eq(quotaCells.projectId, projectId))).filter(
      (c) => !c.removed,
    );
    const keyed = cells.map((c) => ({
      id: c.id,
      countryCode: c.countryCode,
      group: c.groupName,
      name: c.name,
      isMarketCell: c.sourceCellId === MARKET_CELL,
      conditionsHash: c.conditionsHash,
    }));
    const matches = matchCells(content.cells, keyed);
    const held = new Set(
      cells.length
        ? (
            await tx
              .selectDistinct({ cellId: reservedRefs.cellId })
              .from(reservedRefs)
              .where(
                inArray(
                  reservedRefs.cellId,
                  cells.map((c) => c.id),
                ),
              )
          ).map((r) => r.cellId)
        : [],
    );
    const lines: Line[] = [];
    const skipped: Skip[] = [];
    const writes = {
      policy: null as PolicyFields | null,
      allocation: null as AllocationMode | null,
      criteria: new Map<string, Record<string, unknown>>(),
      caps: new Map<string, number>(),
      qaMode: null as QaMode | null,
    };

    if (parts.includes('policy')) {
      if (!content.policy)
        skipped.push({ part: 'policy', cell: null, reason: 'The source has no sending policy saved' });
      else {
        // Automatic mode is never switched on by a copy: it starts as manual and a person turns it on.
        const auto = content.policy.mode === 'auto';
        writes.policy = { ...content.policy, mode: auto ? 'manual' : content.policy.mode };
        const r = content.policy.reminderOffsetsHours;
        lines.push({
          part: 'policy',
          text: `Mode ${writes.policy.mode}${auto ? ' (automatic in the source; turn it on yourself)' : ''}, batches of ${content.policy.batchSize}, at most ${content.policy.dailyMax} a day, quiet ${content.policy.quietStartHour}:00 to ${content.policy.quietEndHour}:00 ${content.policy.timezone}, reminders ${r.length ? r.map((h) => `${h} h`).join(', ') : 'off'}, links valid ${content.policy.linkValidDays} days, panels ${content.policy.allowedPanels.join(', ')}`,
        });
      }
    }
    if (parts.includes('allocation')) {
      if (!content.allocationMode)
        skipped.push({ part: 'allocation', cell: null, reason: 'The source has no allocation saved' });
      else if (content.allocationMode === 'manual')
        skipped.push({
          part: 'allocation',
          cell: null,
          reason: 'Manual targets belong to the source’s cells and are not copied; set them on Allocation',
        });
      else {
        writes.allocation = content.allocationMode;
        lines.push({
          part: 'allocation',
          text: `Allocation ${content.allocationMode}, recalculated from this project’s targets`,
        });
      }
    }
    if (parts.includes('criteria') || parts.includes('caps')) {
      for (const c of cells) {
        const s = matches.get(c.id);
        const label = cellLabel(c);
        if (!s) {
          if (parts.includes('criteria'))
            skipped.push({ part: 'criteria', cell: label, reason: 'No matching cell in the source' });
          continue;
        }
        if (parts.includes('criteria')) {
          if (!s.criteria) skipped.push({ part: 'criteria', cell: label, reason: 'Not mapped in the source' });
          else if (held.has(c.id))
            skipped.push({ part: 'criteria', cell: label, reason: 'People are held here; release them first' });
          else if (JSON.stringify(s.criteria) !== JSON.stringify(c.criteria)) writes.criteria.set(c.id, s.criteria);
        }
        if (parts.includes('caps') && s.inviteCap != null && s.inviteCap !== c.inviteCap)
          writes.caps.set(c.id, s.inviteCap);
      }
      if (parts.includes('criteria'))
        lines.push({
          part: 'criteria',
          text: `Audience criteria for ${writes.criteria.size} of ${cells.length} cells`,
        });
      if (parts.includes('caps'))
        lines.push({ part: 'caps', text: `Invite caps for ${writes.caps.size} of ${cells.length} cells` });
    }
    if (parts.includes('qaMode')) {
      if (content.qaMode === target.qaMode) lines.push({ part: 'qaMode', text: `QA mode stays ${content.qaMode}` });
      else {
        writes.qaMode = content.qaMode;
        lines.push({ part: 'qaMode', text: `QA mode ${target.qaMode} → ${content.qaMode}` });
      }
    }
    return { lines, skipped, writes, cells };
  }

  private missing(ctx: RequestContext, parts: SetupPart[]) {
    return [...new Set(parts.map((p) => PART_PERMISSION[p]))].filter((p) => !ctx.permissions.includes(p));
  }

  async preview(ctx: RequestContext, projectId: string, source: SetupSource, parts: SetupPart[]) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      await this.project(tx, projectId);
      const { content, from } = await this.contentOf(tx, source, projectId);
      const r = await this.plan(tx, projectId, content, parts);
      return { from, changes: r.lines, skipped: r.skipped, missingPermissions: this.missing(ctx, parts) };
    });
  }

  async apply(ctx: RequestContext, projectId: string, body: SetupApply) {
    const missing = this.missing(ctx, body.parts);
    if (missing.length)
      throw problem.forbidden(
        'permission_missing',
        `Copying ${body.parts.map((p) => SETUP_PART_LABELS[p].toLowerCase()).join(', ')} needs ${missing.join(', ')}`,
      );
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const p = await this.project(tx, projectId, true);
      const { content, from } = await this.contentOf(tx, body.source, projectId);
      const r = await this.plan(tx, projectId, content, body.parts);
      const reason = `Copied from ${from}: ${body.reason}`.slice(0, 500);

      if (r.writes.policy)
        await this.exec.writePolicy(tx, ctx, projectId, ExecutionPolicyUpdate.parse({ ...r.writes.policy, reason }));
      if (r.writes.criteria.size) {
        const conn = await this.audience.activeOrThrow(tx);
        for (const [cellId, criteria] of r.writes.criteria) {
          const c = r.cells.find((x) => x.id === cellId)!;
          await this.audience.validate(conn, criteriaFor({ countryCode: c.countryCode, criteria }));
          await tx
            .update(quotaCells)
            .set({ criteria, mappedBy: ctx.userId, mappedAt: new Date(), updatedAt: new Date() })
            .where(eq(quotaCells.id, cellId));
        }
      }
      for (const [cellId, cap] of r.writes.caps)
        await tx.update(quotaCells).set({ inviteCap: cap, updatedAt: new Date() }).where(eq(quotaCells.id, cellId));
      if (r.writes.allocation) {
        const ms = await this.audience.marketsOf(tx, projectId);
        const targets = allocate(r.writes.allocation, r.cells, vendorTarget(ms));
        for (const c of r.cells)
          await tx
            .update(quotaCells)
            .set({ allocationTarget: targets.get(c.id) ?? 0, updatedAt: new Date() })
            .where(eq(quotaCells.id, c.id));
        await tx
          .insert(allocationPlans)
          .values({ projectId, tenantId: ctx.tenantId, mode: r.writes.allocation, updatedBy: ctx.userId })
          .onConflictDoUpdate({
            target: allocationPlans.projectId,
            set: { mode: r.writes.allocation, updatedBy: ctx.userId, updatedAt: new Date() },
          });
      }
      if (r.writes.qaMode) await tx.update(projects).set({ qaMode: r.writes.qaMode }).where(eq(projects.id, projectId));

      await this.audit.write(tx, actorOf(ctx), {
        action: 'project.setup_copied',
        targetType: 'project',
        targetId: projectId,
        reason: body.reason,
        details: {
          project: p.projectCode,
          from,
          parts: body.parts,
          criteriaCells: [...r.writes.criteria.keys()],
          capCells: Object.fromEntries(r.writes.caps),
          allocation: r.writes.allocation,
          qaMode: r.writes.qaMode,
          skipped: r.skipped,
        },
      });
      return { from, changes: r.lines, skipped: r.skipped };
    });
  }

  // ───────────────────────────── templates ─────────────────────────────

  list(ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const rows = await tx.select().from(setupTemplates).orderBy(asc(setupTemplates.name));
      return rows.map((t) => {
        const c = t.content as SetupContent;
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          sourceProjectCode: t.sourceProjectCode,
          hasPolicy: !!c.policy,
          mode: c.policy?.mode ?? null,
          allocationMode: c.allocationMode,
          mappedCells: c.cells.filter((x) => x.criteria).length,
          cells: c.cells.length,
          qaMode: c.qaMode,
          createdAt: t.createdAt.toISOString(),
        };
      });
    });
  }

  create(ctx: RequestContext, body: SetupTemplateCreate) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const content = await this.snapshot(tx, body.fromProjectId);
      if (!content.policy && !content.cells.some((c) => c.criteria || c.inviteCap != null) && !content.allocationMode)
        throw problem.badRequest(
          'nothing_to_save',
          'This project has no sending policy, allocation or cell mapping yet',
        );
      const [dupe] = await tx
        .select({ id: setupTemplates.id })
        .from(setupTemplates)
        .where(eq(setupTemplates.name, body.name));
      if (dupe) throw problem.conflict('name_taken', 'A template with this name already exists');
      const [t] = await tx
        .insert(setupTemplates)
        .values({
          tenantId: ctx.tenantId,
          name: body.name,
          description: body.description ?? null,
          sourceProjectCode: content.sourceProjectCode,
          content,
          createdBy: ctx.userId,
        })
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'setup_template.created',
        targetType: 'setup_template',
        targetId: t!.id,
        details: { name: body.name, from: content.sourceProjectCode },
      });
      return { id: t!.id };
    });
  }

  remove(ctx: RequestContext, id: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [t] = await tx
        .delete(setupTemplates)
        .where(and(eq(setupTemplates.id, id)))
        .returning();
      if (!t) throw problem.notFound('No such template');
      await this.audit.write(tx, actorOf(ctx), {
        action: 'setup_template.removed',
        targetType: 'setup_template',
        targetId: id,
        details: { name: t.name },
      });
      return { ok: true };
    });
  }
}
