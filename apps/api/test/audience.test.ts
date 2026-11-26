import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixturePopulation } from '../src/audience/madp/fixture.js';
import { fixtureCells } from '../src/ingestion/samptrek/fixture.js';
import { madpConnection, quotas, type Cell } from './audience-setup.js';
import { signIn, startHarness, tenant, type Harness } from './harness.js';

let h: Harness;
const csrf = { 'x-s360-csrf': '1' };
type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
let admin: Agent;
let sourceId: string;
const ids: Record<string, string> = {};

const db = async <T extends pg.QueryResultRow>(q: string, p: unknown[] = []) => {
  const c = new pg.Client({ connectionString: h.adminUrl });
  await c.connect();
  try {
    return (await c.query<T>(q, p)).rows;
  } finally {
    await c.end();
  }
};
const cellOf = async (code: string, cc: string, name?: string) =>
  (await quotas(admin, ids[code]!)).cells.find((c) => c.countryCode === cc && (!name || c.name === name))!;
const map = (pid: string, cid: string, criteria: unknown) =>
  admin.put(`/api/v1/projects/${pid}/quotas/${cid}/mapping`).set(csrf).send({ criteria });
const reserve = (pid: string, cid: string, count: number) =>
  admin.post(`/api/v1/projects/${pid}/quotas/${cid}/reserve`).set(csrf).send({ count });
const caps = (pid: string, c: Record<string, number>, mode = 'proportional') =>
  admin.put(`/api/v1/projects/${pid}/allocation`).set(csrf).send({ mode, caps: c });

beforeAll(async () => {
  h = await startHarness();
  await tenant(h, 'acme');
  await tenant(h, 'other');
  ({ agent: admin } = await signIn(h, 'acme', 'admin@acme.example.invalid'));
  const s = await admin
    .post('/api/v1/sources')
    .set(csrf)
    .send({ kind: 'samptrek', name: 'SampTrek (FIXTURE)', mode: 'fixture', vendorCode: 'S360' });
  sourceId = s.body.id;
  await admin.post(`/api/v1/sources/${sourceId}/sync`).set(csrf).send({ full: true });
  for (const p of (await admin.get('/api/v1/projects')).body.items) ids[p.projectCode] = p.id;
});
afterAll(async () => h?.close());

describe('MADP connection', () => {
  it('needs a connection before any count', async () => {
    const r = await admin.post('/api/v1/audience/counts').set(csrf).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('no_audience_source');
  });
  it('requires LIVE to have a base URL, client id and secret, and seals the secret', async () => {
    const bad = await admin.post('/api/v1/audience/connections').set(csrf).send({ name: 'MADP', mode: 'live' });
    expect(bad.status).toBe(400);
    const secret = 'madp-secret-for-the-test-only-0001';
    const live = await admin.post('/api/v1/audience/connections').set(csrf).send({
      name: 'MADP (LIVE, off)',
      mode: 'live',
      baseUrl: 'http://127.0.0.1:1',
      clientId: 's360-client',
      secret,
    });
    expect(live.status).toBe(201);
    expect(JSON.stringify(live.body)).not.toContain(secret);
    const [row] = await db<{ s: string }>('select secret_sealed s from audience_connections where id = $1', [
      live.body.id,
    ]);
    expect(row!.s).toMatch(/^v1\./);
    expect(row!.s).not.toContain(secret);
    const chk = await admin.post(`/api/v1/audience/connections/${live.body.id}/check`).set(csrf).send({});
    expect(chk.body.lastCheckResult).toMatchObject({ ok: false });
    await admin.patch(`/api/v1/audience/connections/${live.body.id}`).set(csrf).send({ enabled: false });
  });
  it('a FIXTURE connection answers a signed-shape round trip', async () => {
    const id = await madpConnection(admin);
    const chk = await admin.post(`/api/v1/audience/connections/${id}/check`).set(csrf).send({});
    expect(chk.body.lastCheckResult).toMatchObject({ ok: true, dataMode: 'demo' });
  });
});

