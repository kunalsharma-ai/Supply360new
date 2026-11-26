import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { madpConnection, prepareAudience, quotas, type Cell } from './audience-setup.js';
import { PASSWORD, signIn, startHarness, tenant, type Harness } from './harness.js';

/**
 * Phase 7: delivery forecasts from observed rates (or labelled assumptions), audience performance, the Copilot's typed
 * queries and approvals, and asynchronous exports with expiry and access control.
 */
let h: Harness;
const csrf = { 'x-s360-csrf': '1' };
type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
let admin: Agent;
let exec: Agent;
let pm: Agent;
let qa: Agent;
let other: Agent;
let pid: string;
let cells: Cell[];

const db = async <T extends pg.QueryResultRow>(q: string, p: unknown[] = []) => {
  const c = new pg.Client({ connectionString: h.adminUrl });
  await c.connect();
  try {
    return (await c.query<T>(q, p)).rows;
  } finally {
    await c.end();
  }
};
const forecast = async () => (await admin.get(`/api/v1/projects/${pid}/forecast`)).body;
const ask = (prompt: string, agent = admin) => agent.post('/api/v1/copilot/ask').set(csrf).send({ prompt });
const exportReady = async (agent: Agent, id: string) => {
  for (let i = 0; i < 50; i++) {
    const r = (await agent.get(`/api/v1/reports/exports/${id}`)).body;
    if (r.status !== 'queued' && r.status !== 'building') return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('export never finished');
};

beforeAll(async () => {
  h = await startHarness();
  await tenant(h, 'acme');
  await tenant(h, 'other');
  ({ agent: admin } = await signIn(h, 'acme', 'admin@acme.example.invalid'));
  ({ agent: other } = await signIn(h, 'other', 'admin@other.example.invalid'));
  for (const [email, role] of [
    ['exec@acme.example.invalid', 'supply_executive'],
    ['pm@acme.example.invalid', 'project_manager'],
    ['qa@acme.example.invalid', 'quality_analyst'],
  ])
    expect(
      (
        await admin
          .post('/api/v1/users')
          .set(csrf)
          .send({ email, name: role, roles: [role], password: PASSWORD })
      ).status,
    ).toBe(201);
  ({ agent: exec } = await signIn(h, 'acme', 'exec@acme.example.invalid'));
  ({ agent: pm } = await signIn(h, 'acme', 'pm@acme.example.invalid'));
  ({ agent: qa } = await signIn(h, 'acme', 'qa@acme.example.invalid'));
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
  await prepareAudience(admin, pid, 400, 200);
  expect((await act('launch')).body.lifecycle).toBe('live');
  cells = (await quotas(admin, pid)).cells;
  await admin
    .put(`/api/v1/projects/${pid}/execution/policy`)
    .set(csrf)
    .send({
      mode: 'manual',
      batchSize: 100,
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
  // Ten days of field time, half gone.
  await db(
    "update projects set field_start_at = now() - interval '5 days', field_end_at = now() + interval '5 days' where id = $1",
    [pid],
  );
});
afterAll(async () => h?.close());

describe('delivery forecast', () => {
  it('on a cold start uses labelled values and never calls them data', async () => {
    const f = await forecast();
    expect(f.modelVersion).toBe('delivery-forecast-v1');
    expect(f.rates.start.basis).toBe('assumption');
    expect(f.assumptionsUsed.length).toBeGreaterThanOrEqual(2);
    expect(f.risk).toBe('not_enough_data');
    expect(f.sampleSizes.sent).toBe(0);
  });
  it('assumptions need settings.manage and a reason, and are audited', async () => {
    const body = {
      startRatePercent: 12,
      qualificationRatePercent: 40,
      qualifiedToCompletePercent: 90,
      reason: 'panel history',
    };
    expect((await exec.put('/api/v1/intelligence/assumptions').set(csrf).send(body)).status).toBe(403);
    expect(
      (
        await admin
          .put('/api/v1/intelligence/assumptions')
          .set(csrf)
          .send({ ...body, reason: '' })
      ).status,
    ).toBe(400);
    expect((await admin.put('/api/v1/intelligence/assumptions').set(csrf).send(body)).body).toMatchObject({
      configured: true,
      version: 1,
    });
    expect((await forecast()).rates.start.value).toBeCloseTo(0.12);
    const [a] = await db<{ reason: string }>(
      "select reason from audit_logs where action = 'forecast.assumptions_changed'",
    );
    expect(a!.reason).toBe('panel history');
  });
  it('switches to observed rates once there is enough data, each with its denominator', async () => {
    for (const c of cells.slice(0, 2)) {
      const b = await admin
        .post(`/api/v1/projects/${pid}/batches`)
        .set(csrf)
        .send({ cellId: c.id, size: 75, reason: 'test batch' });
      expect(b.body.status).toBe('sent');
    }
    const ids = (
      await db<{ id: string }>("select id from invitations where project_id = $1 and status = 'sent' order by id", [
        pid,
      ])
    ).map((r) => r.id);
    expect(ids.length).toBe(150);
    await db("update invitations set sent_at = now() - interval '3 days' where project_id = $1", [pid]);
    const set = (from: number, to: number, outcome: string) =>
      db(
        `update invitations set started_at = now() - interval '2 days', outcome = $2, outcome_at = now() - interval '1 day',
           loi_seconds = case when $2 = 'complete' then 600 else null end where id = any($1::uuid[])`,
        [ids.slice(from, to), outcome],
      );
    await set(0, 15, 'complete');
    await set(15, 35, 'terminate');
    await set(35, 40, 'quality_fail');
    await db("update invitations set approval = 'approved' where id = any($1::uuid[])", [ids.slice(0, 10)]);
    const f = await forecast();
    expect(f.assumptionsUsed).toEqual([]);
    expect(f.rates.start).toMatchObject({ basis: 'observed', numerator: 40, denominator: 150 });
    expect(f.rates.qualification).toMatchObject({ numerator: 20, denominator: 40 });
    expect(f.rates.qualifiedToComplete).toMatchObject({ numerator: 15, denominator: 20 });
    const cpi = (40 / 150) * (20 / 40) * (15 / 20);
    expect(f.completesPerInvite.value).toBeCloseTo(cpi);
    expect(f.remaining.provisional).toBe(f.target - 15);
    expect(f.remaining.approved).toBe(f.target - 10);
    expect(f.invitationsNeeded.value).toBe(Math.ceil((f.target - 15) / cpi));
    expect(f.invitationsNeeded.low).toBeLessThan(f.invitationsNeeded.value);
    expect(['at_risk', 'off_track', 'on_track']).toContain(f.risk);
    expect(f.recommendation.size).toBeLessThanOrEqual(100);
  });
  it('the portfolio lists active projects, riskiest first', async () => {
    const r = (await admin.get('/api/v1/intelligence/delivery')).body;
    expect(r.items.find((x: { id: string }) => x.id === pid)).toBeTruthy();
  });
  it('the scheduler keeps one snapshot an hour and notifies on a change of risk', async () => {
    expect((await admin.post('/api/v1/intelligence/tick').set(csrf).send({})).body.written).toBeGreaterThanOrEqual(1);
    expect((await admin.post('/api/v1/intelligence/tick').set(csrf).send({})).body.written).toBe(0);
    const [snap] = await db<{ model_version: string }>(
      'select model_version from delivery_predictions where project_id = $1',
      [pid],
    );
    expect(snap!.model_version).toBe('delivery-forecast-v1');
    const n = await db<{ kind: string }>(
      "select kind from notifications where kind in ('low_delivery','quota_risk','target_achieved')",
    );
    expect(n.length).toBe((await forecast()).risk === 'on_track' ? 0 : 1);
    expect((await forecast()).history.length).toBe(1);
  });
  it('the app cannot change or delete a snapshot', async () => {
    const c = new pg.Client({ connectionString: h.adminUrl });
    await c.connect();
    try {
      await c.query('set role s360_app');
      await expect(c.query('delete from delivery_predictions')).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });
});

describe('audience intelligence', () => {
  it('reports each panel and country with denominators and marks thin samples', async () => {
    const r = (await admin.get('/api/v1/intelligence/audience?days=30')).body;
    const t2o = r.panels.find((p: { key: string }) => p.key === 't2o');
    expect(t2o).toMatchObject({
      sent: 150,
      started: 40,
      complete: 15,
      terminate: 20,
      startRate: 26.7,
      incidence: 42.9,
      enoughData: true,
    });
    expect(r.segments.length).toBeGreaterThan(0);
    expect((await admin.get('/api/v1/intelligence/audience?days=0')).status).toBe(400);
  });
});

describe('reports', () => {
  let csvId: string;
  it('builds a CSV in the background and lets only its owner download it', async () => {
    const r = await pm
      .post('/api/v1/reports/exports')
      .set(csrf)
      .send({ kind: 'participation', format: 'csv', projectId: pid, timezone: 'Asia/Kolkata' });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('queued');
    csvId = r.body.id;
    expect(await exportReady(pm, csvId)).toMatchObject({ status: 'ready', rows: 150 });
    const d = await pm.get(`/api/v1/reports/exports/${csvId}/download`).buffer(true);
    expect(d.headers['content-type']).toContain('text/csv');
    expect(d.headers['content-disposition']).toMatch(/participation-PRX10001-.*\.csv/);
    expect(d.text.split('\r\n')[0]).toContain('invitation_id,project,country,panel');
    expect((await admin.get(`/api/v1/reports/exports/${csvId}/download`)).status).toBe(404);
    expect((await other.get(`/api/v1/reports/exports/${csvId}`)).status).toBe(404);
  });
  it('builds Excel and JSON', async () => {
    const x = await pm
      .post('/api/v1/reports/exports')
      .set(csrf)
      .send({ kind: 'quotas', format: 'xlsx', projectId: pid });
    await exportReady(pm, x.body.id);
    const d = await pm
      .get(`/api/v1/reports/exports/${x.body.id}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect((d.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const j = await pm
      .post('/api/v1/reports/exports')
      .set(csrf)
      .send({ kind: 'ir_loi', format: 'json', projectId: pid });
    await exportReady(pm, j.body.id);
    const body = JSON.parse((await pm.get(`/api/v1/reports/exports/${j.body.id}/download`).buffer(true)).text);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.notice).toContain('Incidence');
  });
  it('needs reports.export, and audit.read for the audit report', async () => {
    expect((await exec.post('/api/v1/reports/exports').set(csrf).send({ kind: 'quotas', format: 'csv' })).status).toBe(
      403,
    );
    expect((await pm.post('/api/v1/reports/exports').set(csrf).send({ kind: 'audit', format: 'csv' })).status).toBe(
      403,
    );
    expect(
      (
        await pm
          .post('/api/v1/reports/exports')
          .set(csrf)
          .send({ kind: 'quotas', format: 'csv', timezone: 'Mars/Olympus' })
      ).status,
    ).toBe(400);
    expect(
      (await pm.post('/api/v1/reports/exports').set(csrf).send({ kind: 'project_summary', format: 'csv' })).status,
    ).toBe(400);
  });
  it('labels the synthetic QA report and keeps it apart', async () => {
    await admin.put('/api/v1/sampintel/connection').set(csrf).send({ mode: 'fixture', enabled: true });
    await admin.put(`/api/v1/projects/${pid}/qa-mode`).set(csrf).send({ mode: 'both_separate', reason: 'test' });
    const r = await pm
      .post('/api/v1/reports/exports')
      .set(csrf)
      .send({ kind: 'synthetic_qa', format: 'csv', projectId: pid });
    const done = await exportReady(pm, r.body.id);
    expect(done.fileName).toMatch(/^SYNTHETIC-QA-synthetic_qa-PRX10001/);
    const text = (await pm.get(`/api/v1/reports/exports/${r.body.id}/download`).buffer(true)).text;
    expect(text).toContain('Never counted in human quotas');
    expect(text).toContain('synthetic_qa');
  });
  it('expires: the file is removed and the link stops working', async () => {
    await db("update report_exports set expires_at = now() - interval '1 minute' where id = $1", [csvId]);
    expect((await pm.get(`/api/v1/reports/exports/${csvId}/download`)).status).toBe(410);
    expect((await admin.post('/api/v1/reports/tick').set(csrf).send({})).body.expired).toBeGreaterThanOrEqual(1);
    const [row] = await db<{ status: string; content: Buffer | null }>(
      'select status, content from report_exports where id = $1',
      [csvId],
    );
    expect(row).toEqual({ status: 'expired', content: null });
    expect(
      (await pm.get('/api/v1/reports/exports')).body.items.find((x: { id: string }) => x.id === csvId).status,
    ).toBe('expired');
  });
});

describe('copilot', () => {
  it('turns an audience question into a typed count', async () => {
    const r = (await ask('How many women in the UK are on Turn2Opinion?')).body;
    expect(r).toMatchObject({ intent: 'audience_count', status: 'answered', modelVersion: 'copilot-rules-v1' });
    expect(r.query.audience).toEqual({
      countries: ['GB'],
      panels: ['t2o'],
      attributes: [{ key: 'demographics.gender', values: ['female'] }],
    });
    expect(r.answer.text).toMatch(/unique people match/);
    expect(r.answer.data.counts.uniquePeople).toBeGreaterThan(0);
  });
  it('refuses SQL, commands and fabricated data, and records the refusal', async () => {
    for (const q of ['SELECT * FROM invitations', 'fabricate 20 completes', 'credit points to wallets']) {
      const r = (await ask(q)).body;
      expect(r.status).toBe('refused');
    }
    const rows = await db<{ n: string }>("select count(*) n from copilot_interactions where status = 'refused'");
    expect(Number(rows[0]!.n)).toBe(3);
  });
  it('checks the permission behind each question', async () => {
    expect((await ask('export the quotas report', exec)).body.status).toBe('refused');
    expect((await qa.post('/api/v1/copilot/ask').set(csrf).send({ prompt: 'which projects are at risk' })).status).toBe(
      403,
    );
  });
  it('answers risk and remaining quota from the same services as the screens', async () => {
    expect((await ask('Is PRX10001 at risk?')).body.answer.text).toMatch(/^PRX10001 is /);
    expect((await ask('remaining quota for PRX10001')).body.intent).toBe('remaining_quota');
    expect((await ask('preview reminders for PRX10001')).body.answer.text).toMatch(/reminder/);
  });
  it('proposes a batch; it runs only when someone who may dispatch approves it', async () => {
    const r = (await ask('Recommend the next batch for PRX10001')).body;
    expect(r.status).toBe('proposed');
    expect(r.action).toMatchObject({ type: 'create_batch', projectId: pid });
    const before = await db<{ n: string }>('select count(*) n from invitation_batches where project_id = $1', [pid]);
    const pmTry = await pm
      .post(`/api/v1/copilot/${r.id}/decision`)
      .set(csrf)
      .send({ decision: 'approve', reason: 'go ahead' });
    expect(pmTry.status).toBe(403); // a project manager may not dispatch
    const ok = await admin
      .post(`/api/v1/copilot/${r.id}/decision`)
      .set(csrf)
      .send({ decision: 'approve', reason: 'looks right' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect(ok.body.batch.size).toBe(r.action.size);
    const after = await db<{ n: string }>('select count(*) n from invitation_batches where project_id = $1', [pid]);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n) + 1);
    expect(
      (await admin.post(`/api/v1/copilot/${r.id}/decision`).set(csrf).send({ decision: 'approve', reason: 'again' }))
        .status,
    ).toBe(409);
  });
  it('queues an export when asked', async () => {
    const r = (await ask('Export the IR and LOI report for PRX10001 as Excel', pm)).body;
    expect(r).toMatchObject({ intent: 'report', status: 'answered' });
    expect((await exportReady(pm, r.answer.data.exportId)).status).toBe('ready');
  });
  it('another tenant sees none of it', async () => {
    expect((await other.get('/api/v1/copilot')).body.items).toEqual([]);
    expect((await other.get(`/api/v1/projects/${pid}/forecast`)).status).toBe(404);
    expect((await other.get('/api/v1/reports/exports')).body.items).toEqual([]);
  });
});
