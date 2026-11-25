import type { LaunchCheck } from '@s360/contracts';

interface P {
  sourceStatus: string;
  fieldEndAt: Date | null;
}
interface M {
  countryCode: string;
  sourceStatus: string;
  loiMinutes: number | null;
  irPercent: number | null;
  targetCompletes: number;
  vendorLinkId: string | null;
  vendorLinkStatus: string | null;
  vendorTarget: number | null;
  entryUrl: string | null;
}

/**
 * Launch validation (spec §4). Only markets where Supply360 has its own vendor link count: the others belong to
 * other vendors. Checks owned by later phases are listed with `pendingPhase` so people see what is still to come.
 */
export function launchChecks(p: P, markets: M[], now = new Date()): LaunchCheck[] {
  const mine = markets.filter((m) => m.vendorLinkId);
  const missing = (pred: (m: M) => boolean) =>
    mine
      .filter((m) => !pred(m))
      .map((m) => m.countryCode)
      .join(', ');
  const per = (key: string, label: string, pred: (m: M) => boolean): LaunchCheck => {
    const bad = mine.length ? missing(pred) : '';
    return { key, label, ok: mine.length > 0 && !bad, ...(bad ? { detail: `Missing in ${bad}` } : {}) };
  };
  return [
    {
      key: 'source_status',
      label: 'SampTrek status is LIVE or TEST',
      ok: p.sourceStatus === 'LIVE' || p.sourceStatus === 'TEST',
      detail: `SampTrek shows ${p.sourceStatus}`,
    },
    {
      key: 'vendor_link',
      label: 'Supply360 is a vendor in at least one market',
      ok: mine.length > 0,
      ...(mine.length ? {} : { detail: 'Ask the SampTrek project manager to add Supply360 as a vendor' }),
    },
    per('vendor_link_active', "Supply360's vendor link is ACTIVE", (m) => m.vendorLinkStatus === 'ACTIVE'),
    per('target', 'Target completes are set', (m) => (m.vendorTarget ?? m.targetCompletes) > 0),
    per('loi_ir', 'LOI and IR are set', (m) => m.loiMinutes != null && m.loiMinutes > 0 && m.irPercent != null),
    per('entry_link', 'Entry link approved by a person', (m) => !!m.entryUrl),
    {
      key: 'field_dates',
      label: 'Field end date has not passed',
      ok: !p.fieldEndAt || p.fieldEndAt > now,
      ...(p.fieldEndAt && p.fieldEndAt <= now ? { detail: `Ended ${p.fieldEndAt.toISOString().slice(0, 10)}` } : {}),
    },
    { key: 'quota_map', label: 'Quotas mapped to MADP attributes', ok: false, pendingPhase: 3 },
    { key: 'audience', label: 'Audience selected and reserved', ok: false, pendingPhase: 3 },
  ];
}