describe('Audience Finder (gate: overlap is counted once)', () => {
  it('reports unique people, not summed memberships', async () => {
    const r = await admin
      .post('/api/v1/audience/counts')
      .set(csrf)
      .send({ countries: ['US'] });
    expect(r.status).toBe(200);
    const us = fixturePopulation().filter((p) => p.country === 'US');
    expect(r.body.uniquePeople).toBe(us.length);
    expect(r.body.panelMemberships).toBe(us.reduce((a, p) => a + p.memberships.length, 0));
    expect(r.body.panelMemberships).toBeGreaterThan(r.body.uniquePeople);
    expect(r.body.source).toMatchObject({ mode: 'fixture' });
  });
  it('never offers or accepts special-category attributes', async () => {
    const a = await admin.get('/api/v1/audience/attributes');
    expect(a.body.attributes.some((x: { sensitivity: string }) => x.sensitivity === 'special_category')).toBe(false);
    const r = await admin
      .post('/api/v1/audience/counts')
      .set(csrf)
      .send({ attributes: [{ key: 'demographics.ethnicity', values: ['any'] }] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('sensitive_attribute');
    const u = await admin
      .post('/api/v1/audience/counts')
      .set(csrf)
      .send({ attributes: [{ key: 'made.up', values: ['x'] }] });
    expect(u.status).toBe(400);
  });
  it('saves a segment and refuses a duplicate name', async () => {
    const body = {
      name: 'US women',
      criteria: { countries: ['US'], attributes: [{ key: 'demographics.gender', values: ['female'] }] },
    };
    expect((await admin.post('/api/v1/audience/segments').set(csrf).send(body)).status).toBe(201);
    expect((await admin.post('/api/v1/audience/segments').set(csrf).send(body)).status).toBe(409);
    expect((await admin.get('/api/v1/audience/segments')).body.items).toHaveLength(1);
  });
});

describe('quota cells from SampTrek', () => {
  it('imports cells for Supply360 markets only, with a whole-market cell where SampTrek has none', async () => {
    const q = await quotas(admin, ids.PRX10001!);
    expect(q.cells.map((c) => `${c.countryCode} ${c.name}`).sort()).toEqual([
      'GB Whole market',
      'US Female',
      'US Male',
    ]);
    const us = q.cells.find((c) => c.name === 'Female')!;
    // SampTrek's US cell is 400 of 800; Supply360's US target is 400, so its share is 200.
    expect(us.allocation).toBe(200);
    expect(q.checks.find((c) => c.key === 'quota_map')).toMatchObject({ ok: false });
  });
  it('mapping needs exactly one panel', async () => {
    const c = await cellOf('PRX10001', 'US', 'Female');
    expect((await map(ids.PRX10001!, c.id, { panels: ['t2o', 'mfr'] })).status).toBe(400);
    expect((await map(ids.PRX10001!, c.id, {})).status).toBe(400);
  });
  it('a change to the cell conditions at SampTrek clears the mapping', async () => {
    const c = await cellOf('PRX10002', 'DE');
    expect((await map(ids.PRX10002!, c.id, { panels: ['mfr'] })).status).toBe(200);
    expect((await cellOf('PRX10002', 'DE')).criteria).toBeTruthy();
    fixtureCells(sourceId).PRX10002 = {
      DE: [
        {
          id: 'fx-q-de-young',
          group: 'Age',
          name: '18-34',
          conditions: [{ source: 'gate', questionId: 'q_age', min: 18, max: 34 }],
          target: 300,
          completes: 0,
          isOpen: true,
        },
      ],
    };
    await admin.post(`/api/v1/sources/${sourceId}/sync`).set(csrf).send({ full: true });
    const q = await quotas(admin, ids.PRX10002!);
    expect(q.cells.map((x) => x.name)).toEqual(['18-34']);
    expect(q.cells[0]!.criteria).toBeNull();
    const ch = {
      ...fixtureCells(sourceId).PRX10002!.DE![0]!,
      conditions: [{ source: 'gate', questionId: 'q_age', min: 18, max: 29 }],
    };
    expect((await map(ids.PRX10002!, q.cells[0]!.id, { panels: ['mfr'] })).status).toBe(200);
    fixtureCells(sourceId).PRX10002!.DE = [ch];
    await admin.post(`/api/v1/sources/${sourceId}/sync`).set(csrf).send({ full: true });
    expect((await cellOf('PRX10002', 'DE')).criteria).toBeNull();
    const [a] = await db<{ n: string }>("select count(*) n from audit_logs where action = 'quota.mapping_cleared'");
    expect(Number(a!.n)).toBe(1);
  });
});

describe('reservations (gate: concurrent reserves never pass the cap)', () => {
  let female: Cell;
  it('needs a mapping and a cap first', async () => {
    female = await cellOf('PRX10001', 'US', 'Female');
    expect((await reserve(ids.PRX10001!, female.id, 10)).body.code).toBe('cell_unmapped');
    const m = await map(ids.PRX10001!, female.id, {
      panels: ['t2o'],
      attributes: [{ key: 'demographics.gender', values: ['female'] }],
    });
    expect(m.status).toBe(200);
    expect((await reserve(ids.PRX10001!, female.id, 10)).body.code).toBe('no_cap');
  });

  it('ten requests of 30 at once against a cap of 100 hold exactly 100', async () => {
    expect((await caps(ids.PRX10001!, { [female.id]: 100 })).status).toBe(200);
    const rs = await Promise.all(Array.from({ length: 10 }, () => reserve(ids.PRX10001!, female.id, 30)));
    const ok = rs.filter((r) => r.status === 200);
    const held = ok.reduce((a, r) => a + r.body.held, 0);
    expect(held).toBe(100);
    expect(ok.map((r) => r.body.held).sort((a, b) => a - b)).toEqual([10, 30, 30, 30]);
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'cap_reached')).toBe(true);
    const [row] = await db<{ n: string; d: string }>(
      'select count(*) n, count(distinct ref) d from reserved_refs where cell_id = $1',
      [female.id],
    );
    expect(Number(row!.n)).toBe(100);
    expect(Number(row!.d)).toBe(100);
    expect((await cellOf('PRX10001', 'US', 'Female')).held).toBe(100);
  });

  it('never holds one MADP reference twice for a project, even across cells', async () => {
    const male = await cellOf('PRX10001', 'US', 'Male');
    // Deliberately the same criteria as the female cell: the overlap must be skipped, not held twice.
    await map(ids.PRX10001!, male.id, {
      panels: ['t2o'],
      attributes: [{ key: 'demographics.gender', values: ['female'] }],
    });
    await caps(ids.PRX10001!, { [female.id]: 100, [male.id]: 50 });
    const r = await reserve(ids.PRX10001!, male.id, 50);
    expect(r.body.held).toBe(50);
    const [row] = await db<{ n: string; d: string }>(
      'select count(*) n, count(distinct ref) d from reserved_refs where project_id = $1',
      [ids.PRX10001],
    );
    expect(row).toEqual({ n: '150', d: '150' });
  });

  it('refuses a second panel in the same project, since a person may be in both', async () => {
    const gb = await cellOf('PRX10001', 'GB');
    await map(ids.PRX10001!, gb.id, { panels: ['mfr'] });
    await caps(ids.PRX10001!, { [gb.id]: 20 });
    const r = await reserve(ids.PRX10001!, gb.id, 10);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('panel_mixing');
  });

  it('a mapping cannot change while people are held under it', async () => {
    const r = await map(ids.PRX10001!, female.id, { panels: ['t2o'] });
    expect(r.body.code).toBe('release_first');
  });

  it('release frees the hold here and at MADP, and records a snapshot of every selection', async () => {
    const q = (await admin.get(`/api/v1/projects/${ids.PRX10001}/quotas`)).body;
    const r = q.reservations.find((x: { cellId: string; held: number }) => x.cellId === female.id && x.held === 30);
    const rel = await admin
      .post(`/api/v1/projects/${ids.PRX10001}/reservations/${r.id}/release`)
      .set(csrf)
      .send({ reason: 'test release' });
    expect(rel.body).toMatchObject({ status: 'released', released: 30 });
    expect((await cellOf('PRX10001', 'US', 'Female')).held).toBe(70);
    const again = await admin
      .post(`/api/v1/projects/${ids.PRX10001}/reservations/${r.id}/release`)
      .set(csrf)
      .send({ reason: 'twice' });
    expect(again.status).toBe(409);
    expect((await reserve(ids.PRX10001!, female.id, 30)).body.held).toBe(30);
    const sel = await admin.get('/api/v1/audience/selections');
    expect(sel.body.items.length).toBeGreaterThanOrEqual(6);
    expect(sel.body.items[0]).toMatchObject({ projectCode: 'PRX10001', dataMode: 'demo' });
    expect(JSON.stringify(sel.body)).not.toMatch(/ref_[A-Za-z0-9_-]{16}/);
  });

  it('expired holds stop counting against the cap', async () => {
    await db("update reserved_refs set expires_at = now() - interval '1 second' where cell_id = $1", [female.id]);
    await db("update reservations set expires_at = now() - interval '1 second' where cell_id = $1", [female.id]);
    expect((await cellOf('PRX10001', 'US', 'Female')).held).toBe(0);
    expect((await reserve(ids.PRX10001!, female.id, 40)).body.held).toBe(40);
  });

  it('nothing is reserved for a project on hold at the source', async () => {
    const c = await cellOf('PRX10003', 'IN');
    await map(ids.PRX10003!, c.id, { panels: ['t2o'] });
    await caps(ids.PRX10003!, { [c.id]: 10 });
    expect((await reserve(ids.PRX10003!, c.id, 5)).body.code).toBe('project_stopped');
  });
});

