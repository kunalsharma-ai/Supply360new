import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureOutbox } from '../src/audience/delivery.js';
import { fixtureEvents, fixtureWithdrawConsent } from '../src/audience/madp/fixture.js';
import { madpConnection, prepareAudience, quotas, type Cell } from './audience-setup.js';
import { PASSWORD, signIn, startHarness, tenant, type Harness } from './harness.js';

/**
 * Phase 4 gates: consent withdrawal blocks dispatch; a click cancels reminders, also when both happen at once;
 * mode changes keep every record; semi-automatic approval is enforced; automatic mode obeys the limits and
 * escalates; a missing delivery API pauses safely; nothing is ever sent twice.
 */
let h: Harness;
const csrf = { 'x-s360-csrf': '1' };
type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
let admin: Agent;
let exec: Agent;
let pid: string;
let madp: string;
let cells: Cell[];
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

const db = async <T extends pg.QueryResultRow>(q: string, p: unknown[] = []) => {
  const c = new pg.Client({ connectionString: h.adminUrl });
  await c.connect();
  try {
    return (await c.query<T>(q, p)).rows;
  } finally {
    await c.end();
  }
};
const BASE = {
  mode: 'manual',
  batchSize: 10,
  dailyMax: 10_000,
  reviewIntervalMinutes: 5,
  quietStartHour: 0,
  quietEndHour: 0,
  timezone: 'UTC',
  reminderOffsetsHours: [24, 72],
  allowedPanels: ['t2o'],
  linkValidDays: 7,
  escalateRefusalPercent: 50,
  reason: 'test policy',
};
const policy = (over: Record<string, unknown> = {}, agent = admin) =>
  agent.put(`/api/v1/projects/${pid}/execution/policy`).set(csrf).send({ ...BASE, ...over });
const batch = (cellId: string, size: number, extra: Record<string, unknown> = {}, agent = admin) =>
  agent.post(`/api/v1/projects/${pid}/batches`).set(csrf).send({ cellId, size, reason: 'test batch', ...extra });
const decide = (bid: string, decision: string, agent = admin) =>
  agent.post(`/api/v1/projects/${pid}/batches/${bid}/decision`).set(csrf).send({ decision, reason: 'test decision' });
const send = (bid: string) => admin.post(`/api/v1/projects/${pid}/batches/${bid}/send`).set(csrf).send({});
const tick = () => admin.post('/api/v1/execution/tick').set(csrf).send({});
const view = async () => (await admin.get(`/api/v1/projects/${pid}/execution`)).body;
const tokenOf = (invitationId: string) =>
  fixtureOutbox(madp).get(`inv-${invitationId}`)!.link.split('/').pop()!;
const open = (token: string, ua = BROWSER, method: 'get' | 'head' = 'get') =>
  h.http[method](`/api/v1/i/acme/${token}`).set('user-agent', ua);
const sentInvites = (batchId: string) =>
  db<{ id: string; ref: string }>(
    "select id, ref from invitations where batch_id = $1 and status = 'sent' order by ref",
    [batchId],
  );
/** The next held references the cell would invite, in the order the service picks them. */
const nextRefs = (cellId: string, n: number) =>
  db<{ ref: string }>(
    `select r.ref from reserved_refs r where r.cell_id = $1 and r.expires_at > now()
       and not exists (select 1 from invitations i where i.project_id = r.project_id and i.ref = r.ref)
     order by r.ref limit $2`,
    [cellId, n],
  );

beforeAll(async () => {
  h = await startHarness();
  await tenant(h, 'acme');
  await tenant(h, 'other');
  ({ agent: admin } = await signIn(h, 'acme', 'admin@acme.example.invalid'));
  for (const [email, role] of [
    ['exec@acme.example.invalid', 'supply_executive'],
    ['aiops@acme.example.invalid', 'ai_operations_manager'],
  ])
    expect(
      (await admin.post('/api/v1/users').set(csrf).send({ email, name: role, roles: [role], password: PASSWORD }))
        .status,
    ).toBe(201);
  ({ agent: exec } = await signIn(h, 'acme', 'exec@acme.example.invalid'));
  const s = await admin
    .post('/api/v1/sources')
    .set(csrf)
    .send({ kind: 'samptrek', name: 'SampTrek (FIXTURE)', mode: 'fixture', vendorCode: 'S360' });
  await admin.post(`/api/v1/sources/${s.body.id}/sync`).set(csrf).send({ full: true });
  const p = (await admin.get('/api/v1/projects')).body.items.find(
    (x: { projectCode: string }) => x.projectCode === 'PRX10001',
  );
  pid = p.id;
  const d = (await admin.get(`/api/v1/projects/${pid}`)).body;
  for (const m of d.markets)
    await admin
      .put(`/api/v1/projects/${pid}/markets/${m.countryCode}/entry-link`)
      .set(csrf)
      .send({ entryUrl: `https://st.example/s/${m.countryCode}?uid=[UID]` });
  const act = (action: string) =>
    admin.post(`/api/v1/projects/${pid}/lifecycle`).set(csrf).send({ action, reason: 'test' });
  await act('mark_ready');
  madp = await madpConnection(admin);
  await prepareAudience(admin, pid, 400, 120);
  expect((await act('launch')).body.lifecycle).toBe('live');
  cells = (await quotas(admin, pid)).cells;
});
afterAll(async () => h?.close());

