import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { AllocationUpdate, AudienceCriteria, CellMapping, ReserveRequest } from '@s360/contracts';
import { allocationPlans, projects, quotaCells, reservedRefs, withTenant, type Db, type Tx } from '@s360/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DB } from '../db/db.module.js';
import { AudienceService } from './audience.service.js';
import {
  allocate,
  audienceChecks,
  cellStates,
  criteriaFor,
  MARKET_CELL,
  vendorTarget,
  type CellState,
} from './quotas.js';

const ReleaseBody = z.object({ reason: z.string().trim().min(3).max(500) });
const FeasibilityBody = z.object({ criteria: CellMapping.shape.criteria.optional() });

const cellView = (c: CellState) => ({
  id: c.id,
  countryCode: c.countryCode,
  sourceCellId: c.sourceCellId,
  isMarketCell: c.sourceCellId === MARKET_CELL,
  group: c.groupName,
  name: c.name,
  conditions: c.conditions,
  sourceTarget: c.sourceTarget,
  sourceCompletes: c.sourceCompletes,
  isOpen: c.isOpen,
  removed: c.removed,
  criteria: c.criteria,
  mappedAt: c.mappedAt?.toISOString() ?? null,
  allocation: c.allocation,
  inviteCap: c.inviteCap,
  suggestedCap: c.suggestedCap,
  held: c.held,
});

