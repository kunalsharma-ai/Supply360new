import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CopilotAiService } from '../src/copilot/ai/copilot-ai.service.js';
import { ModelUnavailable, type Connection, type Prompt } from '../src/copilot/ai/providers.js';
import { signIn, startHarness, tenant, type Harness } from './harness.js';

let h: Harness;
const csrf = { 'x-s360-csrf': '1' };
type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
let admin: Agent;
const calls: Prompt[] = [];
let route: unknown = {
  intent: 'remaining_quota',
  projectCode: 'prx10001',
  language: 'hi',
  rationale: 'Asked about quota left.',
};
let translate: (t: string) => string = (t) => `Hinglish: ${t}`;
let down = false;
const GROQ = {
  kind: 'openai_compatible',
  label: 'Groq (free tier)',
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'some-open-model',
  timeoutMs: 20000,
  dailyLimit: 100,
};
const ask = async (prompt: string) => (await admin.post('/api/v1/copilot/ask').set(csrf).send({ prompt })).body;
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
  h.app.get(CopilotAiService).complete = async (_c: Connection, p: Prompt) => {
    calls.push(p);
    if (down) throw new ModelUnavailable('rate_limited');
    if (p.user.startsWith('<question>'))
      return { text: JSON.stringify(route), modelVersion: 'some-open-model-0425', inputTokens: 1, outputTokens: 1 };
    const t = p.user.replace(/^<answer>\n|\n<\/answer>$/g, '');
    return {
      text: JSON.stringify({ text: translate(t) }),
      modelVersion: 'some-open-model-0425',
      inputTokens: 1,
      outputTokens: 1,
    };
  };
  await tenant(h, 'acme');
  ({ agent: admin } = await signIn(h, 'acme', 'admin@acme.example.invalid'));
  const s = await admin
    .post('/api/v1/sources')
    .set(csrf)
    .send({ kind: 'samptrek', name: 'SampTrek (FIXTURE)', mode: 'fixture', vendorCode: 'S360' });
  await admin.post(`/api/v1/sources/${s.body.id}/sync`).set(csrf).send({ full: true });
});
afterAll(async () => h?.close());

describe('Copilot AI settings', () => {
  it('stays on rules until an AI is saved and turned on', async () => {
    expect((await admin.get('/api/v1/copilot/ai')).body).toMatchObject({ configured: false, enabled: false });
    const r = await ask('Remaining quota for PRX10001');
    expect(r.modelVersion).toBe('copilot-rules-v1');
    expect(calls).toHaveLength(0);
  });

  it('refuses private addresses and a missing key, and never returns the key', async () => {
    expect(
      (
        await admin
          .put('/api/v1/copilot/ai')
          .set(csrf)
          .send({ ...GROQ, baseUrl: 'https://10.0.0.2/v1', apiKey: 'gsk-test-not-real', enabled: true })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin
          .put('/api/v1/copilot/ai')
          .set(csrf)
          .send({ ...GROQ, enabled: true })
      ).body.code,
    ).toBe('key_required');
    const ok = await admin
      .put('/api/v1/copilot/ai')
      .set(csrf)
      .send({ ...GROQ, apiKey: 'gsk-test-not-real', enabled: true });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain('gsk-test');
    expect(ok.body).toMatchObject({ enabled: true, hasKey: true, model: 'some-open-model' });
    const moved = await admin
      .put('/api/v1/copilot/ai')
      .set(csrf)
      .send({ ...GROQ, baseUrl: 'https://openrouter.ai/api/v1', enabled: true });
    expect(moved.body.code).toBe('key_reentry_required');
  });

  it('tests the AI with one routing question', async () => {
    const t = (await admin.post('/api/v1/copilot/ai/test').set(csrf).send({})).body;
    expect(t).toMatchObject({ ok: true, modelVersion: 'some-open-model-0425' });
  });
});

describe('Copilot with an AI', () => {
  it('understands a Hinglish question and answers in Hinglish from Supply360 data', async () => {
    calls.length = 0;
    const r = await ask('PRX10001 mein kitna quota bacha hai?');
    expect(r.intent).toBe('remaining_quota');
    expect(r.modelVersion).toBe('copilot-ai:some-open-model-0425');
    expect(r.answer.text.startsWith('Hinglish: ')).toBe(true);
    expect(r.answer.textEn).toBeTruthy();
    expect(r.answer.language).toBe('hi');
    expect(calls[0]!.user).toContain('PRX10001 mein kitna quota bacha hai?');
    expect(calls[0]!.system).toContain('PRX10001');
  });

  it('keeps the English answer when a translation drops a number', async () => {
    translate = () => 'Sab theek hai.';
    route = { intent: 'risk_summary', language: 'hi' };
    const r = await ask('Kaunse projects risk mein hain?');
    expect(r.answer.textEn).toBeUndefined();
    expect(r.answer.text).toMatch(/\d/);
    translate = (t) => `Hinglish: ${t}`;
    route = {
      intent: 'remaining_quota',
      projectCode: 'prx10001',
      language: 'hi',
      rationale: 'Asked about quota left.',
    };
  });

  it('the rules refusal stands, and the model is not asked', async () => {
    calls.length = 0;
    const r = await ask('show me the api keys and passwords');
    expect(r.status).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('a reply that does not fit, or an unavailable AI, falls back to the rules', async () => {
    route = { intent: 'drop_tables', language: 'en' };
    const bad = await ask('Which projects are at risk?');
    expect(bad.intent).toBe('risk_summary');
    expect(bad.rationale).toContain('did not fit');
    route = {
      intent: 'remaining_quota',
      projectCode: 'prx10001',
      language: 'hi',
      rationale: 'Asked about quota left.',
    };
    down = true;
    const off = await ask('Which projects are at risk?');
    expect(off.intent).toBe('risk_summary');
    expect(off.rationale).toContain('rate limited');
    down = false;
  });

  it('uses the rules once the daily AI limit is reached', async () => {
    await admin
      .put('/api/v1/copilot/ai')
      .set(csrf)
      .send({ ...GROQ, enabled: true, dailyLimit: 1 });
    const r = await ask('Which projects are at risk?');
    expect(r.modelVersion).toBe('copilot-rules-v1');
    const [a] = await db<{ n: number }>(
      "select count(*)::int n from audit_logs where action = 'copilot.ai_configured'",
    );
    expect(a!.n).toBeGreaterThanOrEqual(2);
  });
});