const female = () => cells.find((c) => c.name === 'Female')!;
const male = () => cells.find((c) => c.name === 'Male')!;
const gb = () => cells.find((c) => c.countryCode === 'GB')!;

describe('policy', () => {
  it('a batch needs a policy first', async () => {
    const r = await batch(female().id, 5);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('no_policy');
  });
  it('setting limits needs automation.manage, and automatic mode also needs execution.approve', async () => {
    expect((await policy({}, exec)).status).toBe(403);
    const { agent: aiops } = await signIn(h, 'acme', 'aiops@acme.example.invalid');
    const r = await policy({ mode: 'auto' }, aiops);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('approval_required');
  });
  it('rejects a bad time zone and reminder times that do not increase', async () => {
    expect((await policy({ timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await policy({ reminderOffsetsHours: [48, 24] })).status).toBe(400);
  });
  it('saves a manual policy as version 1', async () => {
    const r = await policy();
    expect(r.status).toBe(200);
    expect(r.body.policy).toMatchObject({ mode: 'manual', version: 1, batchSize: 10 });
  });
  it('a batch larger than the policy allows is refused', async () => {
    expect((await batch(female().id, 11)).body.code).toBe('batch_too_large');
  });
});

describe('manual mode (gate: consent withdrawal blocks dispatch)', () => {
  let first: string;
  it('rechecks consent at MADP right before sending: a withdrawn person is never invited', async () => {
    const [gone] = await nextRefs(female().id, 1);
    fixtureWithdrawConsent(madp, gone!.ref);
    const r = await batch(female().id, 10);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'sent', origin: 'person' });
    expect(r.body.refused).toBeGreaterThanOrEqual(1);
    expect(r.body.sent).toBe(r.body.authorized);
    expect(r.body.sent + r.body.refused).toBe(10);
    first = r.body.id;
    const inv = await db<{ ref: string }>('select ref from invitations where project_id = $1', [pid]);
    expect(inv.map((x) => x.ref)).not.toContain(gone!.ref);
    // Refused people leave the hold, so they never block the next batch.
    expect(await db('select 1 from reserved_refs where ref = $1', [gone!.ref])).toHaveLength(0);
  });
  it('hands each invitation to delivery once, with an opaque link and no personal data', async () => {
    const rows = await sentInvites(first);
    for (const i of rows) {
      const d = fixtureOutbox(madp).get(`inv-${i.id}`)!;
      expect(d.link).toMatch(/\/api\/v1\/i\/acme\/[A-Za-z0-9_-]{44}$/);
      expect(d.link).not.toContain(i.ref);
    }
    const [{ n } = { n: -1 }] = await db<{ n: number }>(
      "select count(*)::int n from reminder_jobs where status = 'pending' and invitation_id = any($1::uuid[])",
      [rows.map((x) => x.id)],
    );
    expect(n).toBe(rows.length * 2);
  });
});

describe('no duplicate dispatch', () => {
  it('five concurrent sends and a scheduler pass of one batch send each person once', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const b = await batch(male().id, 10, { scheduledAt: later });
    expect(b.body.status).toBe('approved');
    const rs = await Promise.all([...Array.from({ length: 5 }, () => send(b.body.id)), tick()]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const inv = await db<{ id: string }>('select id from invitations where batch_id = $1', [b.body.id]);
    const att = await db<{ n: number }>(
      "select count(*)::int n from delivery_attempts where kind = 'invitation' and invitation_id = any($1::uuid[])",
      [inv.map((x) => x.id)],
    );
    expect(att[0]!.n).toBe(inv.length);
    const [final] = await db<{ status: string; sent: number }>('select status, sent from invitation_batches where id = $1', [
      b.body.id,
    ]);
    expect(final).toMatchObject({ status: 'sent', sent: inv.length });
    const dup = await db('select ref from invitations where project_id = $1 group by ref having count(*) > 1', [pid]);
    expect(dup).toHaveLength(0);
  });
});

