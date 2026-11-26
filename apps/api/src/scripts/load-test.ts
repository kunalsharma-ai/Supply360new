import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Secret, TOTP } from 'otpauth';
import pg from 'pg';
import { TokenSigner } from '../execution/token.js';
import { signCallback } from '../fieldwork/outcomes.js';
import { signSampTrek } from '../ingestion/signature.js';
import { provisionTenant } from './provision.js';

/**
 * Load test against a running API. Creates its own throwaway tenant (LOADTEST-…) with the owner connection, signs
 * in N people with MFA, then drives authenticated reads and writes at several concurrency levels. Prints measured
 * latency percentiles, throughput and errors; it never claims a target it did not measure.
 *
 *   DATABASE_ADMIN_URL=… node dist/scripts/load-test.js --base http://localhost:4000 --duration 15 --levels 10,50,100
 *
 * Local only: refuses NODE_ENV=production. The API must run with LOGIN_RATE_LIMIT high enough for the sign-ins.
 */
const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4000' },
    duration: { type: 'string', default: '15' },
    levels: { type: 'string', default: '10,50,100' },
    users: { type: 'string', default: '20' },
    json: { type: 'boolean', default: false },
  },
});
if (process.env.NODE_ENV === 'production') throw new Error('Load test is for local and staging stacks only');
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required (the script provisions a throwaway tenant)');
const BASE = `${values.base}/api/v1`;
const DURATION_MS = Number(values.duration) * 1000;
const LEVELS = values.levels!.split(',').map(Number);
const PASSWORD = `load-${randomBytes(12).toString('hex')}-1`;
const slug = `loadtest-${randomBytes(3).toString('hex')}`;
const csrf = { 'x-s360-csrf': '1', 'content-type': 'application/json' };

function cookieOf(res: Response): string {
  const c = res.headers.getSetCookie().find((x) => x.startsWith('s360_session='));
  if (!c) throw new Error(`no session cookie (HTTP ${res.status})`);
  return c.split(';')[0]!;
}

