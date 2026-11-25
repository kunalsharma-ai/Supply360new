import { parseArgs } from 'node:util';
import { provisionTenant } from './provision.js';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
    'super-admin': { type: 'boolean', default: false },
  },
});
const url = process.env.DATABASE_ADMIN_URL;
const password = process.env.S360_ADMIN_PASSWORD;
if (!url || !password || !values.slug || !values.name || !values['admin-email'] || !values['admin-name']) {
  console.error(
    'Usage: S360_ADMIN_PASSWORD=… pnpm --filter @s360/api tenant:create --slug acme --name "Acme" --admin-email you@acme.com --admin-name "Your Name" [--super-admin]',
  );
  process.exit(1);
}
const r = await provisionTenant(url, {
  slug: values.slug,
  name: values.name,
  admin: {
    email: values['admin-email'],
    name: values['admin-name'],
    password,
    roles: values['super-admin'] ? ['super_admin'] : ['tenant_admin'],
  },
});
console.log(`Tenant ${values.slug} created (${r.tenantId}). Sign in and enrol an authenticator app.`);