describe('survey router (gate: a click cancels reminders)', () => {
  let rows: { id: string; ref: string }[];
  beforeAll(async () => {
    const b = (await view()).batches.find((x: { status: string }) => x.status === 'sent');
    rows = await sentInvites(b.id);
  });
  it('a link scanner (HEAD, bot user agent, none) is recorded as prefetch, not a click', async () => {
    const t = tokenOf(rows[0]!.id);
    for (const r of [await open(t, BROWSER, 'head'), await open(t, 'Mozilla/5.0 (compatible; Proofpoint URL Defense)'), await h.http.get(`/api/v1/i/acme/${t}`).unset('user-agent')])
      expect(r.status).toBe(302);
    const [inv] = await db<{ clicked_at: Date | null }>('select clicked_at from invitations where id = $1', [rows[0]!.id]);
    expect(inv!.clicked_at).toBeNull();
    const ev = await db<{ kind: string }>('select kind from router_events where invitation_id = $1', [rows[0]!.id]);
    expect(ev.map((e) => e.kind)).toEqual(['prefetch', 'prefetch', 'prefetch']);
  });
  it('a person clicking goes to the approved entry link with the token as [UID], and reminders stop', async () => {
    const t = tokenOf(rows[0]!.id);
    const r = await open(t);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`https://st.example/s/US?uid=${t}`);
    expect(r.headers['cache-control']).toBe('no-store');
    const jobs = await db<{ status: string; reason: string }>(
      'select status, reason from reminder_jobs where invitation_id = $1',
      [rows[0]!.id],
    );
    expect(jobs.every((j) => j.status === 'cancelled' && j.reason === 'clicked')).toBe(true);
    const again = await open(t);
    expect(again.headers.location).toBe(`https://st.example/s/US?uid=${t}`);
  });
  it('a forged or altered token goes to the invalid page and reveals nothing', async () => {
    const t = tokenOf(rows[1]!.id);
    const altered = t.slice(0, 30) + (t[30] === 'A' ? 'B' : 'A') + t.slice(31);
    for (const x of [altered, 'not-a-token', 'x'.repeat(44)]) {
      const r = await open(x);
      expect(r.headers.location).toMatch(/\/done\/invalid$/);
    }
    expect((await h.http.get(`/api/v1/i/other/${t}`).set('user-agent', BROWSER)).headers.location).toMatch(
      /\/done\/invalid$/,
    );
  });
  it('an expired link goes to the expired page', async () => {
    await db("update invitations set expires_at = now() - interval '1 minute' where id = $1", [rows[2]!.id]);
    expect((await open(tokenOf(rows[2]!.id))).headers.location).toMatch(/\/done\/link-expired$/);
  });
  it('the click reaches MADP through the outbox, once', async () => {
    await tick();
    await tick();
    const [inv] = await db<{ click_reported_at: Date | null }>('select click_reported_at from invitations where id = $1', [
      rows[0]!.id,
    ]);
    expect(inv!.click_reported_at).not.toBeNull();
    expect(fixtureEvents(madp).get(`s360-click-${rows[0]!.id}`)).toBe('click');
  });
  it('a click and a due reminder at the same moment: the reminder never goes after the click', async () => {
    const racers = rows.slice(3, 8);
    await db("update reminder_jobs set due_at = now() - interval '1 second' where attempt = 1 and invitation_id = any($1::uuid[])", [
      racers.map((r) => r.id),
    ]);
    await Promise.all([tick(), ...racers.map((r) => open(tokenOf(r.id)))]);
    const jobs = await db<{ status: string; done_at: Date; clicked_at: Date }>(
      `select j.status, j.done_at, i.clicked_at from reminder_jobs j join invitations i on i.id = j.invitation_id
        where j.invitation_id = any($1::uuid[])`,
      [racers.map((r) => r.id)],
    );
    for (const j of jobs) {
      expect(j.clicked_at).not.toBeNull();
      if (j.status === 'sent') expect(j.done_at.getTime()).toBeLessThanOrEqual(j.clicked_at.getTime());
      else expect(j.status).toBe('cancelled');
    }
    expect(jobs.filter((j) => j.status === 'pending')).toHaveLength(0);
  });
  it('a due reminder for someone who withdrew consent is skipped, and others are sent', async () => {
    const [a, b] = [rows[8]!, rows[9]!];
    fixtureWithdrawConsent(madp, a.ref);
    await db("update reminder_jobs set due_at = now() - interval '1 second' where attempt = 1 and invitation_id = any($1::uuid[])", [
      [a.id, b.id],
    ]);
    await tick();
    const jobs = await db<{ invitation_id: string; status: string; reason: string | null }>(
      'select invitation_id, status, reason from reminder_jobs where attempt = 1 and invitation_id = any($1::uuid[])',
      [[a.id, b.id]],
    );
    expect(jobs.find((j) => j.invitation_id === a.id)).toMatchObject({ status: 'skipped', reason: 'no_consent' });
    expect(jobs.find((j) => j.invitation_id === b.id)).toMatchObject({ status: 'sent' });
    expect(fixtureOutbox(madp).has(`rem-${b.id}-1`)).toBe(true);
    expect(fixtureOutbox(madp).has(`rem-${a.id}-1`)).toBe(false);
  });
});

