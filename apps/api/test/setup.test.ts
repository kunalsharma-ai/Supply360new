import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureCells } from '../src/ingestion/samptrek/fixture.js';
import { madpConnection, quotas } from './audience-setup.js';
import { PASSWORD, signIn, startHarness, tenant, type Harness } from './harness.js';

let h: Harness;
const csrf = { 'x-s360-csrf': '1' };
type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
let admin: Agent;
let pm: Agent;
let sourceId: string;
const ids: Record<string, string> = {};
const POLICY = {
  mode: 'auto',
  batchSize: 25,
  dailyMax: 500,
  reviewIntervalMinutes: 30,
  quietStartHour: 21,
  quietEndHour: 8,
  timezone: 'Asia/Kolkata',
  reminderOffsetsHours: [24, 72],
  allowedPanels: ['t2o'],
  linkValidDays: 10,
  escalateRefusalPercent: 40,
  reason: 'source project policy',
};

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
  ({ agent: admin } = await signIn(h, 'acme', 'admin@acme.example.invalid'));
  expect(
    (
      await admin
        .post('/api/v1/users')
        .set(csrf)
        .send({ email: 'pm@acme.example.invalid', name: 'PM', roles: ['project_manager'], password: PASSWORD })
    ).status,
  ).toBe(201);
  ({ agent: pm } = await signIn(h, 'acme', 'pm@acme.example.invalid'));
  const s = await admin
    .post('/api/v1/sources')
    .set(csrf)
    .send({ kind: 'samptrek', name: 'SampTrek (FIXTURE)', mode: 'fixture', vendorCode: 'S360' });
  sourceId = s.body.id;
  // The wave-2 project has the same gender cells under other SampTrek ids and in other letter case.
  fixtureCells(sourceId).PRX10004 = {
    US: [
      {
        id: 'w2-f',
        group: 'gender',
        name: 'FEMALE',
        conditions: [{ source: 'gate', questionId: 'q_gender', values: ['female'] }],
        target: 150,
        completes: 0,
        isOpen: true,
      },
      {
        id: 'w2-m',
        group: 'gender',
        name: 'male',
        conditions: [{ source: 'gate', questionId: 'q_gender', values: ['male'] }],
        target: 150,
        completes: 0,
        isOpen: true,
      },
    ],
  };
  await admin.post(`/api/v1/sources/${sourceId}/sync`).set(csrf).send({ full: true });
  for (const p of (await admin.get('/api/v1/projects')).body.items) ids[p.projectCode] = p.id;

  // Set up the source project by hand, as a person would.
  await madpConnection(admin);
  const src = ids.PRX10001!;
  const { cells } = await quotas(admin, src);
  for (const c of cells) {
    const gender = c.isMarketCell ? null : c.name.toLowerCase();
    const r = await admin
      .put(`/api/v1/projects/${src}/quotas/${c.id}/mapping`)
      .set(csrf)
      .send({
        criteria: {
          panels: ['t2o'],
          ...(gender ? { attributes: [{ key: 'demographics.gender', values: [gender] }] } : {}),
        },
      });
    expect(r.status).toBe(200);
  }
  expect(
    (
      await admin
        .put(`/api/v1/projects/${src}/allocation`)
        .set(csrf)
        .send({ mode: 'equal', caps: Object.fromEntries(cells.map((c) => [c.id, 120])) })
    ).status,
  ).toBe(200);
  expect((await admin.put(`/api/v1/projects/${src}/execution/policy`).set(csrf).send(POLICY)).status).toBe(200);
});
afterAll(async () => h?.close());

const ALL = ['policy', 'allocation', 'criteria', 'caps', 'qaMode'];

