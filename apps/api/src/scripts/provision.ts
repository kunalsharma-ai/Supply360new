import { PasswordPolicy, Role } from '@s360/contracts';
import { auditLogs, createDb, createPool, tenants, users } from '@s360/db';
import { eq } from 'drizzle-orm';
import { AuthService } from '../auth/auth.service.js';

export interface ProvisionInput {
  slug: string;
  name: string;
  admin: { email: string; name: string; password: string; roles?: Role[] };
}

/**
 * Creates a tenant and its first admin with the owner connection (DATABASE_ADMIN_URL). This is the only code path
 * that writes the tenants table; it is a CLI step, not an API route, and it writes an audit row in the new tenant.
 */
export async function provisionTenant(adminUrl: string, input: ProvisionInput) {
  PasswordPolicy.parse(input.admin.password);
  const pool = createPool(adminUrl, 1);
  const db = createDb(pool);
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(tenants).where(eq(tenants.slug, input.slug)).limit(1);
      if (existing) throw new Error(`Tenant ${input.slug} already exists`);
      const [t] = await tx.insert(tenants).values({ slug: input.slug, name: input.name }).returning();
      const [u] = await tx
        .insert(users)
        .values({
          tenantId: t!.id,
          email: input.admin.email.toLowerCase(),
          name: input.admin.name,
          roles: input.admin.roles ?? ['tenant_admin'],
          passwordHash: await AuthService.hashPassword(input.admin.password),
        })
        .returning();
      await tx.insert(auditLogs).values({
        tenantId: t!.id,
        action: 'tenant.provisioned',
        targetType: 'tenant',
        targetId: t!.id,
        details: { slug: input.slug, firstAdmin: u!.email, via: 'cli' },
      });
      return { tenantId: t!.id, userId: u!.id };
    });
  } finally {
    await pool.end();
  }
}
