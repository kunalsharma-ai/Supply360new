import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeFor, PASSWORD, signIn, startHarness, tenant, type Harness } from './harness.js';

let h: Harness;
const csrf = { 'x-s360-csrf': '1' };

beforeAll(async () => {
  h = await startHarness();
  await tenant(h, 'alpha');
  await tenant(h, 'beta');
});
afterAll(async () => h?.close());

describe('health and openapi', () => {
  it('health is public and reports the database', async () => {
    const r = await h.http.get('/api/v1/health');
    expect(r.status).toBe(200);
    expect(r.body.database).toBe('up');
  });
  it('serves an OpenAPI document generated from the contracts', async () => {
    const r = await h.http.get('/api/v1/openapi.json');
    expect(r.body.openapi).toBe('3.0.3');
    expect(r.body.paths['/users'].post.requestBody).toBeTruthy();
  });
});

describe('sign-in', () => {
  it('refuses writes without the CSRF header', async () => {
    const r = await h.http
      .post('/api/v1/auth/login')
      .send({ tenant: 'alpha', email: 'admin@alpha.example.invalid', password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('csrf_header_missing');
    expect(r.headers['content-type']).toContain('application/problem+json');
  });

  it('gives the same answer for an unknown workspace, unknown e-mail and wrong password', async () => {
    const bodies = [
      { tenant: 'nope', email: 'admin@alpha.example.invalid', password: PASSWORD },
      { tenant: 'alpha', email: 'ghost@alpha.example.invalid', password: PASSWORD },
      { tenant: 'alpha', email: 'admin@alpha.example.invalid', password: 'wrong-password-123' },
    ];
    for (const b of bodies) {
      const r = await h.http.post('/api/v1/auth/login').set(csrf).send(b);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('invalid_credentials');
    }
  });

  it('enrols MFA on first sign-in, challenges afterwards and refuses a reused code', async () => {
    const { agent, uri } = await signIn(h, 'alpha', 'admin@alpha.example.invalid');
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.tenant.slug).toBe('alpha');
    expect(me.body.permissions).toContain('users.manage');

    const again = (await import('supertest')).default.agent(h.app.getHttpServer());
    const l = await again
      .post('/api/v1/auth/login')
      .set(csrf)
      .send({ tenant: 'alpha', email: 'admin@alpha.example.invalid', password: PASSWORD });
    expect(l.body).toEqual({ stage: 'mfa_challenge' });
    // password-stage sessions cannot use the app
    expect((await again.get('/api/v1/users')).body.code).toBe('mfa_required');
    // the code used to enrol has been spent
    expect(
      (
        await again
          .post('/api/v1/auth/mfa')
          .set(csrf)
          .send({ code: codeFor(uri) })
      ).status,
    ).toBe(401);
    expect(
      (
        await again
          .post('/api/v1/auth/mfa')
          .set(csrf)
          .send({ code: codeFor(uri, 1) })
      ).status,
    ).toBe(200);
    expect((await again.get('/api/v1/users')).status).toBe(200);
  });

  it('locks an account after five wrong passwords', async () => {
    const { agent } = await signIn(h, 'alpha', 'admin@alpha.example.invalid');
    await agent
      .post('/api/v1/users')
      .set(csrf)
      .send({ email: 'victim@alpha.example.invalid', name: 'Victim', roles: ['read_only'], password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      await h.http
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ tenant: 'alpha', email: 'victim@alpha.example.invalid', password: 'wrong-password-123' });
    }
    const r = await h.http
      .post('/api/v1/auth/login')
      .set(csrf)
      .send({ tenant: 'alpha', email: 'victim@alpha.example.invalid', password: PASSWORD });
    expect(r.status).toBe(423);
  });

  it('logout revokes the session', async () => {
    const { agent: admin } = await signIn(h, 'beta', 'admin@beta.example.invalid');
    await admin
      .post('/api/v1/users')
      .set(csrf)
      .send({ email: 'leaver@beta.example.invalid', name: 'Leaver', roles: ['read_only'], password: PASSWORD });
    const { agent } = await signIn(h, 'beta', 'leaver@beta.example.invalid');
    expect((await agent.post('/api/v1/auth/logout').set(csrf)).status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('roles and permissions', () => {
  it('enforces the role matrix on the server', async () => {
    const { agent: admin } = await signIn(h, 'alpha', 'admin@alpha.example.invalid');
    const c = await admin
      .post('/api/v1/users')
      .set(csrf)
      .send({ email: 'reader@alpha.example.invalid', name: 'Reader', roles: ['read_only'], password: PASSWORD });
    expect(c.status).toBe(201);
    const { agent: reader } = await signIn(h, 'alpha', 'reader@alpha.example.invalid');
    const r = await reader
      .post('/api/v1/users')
      .set(csrf)
      .send({ email: 'x@alpha.example.invalid', name: 'X', roles: ['read_only'], password: PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('permission_denied');
    expect((await reader.get('/api/v1/audit')).status).toBe(403);
  });

  it('a tenant admin cannot grant super admin or change their own roles', async () => {
    const { agent } = await signIn(h, 'alpha', 'admin@alpha.example.invalid');
    const r = await agent
      .post('/api/v1/users')
      .set(csrf)
      .send({ email: 'boss@alpha.example.invalid', name: 'Boss', roles: ['super_admin'], password: PASSWORD });
    expect(r.body.code).toBe('role_not_grantable');
    const me = (await agent.get('/api/v1/auth/me')).body;
    const self = await agent
      .patch(`/api/v1/users/${me.user.id}/roles`)
      .set(csrf)
      .send({ roles: ['read_only'] });
    expect(self.body.code).toBe('self_change');
  });

  it('disabling a user ends their sessions at once', async () => {
    const { agent: admin } = await signIn(h, 'alpha', 'admin@alpha.example.invalid');
    const u = await admin
      .post('/api/v1/users')
      .set(csrf)
      .send({ email: 'temp@alpha.example.invalid', name: 'Temp', roles: ['reporting_user'], password: PASSWORD });
    const { agent: temp } = await signIn(h, 'alpha', 'temp@alpha.example.invalid');
    expect((await temp.get('/api/v1/auth/me')).status).toBe(200);
    await admin
      .patch(`/api/v1/users/${u.body.id}/status`)
      .set(csrf)
      .send({ status: 'disabled', reason: 'left the team' });
    expect((await temp.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('tenant isolation (spec acceptance: tenant A cannot access tenant B)', () => {
  it('never returns another tenant’s users, even by id', async () => {
    const { agent: a } = await signIn(h, 'alpha', 'admin@alpha.example.invalid');
    const { agent: b } = await signIn(h, 'beta', 'admin@beta.example.invalid');
    const aUsers = (await a.get('/api/v1/users')).body.items as { id: string; email: string }[];
    const bUsers = (await b.get('/api/v1/users')).body.items as { id: string; email: string }[];
    expect(aUsers.every((u) => u.email.endsWith('@alpha.example.invalid'))).toBe(true);
    expect(bUsers.every((u) => u.email.endsWith('@beta.example.invalid'))).toBe(true);
    expect((await b.get(`/api/v1/users/${aUsers[0]!.id}`)).status).toBe(404);
    const audit = (await b.get('/api/v1/audit')).body.items as { actorEmail: string | null }[];
    expect(audit.some((e) => e.actorEmail?.includes('alpha'))).toBe(false);
  });

  it('row-level security holds below the API: no tenant set means no rows, and writes into another tenant fail', async () => {
    const c = new pg.Client({ connectionString: h.appUrl });
    await c.connect();
    try {
      expect((await c.query('select * from users')).rowCount).toBe(0);
      const t = await c.query('select id, slug from tenants order by slug');
      const alpha = t.rows.find((r) => r.slug === 'alpha')!.id;
      const beta = t.rows.find((r) => r.slug === 'beta')!.id;
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true)", [alpha]);
      expect((await c.query('select tenant_id from users')).rows.every((r) => r.tenant_id === alpha)).toBe(true);
      await expect(
        c.query(
          "insert into users (tenant_id, email, name, password_hash, roles) values ($1, 'x@x', 'x', 'x', '{read_only}')",
          [beta],
        ),
      ).rejects.toThrow(/row-level security/);
      await c.query('rollback');
    } finally {
      await c.end();
    }
  });

  it('the audit log is append-only for the application role', async () => {
    const c = new pg.Client({ connectionString: h.appUrl });
    await c.connect();
    try {
      await expect(c.query("update audit_logs set action = 'tampered'")).rejects.toThrow(/permission denied/);
      await expect(c.query('delete from audit_logs')).rejects.toThrow(/permission denied/);
      await expect(c.query("insert into tenants (slug, name) values ('evil', 'Evil')")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await c.end();
    }
  });
});

describe('settings and audit', () => {
  it('saves tenant settings with a version and an audit entry', async () => {
    const { agent } = await signIn(h, 'beta', 'admin@beta.example.invalid');
    const put = await agent
      .put('/api/v1/settings/tenant')
      .set(csrf)
      .send({
        displayName: 'Beta Research',
        timezone: 'Asia/Kolkata',
        locale: 'en-IN',
        defaultTheme: 'emerald',
        defaultExecutionMode: 'manual',
      });
    expect(put.status).toBe(200);
    expect(put.body.version).toBe(1);
    const bad = await agent
      .put('/api/v1/settings/tenant')
      .set(csrf)
      .send({ ...put.body.value, defaultExecutionMode: 'automatic' });
    expect(bad.status).toBe(400);
    const audit = (await agent.get('/api/v1/audit?limit=5')).body;
    expect(audit.items[0].action).toBe('settings.changed');
  });
});
