import type { AudienceCriteria } from '@s360/contracts';
import type { z } from 'zod';
import { madpHeaders } from './signing.js';
import { AudienceError, type AudienceSource } from './source.js';
import {
  MdAttributes,
  MdAuthorize,
  MdConsent,
  MdCounts,
  MdMatch,
  MdParticipation,
  MdReleased,
  MdReservation,
} from './types.js';

const PREFIX = '/api/v1/supply360';
const TIMEOUT_MS = 10_000;

/**
 * LIVE mode: MADP's signed service API. Not yet exercised against a real MADP, because no service client has been
 * issued to Supply360; the tests run it against a local stub that verifies signatures exactly as MADP does.
 */
export class LiveMadp implements AudienceSource {
  readonly mode = 'live' as const;
  private readonly origin: string;

  constructor(
    baseUrl: string,
    private readonly clientId: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {
    this.origin = baseUrl.replace(/\/+$/, '');
  }

  private async call<T extends z.ZodType>(
    method: 'GET' | 'POST' | 'DELETE',
    route: string,
    schema: T,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<z.infer<T>> {
    const path = `${PREFIX}${route}`;
    const raw = body === undefined ? '' : JSON.stringify(body);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          ...madpHeaders({ clientId: this.clientId, secret: this.secret, method, path, body: raw }),
        },
        body: body === undefined ? undefined : raw,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new AudienceError(`MADP unreachable: ${(e as Error).message}`, true);
    }
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      const said = data && typeof data === 'object' && 'message' in data ? String(data.message).slice(0, 200) : '';
      const hint =
        res.status === 401
          ? 'refused the signature or client'
          : res.status === 403
            ? `refused: ${said || 'missing scope or panel'}`
            : `HTTP ${res.status}${said ? `: ${said}` : ''}`;
      throw new AudienceError(`MADP ${hint}`, retryable, res.status);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AudienceError(`MADP ${route} has an unexpected shape`, false);
    return parsed.data;
  }

  attributes() {
    return this.call('GET', '/attributes', MdAttributes);
  }
  counts(criteria: AudienceCriteria) {
    return this.call('POST', '/counts', MdCounts, criteria);
  }
  match(q: AudienceCriteria & { projectRef: string; limit: number }) {
    return this.call('POST', '/match', MdMatch, q);
  }
  reserve(q: { projectRef: string; refs: string[]; expiresAt: string }, idempotencyKey: string) {
    return this.call('POST', '/reservations', MdReservation, q, idempotencyKey);
  }
  async release(id: string) {
    await this.call('DELETE', `/reservations/${encodeURIComponent(id)}`, MdReleased);
  }
  authorize(q: { reservationId: string; refs: string[] }, idempotencyKey: string) {
    return this.call('POST', '/invitations/authorize', MdAuthorize, q, idempotencyKey);
  }
  consent(refs: string[]) {
    return this.call('POST', '/consent/check', MdConsent, { refs, purpose: 'survey_invitation' });
  }
  participation(events: { eventId: string; invitationId: string; event: string; occurredAt: string }[]) {
    return this.call('POST', '/participation/events', MdParticipation, { events });
  }
}
