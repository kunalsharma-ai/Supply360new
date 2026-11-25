import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureProjects, fixtureStore } from '../src/ingestion/samptrek/fixture.js';
import { signSampTrek } from '../src/ingestion/signature.js';
import { signIn, startHarness, tenant, type Harness } from './harness.js';

let h: Harness;
const csrf = { 'x-s360-csrf': '1' };
type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
let admin: Agent;
let source: { id: string; webhookUrl: string; webhookSecret: string };

const path = (url: string) => new URL(url).pathname;
const envelope = (id: string, projectId: string, to: string, createdAt = new Date().toISOString()) =>
  JSON.stringify({
    id,
    event: 'project.status_changed',
    createdAt,
    data: { project: { id: projectId }, from: 'LIVE', to, changedBy: { name: 'PM', email: 'pm@client.example' } },
  });
const deliver = (body: string, secret = source.webhookSecret, url = source.webhookUrl, ts?: number) =>
  h.http
    .post(path(url))
    .set({
      'content-type': 'application/json',
      ...signSampTrek(secret, body, ts),
      'x-projexa-delivery': randomBytes(4).toString('hex'),
    })
    .send(body);
const projectBy = async (code: string) => {
  const r = await admin.get('/api/v1/projects');
  const s = (r.body.items as { projectCode: string; id: string }[]).find((p) => p.projectCode === code)!;
  return (await admin.get(`/api/v1/projects/${s.id}`)).body;
};
const act = (id: string, action: string) =>
  admin.post(`/api/v1/projects/${id}/lifecycle`).set(csrf).send({ action, reason: 'integration test' });
const db = async <T extends pg.QueryResultRow>(q: string, p: unknown[] = []) => {
  const c = new pg.Client({ connectionString: h.adminUrl });
  await c.connect();
  try {
    return (await c.query<T>(q, p)).rows;
  } finally {
    await c.end();
  }
};

beforeAll(async () => {
  h = await startHarness();
  await tenant(h, 'acme');
  await tenant(h, 'other');
  ({ agent: admin } = await signIn(h, 'acme', 'admin@acme.example.invalid'));
  const r = await admin
    .post('/api/v1/sources')
    .set(csrf)
    .send({ kind: 'samptrek', name: 'SampTrek (FIXTURE)', mode: 'fixture', vendorCode: 'S360' });
  expect(r.status).toBe(201);
  source = r.body;
});
afterAll(async () => h?.close());

describe('source connections', () => {
  it('shows the webhook secret once and never again', async () => {
    expect(source.webhookSecret).toMatch(/^whsec_/);
    const list = await admin.get('/api/v1/sources');
    expect(JSON.stringify(list.body)).not.toContain(source.webhookSecret);
    expect(list.body.items[0].webhookUrl).toContain(`/webhooks/samptrek/acme/${source.id}`);
  });
  it('stores the secret sealed, not in plain text', async () => {
    const [row] = await db<{ s: string }>('select webhook_secret_sealed s from source_connections where id = $1', [
      source.id,
    ]);
    expect(row!.s).toMatch(/^v1\./);
    expect(row!.s).not.toContain(source.webhookSecret);
  });
  it('requires LIVE connections to have a key', async () => {
    const r = await admin
      .post('/api/v1/sources')
      .set(csrf)
      .send({ kind: 'samptrek', name: 'x', mode: 'live', vendorCode: 'S360' });
    expect(r.status).toBe(400);
  });
});

describe('backfill and polling', () => {
  it('imports every FIXTURE project once, with the source status deciding the starting state', async () => {
    const r = await admin.post(`/api/v1/sources/${source.id}/sync`).set(csrf).send({ full: true });
    expect(r.body).toMatchObject({ ok: true, seen: 3, created: 3 });
    expect((await projectBy('PRX10001')).lifecycle).toBe('imported');
    expect((await projectBy('PRX10003')).lifecycle).toBe('source_hold');
  });
  it('a second run changes nothing and makes no new versions', async () => {
    const r = await admin.post(`/api/v1/sources/${source.id}/sync`).set(csrf).send({ full: true });
    expect(r.body).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 3 });
    const [v] = await db<{ n: string }>('select count(*) n from project_versions');
    expect(Number(v!.n)).toBe(3);
  });
  it('a content change at the source becomes version 2; progress alone does not', async () => {
    const p = fixtureStore(source.id).find((x) => x.projectCode === 'PRX10002')!;
    p.markets[0]!.completes += 25;
    p.updatedAt = new Date().toISOString();
    await admin.post(`/api/v1/sources/${source.id}/sync`).set(csrf).send({});
    expect((await projectBy('PRX10002')).version).toBe(1);
    p.markets[0]!.loiMinutes = 20;
    p.updatedAt = new Date(Date.now() + 1000).toISOString();
    const r = await admin.post(`/api/v1/sources/${source.id}/sync`).set(csrf).send({});
    expect(r.body).toMatchObject({ ok: true, updated: 1 });
    const d = await projectBy('PRX10002');
    expect(d.version).toBe(2);
    expect(d.markets[0].completes).toBe(25);
    const v = await admin.get(`/api/v1/projects/${d.id}/versions`);
    expect(v.body.items.map((x: { version: number }) => x.version)).toEqual([2, 1]);
  });
  it('never stores prices, other vendors or e-mail addresses', async () => {
    const rows = await db('select * from projects p join project_markets m on m.project_id = p.id');
    expect(JSON.stringify(rows)).not.toMatch(/cpi|Another vendor|@/i);
  });
});

