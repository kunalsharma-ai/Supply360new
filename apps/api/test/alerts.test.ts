import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertsService } from '../src/alerts/alerts.service.js';
import type { AlertTransport, Mail, SmtpConfig } from '../src/alerts/transport.js';
import { fixtureCells } from '../src/ingestion/samptrek/fixture.js';
import { quotas } from './audience-setup.js';
import { signIn, startHarness, tenant, type Harness } from './harness.js';

let h: Harness;
const csrf = { 'x-s360-csrf': '1' };
type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
let admin: Agent;
let sourceId: string;
const ids: Record<string, string> = {};
const sent: { channel: string; to?: string[]; subject: string; text: string; cfg?: SmtpConfig }[] = [];
let failOn: string | null = null;
const fake: AlertTransport = {
  async email(cfg, m: Mail) {
    if (failOn && m.subject.includes(failOn)) throw new Error('535 Authentication failed');
    sent.push({ channel: 'email', to: cfg.to, subject: m.subject, text: m.text, cfg });
  },
  async webhook(_url, text) {
    sent.push({ channel: 'webhook', subject: text.split('\n')[0]!, text });
  },
};
const SETTINGS = {
  emailEnabled: true,
  smtpHost: 'smtp.zoho.in',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: 'alerts@frequent.example',
  smtpPassword: 'app-password-for-tests-only',
  fromAddress: 'alerts@frequent.example',
  recipients: ['ops@frequent.example'],
  webhookEnabled: false,
  categories: ['delivery', 'automation', 'quota_full', 'ir_drop'],
  minSeverity: 'warning',
  irDropPoints: 15,
  digestEnabled: false,
  digestHour: 9,
  digestTimezone: 'Asia/Kolkata',
};
const save = (over: Record<string, unknown> = {}) =>
  admin
    .put('/api/v1/alerts')
    .set(csrf)
    .send({ ...SETTINGS, ...over });
const run = () => admin.post('/api/v1/alerts/run').set(csrf).send({});

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
  h.app.get(AlertsService).transport = fake;
  await tenant(h, 'acme');
  ({ agent: admin } = await signIn(h, 'acme', 'admin@acme.example.invalid'));
  const s = await admin
    .post('/api/v1/sources')
    .set(csrf)
    .send({ kind: 'samptrek', name: 'SampTrek (FIXTURE)', mode: 'fixture', vendorCode: 'S360' });
  sourceId = s.body.id;
  await admin.post(`/api/v1/sources/${sourceId}/sync`).set(csrf).send({ full: true });
  for (const p of (await admin.get('/api/v1/projects')).body.items) ids[p.projectCode] = p.id;
  await db("update projects set lifecycle = 'live' where id = $1", [ids.PRX10001]);
});
afterAll(async () => h?.close());

describe('alert settings', () => {
  it('needs a full email setup, refuses private mail servers, and never returns the password', async () => {
    expect((await save({ recipients: [] })).body.code).toBe('email_incomplete');
    expect((await save({ smtpHost: 'localhost' })).body.code).toBe('smtp_host_not_public');
    expect((await save({ smtpHost: 'mail.internal' })).body.code).toBe('smtp_host_not_public');
    expect((await save({ webhookEnabled: true, webhookUrl: 'http://hooks.example.com/x' })).status).toBe(400);
    const ok = await save();
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain('app-password');
    const got = (await admin.get('/api/v1/alerts')).body;
    expect(got.settings).toMatchObject({
      emailEnabled: true,
      hasSmtpPassword: true,
      recipients: ['ops@frequent.example'],
    });
    const [row] = await db<{ p: string }>('select smtp_password_sealed p from alert_settings');
    expect(row!.p).toMatch(/^v1\./);
  });

  it('drops the stored password when the mail server changes', async () => {
    await save({ smtpHost: 'smtp.gmail.com', smtpPassword: undefined });
    expect((await admin.get('/api/v1/alerts')).body.settings.hasSmtpPassword).toBe(false);
    await save();
  });

  it('sends a test email through the saved setup', async () => {
    const r = await admin.post('/api/v1/alerts/test').set(csrf).send({ channel: 'email' });
    expect(r.body).toMatchObject({ ok: true });
    expect(sent.at(-1)).toMatchObject({
      channel: 'email',
      subject: '[Supply360] Test alert',
      to: ['ops@frequent.example'],
    });
    expect(sent.at(-1)!.cfg).toMatchObject({ host: 'smtp.zoho.in', password: 'app-password-for-tests-only' });
  });
});