@Controller('projects')
export class QuotasController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audience: AudienceService,
    private readonly audit: AuditService,
  ) {}

  private async project(tx: Tx, id: string, lock = false) {
    const q = tx.select().from(projects).where(eq(projects.id, id));
    const [p] = lock ? await q.for('update') : await q;
    if (!p) throw problem.notFound('No such project');
    return p;
  }

  private async cell(tx: Tx, projectId: string, cellId: string) {
    const [c] = await tx
      .select()
      .from(quotaCells)
      .where(and(eq(quotaCells.id, cellId), eq(quotaCells.projectId, projectId)));
    if (!c) throw problem.notFound('No such quota cell');
    return c;
  }

  /** Quota matrix: cells per Supply360 market with mapping, allocation, cap, what is held, and reservations. */
  @Get(':id/quotas')
  @RequirePermissions('projects.read')
  quotas(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const p = await this.project(tx, id);
      const ms = (await this.audience.marketsOf(tx, id)).filter((m) => m.sourceStatus !== 'REMOVED');
      const cells = await cellStates(tx, id, ms);
      const [plan] = await tx.select().from(allocationPlans).where(eq(allocationPlans.projectId, id));
      const conn = await this.audience.active(tx);
      const [held] = await tx
        .select({ panel: reservedRefs.panel })
        .from(reservedRefs)
        .where(eq(reservedRefs.projectId, id))
        .limit(1);
      const rs = await this.audience.reservationsOf(tx, id);
      const now = Date.now();
      return {
        projectId: id,
        projectCode: p.projectCode,
        name: p.name,
        lifecycle: p.lifecycle,
        allocationMode: plan?.mode ?? 'proportional',
        panelInUse: held?.panel ?? null,
        source: conn ? { id: conn.id, name: conn.name, mode: conn.mode } : null,
        markets: ms
          .filter((m) => m.vendorLinkId)
          .map((m) => ({
            countryCode: m.countryCode,
            vendorTarget: m.vendorTarget ?? m.targetCompletes,
            vendorCompletes: m.vendorCompletes ?? 0,
            irPercent: m.irPercent,
          })),
        cells: cells.filter((c) => !c.removed || c.held > 0).map(cellView),
        checks: audienceChecks(ms, cells),
        reservations: rs.map((r) => ({
          id: r.id,
          cellId: r.cellId,
          status: r.status === 'active' && r.expiresAt.getTime() <= now ? 'expired' : r.status,
          requested: r.requested,
          held: r.held,
          refused: (r.refused as unknown[]).length,
          expiresAt: r.expiresAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
          releasedAt: r.releasedAt?.toISOString() ?? null,
        })),
      };
    });
  }

  /** A person maps a SampTrek cell to MADP criteria. The market country is added by Supply360. */
  @Put(':id/quotas/:cellId/mapping')
  @RequirePermissions('quotas.manage')
  map(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cellId', ParseUUIDPipe) cellId: string,
    @Body(new ZodPipe(CellMapping)) body: CellMapping,
  ) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      await this.project(tx, id, true);
      const c = await this.cell(tx, id, cellId);
      if (c.removed) throw problem.conflict('cell_removed', 'This cell no longer exists at SampTrek');
      const [holding] = await tx
        .select({ ref: reservedRefs.ref })
        .from(reservedRefs)
        .where(eq(reservedRefs.cellId, cellId))
        .limit(1);
      if (holding)
        throw problem.conflict(
          'release_first',
          'People are held under the current mapping; release them before changing it',
        );
      const conn = await this.audience.activeOrThrow(tx);
      await this.audience.validate(conn, body.criteria);
      await tx
        .update(quotaCells)
        .set({ criteria: body.criteria, mappedBy: ctx.userId, mappedAt: new Date(), updatedAt: new Date() })
        .where(eq(quotaCells.id, cellId));
      await this.audit.write(tx, actorOf(ctx), {
        action: 'quota.mapped',
        targetType: 'quota_cell',
        targetId: cellId,
        details: { projectId: id, cell: `${c.countryCode} ${c.name}`, criteria: body.criteria, previous: c.criteria },
      });
      return { cellId, criteria: body.criteria };
    });
  }

  /** Counts for a cell: its mapping, or criteria being tried before saving. */
  @Post(':id/quotas/:cellId/feasibility')
  @HttpCode(200)
  @RequirePermissions('audience.read')
  async feasibility(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cellId', ParseUUIDPipe) cellId: string,
    @Body(new ZodPipe(FeasibilityBody)) body: z.infer<typeof FeasibilityBody>,
  ) {
    const { conn, criteria } = await withTenant(this.db, ctx.tenantId, async (tx) => {
      await this.project(tx, id);
      const c = await this.cell(tx, id, cellId);
      const criteria: AudienceCriteria = body.criteria
        ? { ...body.criteria, countries: [c.countryCode] }
        : c.criteria
          ? criteriaFor(c)
          : { countries: [c.countryCode] };
      return { conn: await this.audience.activeOrThrow(tx), criteria };
    });
    await this.audience.validate(conn, criteria);
    const n = await this.audience.call(() => this.audience.sourceFor(conn).counts(criteria));
    return { ...n, criteria };
  }

  /** Allocation: Supply360 completes per cell and the cap on people held per cell. */
  @Put(':id/allocation')
  @RequirePermissions('allocation.manage')
  allocation(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(AllocationUpdate)) body: AllocationUpdate,
  ) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      await this.project(tx, id, true);
      const ms = await this.audience.marketsOf(tx, id);
      const cells = (await tx.select().from(quotaCells).where(eq(quotaCells.projectId, id))).filter((c) => !c.removed);
      const known = new Set(cells.map((c) => c.id));
      const stray = [...Object.keys(body.caps), ...Object.keys(body.targets ?? {})].find((k) => !known.has(k));
      if (stray) throw problem.badRequest('unknown_cell', `No such cell ${stray} in this project`);
      if (body.mode === 'manual' && !body.targets)
        throw problem.badRequest('targets_required', 'Manual allocation needs targets');
      const targets = allocate(body.mode, cells, vendorTarget(ms), body.targets);
      for (const c of cells) {
        await tx
          .update(quotaCells)
          .set({
            allocationTarget: targets.get(c.id) ?? 0,
            ...(c.id in body.caps ? { inviteCap: body.caps[c.id]! } : {}),
            updatedAt: new Date(),
          })
          .where(eq(quotaCells.id, c.id));
      }
      await tx
        .insert(allocationPlans)
        .values({ projectId: id, tenantId: ctx.tenantId, mode: body.mode, updatedBy: ctx.userId })
        .onConflictDoUpdate({
          target: allocationPlans.projectId,
          set: { mode: body.mode, updatedBy: ctx.userId, updatedAt: new Date() },
        });
      await this.audit.write(tx, actorOf(ctx), {
        action: 'allocation.updated',
        targetType: 'project',
        targetId: id,
        details: { mode: body.mode, targets: Object.fromEntries(targets), caps: body.caps },
      });
      return { mode: body.mode, targets: Object.fromEntries(targets), caps: body.caps };
    });
  }

  @Post(':id/quotas/:cellId/reserve')
  @HttpCode(200)
  @RequirePermissions('audience.select')
  reserve(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cellId', ParseUUIDPipe) cellId: string,
    @Body(new ZodPipe(ReserveRequest)) body: ReserveRequest,
  ) {
    return this.audience.reserve(ctx, id, cellId, body);
  }

  @Post(':id/reservations/:rid/release')
  @HttpCode(200)
  @RequirePermissions('audience.select')
  release(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rid', ParseUUIDPipe) rid: string,
    @Body(new ZodPipe(ReleaseBody)) body: z.infer<typeof ReleaseBody>,
  ) {
    return this.audience.release(ctx, id, rid, body.reason);
  }
}
