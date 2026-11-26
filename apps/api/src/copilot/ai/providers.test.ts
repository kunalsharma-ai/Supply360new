import { describe, expect, it } from 'vitest';
import { assertHttpsAddress, assertPublicHttps, isPublicAddress } from '../../common/egress.js';
import { complete, extractJson, listModels, ModelUnavailable, type Connection, type Deps } from './providers.js';

const publicDns = async () => [{ address: '93.184.215.14' }];
const KEY = 'sk-test-secret-123456';

function fake(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const deps: Deps = {
    resolve: publicDns,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const i =
        init ??
        (input instanceof Request ? { method: input.method, headers: input.headers, body: await input.text() } : {});
      calls.push({ url, init: i });
      return handler(url, i);
    }) as typeof fetch,
  };
  return { deps, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const conn = (o: Partial<Connection>): Connection => ({
  kind: 'openai_compatible',
  baseUrl: 'https://api.groq.com/openai/v1',
  authStyle: 'bearer',
  model: 'some-model',
  apiKey: KEY,
  timeoutMs: 5000,
  maxOutputTokens: 300,
  ...o,
});
const prompt = { system: 'sys', user: 'usr' };
const hdr = (i: RequestInit, k: string) => new Headers(i.headers).get(k);

describe('egress guard', () => {
  it('accepts public https and refuses private, local, plain-http and credentialed addresses', async () => {
    expect((await assertPublicHttps('https://api.example.com/v1', publicDns)).hostname).toBe('api.example.com');
    for (const u of [
      'http://api.example.com',
      'https://localhost',
      'https://x.internal',
      'https://printer.local',
      'https://10.1.2.3',
      'https://192.168.1.1',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[fd00::1]',
      'https://[::ffff:127.0.0.1]',
      'https://u:p@api.example.com',
      'https://intranet',
    ])
      expect(() => assertHttpsAddress(u), u).toThrow();
    await expect(
      assertPublicHttps('https://sneaky.example.com', async () => [
        { address: '93.184.215.14' },
        { address: '10.0.0.8' },
      ]),
    ).rejects.toThrow('host_not_public');
    await expect(
      assertPublicHttps('https://gone.example.com', async () => Promise.reject(new Error('ENOTFOUND'))),
    ).rejects.toThrow('host_not_found');
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('100.64.1.1')).toBe(false);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });
});

