import { Inject, Injectable } from '@nestjs/common';
import { canGrant, type Role, type UserCreate, type UserSummary } from '@s360/contracts';
import { sessions, users, withTenant, type Db } from '@s360/db';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { actorOf, AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { RequestContext } from '../common/context.js';
import { problem } from '../common/problem.js';
import { DB } from '../db/db.module.js';

type Row = typeof users.$inferSelect;
const summary = (u: Row): UserSummary => ({
  id: u.id,
  email: u.email,
  name: u.name,
  roles: u.roles as Role[],
  status: u.status,
  mfaEnabled: u.mfaEnabled,
  lastSignInAt: u.lastSignInAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
});

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private assertGrantable(ctx: RequestContext, roles: Role[]) {
    const bad = roles.filter((r) => !canGrant(ctx.permissions, r));
    if (bad.length) throw problem.forbidden('role_not_grantable', `You cannot grant ${bad.join(', ')}`);
  }

  list(ctx: RequestContext, after: string | undefined, limit: number) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(users)
        .where(after ? gt(users.id, after) : undefined)
        .orderBy(asc(users.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map(summary);
      return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    });
  }

  get(ctx: RequestContext, id: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
      if (!u) throw problem.notFound('User not found');
      return summary(u);
    });
  }

  async create(ctx: RequestContext, body: UserCreate) {
    this.assertGrantable(ctx, body.roles);
    const hash = await AuthService.hashPassword(body.password);
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [exists] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
      if (exists) throw problem.conflict('email_taken', 'Someone in this workspace already uses that e-mail');
      const [u] = await tx
        .insert(users)
        .values({ tenantId: ctx.tenantId, email: body.email, name: body.name, roles: body.roles, passwordHash: hash })
        .returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'user.created',
        targetType: 'user',
        targetId: u!.id,
        details: { email: body.email, roles: body.roles },
      });
      return summary(u!);
    });
  }

  async setRoles(ctx: RequestContext, id: string, roles: Role[]) {
    this.assertGrantable(ctx, roles);
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update').limit(1);
      if (!before) throw problem.notFound('User not found');
      this.assertGrantable(ctx, before.roles as Role[]);
      if (id === ctx.userId) throw problem.forbidden('self_change', 'Ask another admin to change your own roles');
      const [u] = await tx.update(users).set({ roles }).where(eq(users.id, id)).returning();
      await this.audit.write(tx, actorOf(ctx), {
        action: 'user.roles_changed',
        targetType: 'user',
        targetId: id,
        details: { before: before.roles, after: roles },
      });
      return summary(u!);
    });
  }

  async setStatus(ctx: RequestContext, id: string, status: 'active' | 'disabled', reason: string) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update').limit(1);
      if (!before) throw problem.notFound('User not found');
      if (id === ctx.userId) throw problem.forbidden('self_change', 'You cannot disable your own account');
      this.assertGrantable(ctx, before.roles as Role[]);
      const [u] = await tx
        .update(users)
        .set({ status, lockedUntil: null, failedSignIns: 0 })
        .where(eq(users.id, id))
        .returning();
      if (status === 'disabled') {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
      }
      await this.audit.write(tx, actorOf(ctx), {
        action: status === 'disabled' ? 'user.disabled' : 'user.enabled',
        targetType: 'user',
        targetId: id,
        reason,
      });
      return summary(u!);
    });
  }
}
