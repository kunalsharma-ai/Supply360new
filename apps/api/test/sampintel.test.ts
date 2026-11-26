import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { madpConnection, prepareAudience, quotas, type Cell } from './audience-setup.js';
import { PASSWORD, signIn, startHarness, tenant, type Harness } from './harness.js';

/**
 * Module 26: the SampIntel AI link. The token is sealed and never shown again, synthetic QA is read only and
 * shown apart from human sample, a synthetic-QA-only project sends no human invitations, and tenants stay apart.
 */
let h: Harness;
const csrf = { 'x-s360-csrf': '1' };
type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
let admin: Agent;
let exec: Agent;
let other: Agent;
let pid: string;
let cells: Cell[];
const TOKEN =
  'sik.01936b1e-0000-7000-8000-000000000001.01936b1e-0000-7000-8000-000000000002.abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456';

const db = async <T extends pg.QueryResultRow>(q: string, p: unknown[] = []) => {
  const c = new pg.Client({ connectionString: h.adminUrl });
  await c.connect();
  try {
    return (await c.query<T>(q, p)).rows;
  } finally {
    await c.end();
  }
};
const mode = (m: string, agent = admin) =>
  agent.put(`/api/v1/projects/${pid}/qa-mode`).set(csrf).send({ mode: m, reason: 'test qa mode' });

beforeAll(async () => {
  h = await startHarness();
  await tenant(h, 'acme');
  await tenant(h, 'other');
  ({ agent: admin } = await signIn(h, 'acme', 'admin@acme.example.invalid'));
  ({ agent: other } = await signIn(h, 'other', 'admin@other.example.invalid'));
  expect(
    (
      await admin
        .post('/api/v1/users')
        .set(csrf)
        .send({ email: 'exec@acme.example.invalid', name: 'exec', roles: ['supply_executive'], password: PASSWORD })
    ).status,
  ).toBe(201);
  ({ agent: exec } = await signIn(h, 'acme', 'exec@acme.example.invalid'));
  const s = await admin
    .post('/api/v1/sources')
    .set(csrf)
    .send({ kind: 'samptrek', name: 'SampTrek (FIXTURE)', mode: 'fixture', vendorCode: 'S360' });
  await admin.post(`/api/v1/sources/${s.body.id}/sync`).set(csrf).send({ full: true });
  pid = (await admin.get('/api/v1/projects')).body.items.find(
    (x: { projectCode: string }) => x.projectCode === 'PRX10001',
  ).id;
  const d = (await admin.get(`/api/v1/projects/${pid}`)).body;
  for (const m of d.markets)
    await admin
      .put(`/api/v1/projects/${pid}/markets/${m.countryCode}/entry-link`)
      .set(csrf)
      .send({ entryUrl: `https://st.example/s/${m.countryCode}?uid=[UID]` });
  const act = (action: string) =>
    admin.post(`/api/v1/projects/${pid}/lifecycle`).set(csrf).send({ action, reason: 'test' });
  await act('mark_ready');
  await madpConnection(admin);
  await prepareAudience(admin, pid, 200, 40);
  expect((await act('launch')).body.lifecycle).toBe('live');
  cells = (await quotas(admin, pid)).cells;
});
afterAll(async () => h?.close());

describe('connection', () => {
  it('starts empty, and a project starts as human only', async () => {
    expect((await admin.get('/api/v1/sampintel/connection')).body).toEqual({ connection: null });
    expect((await admin.get(`/api/v1/projects/${pid}`)).body.qaMode).toBe('human_only');
  });
  it('managing the link needs sampintel.manage', async () => {
    const r = await exec.put('/api/v1/sampintel/connection').set(csrf).send({ mode: 'fixture', enabled: true });
    expect(r.status).toBe(403);
  });
  it('live mode needs HTTPS and a token', async () => {
    const plain = await admin
      .put('/api/v1/sampintel/connection')
      .set(csrf)
      .send({ mode: 'live', baseUrl: 'http://sampintel.example.invalid', enabled: true });
    expect(plain.status).toBe(400);
    const noToken = await admin
      .put('/api/v1/sampintel/connection')
      .set(csrf)
      .send({ mode: 'live', baseUrl: 'https://sampintel.example.invalid', enabled: true });
    expect(noToken.status).toBe(400);
  });
  it('seals the token and never returns it', async () => {
    const r = await admin
      .put('/api/v1/sampintel/connection')
      .set(csrf)
      .send({ mode: 'live', baseUrl: 'https://sampintel.example.invalid/', token: TOKEN, enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'live', baseUrl: 'https://sampintel.example.invalid', hasToken: true });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    const [row] = await db<{ token_sealed: string }>('select token_sealed from sampintel_connections');
    expect(row!.token_sealed).not.toContain(TOKEN);
    const audit = await db<{ details: unknown }>(
      "select details from audit_logs where action = 'sampintel.connection_saved' order by at desc limit 1",
    );
    expect(JSON.stringify(audit[0]!.details)).not.toContain(TOKEN);
  });
  it('the FIXTURE check answers ok without leaving the box', async () => {
    await admin.put('/api/v1/sampintel/connection').set(csrf).send({ mode: 'fixture', enabled: true });
    const r = await admin.post('/api/v1/sampintel/connection/check').set(csrf).send({});
    expect(r.body).toEqual({ status: 'ok' });
    expect((await admin.get('/api/v1/sampintel/connection')).body.connection).toMatchObject({
      mode: 'fixture',
      lastStatus: 'ok',
    });
  });
});

