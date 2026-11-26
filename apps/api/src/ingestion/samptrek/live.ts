import { SourceError, type ProjectSource } from '../adapter.js';
import { StListItem, StPage, StProject, StQuotas, StSession, toSourceSession, type SourceSession } from './types.js';

const TIMEOUT_MS = 10_000;

/**
 * LIVE mode: SampTrek's public REST API with a `pjx_` key (scopes projects:read sessions:read quotas:read only).
 * Read-only by design: Supply360 never calls SampTrek's PATCH endpoints. Not yet exercised against a real SampTrek,
 * because no key has been issued; the tests run it against a local stub that serves the documented shapes.
 */
export class LiveSampTrek implements ProjectSource {
  readonly mode = 'live' as const;
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {
    this.base = `${baseUrl.replace(/\/+$/, '')}/api/v1/public`;
  }

  private async get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new SourceError(`SampTrek unreachable: ${(e as Error).message}`, true);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      const hint =
        res.status === 401 ? 'key rejected' : res.status === 403 ? 'key is missing a scope' : `HTTP ${res.status}`;
      throw new SourceError(`SampTrek ${hint}`, retryable, res.status);
    }
    return res.json();
  }

  async listProjects(q: { updatedSince?: Date; cursor?: string | null }) {
    const p = new URLSearchParams({ limit: '100' });
    if (q.updatedSince) p.set('updatedSince', q.updatedSince.toISOString());
    if (q.cursor) p.set('cursor', q.cursor);
    const body = await this.get(`/projects?${p}`);
    const parsed = StPage(StListItem).safeParse(body);
    if (!parsed.success) throw new SourceError('SampTrek project list has an unexpected shape', false);
    return parsed.data;
  }

  async getProject(ref: string) {
    const body = await this.get(`/projects/${encodeURIComponent(ref)}`);
    if (body === null) return null;
    const parsed = StProject.safeParse(body);
    if (!parsed.success) throw new SourceError('SampTrek project has an unexpected shape', false);
    return parsed.data;
  }

  async getQuotas(ref: string) {
    const body = await this.get(`/projects/${encodeURIComponent(ref)}/quotas`);
    if (body === null) return null;
    const parsed = StQuotas.safeParse(body);
    if (!parsed.success) throw new SourceError('SampTrek quotas have an unexpected shape', false);
    return parsed.data;
  }

  async getSessions(ref: string, vendorCode: string, since?: Date): Promise<SourceSession[] | null> {
    const out: SourceSession[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 500; page++) {
      const p = new URLSearchParams({ limit: '200' });
      if (since) p.set('outcomeSince', since.toISOString());
      if (cursor) p.set('cursor', cursor);
      const body = await this.get(`/projects/${encodeURIComponent(ref)}/sessions?${p}`);
      if (body === null) return null;
      const parsed = StPage(StSession).safeParse(body);
      if (!parsed.success) throw new SourceError('SampTrek sessions have an unexpected shape', false);
      for (const s of parsed.data.data) if (s.vendor?.code === vendorCode) out.push(toSourceSession(s));
      cursor = parsed.data.nextCursor;
      if (!cursor) return out;
    }
    throw new SourceError('SampTrek sessions did not finish paging', true);
  }
}
