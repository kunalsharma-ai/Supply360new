import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureOutbox } from '../src/audience/delivery.js';
import { fixtureEvents, fixtureWithdrawConsent } from '../src/audience/madp/fixture.js';
import { signCallback } from '../src/fieldwork/outcomes.js';
import { fixtureSessions } from '../src/ingestion/samptrek/fixture.js';
import { madpConnection, prepareAudience, quotas, type Cell } from './audience-setup.js';
import { PASSWORD, signIn, startHarness, tenant, type Harness } from './harness.js';

/**
 * Phase 5 gates: outcomes only from signed or authenticated sources; duplicate and out-of-order events never
 * inflate completes; reconciliation and rewards are idempotent; a reached target stops sending; quality flags are
 * reviewed by a person; recontact and reinvite respect consent, limits and the kill switch; tenants stay apart.
 */
let h: Harness;
const csrf = { 'x-s360-csrf': '1' };
type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
let admin: Agent;
let analyst: Agent;
let other: Agent;
let pid: string;
let pid2: string;
let src: string;
let madp: string;
let cells: Cell[];
let template: string;
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

const db = async <T extends pg.QueryResultRow>(q: string, p: unknown[] = []) => {
  const c = new pg.Client({ connectionString: h.adminUrl });
  await c.connect();
  try {
    return (await c.query<T>(q, p)).rows;
  } finally {
    await c.end();
  }
};
const POLICY = {
  mode: 'manual',
  batchSize: 50,
  dailyMax: 10_000,
  reviewIntervalMinutes: 5,
  quietStartHour: 0,
  quietEndHour: 0,
  timezone: 'UTC',
  reminderOffsetsHours: [24],
  allowedPanels: ['t2o'],
  linkValidDays: 7,
  escalateRefusalPercent: 50,
  speederPercent: 40,
  reason: 'test policy',
};
const batch = (projectId: string, cellId: string, size: number) =>
  admin.post(`/api/v1/projects/${projectId}/batches`).set(csrf).send({ cellId, size, reason: 'test batch' });
const tokenOf = (invitationId: string) => fixtureOutbox(madp).get(`inv-${invitationId}`)!.link.split('/').pop()!;
const open = (token: string) => h.http.get(`/api/v1/i/acme/${token}`).set('user-agent', BROWSER);
const sent = (batchId: string) =>
  db<{ id: string; ref: string }>(
    "select id, ref from invitations where batch_id = $1 and status = 'sent' order by ref",
    [batchId],
  );
const inv = async (id: string) =>
  (
    await db<{ outcome: string | null; started_at: Date | null; approval: string | null; loi_seconds: number | null }>(
      'select outcome, started_at, approval, loi_seconds from invitations where id = $1',
      [id],
    )
  )[0]!;
/** A real SampTrek-style signed S2S callback, as a GET to the template URL. */
const callback = (uid: string, status: string, opts: { key?: string; secret?: string; tamper?: boolean } = {}) => {
  const url = template.replace('{uid}', encodeURIComponent(uid)).replace('{status}', status);
  const signed = signCallback(opts.secret ?? secret, url);
  const path = new URL(url).pathname + new URL(url).search;
  return h.http
    .get(opts.tamper ? path.replace(`status=${status}`, 'status=complete') : path)
    .set('x-projexa-timestamp', signed['x-projexa-timestamp'])
    .set('x-projexa-signature', signed['x-projexa-signature'])
    .set('x-idempotency-key', opts.key ?? `cb:ses-${uid.slice(0, 8)}:${status}:vendor`);
};
let secret = 'test-callback-secret-0123456789';
const simulate = (invitationId: string, status: string, loiMinutes?: number) =>
  admin.post(`/api/v1/sources/${src}/fixture/outcome`).set(csrf).send({ invitationId, status, loiMinutes });
const fieldwork = async (projectId = pid) => (await admin.get(`/api/v1/projects/${projectId}/fieldwork`)).body;
const reconcile = (projectId = pid) => admin.post(`/api/v1/projects/${projectId}/reconciliation`).set(csrf).send({});

