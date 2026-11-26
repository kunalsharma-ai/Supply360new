import { createHmac, timingSafeEqual } from 'node:crypto';
import { OUTCOMES, type Outcome } from '@s360/contracts';

/** Pure participation rules, unit-tested without a database. */

export type EventKind = Outcome | 'started' | 'client_approved' | 'client_rejected';
export type Source = 'samptrek_callback' | 'samptrek_sessions';

/** SampTrek status (callback `{status}` is lowercase, the sessions API is uppercase) to a participation event kind. */
export function kindOf(status: string): EventKind | null {
  const s = status.toLowerCase();
  if (s === 'started') return 'started';
  return (OUTCOMES as readonly string[]).includes(s) ? (s as Outcome) : null;
}

export interface Current {
  startedAt: Date | null;
  outcome: string | null;
  outcomeSource: string | null;
  approval: string | null;
}
export interface Change {
  /** applied | ignored:<why> | conflict */
  effect: string;
  patch: Partial<{
    startedAt: Date;
    outcome: string;
    outcomeAt: Date;
    outcomeSource: string;
    approval: string | null;
    approvalAt: Date | null;
    outcomeReportedAt: null;
  }>;
  flag?: { kind: string; detail: Record<string, unknown> };
}

/**
 * How one verified event changes an invitation's derived state. Events can arrive late, twice or out of order:
 * - a start never moves anything backwards and never comes from a click;
 * - the first final outcome sticks; a partial gives way to a final outcome;
 * - SampTrek's sessions API is the source of record, so at reconciliation it overrides a callback that disagreed,
 *   and the disagreement is flagged for a person; a disagreeing callback never overrides;
 * - a client decision only applies to a complete.
 */
export function derive(cur: Current, kind: EventKind, source: Source, at: Date): Change {
  if (kind === 'started') {
    return cur.startedAt
      ? { effect: 'ignored:already_started', patch: {} }
      : { effect: 'applied', patch: { startedAt: at } };
  }
  if (kind === 'client_approved' || kind === 'client_rejected') {
    const approval = kind === 'client_approved' ? 'approved' : 'rejected';
    if (cur.outcome !== 'complete')
      return {
        effect: 'ignored:not_a_complete',
        patch: {},
        flag: { kind: 'approval_without_complete', detail: { approval, outcome: cur.outcome } },
      };
    if (cur.approval === approval) return { effect: 'ignored:same_decision', patch: {} };
    return { effect: 'applied', patch: { approval, approvalAt: at } };
  }
  const outcome = { outcome: kind, outcomeAt: at, outcomeSource: source, outcomeReportedAt: null } as const;
  // An outcome never invents a start time: LOI comes only from a start a source reported.
  if (!cur.outcome || (cur.outcome === 'partial' && kind !== 'partial'))
    return { effect: 'applied', patch: { ...outcome } };
  if (cur.outcome === kind) return { effect: 'ignored:same_outcome', patch: {} };
  if (kind === 'partial') return { effect: 'ignored:already_final', patch: {} };
  const flag = {
    kind: 'conflicting_outcome',
    detail: { had: cur.outcome, hadFrom: cur.outcomeSource, got: kind, from: source },
  };
  if (source === 'samptrek_sessions')
    return { effect: 'conflict', patch: { ...outcome, approval: null, approvalAt: null }, flag };
  return { effect: 'conflict', patch: {}, flag };
}

/**
 * SampTrek's vendor S2S callback signature (samptrek apps/api/src/callbacks/callbacks.service.ts): hex
 * HMAC-SHA256 of `{timestamp}.{full URL}.{body}` with the vendor's callback secret, no prefix, within ±5 minutes.
 */
export function verifyCallback(
  secret: string,
  h: { timestamp?: string; signature?: string },
  url: string,
  body: string,
  nowMs = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const ts = h.timestamp ?? '';
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, reason: 'missing or malformed timestamp' };
  if (Math.abs(nowMs / 1000 - Number(ts)) > 300) return { ok: false, reason: 'timestamp outside window' };
  const want = Buffer.from(createHmac('sha256', secret).update(`${ts}.${url}.${body}`).digest('hex'));
  const got = Buffer.from(h.signature ?? '');
  return got.length === want.length && timingSafeEqual(got, want)
    ? { ok: true }
    : { ok: false, reason: 'bad signature' };
}
export function signCallback(secret: string, url: string, body = '', ts = Math.floor(Date.now() / 1000)) {
  return {
    'x-projexa-timestamp': String(ts),
    'x-projexa-signature': createHmac('sha256', secret).update(`${ts}.${url}.${body}`).digest('hex'),
  };
}

/** Incidence: completes over completes plus terminates. Quota fulls and other outcomes are shown beside it. */
export const incidence = (complete: number, terminate: number) =>
  complete + terminate ? Math.round((complete / (complete + terminate)) * 1000) / 10 : null;

const q = (s: number[], p: number) =>
  s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]! : null;
/** LOI of completes in minutes: count, quartiles and a histogram in whole-minute buckets (last bucket open-ended). */
export function loiStats(seconds: number[], buckets = 12) {
  const m = seconds.map((x) => x / 60).sort((a, b) => a - b);
  const r = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  const hist = Array.from({ length: buckets }, (_, i) => ({
    from: i * Math.max(1, Math.ceil((m.at(-1) ?? buckets) / buckets)),
    n: 0,
  }));
  const width = hist[1]!.from - hist[0]!.from;
  for (const x of m) hist[Math.min(buckets - 1, Math.floor(x / width))]!.n++;
  return {
    n: m.length,
    p25: r(q(m, 0.25)),
    median: r(q(m, 0.5)),
    p75: r(q(m, 0.75)),
    histogram: hist,
    bucketMinutes: width,
  };
}

/** A complete faster than `percent`% of the expected LOI. */
export const isSpeeder = (loiSeconds: number, expectedMinutes: number, percent: number) =>
  loiSeconds < (expectedMinutes * 60 * percent) / 100;