describe('signed webhook inbox (gate: duplicate webhook gives one project)', () => {
  it('refuses a bad signature and an old timestamp, and only counts them', async () => {
    const body = envelope('evt_bad', 'fx-prj-10001', 'HOLD');
    expect((await deliver(body, 'whsec_wrong')).status).toBe(401);
    expect(
      (await deliver(body, source.webhookSecret, source.webhookUrl, Math.floor(Date.now() / 1000) - 600)).status,
    ).toBe(401);
    const [c] = await db<{ n: number }>('select rejected_count n from source_connections where id = $1', [source.id]);
    expect(c!.n).toBe(2);
    expect(await db("select 1 from inbound_events where event_id = 'evt_bad'")).toHaveLength(0);
  });

  it('a project first seen in a webhook, delivered twice at once, is created exactly once', async () => {
    const extra = structuredClone(fixtureProjects()[1]!);
    Object.assign(extra, {
      id: 'fx-prj-20001',
      projectCode: 'PRX20001',
      name: 'FIXTURE · Late arrival',
      status: 'LIVE',
    });
    fixtureStore(source.id).push(extra);
    const body = envelope('evt_dup_1', 'fx-prj-20001', 'LIVE');
    const [a, b] = await Promise.all([deliver(body), deliver(body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.status, b.body.status].sort()).toEqual(['duplicate', 'processed']);
    const third = await deliver(body);
    expect(third.body.status).toBe('duplicate');
    expect(await db("select 1 from projects where source_project_id = 'fx-prj-20001'")).toHaveLength(1);
    const [e] = await db<{ duplicates: number; payload: unknown }>(
      "select duplicates, payload from inbound_events where event_id = 'evt_dup_1'",
    );
    expect(e!.duplicates).toBe(2);
    expect(JSON.stringify(e!.payload)).not.toContain('pm@client.example');
  });

  it('records events it does not act on yet, and finance events are ignored', async () => {
    const body = JSON.stringify({
      id: 'evt_inv',
      event: 'invoice.status_changed',
      createdAt: new Date().toISOString(),
      data: { invoice: { total: 100 } },
    });
    expect((await deliver(body)).body.status).toBe('ignored');
    const ev = await admin.get('/api/v1/sources/events');
    const row = ev.body.items.find((x: { eventId: string }) => x.eventId === 'evt_inv');
    expect(row.error).toContain('out of scope');
    expect(JSON.stringify(row.payload)).not.toContain('100');
  });

  it("another tenant's webhook URL does not reach this connection", async () => {
    const body = envelope('evt_x', 'fx-prj-10001', 'HOLD');
    const wrong = source.webhookUrl.replace('/acme/', '/other/');
    expect((await deliver(body, source.webhookSecret, wrong)).status).toBe(404);
  });
});

describe('lifecycle (gate: source pause stops dispatch)', () => {
  let p: { id: string; markets: { countryCode: string }[] };
  it('cannot be marked ready until an entry link is approved for every Supply360 market', async () => {
    p = await projectBy('PRX10001');
    const r = await act(p.id, 'mark_ready');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('launch_checks');
    const bad = await admin
      .put(`/api/v1/projects/${p.id}/markets/US/entry-link`)
      .set(csrf)
      .send({ entryUrl: 'https://st.example/s/abc' });
    expect(bad.status).toBe(400);
    for (const m of p.markets) {
      const ok = await admin
        .put(`/api/v1/projects/${p.id}/markets/${m.countryCode}/entry-link`)
        .set(csrf)
        .send({ entryUrl: `https://st.example/s/${m.countryCode}?uid=[UID]` });
      expect(ok.status).toBe(200);
    }
  });

  it('marks ready, launches and is then allowed to dispatch', async () => {
    expect((await act(p.id, 'mark_ready')).body.lifecycle).toBe('ready');
    const l = await act(p.id, 'launch');
    expect(l.body).toMatchObject({ lifecycle: 'live', dispatchAllowed: true });
  });

  it('a signed HOLD from SampTrek stops dispatch at once, and LIVE again only returns it to paused', async () => {
    const hold = await admin
      .post(`/api/v1/sources/${source.id}/fixture/status`)
      .set(csrf)
      .send({ projectCode: 'PRX10001', status: 'HOLD' });
    expect(hold.body.status).toBe('processed');
    let d = await projectBy('PRX10001');
    expect(d).toMatchObject({ lifecycle: 'source_hold', dispatchAllowed: false });
    expect(d.markets.every((m: { dispatchAllowed: boolean }) => !m.dispatchAllowed)).toBe(true);
    expect((await act(p.id, 'resume')).status).toBe(409);

    await admin
      .post(`/api/v1/sources/${source.id}/fixture/status`)
      .set(csrf)
      .send({ projectCode: 'PRX10001', status: 'LIVE' });
    d = await projectBy('PRX10001');
    expect(d).toMatchObject({ lifecycle: 'paused', dispatchAllowed: false });
    expect((await act(p.id, 'resume')).body).toMatchObject({ lifecycle: 'live', dispatchAllowed: true });
  });

  it('a poll that sees the hold does the same, without any webhook', async () => {
    const st = fixtureStore(source.id).find((x) => x.projectCode === 'PRX10001')!;
    st.status = 'HOLD';
    st.updatedAt = new Date(Date.now() + 5000).toISOString();
    await admin.post(`/api/v1/sources/${source.id}/sync`).set(csrf).send({});
    expect((await projectBy('PRX10001')).dispatchAllowed).toBe(false);
  });

  it('CLOSED at the source is final', async () => {
    await admin
      .post(`/api/v1/sources/${source.id}/fixture/status`)
      .set(csrf)
      .send({ projectCode: 'PRX10001', status: 'CLOSED' });
    await admin
      .post(`/api/v1/sources/${source.id}/fixture/status`)
      .set(csrf)
      .send({ projectCode: 'PRX10001', status: 'LIVE' });
    expect((await projectBy('PRX10001')).lifecycle).toBe('closed');
  });

  it('every move is in the audit log with who made it', async () => {
    const rows = await db<{ actor_email: string; details: { to: string; by: string } }>(
      "select actor_email, details from audit_logs where action = 'project.lifecycle_changed' and target_id = $1 order by at",
      [p.id],
    );
    expect(rows.map((r) => `${r.details.by}:${r.details.to}`)).toEqual([
      'person:ready',
      'person:live',
      'source:source_hold',
      'source:paused',
      'person:live',
      'source:source_hold',
      'source:closed',
    ]);
    expect(rows[0]!.actor_email).toBe('admin@acme.example.invalid');
    expect(rows[2]!.actor_email).toBe('system:samptrek');
  });

  it('a read-only person sees projects but cannot move them', async () => {
    await admin
      .post('/api/v1/users')
      .set(csrf)
      .send({
        email: 'viewer@acme.example.invalid',
        name: 'Viewer',
        roles: ['read_only'],
        password: 'correct-horse-battery-42',
      });
    const { agent } = await signIn(h, 'acme', 'viewer@acme.example.invalid');
    const d = await projectBy('PRX10002');
    expect((await agent.get(`/api/v1/projects/${d.id}`)).status).toBe(200);
    const r = await agent
      .post(`/api/v1/projects/${d.id}/lifecycle`)
      .set(csrf)
      .send({ action: 'close', reason: 'nope' });
    expect(r.status).toBe(403);
    expect((await agent.get('/api/v1/sources')).status).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('another tenant sees none of these projects or events', async () => {
    const { agent } = await signIn(h, 'other', 'admin@other.example.invalid');
    expect((await agent.get('/api/v1/projects')).body.items).toHaveLength(0);
    expect((await agent.get('/api/v1/sources/events')).body.items).toHaveLength(0);
    const d = await projectBy('PRX10002');
    expect((await agent.get(`/api/v1/projects/${d.id}`)).status).toBe(404);
  });
});

describe('redirect endpoints', () => {
  it('record the outcome and always land on the Supply360 page, whatever the query says', async () => {
    const d = await projectBy('PRX10002');
    expect(d.redirects).toHaveLength(8);
    const complete = d.redirects.find((r: { status: string }) => r.status === 'COMPLETE');
    expect(complete.url).toContain('?uid={respondent_uid}');
    const u = new URL(complete.url.replace('{respondent_uid}', 'tok_abc123'));
    const r = await h.http.get(`${u.pathname}${u.search}&next=https://evil.example`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('http://localhost:3000/done/complete');
    expect((await projectBy('PRX10002')).redirects.find((x: { status: string }) => x.status === 'COMPLETE').hits).toBe(
      1,
    );
  });
  it('an unknown project or tenant gets the same answer and records nothing', async () => {
    const before = await db<{ n: string }>('select count(*) n from redirect_hits');
    const r1 = await h.http.get(
      `/api/v1/r/acme/${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}/complete?uid=tok_abc123`,
    );
    const r2 = await h.http.get(
      `/api/v1/r/nobody/${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}/complete?uid=tok_abc123`,
    );
    expect([r1.status, r1.headers.location, r2.status, r2.headers.location]).toEqual([
      302,
      'http://localhost:3000/done/complete',
      302,
      'http://localhost:3000/done/complete',
    ]);
    expect(await db<{ n: string }>('select count(*) n from redirect_hits')).toEqual(before);
  });
});

describe('LIVE connection over HTTP', () => {
  let server: Server;
  let up = true;
  beforeAll(async () => {
    const p = fixtureProjects()[0]!;
    Object.assign(p, { id: 'live-1', projectCode: 'PRX30001', name: 'Stub · Live project' });
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (!up) {
        res.statusCode = 503;
        return res.end('{}');
      }
      if (req.headers.authorization !== `Bearer pjx_${'k'.repeat(32)}`) {
        res.statusCode = 401;
        return res.end('{}');
      }
      if (req.url?.startsWith('/api/v1/public/projects?')) {
        return res.end(
          JSON.stringify({
            data: [{ id: p.id, projectCode: p.projectCode, name: p.name, status: p.status, updatedAt: p.updatedAt }],
            nextCursor: null,
          }),
        );
      }
      if (req.url === '/api/v1/public/projects/live-1') return res.end(JSON.stringify(p));
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('imports through the real HTTP client, keeps the key sealed, and holds the checkpoint when SampTrek is down', async () => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const c = await admin
      .post('/api/v1/sources')
      .set(csrf)
      .send({
        kind: 'samptrek',
        name: 'SampTrek stub',
        mode: 'live',
        baseUrl: base,
        apiKey: `pjx_${'k'.repeat(32)}`,
        vendorCode: 'S360',
      });
    expect(c.status).toBe(201);
    expect(JSON.stringify(c.body)).not.toContain('kkkk');
    const s = await admin.post(`/api/v1/sources/${c.body.id}/sync`).set(csrf).send({ full: true });
    expect(s.body).toMatchObject({ ok: true, created: 1 });
    expect((await projectBy('PRX30001')).sourceMode).toBe('live');

    up = false;
    const down = await admin.post(`/api/v1/sources/${c.body.id}/sync`).set(csrf).send({});
    expect(down.body.ok).toBe(false);
    const list = await admin.get('/api/v1/sources');
    const conn = list.body.items.find((x: { id: string }) => x.id === c.body.id);
    expect(conn.pollCheckpoint).toBe(s.body.ok ? conn.pollCheckpoint : null);

    // A signed HOLD still applies while SampTrek's API is down: the signed status is enough to stop dispatch.
    const hold = await deliver(envelope('evt_live_hold', 'live-1', 'HOLD'), c.body.webhookSecret, c.body.webhookUrl);
    expect(hold.body.status).toBe('processed');
    expect((await projectBy('PRX30001')).lifecycle).toBe('source_hold');

    // An unknown project while SampTrek is down cannot be imported yet: recorded as failed, retried later.
    const unknown = await deliver(envelope('evt_live_new', 'live-2', 'LIVE'), c.body.webhookSecret, c.body.webhookUrl);
    expect(unknown.status).toBe(200);
    expect(unknown.body.status).toBe('failed');
    up = true;
    const ev = await admin.get('/api/v1/sources/events');
    const failed = ev.body.items.find((x: { eventId: string }) => x.eventId === 'evt_live_new');
    const retry = await admin.post(`/api/v1/sources/events/${failed.id}/retry`).set(csrf).send({});
    expect(retry.body.status).toBe('failed');
  });
});