let people: { id: string; ref: string }[] = [];

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
        .send({ email: 'qa@acme.example.invalid', name: 'QA', roles: ['reporting_user'], password: PASSWORD })
    ).status,
  ).toBe(201);
  ({ agent: analyst } = await signIn(h, 'acme', 'qa@acme.example.invalid'));
  const s = await admin
    .post('/api/v1/sources')
    .set(csrf)
    .send({ kind: 'samptrek', name: 'SampTrek (FIXTURE)', mode: 'fixture', vendorCode: 'S360' });
  src = s.body.id;
  await admin.post(`/api/v1/sources/${src}/sync`).set(csrf).send({ full: true });
  const list = (await admin.get('/api/v1/projects')).body.items as { id: string; projectCode: string }[];
  pid = list.find((x) => x.projectCode === 'PRX10001')!.id;
  pid2 = list.find((x) => x.projectCode === 'PRX10002')!.id;
  for (const m of (await admin.get(`/api/v1/projects/${pid}`)).body.markets)
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
  expect((await admin.put(`/api/v1/projects/${pid}/execution/policy`).set(csrf).send(POLICY)).status).toBe(200);
  const b = await batch(pid, cells.find((c) => c.name === 'Female')!.id, 40);
  expect(b.body.status).toBe('sent');
  people = await sent(b.body.id);
  // Everyone but the last ten opens their link.
  for (const p of people.slice(0, 30)) expect((await open(tokenOf(p.id))).status).toBe(302);
  template = (await admin.get(`/api/v1/sources/${src}/callback`)).body.callbackUrlTemplate;
});
afterAll(async () => h?.close());

describe('S2S callbacks', () => {
  it('a LIVE-style connection rejects callbacks until a secret is set, and counts bad signatures', async () => {
    // FIXTURE generates its own secret; this test sets a known one, as a person would paste SampTrek's.
    expect((await analyst.put(`/api/v1/sources/${src}/callback-secret`).set(csrf).send({ secret })).status).toBe(403);
    expect((await admin.put(`/api/v1/sources/${src}/callback-secret`).set(csrf).send({ secret })).status).toBe(200);
    const uid = tokenOf(people[0]!.id);
    expect((await callback(uid, 'complete', { secret: 'not-the-secret-at-all-000' })).status).toBe(401);
    expect((await callback(uid, 'terminate', { tamper: true })).status).toBe(401);
    expect((await h.http.get(new URL(template).pathname + `?uid=${uid}&status=complete`)).status).toBe(401);
    const [c] = await db<{ rejected_count: number }>('select rejected_count from source_connections where id = $1', [
      src,
    ]);
    expect(c!.rejected_count).toBe(3);
    expect((await inv(people[0]!.id)).outcome).toBeNull();
  });
  it('a signed complete is recorded once, however often it is delivered', async () => {
    const uid = tokenOf(people[0]!.id);
    const first = await callback(uid, 'complete', { key: 'cb:ses-a:complete:vendor' });
    expect(first.body).toMatchObject({ status: 'recorded', effect: 'applied' });
    const again = await Promise.all(
      [1, 2, 3].map(() => callback(uid, 'complete', { key: 'cb:ses-a:complete:vendor' })),
    );
    for (const r of again) expect(r.body.status).toBe('duplicate');
    // Same outcome under another delivery key: stored, but changes nothing.
    expect((await callback(uid, 'complete', { key: 'cb:ses-a:complete:retry' })).body.effect).toBe(
      'ignored:same_outcome',
    );
    expect((await fieldwork()).total.complete).toBe(1);
  });
  it('a click is never a start, and a later disagreeing callback only raises a flag', async () => {
    expect((await inv(people[1]!.id)).started_at).toBeNull(); // opened the link, but no source said it started
    const uid = tokenOf(people[0]!.id);
    expect((await callback(uid, 'terminate')).body.effect).toBe('conflict');
    expect((await inv(people[0]!.id)).outcome).toBe('complete');
    const flags = (await admin.get('/api/v1/quality/flags?status=open')).body.items;
    expect(flags.find((f: { invitationId: string }) => f.invitationId === people[0]!.id).kind).toBe(
      'conflicting_outcome',
    );
  });
  it('a partial gives way to a final outcome, never the other way round', async () => {
    const uid = tokenOf(people[2]!.id);
    await callback(uid, 'partial');
    expect((await inv(people[2]!.id)).outcome).toBe('partial');
    await callback(uid, 'quota_full');
    await callback(uid, 'partial', { key: 'late-partial' });
    expect((await inv(people[2]!.id)).outcome).toBe('quota_full');
  });
  it('acknowledges a valid callback for someone Supply360 never invited, and refuses unknown statuses', async () => {
    expect((await callback('x'.repeat(44), 'complete')).body).toMatchObject({ status: 'ignored' });
    expect((await callback(tokenOf(people[3]!.id), 'abandoned')).status).toBe(400);
  });
  it('another tenant cannot use this connection', async () => {
    const path = new URL(template).pathname.replace('/acme/', '/other/');
    expect((await h.http.get(`${path}?uid=a&status=complete`)).status).toBe(404);
  });
});