async function signIn(email: string): Promise<string> {
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: csrf,
    body: JSON.stringify({ tenant: slug, email, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login ${login.status}: ${await login.text()}`);
  const body = (await login.json()) as { otpauthUri: string };
  const secret = new URL(body.otpauthUri).searchParams.get('secret')!;
  const code = new TOTP({ secret: Secret.fromBase32(secret), period: 30, digits: 6 }).generate();
  const mfa = await fetch(`${BASE}/auth/mfa`, {
    method: 'POST',
    headers: { ...csrf, cookie: cookieOf(login) },
    body: JSON.stringify({ code }),
  });
  if (!mfa.ok) throw new Error(`mfa ${mfa.status}: ${await mfa.text()}`);
  return cookieOf(mfa);
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;

interface Op {
  name: string;
  weight: number;
  run: (cookie: string) => Promise<Response>;
}
// Filled in by the Phase 2 setup below: a FIXTURE SampTrek connection and its imported projects.
const source = {
  webhookUrl: '',
  secret: '',
  projectIds: [] as string[],
  sourceIds: ['fx-prj-10001', 'fx-prj-10002', 'fx-prj-10003'],
  /** Phase 3: PRX10001 and its US Female cell, mapped and capped so reserve/release can run under load. */
  audienceProject: '',
  audienceCell: '',
};
/** Reserve one person, then release that reservation: exercises the project row lock and MADP round trips. */
async function reserveRelease(c: string): Promise<Response> {
  const r = await fetch(`${BASE}/projects/${source.audienceProject}/quotas/${source.audienceCell}/reserve`, {
    method: 'POST',
    headers: { ...csrf, cookie: c },
    body: JSON.stringify({ count: 1 }),
  });
  if (!r.ok) return r;
  const { reservationId } = (await r.json()) as { reservationId: string };
  return fetch(`${BASE}/projects/${source.audienceProject}/reservations/${reservationId}/release`, {
    method: 'POST',
    headers: { ...csrf, cookie: c },
    body: JSON.stringify({ reason: 'load test' }),
  });
}
const any = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
let eventSeq = 0;
/** Signed project.status_changed with the project's current status; every second one repeats an earlier event id. */
function webhook(): Promise<Response> {
  const n = eventSeq++;
  const id = `evt_load_${slug}_${n % 2 ? n - 1 : n}`;
  const st = ['LIVE', 'TEST', 'HOLD'][n % 3]!;
  const body = JSON.stringify({
    id,
    event: 'project.status_changed',
    createdAt: new Date().toISOString(),
    data: { project: { id: source.sourceIds[n % 3] }, from: st, to: st },
  });
  return fetch(source.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signSampTrek(source.secret, body) },
    body,
  });
}

const OPS: Op[] = [
  { name: 'GET /auth/me', weight: 10, run: (c) => fetch(`${BASE}/auth/me`, { headers: { cookie: c } }) },
  { name: 'GET /users', weight: 5, run: (c) => fetch(`${BASE}/users?limit=50`, { headers: { cookie: c } }) },
  { name: 'GET /audit', weight: 5, run: (c) => fetch(`${BASE}/audit?limit=50`, { headers: { cookie: c } }) },
  { name: 'GET /notifications', weight: 5, run: (c) => fetch(`${BASE}/notifications`, { headers: { cookie: c } }) },
  { name: 'GET /projects', weight: 15, run: (c) => fetch(`${BASE}/projects`, { headers: { cookie: c } }) },
  {
    name: 'GET /projects/:id',
    weight: 15,
    run: (c) => fetch(`${BASE}/projects/${any(source.projectIds)}`, { headers: { cookie: c } }),
  },
  {
    name: 'GET /projects/:id/quotas',
    weight: 10,
    run: (c) => fetch(`${BASE}/projects/${any(source.projectIds)}/quotas`, { headers: { cookie: c } }),
  },
  {
    name: 'POST /audience/counts',
    weight: 10,
    run: (c) =>
      fetch(`${BASE}/audience/counts`, {
        method: 'POST',
        headers: { ...csrf, cookie: c },
        body: JSON.stringify({ countries: [any(['US', 'GB', 'DE', 'IN'])], panels: ['t2o'] }),
      }),
  },
  {
    name: 'GET /projects/:id/execution',
    weight: 5,
    run: (c) => fetch(`${BASE}/projects/${source.audienceProject}/execution`, { headers: { cookie: c } }),
  },
  { name: 'POST reserve + release', weight: 5, run: (c) => reserveRelease(c) },
  {
    name: 'GET /projects/:id/synthetic-qa',
    weight: 5,
    run: (c) => fetch(`${BASE}/projects/${source.audienceProject}/synthetic-qa`, { headers: { cookie: c } }),
  },
  { name: 'POST signed webhook', weight: 5, run: () => webhook() },
  {
    name: 'PUT /settings/tenant',
    weight: 5,
    run: (c) =>
      fetch(`${BASE}/settings/tenant`, {
        method: 'PUT',
        headers: { ...csrf, cookie: c },
        body: JSON.stringify({
          displayName: 'Load test',
          timezone: 'UTC',
          locale: 'en',
          defaultTheme: 'midnight',
          defaultExecutionMode: 'manual',
        }),
      }),
  },
];
const pick = (): Op => {
  let r = Math.random() * 100;
  for (const o of OPS) if ((r -= o.weight) < 0) return o;
  return OPS[0]!;
};

async function level(concurrency: number, cookies: string[]) {
  const lat: Record<string, number[]> = {};
  let ok = 0;
  let errors = 0;
  const statuses: Record<number, number> = {};
  const end = Date.now() + DURATION_MS;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      const cookie = cookies[i % cookies.length]!;
      while (Date.now() < end) {
        const op = pick();
        const s = performance.now();
        try {
          const res = await op.run(cookie);
          await res.arrayBuffer();
          (lat[op.name] ??= []).push(performance.now() - s);
          statuses[res.status] = (statuses[res.status] ?? 0) + 1;
          if (res.ok) ok++;
          else errors++;
        } catch {
          errors++;
        }
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  const all = Object.values(lat)
    .flat()
    .sort((a, b) => a - b);
  return {
    concurrency,
    seconds: Number(seconds.toFixed(1)),
    requests: ok + errors,
    rps: Math.round((ok + errors) / seconds),
    errors,
    errorRate: Number(((errors / Math.max(1, ok + errors)) * 100).toFixed(2)),
    p50: Number(pct(all, 50).toFixed(1)),
    p95: Number(pct(all, 95).toFixed(1)),
    p99: Number(pct(all, 99).toFixed(1)),
    statuses,
    perRoute: Object.fromEntries(
      Object.entries(lat).map(([k, v]) => {
        const s = v.sort((a, b) => a - b);
        return [k, { n: s.length, p50: Number(pct(s, 50).toFixed(1)), p95: Number(pct(s, 95).toFixed(1)) }];
      }),
    ),
  };
}

// Setup: tenant + people, then sign everyone in (argon2id + TOTP is the expensive path, measured separately).
const { tenantId } = await provisionTenant(adminUrl, {
  slug,
  name: `LOADTEST ${slug}`,
  admin: { email: `admin@${slug}.example.invalid`, name: 'LOADTEST admin', password: PASSWORD },
});
const adminCookie = await signIn(`admin@${slug}.example.invalid`);
const n = Number(values.users);
for (let i = 0; i < n - 1; i++) {
  const r = await fetch(`${BASE}/users`, {
    method: 'POST',
    headers: { ...csrf, cookie: adminCookie },
    body: JSON.stringify({
      email: `u${i}@${slug}.example.invalid`,
      name: `LOADTEST user ${i}`,
      roles: ['tenant_admin'],
      password: PASSWORD,
    }),
  });
  if (!r.ok) throw new Error(`create user ${r.status}: ${await r.text()}`);
}
const signInTimes: number[] = [];
const cookies = [adminCookie];
await Promise.all(
  Array.from({ length: n - 1 }, async (_, i) => {
    const s = performance.now();
    cookies.push(await signIn(`u${i}@${slug}.example.invalid`));
    signInTimes.push(performance.now() - s);
  }),
);
signInTimes.sort((a, b) => a - b);

// Phase 2: a FIXTURE SampTrek connection, backfilled, so project reads and signed webhooks are part of the mix.
const conn = await fetch(`${BASE}/sources`, {
  method: 'POST',
  headers: { ...csrf, cookie: adminCookie },
  body: JSON.stringify({ kind: 'samptrek', name: 'LOADTEST FIXTURE', mode: 'fixture', vendorCode: 'S360' }),
});
if (!conn.ok) throw new Error(`create source ${conn.status}: ${await conn.text()}`);
const connBody = (await conn.json()) as { id: string; webhookSecret: string };
source.secret = connBody.webhookSecret;
// Deliver straight to the API (the public URL in the response may point at the web origin).
source.webhookUrl = `${BASE}/webhooks/samptrek/${slug}/${connBody.id}`;
const backfill = await fetch(`${BASE}/sources/${connBody.id}/sync`, {
  method: 'POST',
  headers: { ...csrf, cookie: adminCookie },
  body: JSON.stringify({ full: true }),
});
if (!backfill.ok) throw new Error(`backfill ${backfill.status}`);
const plist = (await (await fetch(`${BASE}/projects`, { headers: { cookie: adminCookie } })).json()) as {
  items: { id: string }[];
};
source.projectIds = plist.items.map((p) => p.id);

// Phase 3: a FIXTURE MADP connection, one cell mapped and given a large cap.
const post = (path: string, body: unknown, method = 'POST') =>
  fetch(`${BASE}${path}`, { method, headers: { ...csrf, cookie: adminCookie }, body: JSON.stringify(body) });
const madp = await post('/audience/connections', { name: 'LOADTEST MADP FIXTURE', mode: 'fixture' });
if (!madp.ok) throw new Error(`create MADP ${madp.status}`);
const prx = (await (await fetch(`${BASE}/projects?q=PRX10001`, { headers: { cookie: adminCookie } })).json()) as {
  items: { id: string }[];
};
source.audienceProject = prx.items[0]!.id;
const q = (await (
  await fetch(`${BASE}/projects/${source.audienceProject}/quotas`, { headers: { cookie: adminCookie } })
).json()) as { cells: { id: string; name: string }[] };
source.audienceCell = q.cells.find((c) => c.name === 'Female')!.id;
const mapped = await post(
  `/projects/${source.audienceProject}/quotas/${source.audienceCell}/mapping`,
  { criteria: { panels: ['t2o'], attributes: [{ key: 'demographics.gender', values: ['female'] }] } },
  'PUT',
);
const capped = await post(
  `/projects/${source.audienceProject}/allocation`,
  { mode: 'proportional', caps: { [source.audienceCell]: 100_000 } },
  'PUT',
);
if (!mapped.ok || !capped.ok) throw new Error(`audience setup ${mapped.status} ${capped.status}`);
// Phase 6: a FIXTURE SampIntel link and one project showing synthetic QA beside human sample.
const si = await post('/sampintel/connection', { mode: 'fixture', enabled: true }, 'PUT');
const qa = await post(`/projects/${source.audienceProject}/qa-mode`, { mode: 'both_separate', reason: 'load test' }, 'PUT');
if (!si.ok || !qa.ok) throw new Error(`sampintel setup ${si.status} ${qa.status}`);

const MIX = OPS.map((o) => `${o.weight}% ${o.name}`);
const results: Awaited<ReturnType<typeof level>>[] = [];
for (const c of LEVELS) results.push(await level(c, cookies));

// Phase 4: the click path on its own. It is the busiest route once invitations go out: no session, one signed token
// check, a row lock on the invitation, the reminder cancel and a router event, then a 302 to the entry link.
const pid = source.audienceProject;
const detail = (await (await fetch(`${BASE}/projects/${pid}`, { headers: { cookie: adminCookie } })).json()) as {
  markets: { countryCode: string }[];
};
for (const m of detail.markets)
  await post(
    `/projects/${pid}/markets/${m.countryCode}/entry-link`,
    { entryUrl: `https://st.example/s/${m.countryCode}?uid=[UID]` },
    'PUT',
  );
const all = (await (await fetch(`${BASE}/projects/${pid}/quotas`, { headers: { cookie: adminCookie } })).json()) as {
  cells: { id: string; name: string; isMarketCell: boolean }[];
};
await post(`/projects/${pid}/lifecycle`, { action: 'mark_ready', reason: 'load test' });
for (const c of all.cells) {
  if (c.id !== source.audienceCell)
    await post(`/projects/${pid}/quotas/${c.id}/mapping`, { criteria: { panels: ['t2o'] } }, 'PUT');
}
await post(
  `/projects/${pid}/allocation`,
  { mode: 'proportional', caps: Object.fromEntries(all.cells.map((c) => [c.id, 100_000])) },
  'PUT',
);
for (const c of all.cells) await post(`/projects/${pid}/quotas/${c.id}/reserve`, { count: 2000 });
const launched = await post(`/projects/${pid}/lifecycle`, { action: 'launch', reason: 'load test' });
if (!launched.ok) throw new Error(`launch ${launched.status}: ${await launched.text()}`);
const pol = await post(
  `/projects/${pid}/execution/policy`,
  {
    mode: 'manual',
    batchSize: 5000,
    dailyMax: 1_000_000,
    reviewIntervalMinutes: 60,
    quietStartHour: 0,
    quietEndHour: 0,
    timezone: 'UTC',
    reminderOffsetsHours: [24, 72],
    allowedPanels: ['t2o'],
    linkValidDays: 7,
    escalateRefusalPercent: 100,
    reason: 'load test',
  },
  'PUT',
);
if (!pol.ok) throw new Error(`policy ${pol.status}: ${await pol.text()}`);
const batchMs: number[] = [];
let invited = 0;
for (const c of all.cells) {
  const s = performance.now();
  const b = await post(`/projects/${pid}/batches`, { cellId: c.id, size: 5000, reason: 'load test' });
  if (!b.ok) throw new Error(`batch ${b.status}: ${await b.text()}`);
  invited += ((await b.json()) as { sent: number }).sent;
  batchMs.push(performance.now() - s);
}
const secret = process.env.PARTICIPATION_TOKEN_SECRET ?? process.env.SESSION_SECRET;
if (!secret) throw new Error('SESSION_SECRET is required to build participation links (run with the API .env)');
const signer = new TokenSigner(secret);
const pgc = new pg.Client({ connectionString: adminUrl });
await pgc.connect();
const ids = (
  await pgc.query<{ id: string }>("select id from invitations where tenant_id = $1 and status = 'sent'", [tenantId])
).rows;
await pgc.end();
const links = ids.map((r) => `${BASE}/i/${slug}/${signer.sign(r.id)}`);
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
OPS.splice(0, OPS.length, {
  name: 'GET /i/:tenant/:token (click)',
  weight: 100,
  run: async () => {
    const r = await fetch(any(links), { redirect: 'manual', headers: { 'user-agent': BROWSER } });
    // A 302 to the approved entry link is the success answer here.
    return r.status === 302 && r.headers.get('location')?.startsWith('https://st.example/')
      ? new Response(null, { status: 200 })
      : new Response(null, { status: r.status === 302 ? 409 : r.status });
  },
});
const clicks: Awaited<ReturnType<typeof level>>[] = [];
for (const c of LEVELS) clicks.push(await level(c, cookies));

// Phase 5: SampTrek's signed S2S callbacks for those invitations (a mix of outcomes, so duplicates and conflicts
// happen as they would in the field), alongside people reading live fieldwork.
const cbSecret = `loadtest-callback-${randomBytes(12).toString('hex')}`;
const setSecret = await post(`/sources/${connBody.id}/callback-secret`, { secret: cbSecret }, 'PUT');
if (!setSecret.ok) throw new Error(`callback secret ${setSecret.status}`);
const { callbackUrlTemplate } = (await (
  await fetch(`${BASE}/sources/${connBody.id}/callback`, { headers: { cookie: adminCookie } })
).json()) as { callbackUrlTemplate: string };
const tokens = ids.map((r) => signer.sign(r.id));
const STATUSES = ['complete', 'complete', 'terminate', 'quota_full', 'partial'];
let cbSeq = 0;
OPS.splice(
  0,
  OPS.length,
  {
    name: 'GET /s2s/samptrek (signed callback)',
    weight: 80,
    run: async () => {
      const url = callbackUrlTemplate.replace('{uid}', any(tokens)).replace('{status}', any(STATUSES));
      const h = signCallback(cbSecret, url);
      const u = new URL(url);
      return fetch(`${BASE}${u.pathname.replace(/^\/api\/v1/, '')}${u.search}`, {
        headers: { ...h, 'x-idempotency-key': `cb:load-${process.pid}-${cbSeq++}:vendor` },
      });
    },
  },
  {
    name: 'GET /projects/:id/fieldwork',
    weight: 20,
    run: (c) => fetch(`${BASE}/projects/${pid}/fieldwork`, { headers: { cookie: c } }),
  },
);
const callbacks: Awaited<ReturnType<typeof level>>[] = [];
for (const c of LEVELS) callbacks.push(await level(c, cookies));
const report = {
  at: new Date().toISOString(),
  base: values.base,
  tenant: slug,
  tenantId,
  people: n,
  durationPerLevelSeconds: Number(values.duration),
  signIn: {
    concurrent: n - 1,
    p50: Number(pct(signInTimes, 50).toFixed(0)),
    p95: Number(pct(signInTimes, 95).toFixed(0)),
  },
  mix: MIX,
  results,
  clickPath: { invitations: invited, batches: batchMs.map((x) => Math.round(x)), results: clicks },
  s2sPath: { mix: OPS.map((o) => `${o.weight}% ${o.name}`), results: callbacks },
};
if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Load test ${report.at} against ${report.base} (tenant ${slug}, ${n} people)`);
  console.log(`Sign-in with MFA, ${n - 1} at once: p50 ${report.signIn.p50} ms, p95 ${report.signIn.p95} ms`);
  console.log('conc  req/s  requests  errors   p50 ms  p95 ms  p99 ms  statuses');
  const table = (rows: typeof results) => {
    for (const r of rows)
      console.log(
        `${String(r.concurrency).padStart(4)}  ${String(r.rps).padStart(5)}  ${String(r.requests).padStart(8)}  ${String(r.errors).padStart(6)}  ${String(r.p50).padStart(7)} ${String(r.p95).padStart(7)} ${String(r.p99).padStart(7)}  ${Object.entries(
          r.statuses,
        )
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')}`,
      );
  };
  table(results);
  console.log(
    `\nClick path only (${invited} invitations, batches of up to 5000 sent in ${batchMs.map((x) => Math.round(x)).join(' / ')} ms):`,
  );
  console.log('conc  req/s  requests  errors   p50 ms  p95 ms  p99 ms  statuses');
  table(clicks);
  console.log(`\nS2S callbacks (${report.s2sPath.mix.join(', ')}):`);
  console.log('conc  req/s  requests  errors   p50 ms  p95 ms  p99 ms  statuses');
  table(callbacks);
}