describe('per-project QA mode', () => {
  it('a human-only project never asks SampIntel', async () => {
    const r = await admin.get(`/api/v1/projects/${pid}/synthetic-qa`);
    expect(r.body).toEqual({ qaMode: 'human_only', connection: null, summary: null, error: null });
  });
  it('changing the mode needs sampintel.manage and a reason, and is audited', async () => {
    expect((await mode('both_separate', exec)).status).toBe(403);
    expect((await admin.put(`/api/v1/projects/${pid}/qa-mode`).set(csrf).send({ mode: 'both_separate' })).status).toBe(
      400,
    );
    expect((await mode('both_separate')).body).toEqual({ id: pid, qaMode: 'both_separate' });
    const [a] = await db<{ details: { before: string; after: string } }>(
      "select details from audit_logs where action = 'project.qa_mode' order by at desc limit 1",
    );
    expect(a!.details).toEqual({ before: 'human_only', after: 'both_separate' });
  });
  it('both, kept separate: the synthetic card is labelled and is not counted with human sample', async () => {
    const r = await admin.get(`/api/v1/projects/${pid}/synthetic-qa`);
    expect(r.body).toMatchObject({ qaMode: 'both_separate', connection: 'fixture', error: null });
    expect(r.body.summary.classification).toBe('synthetic_qa');
    expect(r.body.summary.projectRef).toBe('PRX10001');
    const before = await db<{ n: string }>('select count(*) n from invitations where project_id = $1', [pid]);
    expect(Number(before[0]!.n)).toBe(0);
  });
  it('synthetic QA only: no human invitation is sent', async () => {
    await admin
      .put(`/api/v1/projects/${pid}/execution/policy`)
      .set(csrf)
      .send({
        mode: 'manual',
        batchSize: 10,
        dailyMax: 10_000,
        reviewIntervalMinutes: 5,
        quietStartHour: 0,
        quietEndHour: 0,
        timezone: 'UTC',
        reminderOffsetsHours: [24],
        allowedPanels: ['t2o'],
        linkValidDays: 7,
        escalateRefusalPercent: 50,
        reason: 'test policy',
      });
    await mode('synthetic_qa_only');
    const b = await admin
      .post(`/api/v1/projects/${pid}/batches`)
      .set(csrf)
      .send({ cellId: cells[0]!.id, size: 5, reason: 'test batch' });
    expect(b.body).toMatchObject({ status: 'blocked', sent: 0, blockedReason: 'qa_mode_synthetic_only' });
    expect(b.body.blockedText).toContain('synthetic QA only');
    const sent = await db<{ n: string }>(
      "select count(*) n from invitations where project_id = $1 and status = 'sent'",
      [pid],
    );
    expect(Number(sent[0]!.n)).toBe(0);
    await mode('both_separate');
    const again = await admin
      .post(`/api/v1/projects/${pid}/batches`)
      .set(csrf)
      .send({ cellId: cells[0]!.id, size: 5, reason: 'test batch' });
    expect(again.body).toMatchObject({ status: 'sent', blockedReason: null });
  });
  it('a broken link shows an error on the card, never made-up numbers', async () => {
    await admin
      .put('/api/v1/sampintel/connection')
      .set(csrf)
      .send({ mode: 'live', baseUrl: 'https://sampintel.example.invalid', token: TOKEN, enabled: true });
    const r = await admin.get(`/api/v1/projects/${pid}/synthetic-qa`);
    expect(r.body.summary).toBeNull();
    expect(r.body.error).toBeTruthy();
  });
});

describe('tenant isolation', () => {
  it('another tenant sees no connection and cannot touch the project', async () => {
    expect((await other.get('/api/v1/sampintel/connection')).body).toEqual({ connection: null });
    expect((await other.get(`/api/v1/projects/${pid}/synthetic-qa`)).status).toBe(404);
    expect((await mode('human_only', other)).status).toBe(404);
    expect((await other.get('/api/v1/sampintel/projects')).body).toEqual([]);
  });
});