describe('FIXTURE simulator, quality flags', () => {
  it('plays outcomes through the real router and signed callback path', async () => {
    // Someone who never opened the link opens it through the real router first.
    expect((await simulate(people[35]!.id, 'technical_error')).body.status).toBe('recorded');
    const [r] = await db<{ kind: string }>('select kind from router_events where invitation_id = $1', [people[35]!.id]);
    expect(r!.kind).toBe('click');
    for (const [i, s] of [
      [3, 'complete'],
      [4, 'complete'],
      [5, 'terminate'],
      [6, 'terminate'],
      [7, 'security_reject'],
    ] as const)
      expect((await simulate(people[i]!.id, s, 12)).body.status).toBe('recorded');
    // Callbacks carry no start time, so there is no LOI yet; it comes from SampTrek's sessions at reconciliation.
    expect((await fieldwork()).loi.n).toBe(0);
    await reconcile();
    const fw = await fieldwork();
    expect(fw.total).toMatchObject({ complete: 3, terminate: 2, quota_full: 1, security_reject: 1, partial: 0 });
    expect(fw.total.incidence).toBe(60);
    expect(fw.loi.n).toBe(2); // the callback-only complete has no start time, so no LOI
  });
  it('a speeder is flagged for review and never rejected automatically', async () => {
    await simulate(people[8]!.id, 'complete', 2); // 2 of 12 expected minutes, under the 40% policy
    await reconcile();
    expect((await inv(people[8]!.id)).outcome).toBe('complete');
    const flags = (await admin.get(`/api/v1/quality/flags?projectId=${pid}`)).body.items as {
      id: string;
      kind: string;
      invitationId: string;
    }[];
    const speeder = flags.find((f) => f.kind === 'speeder')!;
    expect(speeder.invitationId).toBe(people[8]!.id);
    expect(flags.find((f) => f.kind === 'source_security')).toBeTruthy();
    expect(
      (
        await analyst
          .post(`/api/v1/quality/flags/${speeder.id}/review`)
          .set(csrf)
          .send({ decision: 'accept', reason: 'too fast' })
      ).status,
    ).toBe(403);
    const r = await admin
      .post(`/api/v1/quality/flags/${speeder.id}/review`)
      .set(csrf)
      .send({ decision: 'accept', reason: 'too fast' });
    expect(r.body.status).toBe('accepted');
    expect(
      (
        await admin
          .post(`/api/v1/quality/flags/${speeder.id}/review`)
          .set(csrf)
          .send({ decision: 'dismiss', reason: 'again' })
      ).status,
    ).toBe(409);
    expect((await inv(people[8]!.id)).outcome).toBe('complete'); // the outcome is still SampTrek's
  });
  it('outcomes stop reminders and are reported to MADP once', async () => {
    const [j] = await db<{ status: string }>('select status from reminder_jobs where invitation_id = $1', [
      people[3]!.id,
    ]);
    expect(j!.status).toBe('cancelled');
    await admin.post('/api/v1/execution/tick').set(csrf).send({});
    await admin.post('/api/v1/execution/tick').set(csrf).send({});
    const ev = fixtureEvents(madp);
    expect(ev.get(`s360-complete-${people[3]!.id}`)).toBe('complete');
    expect(ev.get(`s360-start-${people[3]!.id}`)).toBe('start');
    const [n] = await db<{ n: number }>(
      'select count(*)::int n from invitations where outcome is not null and outcome_reported_at is null',
    );
    expect(n!.n).toBe(0);
  });
});

