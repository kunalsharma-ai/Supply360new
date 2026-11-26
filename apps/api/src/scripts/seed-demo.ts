import { ROLE_LABELS, Role } from '@s360/contracts';
import { audienceConnections, createDb, createPool, notifications, sourceConnections, tenants, users } from '@s360/db';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Env } from '../config.js';
import { Sealer } from '../crypto/sealer.js';
import { IngestionService, secretContext } from '../ingestion/ingestion.service.js';
import { provisionTenant } from './provision.js';

/**
 * DEMO tenant for local previews only: slug `demo`, one fictional account per role at `@demo.example.invalid`.
 * Never run against production. Refuses unless NODE_ENV is development or test.
 */
const url = process.env.DATABASE_ADMIN_URL;
const password = process.env.S360_DEMO_PASSWORD;
const key = process.env.FIELD_ENCRYPTION_KEY;
if (!url || !password || !key)
  throw new Error(
    'DATABASE_ADMIN_URL, S360_DEMO_PASSWORD and FIELD_ENCRYPTION_KEY (the same one the API uses) are required',
  );
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
  await db.insert(users).values({
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
  body: 'This workspace holds fictional accounts only. SampTrek and MADP are connected in FIXTURE mode with labelled sample projects and a DEMO population.',
});

// A FIXTURE SampTrek connection with its sample projects imported, so the Phase 2 screens have something to show.
const connId = (await pool.query<{ id: string }>('select uuidv7()::text as id')).rows[0]!.id;
const [conn] = await db
  .insert(sourceConnections)
  .values({
    id: connId,
    tenantId,
    kind: 'samptrek',
    mode: 'fixture',
    name: 'SampTrek (FIXTURE)',
    vendorCode: 'S360',
    webhookSecretSealed: new Sealer(key).seal(`whsec_${randomBytes(32).toString('base64url')}`, secretContext(connId)),
  })
  .returning();
const sync = await new IngestionService(db, { FIELD_ENCRYPTION_KEY: key } as Env, new AuditService(db)).sync(
  conn!,
  true,
);
console.log(
  `FIXTURE SampTrek backfill: ${sync.created} projects imported${sync.ok ? '' : `, errors: ${sync.errors.join('; ')}`}`,
);
// A FIXTURE MADP connection: a labelled DEMO population, so audience counts and reservations work in the demo.
await db.insert(audienceConnections).values({ tenantId, mode: 'fixture', name: 'MADP (FIXTURE)' });
console.log('FIXTURE MADP connected (DEMO population).');
const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
console.log(`DEMO tenant ${t?.slug} seeded with ${Role.options.length} accounts.`);
await pool.end();
