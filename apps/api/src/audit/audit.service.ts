import { Inject, Injectable } from '@nestjs/common';
import { auditLogs, withTenant, type Db, type Tx } from '@s360/db';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { RequestContext } from '../common/context.js';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}

export interface Actor {
  tenantId: string;
  userId: string | null;
  email: string | null;
  correlationId?: string | null;
}

export const actorOf = (c: RequestContext): Actor => ({
  tenantId: c.tenantId,
  userId: c.userId,
  email: c.email,
  correlationId: c.correlationId,
});

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Writes inside the caller's transaction, so the audit row commits or rolls back with the change. */
  async write(tx: Tx, actor: Actor, e: AuditEntry): Promise<void> {
    await tx.insert(auditLogs).values({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorEmail: actor.email,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId ?? null,
      reason: e.reason ?? null,
      correlationId: actor.correlationId ?? null,
      details: e.details ?? {},
    });
  }

  /** Keyset paging on (at, id), newest first. Cursor is `<iso>|<id>`. */
  async list(ctx: RequestContext, cursor: string | undefined, limit: number) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      let where = eq(auditLogs.tenantId, ctx.tenantId);
      if (cursor) {
        const [at, id] = cursor.split('|');
        if (at && id) {
          const d = new Date(at);
          where = and(where, or(lt(auditLogs.at, d), and(eq(auditLogs.at, d), lt(auditLogs.id, id))))!;
        }
      }
      const rows = await tx
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.at), desc(auditLogs.id))
        .limit(limit + 1);
      const more = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          actorId: r.actorId,
          actorEmail: r.actorEmail,
          action: r.action,
          targetType: r.targetType,
          targetId: r.targetId,
          reason: r.reason,
          correlationId: r.correlationId,
          details: r.details as Record<string, unknown>,
        })),
        nextCursor: more && last ? `${last.at.toISOString()}|${last.id}` : null,
      };
    });
  }
}