describe('model adapters', () => {
  it('speaks the OpenAI chat format to any compatible API, with the provider token counts', async () => {
    const { deps, calls } = fake(() =>
      json({
        model: 'some-model-0425',
        choices: [{ message: { content: '{"answer":"Short queues","confidence":0.7}' } }],
        usage: { prompt_tokens: 41, completion_tokens: 9 },
      }),
    );
    const r = await complete(conn({}), prompt, deps);
    expect(r).toEqual({
      text: '{"answer":"Short queues","confidence":0.7}',
      modelVersion: 'some-model-0425',
      inputTokens: 41,
      outputTokens: 9,
    });
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(hdr(calls[0]!.init, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.init.redirect).toBe('error');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      model: 'some-model',
      max_tokens: 300,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
    });
    expect(body.response_format).toBeUndefined();
  });

  it('sends Azure-style keys in an api-key header, and asks OpenAI itself for JSON', async () => {
    const az = fake(() => json({ choices: [{ message: { content: '{}' } }] }));
    await complete(conn({ authStyle: 'api-key', baseUrl: 'https://res.openai.azure.com/openai/v1' }), prompt, az.deps);
    expect(hdr(az.calls[0]!.init, 'api-key')).toBe(KEY);
    expect(hdr(az.calls[0]!.init, 'authorization')).toBeNull();
    const oa = fake(() => json({ choices: [{ message: { content: '{}' } }] }));
    await complete(conn({ kind: 'openai', baseUrl: null }), prompt, oa.deps);
    expect(oa.calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(oa.calls[0]!.init.body))).toMatchObject({
      max_completion_tokens: 300,
      response_format: { type: 'json_object' },
    });
  });

  it('calls Gemini generateContent with the key in its header', async () => {
    const { deps, calls } = fake(() =>
      json({
        candidates: [{ content: { parts: [{ text: '{"answer":"ok answer","confidence":1}' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
        modelVersion: 'g-1',
      }),
    );
    const r = await complete(conn({ kind: 'gemini', baseUrl: null, model: 'models/some-gemini' }), prompt, deps);
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/some-gemini:generateContent');
    expect(hdr(calls[0]!.init, 'x-goog-api-key')).toBe(KEY);
    expect(JSON.parse(String(calls[0]!.init.body)).generationConfig).toEqual({
      maxOutputTokens: 300,
      responseMimeType: 'application/json',
    });
    expect(r).toMatchObject({ modelVersion: 'g-1', inputTokens: 12, outputTokens: 5 });
  });

  it('calls Claude through the Anthropic SDK', async () => {
    const { deps, calls } = fake(() =>
      json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '{"answer":"Clear labels","confidence":0.8}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 12 },
      }),
    );
    const r = await complete(
      conn({ kind: 'anthropic', baseUrl: null, model: 'claude-opus-5-5', maxOutputTokens: 2000 }),
      prompt,
      deps,
    );
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(hdr(calls[0]!.init, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 2000,
      system: 'sys',
    });
    expect(r).toEqual({
      text: '{"answer":"Clear labels","confidence":0.8}',
      modelVersion: 'claude-opus-5-5',
      inputTokens: 30,
      outputTokens: 12,
    });
  });

  it('maps failures to reasons and never lets the key back out', async () => {
    const bad = fake(() => json({ error: { message: `Invalid key ${KEY}` } }, 401));
    const e = await complete(conn({}), prompt, bad.deps).then(
      () => null,
      (x: ModelUnavailable) => x,
    );
    expect(e).toBeInstanceOf(ModelUnavailable);
    expect(e?.reason).toBe('auth_failed');
    expect(e?.detail).not.toContain(KEY);
    const claude = fake(() =>
      json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
    );
    expect(
      (
        await complete(conn({ kind: 'anthropic', baseUrl: null }), prompt, claude.deps).then(
          () => null,
          (x: ModelUnavailable) => x,
        )
      )?.reason,
    ).toBe('auth_failed');
    const missing = fake(() => json({ error: 'no such model' }, 404));
    expect(
      (
        await complete(conn({}), prompt, missing.deps).then(
          () => null,
          (x: ModelUnavailable) => x,
        )
      )?.reason,
    ).toBe('model_not_found');
    expect(
      (
        await complete(conn({ baseUrl: 'https://10.0.0.1/v1' }), prompt, missing.deps).then(
          () => null,
          (x: ModelUnavailable) => x,
        )
      )?.reason,
    ).toBe('address_host_not_public');
    expect(
      (
        await complete(conn({ apiKey: null }), prompt, missing.deps).then(
          () => null,
          (x: ModelUnavailable) => x,
        )
      )?.reason,
    ).toBe('key_required');
  });

  it('retries once after a rate limit, then gives up', async () => {
    let n = 0;
    const once = fake(() =>
      n++ === 0
        ? json({ error: 'slow down' }, 429, { 'retry-after': '0' })
        : json({ choices: [{ message: { content: '{}' } }] }),
    );
    await complete(conn({}), prompt, once.deps);
    expect(once.calls).toHaveLength(2);
    const always = fake(() => json({ error: 'slow down' }, 429, { 'retry-after': '0' }));
    expect(
      (
        await complete(conn({}), prompt, always.deps).then(
          () => null,
          (x: ModelUnavailable) => x,
        )
      )?.reason,
    ).toBe('rate_limited');
    expect(always.calls).toHaveLength(2);
  });

  it('lists models for OpenAI-compatible APIs and Gemini', async () => {
    const oa = fake(() => json({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }] }));
    expect(await listModels(conn({}), oa.deps)).toEqual(['a-model', 'b-model']);
    expect(oa.calls[0]!.url).toBe('https://api.groq.com/openai/v1/models');
    const g = fake(() =>
      json({
        models: [
          { name: 'models/gen', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    );
    expect(await listModels(conn({ kind: 'gemini', baseUrl: null }), g.deps)).toEqual(['gen']);
  });

  it('pulls JSON out of prose or a code fence', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure!\n```json\n{"answer":"x y z","confidence":0.5}\n```')).toEqual({
      answer: 'x y z',
      confidence: 0.5,
    });
    expect(extractJson('no json here')).toBeNull();
  });
});
