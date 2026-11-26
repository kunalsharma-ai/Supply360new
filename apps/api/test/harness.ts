import { randomBytes } from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { Secret, TOTP } from 'otpauth';
import { createDb, createPool } from '@s360/db';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../src/bootstrap.js';
import { loadEnv } from '../src/config.js';
import { provisionTenant } from '../src/scripts/provision.js';

/** Each run gets a throwaway database; the API connects as a non-owner role so row-level security is real. */
const ADMIN = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const APP_ROLE = 's360_api_test';
const APP_PASSWORD = 's360-api-test-password';

export interface Harness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  adminUrl: string;
  appUrl: string;
  close(): Promise<void>;
}

function withDb(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export async function startHarness(): Promise<Harness> {
  const name = `s360_test_${randomBytes(4).toString('hex')}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
      create role ${APP_ROLE} login password '${APP_PASSWORD}';
    end if; end $$`);
  await root.end();

  const adminUrl = withDb(ADMIN, name);
  const pool = createPool(adminUrl, 1);
  await migrate(createDb(pool), {
    migrationsFolder: fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)),
  });
  await pool.query(`grant s360_app to ${APP_ROLE}`);
  await pool.end();

  const u = new URL(adminUrl);
  u.username = APP_ROLE;
  u.password = APP_PASSWORD;
  const appUrl = u.toString();
  const env = loadEnv({
    NODE_ENV: 'test',
    LOGIN_RATE_LIMIT: '1000',
    SOURCE_POLL_SECONDS: '0',
    DISPATCH_TICK_SECONDS: '0',
    METRICS_TOKEN: 'test-metrics-token-0123456789abcdef0123',
    DATABASE_URL: appUrl,
    DATABASE_ADMIN_URL: adminUrl,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  const app = await createApp(env);
  await app.init();
  return {
    app,
    http: request(app.getHttpServer()),
    adminUrl,
    appUrl,
    async close() {
      await app.close();
      const c = new pg.Client({ connectionString: ADMIN });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

export const PASSWORD = 'correct-horse-battery-42';

export async function tenant(h: Harness, slug: string, roles: import('@s360/contracts').Role[] = ['tenant_admin']) {
  return provisionTenant(h.adminUrl, {
    slug,
    name: `Tenant ${slug}`,
    admin: { email: `admin@${slug}.example.invalid`, name: `Admin ${slug}`, password: PASSWORD, roles },
  });
}

export function codeFor(otpauthUri: string, offsetSteps = 0): string {
  const secret = new URL(otpauthUri).searchParams.get('secret')!;
  return new TOTP({ secret: Secret.fromBase32(secret), period: 30, digits: 6 }).generate({
    timestamp: Date.now() + offsetSteps * 30_000,
  });
}

const signedIn = new Map<string, { agent: ReturnType<typeof request.agent>; uri: string }>();

/**
 * An agent that has signed in and enrolled MFA, cached per account: a TOTP code can be used once, so signing the
 * same account in again within 30 seconds would (correctly) be refused.
 */
export async function signIn(h: Harness, slug: string, email: string, password = PASSWORD) {
  const key = `${slug}/${email}`;
  const cached = signedIn.get(key);
  if (cached) return cached;
  const agent = request.agent(h.app.getHttpServer());
  const r = await agent.post('/api/v1/auth/login').set('x-s360-csrf', '1').send({ tenant: slug, email, password });
  if (r.status !== 200) throw new Error(`login ${r.status} ${JSON.stringify(r.body)}`);
  const uri = r.body.otpauthUri as string;
  const m = await agent
    .post('/api/v1/auth/mfa')
    .set('x-s360-csrf', '1')
    .send({ code: codeFor(uri) });
  if (m.status !== 200) throw new Error(`mfa ${m.status} ${JSON.stringify(m.body)}`);
  signedIn.set(key, { agent, uri });
  return { agent, uri };
}
