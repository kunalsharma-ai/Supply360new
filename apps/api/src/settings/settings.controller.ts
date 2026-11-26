import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { TenantSettings } from '@s360/contracts';
import { settings, withTenant, type Db } from '@s360/db';
import { and, eq, sql } from 'drizzle-orm';
import { actorOf, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/context.js';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DB } from '../db/db.module.js';

const KEY = 'tenant';

@Controller('settings')
export class SettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get('tenant')
  @RequirePermissions('settings.read')
  get(@Ctx() ctx: RequestContext) {
    return withTenant(this.db, ctx.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(settings)
        .where(and(eq(settings.key, KEY)))
        .limit(1);
      const value: TenantSettings = row
        ? TenantSettings.parse(row.value)
        : {
            displayName: ctx.tenantName,
            timezone: 'UTC',
            locale: 'en',
            defaultTheme: 'glass',
            defaultExecutionMode: 'manual',
          };
      return { value, version: row?.version ?? 0 };
    });
  }

  @Put('tenant')
  @RequirePermissions('settings.manage')
  put(@Ctx() ctx: RequestContext, @Body(new ZodPipe(TenantSettings)) value: TenantSettings) {
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
        action: 'settings.changed',
        targetType: 'settings',
        targetId: KEY,
        details: { before: before?.value ?? null, after: value },
      });
      return { value: row!.value, version: row!.version };
    });
  }
}
