/**
 * Module 11, delivery intelligence (spec §6). Pure functions, unit-tested without a database.
 *
 * Planning formula: invitations needed = remaining completes ÷ (start rate × qualification rate × qualified-to-complete rate).
 * Denominators:
 *   start rate              = sessions started ÷ invitations sent (sent more than START_WINDOW_HOURS ago, so recent sends do not drag it down)
 *   qualification rate      = (complete + quality_fail) ÷ (complete + quality_fail + terminate): sessions with a screening decision
 *   qualified-to-complete   = complete ÷ (complete + quality_fail)
 * Quota-full, duplicate, security and technical outcomes are not screening decisions and are left out of both.
 * Qualification is applied once: it is not multiplied in again from a source IR.
 * Ranges come from 90% Wilson intervals on each rate. Below MIN_SAMPLE a rate falls back to a labelled assumption.
 */
export const MODEL_VERSION = 'delivery-forecast-v1';
export const MIN_SAMPLE = { sent: 100, screened: 30, qualified: 20 } as const;
export const Z90 = 1.645;

export interface Counts {
  sent: number;
  started: number;
  complete: number;
  terminate: number;
  quota_full: number;
  quality_fail: number;
  approved: number;
  rejected: number;
}
export interface Assumptions {
  /** Cold-start values a person set, used only while a rate has too little data. Fractions 0..1. */
  startRate: number;
  qualificationRate: number;
  qualifiedToComplete: number;
}
export const DEFAULT_ASSUMPTIONS: Assumptions = { startRate: 0.1, qualificationRate: 0.5, qualifiedToComplete: 0.9 };

export interface Rate {
  value: number;
  low: number;
  high: number;
  numerator: number;
  denominator: number;
  basis: 'observed' | 'assumption' | 'source_brief';
}

export function wilson(k: number, n: number, z = Z90): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

function rate(k: number, n: number, min: number, fallback: number, fallbackBasis: Rate['basis'] = 'assumption'): Rate {
  if (n >= min) {
    const w = wilson(k, n);
    return { value: k / n, ...w, numerator: k, denominator: n, basis: 'observed' };
  }
  // A fallback is shown as a point value with a wide band, never as data.
  return {
    value: fallback,
    low: fallback * 0.5,
    high: Math.min(1, fallback * 1.5),
    numerator: k,
    denominator: n,
    basis: fallbackBasis,
  };
}

export interface ForecastInput {
  counts: Counts;
  /** Invitations sent long enough ago to have had a fair chance to start, and how many of them started. */
  matured: { sent: number; started: number };
  target: number | null;
  daysLeft: number | null;
  /** Completes in the last 72 hours. */
  recentCompletes: number;
  /** Held people not invited yet, the most that can be sent without a new reservation. */
  heldNotInvited: number;
  /** SampTrek's brief IR in percent, used before there is enough screening data. */
  briefIrPercent: number | null;
  assumptions: Assumptions;
}

export type Risk = 'reached' | 'on_track' | 'at_risk' | 'off_track' | 'no_deadline' | 'not_enough_data';

export interface Forecast {
  modelVersion: string;
  rates: { start: Rate; qualification: Rate; qualifiedToComplete: Rate };
  completesPerInvite: { value: number; low: number; high: number };
  remaining: { provisional: number | null; approved: number | null };
  invitationsNeeded: { value: number; low: number; high: number } | null;
  heldNotInvited: number;
  shortfall: number | null;
  pace: { perDay: number; neededPerDay: number | null };
  projectedCompletesByDeadline: { low: number; high: number } | null;
  risk: Risk;
  assumptionsUsed: string[];
  sampleSizes: { sent: number; matured: number; screened: number; qualified: number };
}