describe('permissions and tenants', () => {
  it('a read-only person can look but not map, allocate or reserve', async () => {
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
    const c = await cellOf('PRX10001', 'US', 'Female');
    expect((await agent.get(`/api/v1/projects/${ids.PRX10001}/quotas`)).status).toBe(200);
    expect((await agent.post('/api/v1/audience/counts').set(csrf).send({})).status).toBe(200);
    expect(
      (
        await agent
          .put(`/api/v1/projects/${ids.PRX10001}/quotas/${c.id}/mapping`)
          .set(csrf)
          .send({ criteria: { panels: ['t2o'] } })
      ).status,
    ).toBe(403);
    expect(
      (await agent.put(`/api/v1/projects/${ids.PRX10001}/allocation`).set(csrf).send({ mode: 'equal', caps: {} }))
        .status,
    ).toBe(403);
    expect(
      (await agent.post(`/api/v1/projects/${ids.PRX10001}/quotas/${c.id}/reserve`).set(csrf).send({ count: 1 })).status,
    ).toBe(403);
  });
  it('another tenant sees none of the cells, connections, segments or selections', async () => {
    const { agent } = await signIn(h, 'other', 'admin@other.example.invalid');
    expect((await agent.get(`/api/v1/projects/${ids.PRX10001}/quotas`)).status).toBe(404);
    expect((await agent.get('/api/v1/audience/connections')).body.items).toHaveLength(0);
    expect((await agent.get('/api/v1/audience/segments')).body.items).toHaveLength(0);
    expect((await agent.get('/api/v1/audience/selections')).body.items).toHaveLength(0);
  });
});