describe('alert conditions and sending', () => {
  it('raises a full quota cell once and emails it once', async () => {
    const before = sent.length;
    fixtureCells(sourceId).PRX10001!.US![0]!.completes = 400;
    await admin.post(`/api/v1/sources/${sourceId}/sync`).set(csrf).send({ full: true });
    const r = (await run()).body;
    expect(r.raised).toBe(1);
    const mails = sent.slice(before);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe('[Supply360] PRX10001: US Female is full');
    expect(mails[0]!.text).toContain(`/quotas?project=${ids.PRX10001}`);
    expect((await run()).body).toMatchObject({ raised: 0, sent: 0 });
    expect(sent.length).toBe(before + 1);
  });

  it('raises an IR drop when the last day runs far below the expected IR', async () => {
    const { cells } = await quotas(admin, ids.PRX10001!);
    const cell = cells.find((c) => c.countryCode === 'US')!;
    const [b] = await db<{ id: string; tenant_id: string }>(
      `insert into invitation_batches (tenant_id, project_id, cell_id, size, status, mode, policy_version, origin)
       select tenant_id, $1, $2, 40, 'finished', 'manual', 1, 'person' from projects where id = $1 returning id, tenant_id`,
      [ids.PRX10001, cell.id],
    );
    for (let i = 0; i < 40; i++)
      await db(
        `insert into invitations (tenant_id, project_id, cell_id, batch_id, ref, panel, country_code, madp_invitation_id, status, sent_at, outcome, outcome_at, expires_at)
         values ($1, $2, $3, $4, $5, 't2o', 'US', $6, 'sent', now() - interval '3 hours', $7, now() - interval '1 hour', now() + interval '5 days')`,
        [b!.tenant_id, ids.PRX10001, cell.id, b!.id, `ref-${i}`, `inv-${i}`, i < 4 ? 'complete' : 'terminate'],
      );
    const before = sent.length;
    expect((await run()).body.raised).toBe(1);
    expect(sent.slice(before)[0]!.subject).toMatch(/PRX10001: IR 10% against \d+% expected/);
    expect((await run()).body.raised).toBe(0);
  });

  it('keeps alerts below the chosen severity in the app only', async () => {
    await save({ minSeverity: 'critical' });
    fixtureCells(sourceId).PRX10001!.US![1]!.completes = 400;
    await admin.post(`/api/v1/sources/${sourceId}/sync`).set(csrf).send({ full: true });
    const before = sent.length;
    expect((await run()).body).toMatchObject({ raised: 1, sent: 0 });
    expect(sent.length).toBe(before);
    const n = (await admin.get('/api/v1/notifications')).body.items;
    expect(n.some((x: { title: string }) => x.title === 'PRX10001: US Male is full')).toBe(true);
    await save();
  });

  it('records a failed send and retries it later, at most three times', async () => {
    await db("update alert_settings set min_severity = 'info'");
    const tenantId = (await db<{ id: string }>("select id from tenants where slug = 'acme'"))[0]!.id;
    await db(
      `insert into notifications (tenant_id, kind, severity, title, body) values ($1, 'execution.escalated', 'critical', 'Automation escalated on PRX10001', 'Too many refusals')`,
      [tenantId],
    );
    failOn = 'escalated';
    expect((await run()).body).toMatchObject({ failed: 1 });
    failOn = null;
    const recent = (await admin.get('/api/v1/alerts')).body.recent;
    const esc = (r: { subject: string }[]) => r.find((d) => d.subject.includes('escalated'));
    expect(esc(recent)).toMatchObject({ status: 'failed', error: '535 Authentication failed', attempts: 1 });
    await db("update alert_deliveries set at = now() - interval '10 minutes' where status = 'failed'");
    expect((await run()).body).toMatchObject({ sent: 1 });
    const again = (await admin.get('/api/v1/alerts')).body.recent;
    expect(esc(again)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('sends the daily digest once a day at the chosen hour', async () => {
    await save({ digestEnabled: true, digestHour: 0, digestTimezone: 'UTC' });
    const before = sent.length;
    await run();
    const d = sent.slice(before).filter((m) => m.subject.includes('Daily digest'));
    expect(d).toHaveLength(1);
    expect(d[0]!.text).toContain('PRX10001');
    await run();
    expect(sent.slice(before).filter((m) => m.subject.includes('Daily digest'))).toHaveLength(1);
  });
});