export function forecast(i: ForecastInput): Forecast {
  const c = i.counts;
  const screened = c.complete + c.quality_fail + c.terminate;
  const qualified = c.complete + c.quality_fail;
  const brief = i.briefIrPercent != null && i.briefIrPercent > 0 ? i.briefIrPercent / 100 : null;
  const start = rate(i.matured.started, i.matured.sent, MIN_SAMPLE.sent, i.assumptions.startRate);
  const qualification = rate(
    qualified,
    screened,
    MIN_SAMPLE.screened,
    brief ?? i.assumptions.qualificationRate,
    brief ? 'source_brief' : 'assumption',
  );
  const q2c = rate(c.complete, qualified, MIN_SAMPLE.qualified, i.assumptions.qualifiedToComplete);
  const cpi = {
    value: start.value * qualification.value * q2c.value,
    low: start.low * qualification.low * q2c.low,
    high: start.high * qualification.high * q2c.high,
  };
  const remaining =
    i.target == null
      ? { provisional: null, approved: null }
      : {
          provisional: Math.max(0, i.target - c.complete),
          // Approved-only view: a client rejection removes a complete, pending ones are not counted yet.
          approved: Math.max(0, i.target - c.approved),
        };
  const need = (r: number | null, per: number) => (r == null ? null : per > 0 ? Math.ceil(r / per) : Infinity);
  const invitationsNeeded =
    remaining.provisional == null
      ? null
      : {
          value: need(remaining.provisional, cpi.value)!,
          // Fewer invitations if rates come in high, more if low.
          low: need(remaining.provisional, cpi.high)!,
          high: need(remaining.provisional, cpi.low)!,
        };
  const perDay = Math.round((i.recentCompletes / 3) * 10) / 10;
  const neededPerDay =
    remaining.provisional == null || i.daysLeft == null
      ? null
      : i.daysLeft <= 0
        ? remaining.provisional
        : Math.round((remaining.provisional / i.daysLeft) * 10) / 10;
  const used = [start, qualification, q2c]
    .map((r, k) => [r, ['start rate', 'qualification rate', 'qualified-to-complete rate'][k]] as const)
    .filter(([r]) => r.basis !== 'observed')
    .map(
      ([r, n]) =>
        `${n}: ${r.basis === 'source_brief' ? 'from the SampTrek brief IR' : 'cold-start assumption'} ${pct(r.value)}`,
    );
  const observedEnough = used.length === 0;
  let risk: Risk;
  if (remaining.provisional === 0) risk = 'reached';
  else if (i.daysLeft == null || remaining.provisional == null) risk = 'no_deadline';
  else if (!observedEnough && c.complete === 0) risk = 'not_enough_data';
  else if (neededPerDay != null && perDay >= neededPerDay) risk = 'on_track';
  else if (neededPerDay != null && perDay >= neededPerDay * 0.7) risk = 'at_risk';
  else risk = 'off_track';
  const days = i.daysLeft != null && i.daysLeft > 0 ? i.daysLeft : 0;
  const projected =
    i.daysLeft == null
      ? null
      : {
          low: c.complete + Math.floor(Math.min(perDay * days, i.heldNotInvited * cpi.low)),
          high: c.complete + Math.floor(perDay * days + i.heldNotInvited * cpi.high),
        };
  return {
    modelVersion: MODEL_VERSION,
    rates: { start, qualification, qualifiedToComplete: q2c },
    completesPerInvite: cpi,
    remaining,
    invitationsNeeded,
    heldNotInvited: i.heldNotInvited,
    shortfall:
      invitationsNeeded && Number.isFinite(invitationsNeeded.value)
        ? Math.max(0, invitationsNeeded.value - i.heldNotInvited)
        : null,
    pace: { perDay, neededPerDay },
    projectedCompletesByDeadline: projected,
    risk,
    assumptionsUsed: used,
    sampleSizes: { sent: c.sent, matured: i.matured.sent, screened, qualified },
  };
}

export const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/**
 * A recommendation for the next batch: enough invitations for one day of the needed pace, inside the policy limits and the
 * people held. Deterministic limits decide what is actually sent.
 */
export function recommendBatch(f: Forecast, limits: { batchSize: number; dailyMaxLeft: number }) {
  if (f.risk === 'reached' || !f.invitationsNeeded) return { size: 0, why: 'Nothing more is needed.' };
  const perDayNeed = f.pace.neededPerDay ?? 0;
  const forDay = f.completesPerInvite.value > 0 ? Math.ceil(perDayNeed / f.completesPerInvite.value) : 0;
  const raw = Math.min(forDay || f.invitationsNeeded.value, f.invitationsNeeded.value);
  const size = Math.max(0, Math.min(raw, limits.batchSize, limits.dailyMaxLeft, f.heldNotInvited));
  const caps = [
    raw > limits.batchSize && `the batch size limit (${limits.batchSize})`,
    raw > limits.dailyMaxLeft && `what is left of today's maximum (${limits.dailyMaxLeft})`,
    raw > f.heldNotInvited && `the people held (${f.heldNotInvited})`,
  ].filter(Boolean);
  return {
    size,
    why: `About ${raw} invitations cover one day of the needed pace at ${pct(f.completesPerInvite.value)} completes per invitation${caps.length ? `, capped by ${caps.join(' and ')}` : ''}.`,
  };
}

export interface CellInput {
  id: string;
  name: string;
  countryCode: string;
  target: number | null;
  complete: number;
  terminate: number;
  isOpen: boolean;
}

/** A quota cell is under-performing when it is behind the share of field time used, by more than 20 points. */
export function underperforming(cells: CellInput[], fieldShareUsed: number | null) {
  if (fieldShareUsed == null) return [];
  return cells
    .filter((c) => c.isOpen && c.target && c.target > 0)
    .map((c) => ({ ...c, progress: c.complete / c.target! }))
    .filter((c) => c.progress < 1 && fieldShareUsed - c.progress > 0.2)
    .map((c) => ({
      id: c.id,
      name: c.name,
      countryCode: c.countryCode,
      target: c.target!,
      complete: c.complete,
      progress: Math.round(c.progress * 1000) / 10,
      expected: Math.round(fieldShareUsed * 1000) / 10,
      incidence:
        c.complete + c.terminate > 0 ? Math.round((c.complete / (c.complete + c.terminate)) * 1000) / 10 : null,
    }))
    .sort((a, b) => a.progress - a.expected - (b.progress - b.expected));
}