describe('checks at send time', () => {
  it('the emergency stop holds every batch and reminder until lifted', async () => {
    expect((await exec.put('/api/v1/execution/kill-switch').set(csrf).send({ halted: true, reason: 'drill' })).status).toBe(403);
    await admin.put('/api/v1/execution/kill-switch').set(csrf).send({ halted: true, reason: 'drill' });
    const b = await batch(gb().id, 5);
    expect(b.body).toMatchObject({ status: 'approved', sent: 0, blockedReason: 'halted' });
    await admin.put('/api/v1/execution/kill-switch').set(csrf).send({ halted: false, reason: 'drill over' });
    expect((await send(b.body.id)).body).toMatchObject({ status: 'sent', blockedReason: null });
  });
  it('quiet hours hold a batch', async () => {
    const hour = new Date().getUTCHours();
    await policy({ quietStartHour: hour, quietEndHour: (hour + 1) % 24 });
    const b = await batch(gb().id, 5);
    expect(b.body).toMatchObject({ status: 'approved', sent: 0, blockedReason: 'quiet_hours' });
    await policy();
    expect((await send(b.body.id)).body.status).toBe('sent');
  });
  it('the daily maximum holds a batch', async () => {
    const today = (await view()).today.sent;
    await policy({ dailyMax: today });
    expect((await batch(gb().id, 5)).body).toMatchObject({ status: 'approved', blockedReason: 'daily_cap' });
    await policy();
  });
  it('a pause at the source holds batches, and links go to the closed page', async () => {
    await db("update projects set lifecycle = 'source_hold' where id = $1", [pid]);
    const b = await batch(female().id, 5);
    expect(b.body).toMatchObject({ status: 'approved', blockedReason: 'project_not_live' });
    const [one] = await db<{ id: string }>("select id from invitations where project_id = $1 and status = 'sent' and country_code = 'US' limit 1", [pid]);
    expect((await open(tokenOf(one!.id))).headers.location).toMatch(/\/done\/closed$/);
    await db("update projects set lifecycle = 'live' where id = $1", [pid]);
    expect((await send(b.body.id)).body.status).toBe('sent');
  });
});

