import { Inject, Injectable } from '@nestjs/common';
import { AudienceCriteria, type ReserveRequest } from '@s360/contracts';
import {
  audienceConnections,
  audienceSelections,
  projectMarkets,
  projects,
  quotaCells,
  reservations,
  reservedRefs,
  withTenant,
  type Db,
  type Tx,
} from '@s360/db';
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, lte, ne } from 'drizzle-orm';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { ENV, type Env } from '../config.js';
import { Sealer } from '../crypto/sealer.js';
import { DB } from '../db/db.module.js';
import { FixtureMadp } from './madp/fixture.js';
import { LiveMadp } from './madp/live.js';
import { AudienceError, type AudienceSource } from './madp/source.js';
import type { MdAttributes } from './madp/types.js';
import { criteriaFor } from './quotas.js';

export type AudienceConnection = typeof audienceConnections.$inferSelect;
export const madpSecretContext = (id: string) => `madp-secret:${id}`;
/** Supply360's project reference at MADP: opaque, no tenant or client names. */
export const projectRef = (projectId: string) => `s360:${projectId}`;

const DAY = 86_400_000;
const CLOSED = ['closed', 'source_hold'];

@Injectable()
export class AudienceService {
  readonly sealer: Sealer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
  ) {
    this.sealer = new Sealer(env.FIELD_ENCRYPTION_KEY);
  }

  sourceFor(c: AudienceConnection): AudienceSource {
    if (c.mode === 'fixture') return new FixtureMadp(c.id);
    if (!c.baseUrl || !c.clientId || !c.secretSealed) throw new AudienceError('LIVE connection is incomplete', false);
    return new LiveMadp(c.baseUrl, c.clientId, this.sealer.open(c.secretSealed, madpSecretContext(c.id)));
  }

  /** The tenant's MADP connection in use: the newest enabled one. */
  async active(tx: Tx): Promise<AudienceConnection | null> {
    const [c] = await tx
      .select()
      .from(audienceConnections)
      .where(eq(audienceConnections.enabled, true))
      .orderBy(desc(audienceConnections.createdAt))
      .limit(1);
    return c ?? null;
  }

  async activeOrThrow(tx: Tx) {
    const c = await this.active(tx);
    if (!c) throw problem.conflict('no_audience_source', 'Connect MADP first (Integrations, MADP)');
    return c;
  }

  /** Wraps a MADP call so an upstream failure is a clear 502, never a 500. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AudienceError) {
        if (e.status === 400 || e.status === 404) throw problem.badRequest('madp_rejected', e.message);
        throw problem.badGateway('madp_unavailable', e.message);
      }
      throw e;
    }
  }

  /** Attributes Supply360 may filter on: never special-category (health and the like). */
  async catalogue(c: AudienceConnection): Promise<MdAttributes> {
    const a = await this.call(() => this.sourceFor(c).attributes());
    return { ...a, attributes: a.attributes.filter((x) => x.sensitivity !== 'special_category') };
  }

  /** Every attribute must be one MADP lists for Supply360, and none may be special-category. */
  async validate(c: AudienceConnection, criteria: AudienceCriteria) {
    if (!criteria.attributes?.length) return;
    const all = await this.call(() => this.sourceFor(c).attributes());
    for (const f of criteria.attributes) {
      const a = all.attributes.find((x) => x.key === f.key);
      if (!a) throw problem.badRequest('unknown_attribute', `MADP has no attribute ${f.key}`);
      if (a.sensitivity === 'special_category')
        throw problem.forbidden(
          'sensitive_attribute',
          `${a.label} is special-category data; Supply360 never filters on it`,
        );
    }
  }

  /** Lazily ends holds that ran out: their rows go, so they stop counting against caps or blocking references. */
  private async expire(tx: Tx, projectId: string, now: Date) {
    await tx.delete(reservedRefs).where(and(eq(reservedRefs.projectId, projectId), lte(reservedRefs.expiresAt, now)));
    await tx
      .update(reservations)
      .set({ status: 'expired' })
      .where(
        and(eq(reservations.projectId, projectId), eq(reservations.status, 'active'), lte(reservations.expiresAt, now)),
      );
  }

  /**
   * Locks the project and checks a cell can take a reservation: open, mapped, capped and not mixing panels.
   * Returns what a reservation needs, including how many more people the cell may hold.
   */
  async prepareHold(tx: Tx, projectId: string, cellId: string, now: Date) {
    const [p] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
    if (!p) throw problem.notFound('No such project');
    if (CLOSED.includes(p.lifecycle))
      throw problem.conflict(
        'project_stopped',
        `The project is ${p.lifecycle.replace('_', ' ')}; nothing can be reserved`,
      );
    const [cell] = await tx
      .select()
      .from(quotaCells)
      .where(and(eq(quotaCells.id, cellId), eq(quotaCells.projectId, projectId)));
    if (!cell) throw problem.notFound('No such quota cell');
    if (cell.removed || !cell.isOpen) throw problem.conflict('cell_closed', 'This cell is closed at SampTrek');
    if (!cell.criteria) throw problem.conflict('cell_unmapped', 'Map this cell to MADP criteria first');
    if (!cell.inviteCap) throw problem.conflict('no_cap', 'Set a cap for this cell in Allocation first');
    const conn = await this.activeOrThrow(tx);

    await this.expire(tx, projectId, now);
    const criteria = criteriaFor(cell);
    const panel = criteria.panels![0]!;
    const [other] = await tx
      .select({ panel: reservedRefs.panel })
      .from(reservedRefs)
      .where(and(eq(reservedRefs.projectId, projectId), ne(reservedRefs.panel, panel)))
      .limit(1);
    if (other)
      throw problem.conflict(
        'panel_mixing',
        `This project already holds ${other.panel} people. MADP gives one reference per panel membership, so mixing panels could invite one person twice.`,
      );
    const [{ n: held } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(reservedRefs)
      .where(eq(reservedRefs.cellId, cellId));
    const room = cell.inviteCap - held;
    if (room <= 0)
      throw problem.conflict('cap_reached', `This cell already holds ${held} of its cap of ${cell.inviteCap}`);
    const mine = new Set(
      (await tx.select({ ref: reservedRefs.ref }).from(reservedRefs).where(eq(reservedRefs.projectId, projectId))).map(
        (r) => r.ref,
      ),
    );
    return { p, cell, conn, criteria, panel, held, room, mine };
  }

  /**
   * Asks MADP to hold the picked references and records the hold. MADP re-checks each one (unknown, held for
   * another project, and so on) and refuses those it will not hold.
   */
  async hold(
    tx: Tx,
    ctx: RequestContext,
    h: Awaited<ReturnType<AudienceService['prepareHold']>>,
    picked: { ref: string; panel: string }[],
    o: {
      requested: number;
      expiresInDays: number;
      origin: 'match' | 'recontact';
      criteria: unknown;
      dataMode: string;
      eligible: number | null;
      returned: number;
      excluded: unknown;
    },
    now: Date,
  ) {
    const { p, cell, conn } = h;
    const src = this.sourceFor(conn);
    const selectionId = randomUUID();
    const expiresAt = new Date(now.getTime() + o.expiresInDays * DAY);
    const r = await this.call(() =>
      src.reserve(
        { projectRef: projectRef(p.id), refs: picked.map((x) => x.ref), expiresAt: expiresAt.toISOString() },
        `s360-${selectionId}`,
      ),
    );
    const refused = new Set(r.refused.map((x) => x.ref));
    const keep = picked.filter((x) => !refused.has(x.ref));
    await tx.insert(audienceSelections).values({
      id: selectionId,
      tenantId: ctx.tenantId,
      projectId: p.id,
      cellId: cell.id,
      connectionId: conn.id,
      dataMode: o.dataMode,
      criteria: o.criteria,
      eligible: o.eligible,
      returned: o.returned,
      excluded: o.excluded,
      refs: picked.map((x) => x.ref),
      createdBy: ctx.userId,
    });
    const [res] = await tx
      .insert(reservations)
      .values({
        tenantId: ctx.tenantId,
        projectId: p.id,
        cellId: cell.id,
        selectionId,
        connectionId: conn.id,
        externalId: r.reservationId,
        origin: o.origin,
        requested: o.requested,
        held: keep.length,
        refused: r.refused,
        expiresAt: new Date(r.expiresAt),
        createdBy: ctx.userId,
      })
      .returning();
    if (keep.length)
      await tx
        .insert(reservedRefs)
        .values(
          keep.map((x) => ({
            tenantId: ctx.tenantId,
            projectId: p.id,
            cellId: cell.id,
            reservationId: res!.id,
            ref: x.ref,
            panel: x.panel,
            expiresAt: new Date(r.expiresAt),
          })),
        )
        .onConflictDoNothing();
    await this.audit.write(tx, actorOf(ctx), {
      action: o.origin === 'recontact' ? 'audience.recontact_reserved' : 'audience.reserved',
      targetType: 'quota_cell',
      targetId: cell.id,
      details: {
        projectId: p.id,
        reservationId: res!.id,
        madpReservationId: r.reservationId,
        requested: o.requested,
        held: keep.length,
        refused: r.refused.length,
        eligible: o.eligible,
        dataMode: o.dataMode,
      },
    });
    return { reservationId: res!.id, selectionId, held: keep.length, refused: r.refused, expiresAt: r.expiresAt };
  }

  /**
   * Selects and reserves people for one cell. The project row lock serialises every reservation of a project,
   * so concurrent requests can never hold more than the cell's cap, and the unique (project, ref) index means one
   * MADP reference is never held twice for a project.
   */
  async reserve(ctx: RequestContext, projectId: string, cellId: string, body: ReserveRequest) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const now = new Date();
      const h = await this.prepareHold(tx, projectId, cellId, now);
      const want = Math.min(body.count, h.room);
      const m = await this.call(() =>
        this.sourceFor(h.conn).match({
          ...h.criteria,
          projectRef: projectRef(projectId),
          limit: Math.min(5000, want + h.mine.size),
        }),
      );
      const picked = m.members.filter((x) => !h.mine.has(x.ref)).slice(0, want);
      if (!picked.length)
        throw problem.conflict(
          'no_audience',
          m.suppressed
            ? `Fewer than ${m.minimumCellSize} eligible people match; MADP returns no references`
            : 'Everyone eligible is already held for this project',
        );
      const r = await this.hold(
        tx,
        ctx,
        h,
        picked,
        {
          requested: want,
          expiresInDays: body.expiresInDays,
          origin: 'match',
          criteria: h.criteria,
          dataMode: m.dataMode,
          eligible: m.eligible,
          returned: m.returned,
          excluded: m.excluded,
        },
        now,
      );
      return {
        ...r,
        requested: body.count,
        cappedTo: want,
        eligible: m.eligible,
        excluded: m.excluded,
        dataMode: m.dataMode,
        cellHeld: h.held + r.held,
        cap: h.cell.inviteCap,
      };
    });
  }

  async release(ctx: RequestContext, projectId: string, reservationId: string, reason: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      const [r] = await tx
        .select()
        .from(reservations)
        .where(and(eq(reservations.id, reservationId), eq(reservations.projectId, projectId)));
      if (!r) throw problem.notFound('No such reservation');
      if (r.status !== 'active') throw problem.conflict('not_active', `This reservation is ${r.status}`);
      const [conn] = await tx.select().from(audienceConnections).where(eq(audienceConnections.id, r.connectionId));
      try {
        await this.sourceFor(conn!).release(r.externalId);
      } catch (e) {
        // Already released or expired at MADP: the local hold is ended all the same.
        if (!(e instanceof AudienceError && (e.status === 404 || e.status === 409))) {
          throw e instanceof AudienceError ? problem.badGateway('madp_unavailable', e.message) : e;
        }
      }
      const gone = await tx
        .delete(reservedRefs)
        .where(eq(reservedRefs.reservationId, r.id))
        .returning({ ref: reservedRefs.ref });
      await tx
        .update(reservations)
        .set({ status: 'released', releasedAt: new Date() })
        .where(eq(reservations.id, r.id));
      await this.audit.write(tx, actorOf(ctx), {
        action: 'audience.released',
        targetType: 'quota_cell',
        targetId: r.cellId,
        reason,
        details: { projectId, reservationId: r.id, released: gone.length },
      });
      return { reservationId: r.id, status: 'released', released: gone.length };
    });
  }

  async reservationsOf(tx: Tx, projectId: string) {
    return tx
      .select()
      .from(reservations)
      .where(eq(reservations.projectId, projectId))
      .orderBy(desc(reservations.createdAt))
      .limit(100);
  }

  async marketsOf(tx: Tx, projectId: string) {
    return tx
      .select()
      .from(projectMarkets)
      .where(eq(projectMarkets.projectId, projectId))
      .orderBy(asc(projectMarkets.countryCode));
  }
}
