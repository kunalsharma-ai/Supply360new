/** Pure scheduling rules, so they are unit-tested without a clock or a database. */

export interface PolicyTimes {
  timezone: string;
  quietStartHour: number;
  quietEndHour: number;
}

/** Local hour and the UTC instant of local midnight for `now` in `tz`. */
export function localParts(tz: string, now: Date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const hour = Number(p.hour);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, hour, +p.minute!, +p.second!);
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  const midnight = new Date(Date.UTC(+p.year!, +p.month! - 1, +p.day!) - offset);
  return { hour, minute: Number(p.minute), midnight };
}

/** Quiet hours run from start (inclusive) to end (exclusive) and may wrap past midnight. Equal means none. */
export function inQuietHours(p: PolicyTimes, now: Date): boolean {
  if (p.quietStartHour === p.quietEndHour) return false;
  const { hour } = localParts(p.timezone, now);
  return p.quietStartHour < p.quietEndHour
    ? hour >= p.quietStartHour && hour < p.quietEndHour
    : hour >= p.quietStartHour || hour < p.quietEndHour;
}

/** When quiet hours end next, for showing people why a batch waits. */
export function quietEndsAt(p: PolicyTimes, now: Date): Date {
  const { hour, minute, midnight } = localParts(p.timezone, now);
  let ends = new Date(midnight.getTime() + p.quietEndHour * 3_600_000);
  if (hour > p.quietEndHour || (hour === p.quietEndHour && minute > 0) || ends <= now)
    ends = new Date(ends.getTime() + 86_400_000);
  return ends;
}

/** Link scanners and mail security gateways open links before people do; they must not count as clicks. */
const SCANNER =
  /(bot|crawler|spider|preview|scanner|safelinks|proofpoint|mimecast|barracuda|urldefense|slurp|facebookexternalhit|curl|wget|python-requests|headless)/i;
export const isScanner = (method: string, userAgent: string | undefined) =>
  method === 'HEAD' || !userAgent || SCANNER.test(userAgent);