describe('launch with audience', () => {
  it('marks ready without audience, but launching needs every cell mapped and holding people', async () => {
    const pid = ids.PRX10001!;
    const d = (await admin.get(`/api/v1/projects/${pid}`)).body;
    for (const m of d.markets)
      await admin
        .put(`/api/v1/projects/${pid}/markets/${m.countryCode}/entry-link`)
        .set(csrf)
        .send({ entryUrl: `https://st.example/s/${m.countryCode}?uid=[UID]` });
    const act = (action: string) =>
      admin.post(`/api/v1/projects/${pid}/lifecycle`).set(csrf).send({ action, reason: 'test' });
    expect((await act('mark_ready')).body.lifecycle).toBe('ready');
    const early = await act('launch');
    expect(early.status).toBe(409);
    // GB was mapped to another panel above; put it on Turn2Opinion and hold people there too.
    const gb = await cellOf('PRX10001', 'GB');
    await map(pid, gb.id, { panels: ['t2o'] });
    expect((await reserve(pid, gb.id, 10)).body.held).toBe(10);
    const checks = (await admin.get(`/api/v1/projects/${pid}`)).body.checks;
    expect(
      checks.filter((c: { key: string; ok: boolean }) => ['quota_map', 'audience'].includes(c.key) && c.ok),
    ).toHaveLength(2);
    expect((await act('launch')).body).toMatchObject({ lifecycle: 'live', dispatchAllowed: true });
  });
});