describe('reconciliation and rewards', () => {
  it('pulls sessions, fills what callbacks missed, and is idempotent', async () => {
    // SampTrek knows about a terminate whose callback never arrived.
    const store = fixtureSessions(src);
    store.set('fx-ses-missed', {
      id: 'fx-ses-missed',
      status: 'TERMINATE',
      approval: 'NOT_APPLICABLE',
      verified: true,
      uid: tokenOf(people[9]!.id),
      startedAt: new Date(Date.now() - 300_000).toISOString(),
      outcomeAt: new Date().toISOString(),
      countryCode: 'US',
      projectCode: 'PRX10001',
      vendorCode: 'S360',
    });
    // And one it never verified: not applied, listed as a difference.
    store.set('fx-ses-unverified', {
      ...store.get('fx-ses-missed')!,
      id: 'fx-ses-unverified',
      status: 'COMPLETE',
      verified: false,
      uid: tokenOf(people[10]!.id),
    });
    const first = await reconcile();
    expect(first.status).toBe(200);
    expect(first.body.summary.unverified).toBe(1);
    expect((await inv(people[9]!.id)).outcome).toBe('terminate');
    expect((await inv(people[10]!.id)).outcome).toBeNull();
    const kinds = first.body.differences.map((d: { kind: string }) => d.kind);
    expect(kinds).toContain('unverified_at_source');
    expect(kinds).toContain('missing_at_source'); // people[0..2] were reported by callback only
    const before = await fieldwork();
    const second = await reconcile();
    expect(second.body.summary.applied).toBe(0);
    expect((await fieldwork()).total).toEqual(before.total);
  });
  it('the sessions API overrides a disagreeing callback, and the disagreement is flagged', async () => {
    const store = fixtureSessions(src);
    const s = [...store.values()].find((x) => x.uid === tokenOf(people[4]!.id))!;
    s.status = 'QUALITY_FAIL';
    await reconcile();
    expect((await inv(people[4]!.id)).outcome).toBe('quality_fail');
    const flags = (await admin.get(`/api/v1/quality/flags?projectId=${pid}`)).body.items;
    expect(
      flags.some(
        (f: { kind: string; invitationId: string }) =>
          f.kind === 'conflicting_outcome' && f.invitationId === people[4]!.id,
      ),
    ).toBe(true);
  });
  it('client approval queues one reward per approved complete; rewards are idempotent', async () => {
    const r = await admin
      .post(`/api/v1/sources/${src}/fixture/approve`)
      .set(csrf)
      .send({ projectCode: 'PRX10001', decision: 'APPROVED' });
    expect(r.body.changed).toBe(2); // people[3] and people[8]
    expect((await inv(people[3]!.id)).approval).toBe('approved');
    await reconcile();
    await admin
      .post(`/api/v1/sources/${src}/fixture/approve`)
      .set(csrf)
      .send({ projectCode: 'PRX10001', decision: 'APPROVED' });
    const rw = (await admin.get('/api/v1/rewards')).body;
    expect(rw.items).toHaveLength(2);
    expect(rw.totals.acknowledged).toBe(2);
    expect(new Set(rw.items.map((x: { idempotencyKey: string }) => x.idempotencyKey)).size).toBe(2);
    expect((await analyst.post('/api/v1/rewards/sync').set(csrf).send({})).status).toBe(403);
    expect((await admin.post('/api/v1/rewards/sync').set(csrf).send({})).body).toEqual({
      acknowledged: 0,
      unavailable: 0,
    });
  });
  it('a client decision on something that is not a complete is flagged, not applied', async () => {
    const store = fixtureSessions(src);
    const s = [...store.values()].find((x) => x.uid === tokenOf(people[5]!.id))!;
    s.approval = 'REJECTED';
    await reconcile();
    expect((await inv(people[5]!.id)).approval).toBeNull();
    const flags = (await admin.get(`/api/v1/quality/flags?projectId=${pid}`)).body.items;
    expect(flags.some((f: { kind: string }) => f.kind === 'approval_without_complete')).toBe(true);
  });
});

