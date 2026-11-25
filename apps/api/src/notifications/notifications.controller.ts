import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { notifications, withTenant, type Db } from '@s360/db';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { DB } from '../db/db.module.js';

/** Personal and tenant-wide (user_id null) notifications. Later phases write them; Phase 1 reads them. */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @RequirePermissions('notifications.read')
  list(@Ctx() ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(notifications)
        .where(or(eq(notifications.userId, ctx.userId), isNull(notifications.userId)))
        .orderBy(desc(notifications.createdAt))
        .limit(50);
      return {
        items: rows.map((n) => ({
          ...n,
          createdAt: n.createdAt.toISOString(),
          readAt: n.readAt?.toISOString() ?? null,
        })),
        unread: rows.filter((n) => !n.readAt).length,
      };
    });
  }

  @Post(':id/read')
  @HttpCode(204)
  @RequirePermissions('notifications.read')
  async read(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await withTenant(this.db, ctx.tenantId, (tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.id, id), or(eq(notifications.userId, ctx.userId), isNull(notifications.userId)))),
    );
  }
}
