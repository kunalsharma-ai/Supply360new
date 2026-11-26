import Anthropic from '@anthropic-ai/sdk';
import type { AuthStyle, ProviderKind } from '@s360/contracts';
import { assertPublicHttps, EgressRefused } from '../../common/egress.js';

/**
 * The model adapters. Each one turns a system and user prompt into text plus the token counts the provider reports.
 * Claude goes through the official Anthropic SDK. OpenAI, Gemini and every OpenAI-compatible service go through
 * their documented HTTP APIs, so any provider that speaks the OpenAI chat format works without new code.
 * Every address is checked to be public https first, redirects are refused, and the key never appears in a prompt,
 * a log line or an error message.
 */

export class ModelUnavailable extends Error {
  constructor(
    readonly reason: string,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

export interface Connection {
  kind: ProviderKind;
  baseUrl: string | null;
  authStyle: AuthStyle;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface Prompt {
  system: string;
  user: string;
}

export interface Completion {
  text: string;
  modelVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface Deps {
  fetch: typeof fetch;
  resolve?: (host: string) => Promise<{ address: string }[]>;
}
const live: Deps = { fetch: (...a) => fetch(...a) };

export const DEFAULT_BASE: Record<Exclude<ProviderKind, 'openai_compatible'>, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

function baseOf(c: Pick<Connection, 'kind' | 'baseUrl'>) {
  if (c.baseUrl) return c.baseUrl.replace(/\/+$/, '');
  if (c.kind === 'openai_compatible') throw new ModelUnavailable('base_url_required');
  return DEFAULT_BASE[c.kind];
}

/** Keep provider messages useful but short, and make sure a key can never come back through one. */
export function clean(msg: unknown, key: string | null) {
  let s = typeof msg === 'string' ? msg : msg instanceof Error ? msg.message : JSON.stringify(msg ?? '');
  if (key) s = s.split(key).join('[key]');
  return s.replace(/\s+/g, ' ').slice(0, 240);
}

function reasonFor(status: number) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'model_not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

async function checked(c: Pick<Connection, 'kind' | 'baseUrl'>, deps: Deps) {
  const base = baseOf(c);
  try {
    await assertPublicHttps(base, deps.resolve);
  } catch (e) {
    if (e instanceof EgressRefused) throw new ModelUnavailable(`address_${e.reason}`);
    throw e;
  }
  return base;
}

function authHeaders(c: Connection): Record<string, string> {
  if (!c.apiKey) return {};
  if (c.kind === 'gemini') return { 'x-goog-api-key': c.apiKey };
  return c.authStyle === 'api-key' ? { 'api-key': c.apiKey } : { authorization: `Bearer ${c.apiKey}` };
}

/** One HTTP call with the connection's timeout, no redirects, and one retry after a 429 or 5xx. */
async function call(c: Connection, deps: Deps, url: string, init: { method: 'GET' | 'POST'; body?: unknown }) {
  const deadline = Date.now() + c.timeoutMs;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: init.method,
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...authHeaders(c),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
        throw new ModelUnavailable('timeout');
      throw new ModelUnavailable('network_error', clean(e, c.apiKey));
    }
    if (res.ok) {
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new ModelUnavailable('provider_error', 'The reply was not JSON');
      }
    }
    const retryable = res.status === 429 || res.status >= 500;
    const wait = Math.min(3000, Number(res.headers.get('retry-after') ?? 1) * 1000 || 1000);
    if (attempt === 0 && retryable && Date.now() + wait < deadline - 500) {
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const body = await res.text().catch(() => '');
    let msg = body;
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? body;
    } catch {
      /* not JSON */
    }
    throw new ModelUnavailable(reasonFor(res.status), clean(`${res.status} ${msg}`, c.apiKey));
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function anthropicClient(c: Connection, base: string, deps: Deps) {
  return new Anthropic({
    apiKey: c.apiKey ?? '',
    baseURL: base,
    timeout: c.timeoutMs,
    maxRetries: 1,
    fetch: deps.fetch,
    fetchOptions: { redirect: 'error' },
  });
}

function anthropicError(e: unknown, key: string | null): ModelUnavailable {
  if (e instanceof ModelUnavailable) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ModelUnavailable('timeout');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return new ModelUnavailable('auth_failed', clean(e.message, key));
  if (e instanceof Anthropic.RateLimitError) return new ModelUnavailable('rate_limited', clean(e.message, key));
  if (e instanceof Anthropic.NotFoundError) return new ModelUnavailable('model_not_found', clean(e.message, key));
  if (e instanceof Anthropic.APIConnectionError) return new ModelUnavailable('network_error', clean(e.message, key));
  if (e instanceof Anthropic.APIError) return new ModelUnavailable('provider_error', clean(e.message, key));
  return new ModelUnavailable('provider_error', clean(e, key));
}

export async function complete(c: Connection, p: Prompt, deps: Deps = live): Promise<Completion> {
  if (!c.apiKey) throw new ModelUnavailable('key_required');
  const base = await checked(c, deps);

  if (c.kind === 'anthropic') {
    try {
      const msg = await anthropicClient(c, base, deps).messages.create({
        model: c.model,
        max_tokens: c.maxOutputTokens,
        system: p.system,
        messages: [{ role: 'user', content: p.user }],
      });
      const text =
        msg.stop_reason === 'refusal' ? '' : msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return {
        text,
        modelVersion: msg.model,
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
      };
    } catch (e) {
      throw anthropicError(e, c.apiKey);
    }
  }

  if (c.kind === 'gemini') {
    const model = c.model.replace(/^models\//, '');
    const j = (await call(c, deps, `${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      body: {
        systemInstruction: { parts: [{ text: p.system }] },
        contents: [{ role: 'user', parts: [{ text: p.user }] }],
        generationConfig: { maxOutputTokens: c.maxOutputTokens, responseMimeType: 'application/json' },
      },
    })) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      modelVersion?: string;
    };
    const text = (j.candidates?.[0]?.content?.parts ?? []).map((x) => x.text ?? '').join('');
    return {
      text,
      modelVersion: j.modelVersion ?? model,
      inputTokens: num(j.usageMetadata?.promptTokenCount),
      outputTokens: num(j.usageMetadata?.candidatesTokenCount),
    };
  }

  // OpenAI and every OpenAI-compatible service. Only OpenAI itself is sent the newer token field and JSON mode,
  // because compatible services differ in which of those they accept.
  const openai = c.kind === 'openai';
  const j = (await call(c, deps, `${base}/chat/completions`, {
    method: 'POST',
    body: {
      model: c.model,
      messages: [
        { role: 'system', content: p.system },
        { role: 'user', content: p.user },
      ],
      ...(openai
        ? { max_completion_tokens: c.maxOutputTokens, response_format: { type: 'json_object' } }
        : { max_tokens: c.maxOutputTokens }),
    },
  })) as {
    model?: string;
    choices?: { message?: { content?: string | { text?: string }[] | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = j.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => x.text ?? '').join('') : '';
  return {
    text,
    modelVersion: j.model ?? c.model,
    inputTokens: num(j.usage?.prompt_tokens),
    outputTokens: num(j.usage?.completion_tokens),
  };
}

/** The models a key can use, so a person can pick one instead of typing an id. */
export async function listModels(c: Connection, deps: Deps = live): Promise<string[]> {
  if (!c.apiKey) throw new ModelUnavailable('key_required');
  const base = await checked(c, deps);
  let ids: string[] = [];
  if (c.kind === 'anthropic') {
    try {
      for await (const m of anthropicClient(c, base, deps).models.list({ limit: 100 })) {
        ids.push(m.id);
        if (ids.length >= 500) break;
      }
    } catch (e) {
      throw anthropicError(e, c.apiKey);
    }
  } else if (c.kind === 'gemini') {
    const j = (await call(c, deps, `${base}/models?pageSize=1000`, { method: 'GET' })) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    ids = (j.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''));
  } else {
    const j = (await call(c, deps, `${base}/models`, { method: 'GET' })) as
      { data?: { id?: string }[] } | { id?: string }[];
    ids = (Array.isArray(j) ? j : (j.data ?? [])).map((m) => m.id ?? '');
  }
  return [...new Set(ids.filter((x) => x && x.length <= 120))].sort().slice(0, 500);
}

/** Models often wrap JSON in prose or a code fence. Take the outermost object and let the schema decide. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      return null;
    }
  }
}