describe('send stops at targets and deadlines', () => {
  it('a cell with all its completes stops sending', async () => {
    const female = cells.find((c) => c.name === 'Female')!;
    const done = (await fieldwork()).cells.find((c: { id: string }) => c.id === female.id).complete;
    await db('update quota_cells set allocation_target = $2 where id = $1', [female.id, done]);
    const b = await batch(pid, female.id, 5);
    expect(b.body).toMatchObject({ status: 'blocked', blockedReason: 'cell_target_reached' });
    await db('update quota_cells set allocation_target = 200 where id = $1', [female.id]);
  });
  it('the field end date stops sending', async () => {
    const [p] = await db<{ field_end_at: Date }>('select field_end_at from projects where id = $1', [pid]);
    await db("update projects set field_end_at = now() - interval '1 minute' where id = $1", [pid]);
    const b = await batch(pid, cells.find((c) => c.name === 'Male')!.id, 5);
    expect(b.body).toMatchObject({ status: 'blocked', blockedReason: 'deadline_passed' });
    await db('update projects set field_end_at = $2 where id = $1', [pid, p!.field_end_at]);
  });
});

describe('reinvite dropouts', () => {
  it('lists dropouts by kind', async () => {
    const d = (await admin.get(`/api/v1/projects/${pid}/dropouts`)).body;
    expect(d.counts.not_clicked).toBe(9);
    expect(d.counts.not_started).toBeGreaterThan(10);
    expect(d.items.every((i: { dropout: string }) => i.dropout)).toBe(true);
    const only = (await admin.get(`/api/v1/projects/${pid}/dropouts?kinds=not_clicked`)).body.items;
    expect(only).toHaveLength(9);
  });
  it('reinvites picked people once, skips final outcomes, and respects consent', async () => {
    const picked = [people[30]!.id, people[31]!.id, people[32]!.id, people[3]!.id];
    fixtureWithdrawConsent(madp, people[32]!.ref);
    const r = await admin
      .post(`/api/v1/projects/${pid}/reinvite`)
      .set(csrf)
      .send({ invitationIds: picked, reason: 'nudge' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ selected: 4, reinvited: 2, refused: 1, skipped: { final_outcome: 1 } });
    expect(fixtureOutbox(madp).get(`reinv-${people[30]!.id}-1`)?.kind).toBe('reinvite');
    expect(fixtureOutbox(madp).has(`reinv-${people[3]!.id}-1`)).toBe(false);
    const [j] = await db<{ status: string; reason: string }>(
      'select status, reason from reminder_jobs where invitation_id = $1',
      [people[30]!.id],
    );
    expect(j).toMatchObject({ status: 'cancelled', reason: 'reinvited' });
    const again = await admin
      .post(`/api/v1/projects/${pid}/reinvite`)
      .set(csrf)
      .send({ invitationIds: picked.slice(0, 2) });
    expect(again.body).toMatchObject({ reinvited: 0, skipped: { reinvited_recently: 2 } });
  });
  it('select all matching: every partial or not-started person, within the limits', async () => {
    const r = await admin
      .post(`/api/v1/projects/${pid}/reinvite`)
      .set(csrf)
      .send({ dropouts: ['not_started'] });
    expect(r.body.reinvited).toBeGreaterThan(5);
    expect(r.body.skipped.final_outcome ?? 0).toBe(0);
  });
  it('the emergency stop blocks reinvites, and it needs invitations.dispatch', async () => {
    expect(
      (
        await analyst
          .post(`/api/v1/projects/${pid}/reinvite`)
          .set(csrf)
          .send({ dropouts: ['not_clicked'] })
      ).status,
    ).toBe(403);
    await admin.put('/api/v1/execution/kill-switch').set(csrf).send({ halted: true, reason: 'drill' });
    const r = await admin
      .post(`/api/v1/projects/${pid}/reinvite`)
      .set(csrf)
      .send({ dropouts: ['not_clicked'] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('halted');
    await admin.put('/api/v1/execution/kill-switch').set(csrf).send({ halted: false, reason: 'drill over' });
  });
});

describe('recontact past participants', () => {
  it('finds participants by when they took part and by outcome', async () => {
    const all = (await admin.get('/api/v1/recontact/participants')).body;
    expect(all.total).toBe(31); // everyone who opened their link
    const completes = (await admin.get('/api/v1/recontact/participants?outcomes=complete')).body;
    expect(completes.items.every((x: { outcome: string }) => x.outcome === 'complete')).toBe(true);
    const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString();
    expect((await admin.get(`/api/v1/recontact/participants?participatedFrom=${lastWeek}`)).body.total).toBe(31);
    // Move one complete a year back: a "last month" search no longer finds it, a "last year" one does.
    await db("update invitations set outcome_at = now() - interval '300 days' where id = $1", [people[3]!.id]);
    const month = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const year = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const m = (await admin.get(`/api/v1/recontact/participants?outcomes=complete&participatedFrom=${month}`)).body;
    const y = (await admin.get(`/api/v1/recontact/participants?outcomes=complete&participatedFrom=${year}`)).body;
    expect(y.total).toBe(m.total + 1);
    expect(JSON.stringify(y.items)).not.toContain(people[3]!.ref); // shortened references only
  });
  it('holds them for a cell of another project through MADP, once', async () => {
    await prepareAudience(admin, pid2, 400, 1);
    const target = (await quotas(admin, pid2)).cells[0]!;
    const body = { filter: { fromProjectId: pid, outcomes: ['complete', 'terminate'] } };
    expect(
      (await analyst.post(`/api/v1/projects/${pid2}/quotas/${target.id}/recontact`).set(csrf).send(body)).status,
    ).toBe(403);
    const r = await admin.post(`/api/v1/projects/${pid2}/quotas/${target.id}/recontact`).set(csrf).send(body);
    // PRX10002 is a German market; PRX10001's participants are in the US, so none qualify.
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('no_one_to_recontact');
    expect(r.body.detail).toContain('outside DE');
  });
  it('recontacts into the same market: picked people are held, and never twice', async () => {
    const male = cells.find((c) => c.name === 'Male')!;
    const ids = [people[3]!.id, people[5]!.id];
    const r = await admin
      .post(`/api/v1/projects/${pid}/quotas/${male.id}/recontact`)
      .set(csrf)
      .send({ invitationIds: ids });
    // They are already invited to this project, so they are skipped rather than invited twice.
    expect(r.status).toBe(409);
    expect(r.body.detail).toContain('already invited');
  });
  it('a wave 2 project in the same market holds every Q1 complete and terminate, then skips them next time', async () => {
    const pid4 = ((await admin.get('/api/v1/projects')).body.items as { id: string; projectCode: string }[]).find(
      (x) => x.projectCode === 'PRX10004',
    )!.id;
    await prepareAudience(admin, pid4, 400, 1);
    // MADP never holds one person for two projects at once, so Q1's remaining holds are released first.
    for (const r of await db<{ id: string }>(
      "select id from reservations where project_id = $1 and status = 'active'",
      [pid],
    ))
      expect(
        (await admin.post(`/api/v1/projects/${pid}/reservations/${r.id}/release`).set(csrf).send({ reason: 'Q1 done' }))
          .status,
      ).toBe(200);
    const target = (await quotas(admin, pid4)).cells[0]!;
    const want = (await admin.get(`/api/v1/recontact/participants?fromProjectId=${pid}&outcomes=complete,terminate`))
      .body;
    const body = { filter: { fromProjectId: pid, outcomes: ['complete', 'terminate'] } };
    const r = await admin.post(`/api/v1/projects/${pid4}/quotas/${target.id}/recontact`).set(csrf).send(body);
    expect(r.status).toBe(201);
    expect(r.body.considered).toBe(want.people);
    expect(r.body.held + r.body.refused.length + r.body.skipped.alreadyInProject).toBe(want.people);
    expect(r.body.held).toBeGreaterThan(0);
    const again = await admin.post(`/api/v1/projects/${pid4}/quotas/${target.id}/recontact`).set(csrf).send(body);
    expect(again.status).toBe(409);
    const [res] = await db<{ n: number }>("select count(*)::int n from reservations where origin = 'recontact'");
    expect(res!.n).toBe(1);
  });
});

describe('tenant isolation', () => {
  it('another tenant sees none of it', async () => {
    expect((await other.get(`/api/v1/projects/${pid}/fieldwork`)).status).toBe(404);
    expect((await other.get('/api/v1/quality/flags')).body.items).toHaveLength(0);
    expect((await other.get('/api/v1/rewards')).body.items).toHaveLength(0);
    expect((await other.get('/api/v1/recontact/participants')).body.total).toBe(0);
    expect((await other.get('/api/v1/reconciliation/runs')).body.items).toHaveLength(0);
    expect((await other.post(`/api/v1/projects/${pid}/reconciliation`).set(csrf).send({})).status).toBe(404);
  });
});
