import { ROLE_LABELS, Role } from '@s360/contracts';
import { createDb, createPool, notifications, tenants, users } from '@s360/db';
import { eq } from 'drizzle-orm';
import { AuthService } from '../auth/auth.service.js';
import { provisionTenant } from './provision.js';

/**
 * DEMO tenant for local previews only: slug `demo`, one fictional account per role at `@demo.example.invalid`.
 * Never run against production. Refuses unless NODE_ENV is development or test.
 */
const url = process.env.DATABASE_ADMIN_URL;
const password = process.env.S360_DEMO_PASSWORD;
if (!url || !password) throw new Error('DATABASE_ADMIN_URL and S360_DEMO_PASSWORD are required');
if (!['development', 'test'].includes(process.env.NODE_ENV ?? 'development'))
  throw new Error('Demo seed is for local use only');

const { tenantId } = await provisionTenant(url, {
  slug: 'demo',
  name: 'DEMO workspace',
  admin: { email: 'tenant_admin@demo.example.invalid', name: 'DEMO Tenant Admin', password },
});
const pool = createPool(url, 1);
const db = createDb(pool);
const hash = await AuthService.hashPassword(password);
for (const r of Role.options.filter((r) => r !== 'tenant_admin')) {
  await db
    .insert(users)
    .values({
      tenantId,
      email: `${r}@demo.example.invalid`,
      name: `DEMO ${ROLE_LABELS[r]}`,
      roles: [r],
      passwordHash: hash,
    });
}
await db.insert(notifications).values({
  tenantId,
  kind: 'system',
  severity: 'info',
  title: 'DEMO workspace',
  body: 'This workspace holds fictional accounts only. No source system is connected.',
});
const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
console.log(`DEMO tenant ${t?.slug} seeded with ${Role.options.length} accounts.`);
await pool.end();