describe('semi-automatic mode (gate: approval is enforced)', () => {
  it('a batch from someone without execution.approve waits as proposed, and only an approver can approve it', async () => {
    await policy({ mode: 'semi_auto' });
    const b = await batch(female().id, 5, {}, exec);
    expect(b.body.status).toBe('proposed');
    expect(b.body.sent).toBe(0);
    expect((await decide(b.body.id, 'approve', exec)).status).toBe(403);
    expect((await send(b.body.id)).status).toBe(409);
    const ok = await decide(b.body.id, 'approve');
    expect(ok.body).toMatchObject({ status: 'sent' });
  });
  it('the planner proposes one batch per open cell and asks a person', async () => {
    await db('update execution_policies set last_review_at = null where project_id = $1', [pid]);
    const r = await tick();
    expect(r.body.planned).toBeGreaterThan(0);
    const v = await view();
    const proposed = v.batches.filter((b: { status: string; origin: string }) => b.status === 'proposed' && b.origin === 'system');
    expect(proposed.length).toBe(r.body.planned);
    expect(proposed.every((b: { sent: number }) => b.sent === 0)).toBe(true);
    const n = (await admin.get('/api/v1/notifications')).body.items;
    expect(n.some((x: { kind: string }) => x.kind === 'execution.approval_needed')).toBe(true);
    const o = (await admin.get('/api/v1/execution/overview')).body;
    expect(o.approvals.length).toBe(proposed.length);
  });
  it('changing mode cancels what the system proposed and keeps every invitation and batch', async () => {
    const before = await db<{ n: number }>('select count(*)::int n from invitations where project_id = $1', [pid]);
    const batches = await db<{ n: number }>('select count(*)::int n from invitation_batches where project_id = $1', [pid]);
    const r = await policy({ mode: 'manual' });
    expect(r.body.cancelledSystemBatches).toBeGreaterThan(0);
    expect(r.body.policy.version).toBeGreaterThan(1);
    expect((await db<{ n: number }>('select count(*)::int n from invitations where project_id = $1', [pid]))[0]).toEqual(before[0]);
    expect((await db<{ n: number }>('select count(*)::int n from invitation_batches where project_id = $1', [pid]))[0]).toEqual(batches[0]);
    const audit = await db("select 1 from audit_logs where action = 'execution.mode_changed' and target_id = $1", [pid]);
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe('automatic mode (gate: obeys the limits and escalates)', () => {
  it('sends within the daily maximum and stops there', async () => {
    const today = (await view()).today.sent;
    await policy({ mode: 'auto', dailyMax: today + 7, escalateRefusalPercent: 100 });
    await tick();
    await db('update execution_policies set last_review_at = null where project_id = $1', [pid]);
    await tick();
    const v = await view();
    expect(v.today.sent).toBeLessThanOrEqual(today + 7);
    expect(v.today.sent).toBeGreaterThan(today);
    const auto = v.batches.filter((b: { origin: string; mode: string }) => b.origin === 'system' && b.mode === 'auto');
    expect(auto.length).toBeGreaterThan(0);
    expect(auto.every((b: { approvedAt: string | null }) => b.approvedAt)).toBe(true);
  });
  it('escalates to a person and proposes nothing more when too many are refused', async () => {
    await policy({ mode: 'auto', escalateRefusalPercent: 10 });
    for (const c of [female(), male(), gb()]) for (const r of await nextRefs(c.id, 5)) fixtureWithdrawConsent(madp, r.ref);
    await tick();
    let v = await view();
    expect(v.policy.escalatedAt).not.toBeNull();
    expect(v.policy.escalationReason).toBe('high_refusal');
    const n = (await admin.get('/api/v1/notifications')).body.items;
    expect(n.some((x: { kind: string }) => x.kind === 'execution.escalated')).toBe(true);
    const count = v.batches.length;
    await db('update execution_policies set last_review_at = null where project_id = $1', [pid]);
    await tick();
    v = await view();
    expect(v.batches.length).toBe(count);
    await policy();
    expect((await view()).policy.escalatedAt).toBeNull();
  });
});

describe('missing delivery API (gate: pauses safely)', () => {
  it('with LIVE MADP, which has no send endpoint yet, a batch stops as blocked and nothing is sent', async () => {
    const live = await admin.post('/api/v1/audience/connections').set(csrf).send({
      name: 'MADP (LIVE)',
      mode: 'live',
      baseUrl: 'http://127.0.0.1:1',
      clientId: 's360-client',
      secret: 'madp-secret-for-the-test-only-0001',
    });
    const before = fixtureOutbox(madp).size;
    const b = await batch(male().id, 5);
    expect(b.body).toMatchObject({ status: 'blocked', blockedReason: 'delivery_unavailable', sent: 0 });
    expect(fixtureOutbox(madp).size).toBe(before);
    const [att] = await db<{ status: string }>(
      "select a.status from delivery_attempts a join invitations i on i.id = a.invitation_id where i.batch_id = $1",
      [b.body.id],
    );
    expect(att!.status).toBe('unavailable');
    const n = (await admin.get('/api/v1/notifications')).body.items;
    expect(n.some((x: { kind: string }) => x.kind === 'execution.batch_blocked')).toBe(true);
    await admin.patch(`/api/v1/audience/connections/${live.body.id}`).set(csrf).send({ enabled: false });
  });
});

describe('tenant isolation', () => {
  it('another tenant sees no policy, batch, reminder or router event', async () => {
    const { agent } = await signIn(h, 'other', 'admin@other.example.invalid');
    expect((await agent.get(`/api/v1/projects/${pid}/execution`)).status).toBe(404);
    expect((await agent.get('/api/v1/execution/batches')).body.items).toHaveLength(0);
    expect((await agent.get('/api/v1/execution/reminders')).body.items).toHaveLength(0);
    // The forged link opened under this tenant's address earlier is its own record, with no project.
    const ev = (await agent.get('/api/v1/execution/router-events')).body.items;
    expect(ev.every((e: { kind: string; projectCode: string | null }) => e.kind === 'invalid' && !e.projectCode)).toBe(true);
    expect((await agent.get('/api/v1/execution/overview')).body.projects).toHaveLength(0);
  });
});