describe('copy a project setup', () => {
  it('previews part by part without changing anything', async () => {
    const r = await admin
      .post(`/api/v1/projects/${ids.PRX10004}/setup/preview`)
      .set(csrf)
      .send({ source: { projectId: ids.PRX10001 }, parts: ALL });
    expect(r.status).toBe(200);
    expect(r.body.from).toBe('project PRX10001');
    const text = r.body.changes.map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('Mode manual (automatic in the source; turn it on yourself)');
    expect(text).toContain('reminders 24 h, 72 h');
    expect(text).toContain('Audience criteria for 2 of 2 cells');
    expect(text).toContain('Invite caps for 2 of 2 cells');
    expect(r.body.missingPermissions).toEqual([]);
    expect((await quotas(admin, ids.PRX10004!)).cells.every((c) => c.criteria === null)).toBe(true);
  });

  it('applies the setup in one step, never switching automatic mode on', async () => {
    const r = await admin
      .post(`/api/v1/projects/${ids.PRX10004}/setup/apply`)
      .set(csrf)
      .send({ source: { projectId: ids.PRX10001 }, parts: ALL, reason: 'Wave 2 runs like wave 1' });
    expect(r.status).toBe(200);
    const { cells } = await quotas(admin, ids.PRX10004!);
    const f = cells.find((c) => c.name === 'FEMALE')!;
    expect(f.criteria).toEqual({ panels: ['t2o'], attributes: [{ key: 'demographics.gender', values: ['female'] }] });
    expect(cells.every((c) => c.inviteCap === 120)).toBe(true);
    expect(cells.map((c) => c.allocation)).toEqual([150, 150]);
    const ex = (await admin.get(`/api/v1/projects/${ids.PRX10004}/execution`)).body;
    expect(ex.policy).toMatchObject({
      mode: 'manual',
      batchSize: 25,
      timezone: 'Asia/Kolkata',
      reminderOffsetsHours: [24, 72],
    });
    const [a] = await db<{ reason: string; details: { from: string } }>(
      "select reason, details from audit_logs where action = 'project.setup_copied'",
    );
    expect(a).toMatchObject({ reason: 'Wave 2 runs like wave 1', details: { from: 'project PRX10001' } });
  });

  it('refuses parts a person may not set by hand, and names the missing permission', async () => {
    const pre = await pm
      .post(`/api/v1/projects/${ids.PRX10004}/setup/preview`)
      .set(csrf)
      .send({ source: { projectId: ids.PRX10001 }, parts: ['policy', 'criteria'] });
    expect(pre.body.missingPermissions).toEqual(['automation.manage', 'quotas.manage']);
    const r = await pm
      .post(`/api/v1/projects/${ids.PRX10004}/setup/apply`)
      .set(csrf)
      .send({ source: { projectId: ids.PRX10001 }, parts: ['policy'], reason: 'try' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('permission_missing');
  });

  it('refuses copying a project onto itself', async () => {
    const r = await admin
      .post(`/api/v1/projects/${ids.PRX10001}/setup/preview`)
      .set(csrf)
      .send({ source: { projectId: ids.PRX10001 }, parts: ['policy'] });
    expect(r.body.code).toBe('same_project');
  });
});

describe('setup templates', () => {
  let tid: string;
  it('saves a project setup under a name, once', async () => {
    const r = await admin
      .post('/api/v1/setup-templates')
      .set(csrf)
      .send({ name: 'US gender split, T2O', description: 'Tracker waves', fromProjectId: ids.PRX10001 });
    expect(r.status).toBe(201);
    tid = r.body.id;
    const list = (await admin.get('/api/v1/setup-templates')).body;
    expect(list[0]).toMatchObject({
      name: 'US gender split, T2O',
      sourceProjectCode: 'PRX10001',
      mode: 'auto',
      mappedCells: 3,
    });
    const again = await admin
      .post('/api/v1/setup-templates')
      .set(csrf)
      .send({ name: 'US gender split, T2O', fromProjectId: ids.PRX10001 });
    expect(again.body.code).toBe('name_taken');
    const empty = await admin
      .post('/api/v1/setup-templates')
      .set(csrf)
      .send({ name: 'Nothing', fromProjectId: ids.PRX10003 });
    expect(empty.body.code).toBe('nothing_to_save');
  });

  it('applies a template and lists cells it could not match', async () => {
    const r = await admin
      .post(`/api/v1/projects/${ids.PRX10002}/setup/apply`)
      .set(csrf)
      .send({ source: { templateId: tid }, parts: ['policy', 'criteria'], reason: 'Same policy for DE' });
    expect(r.status).toBe(200);
    expect(r.body.skipped).toEqual([
      { part: 'criteria', cell: expect.stringContaining('DE'), reason: 'No matching cell in the source' },
    ]);
    expect((await admin.get(`/api/v1/projects/${ids.PRX10002}/execution`)).body.policy).toMatchObject({
      mode: 'manual',
      dailyMax: 500,
    });
  });

  it('removes a template', async () => {
    expect((await pm.delete(`/api/v1/setup-templates/${tid}`).set(csrf)).status).toBe(200);
    expect((await admin.get('/api/v1/setup-templates')).body).toEqual([]);
  });
});
