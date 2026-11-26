import { createHash, randomUUID } from 'node:crypto';
import type { AudienceCriteria, PanelCode } from '@s360/contracts';
import { AudienceError, type AudienceSource } from './source.js';
import type { MdAttributes, MdCounts, MdMatch, MdReservation } from './types.js';

/**
 * FIXTURE mode: a labelled DEMO population answering exactly like MADP's service API, used until MADP issues
 * Supply360 a service client. Nobody here is real. The population is generated from a fixed seed, so counts are
 * the same on every run, and many people belong to more than one panel, which is what the overlap rules are for.
 */
const POPULATION = 6000;
const MIN_CELL = 5; // MADP's MIN_CELL_SIZE default.
const MAX_RESERVATION_DAYS = 14;

const PANELS: PanelCode[] = ['t2o', 'mfr', 'mho'];
const COUNTRIES: [string, number][] = [
  ['US', 30],
  ['IN', 22],
  ['GB', 18],
  ['DE', 12],
  ['FR', 8],
  ['CA', 6],
  ['AU', 4],
];

/** Canonical attribute keys from MADP's catalogue (madp apps/api/src/ingestion/canonical.ts). */
const ATTRIBUTES: {
  key: string;
  label: string;
  sensitivity: 'standard' | 'personal' | 'special_category';
  values: string[];
}[] = [
  {
    key: 'demographics.gender',
    label: 'Gender (self-reported)',
    sensitivity: 'personal',
    values: ['female', 'male', 'non_binary'],
  },
  {
    key: 'household.income_band',
    label: 'Household income band',
    sensitivity: 'personal',
    values: ['low', 'lower_middle', 'middle', 'upper_middle', 'high'],
  },
  { key: 'location.urbanicity', label: 'Urbanicity', sensitivity: 'standard', values: ['urban', 'suburban', 'rural'] },
  {
    key: 'consumer.education_level',
    label: 'Education level',
    sensitivity: 'standard',
    values: ['secondary', 'bachelor', 'postgraduate'],
  },
  {
    key: 'b2b.job_role',
    label: 'Job role',
    sensitivity: 'standard',
    values: ['it_decision_maker', 'finance', 'hr', 'marketing', 'operations', 'c_suite'],
  },
  {
    key: 'b2b.org_size',
    label: 'Organisation size',
    sensitivity: 'standard',
    values: ['1-49', '50-249', '250-999', '1000+'],
  },
  // Listed by MADP only to clients with health.aggregate; Supply360 refuses it either way. Nobody holds a value.
  { key: 'demographics.ethnicity', label: 'Ethnicity (self-reported)', sensitivity: 'special_category', values: [] },
];

interface Membership {
  id: string;
  person: number;
  panel: PanelCode;
  categories: string[];
  /** Why MADP's contact gate would turn this membership away, if it would. */
  gate: string | null;
}
interface Person {
  n: number;
  country: string;
  verified: boolean;
  attrs: Record<string, string>;
  memberships: Membership[];
}

/** mulberry32: small, fast and deterministic. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;
const weighted = (r: () => number, xs: [string, number][]) => {
  let x = r() * xs.reduce((a, [, w]) => a + w, 0);
  for (const [v, w] of xs) if ((x -= w) < 0) return v;
  return xs.at(-1)![0];
};

let population: Person[] | null = null;
export function fixturePopulation(): Person[] {
  if (population) return population;
  const r = rng(360_003);
  population = Array.from({ length: POPULATION }, (_, n) => {
    const business = r() < 0.25;
    const hcp = r() < 0.04;
    const panels = PANELS.filter((_, i) => r() < [0.75, 0.4, 0.2][i]!);
    if (!panels.length) panels.push('t2o');
    const attrs: Record<string, string> = {
      'demographics.gender': r() < 0.04 ? 'non_binary' : r() < 0.5 ? 'female' : 'male',
      'household.income_band': pick(r, ATTRIBUTES[1]!.values),
      'location.urbanicity': weighted(r, [
        ['urban', 45],
        ['suburban', 35],
        ['rural', 20],
      ]),
      'consumer.education_level': pick(r, ATTRIBUTES[3]!.values),
    };
    if (business) {
      attrs['b2b.job_role'] = pick(r, ATTRIBUTES[4]!.values);
      attrs['b2b.org_size'] = pick(r, ATTRIBUTES[5]!.values);
    }
    const memberships = panels.map((panel): Membership => {
      const g = r();
      return {
        id: `fx-m-${n}-${panel}`,
        person: n,
        panel,
        categories: [
          'consumer',
          ...(business && panel !== 'mho' ? ['business_professional'] : []),
          ...(hcp && panel === 'mho' ? ['healthcare_professional'] : []),
        ],
        gate: g < 0.04 ? 'opted_out' : g < 0.06 ? 'bounced_or_complained' : g < 0.09 ? 'frequency_cap_week' : null,
      };
    });
    return { n, country: weighted(r, COUNTRIES), verified: r() < 0.85, attrs, memberships };
  });
  return population;
}

/** MADP issues one stable reference per panel membership. */
export const fixtureRef = (membershipId: string) =>
  `ref_${createHash('sha256').update(`fixture:${membershipId}`).digest('base64url').slice(0, 24)}`;

let refs: Map<string, string> | null = null;
const refIndex = () => {
  if (refs) return refs;
  refs = new Map();
  for (const p of fixturePopulation()) for (const m of p.memberships) refs.set(fixtureRef(m.id), m.id);
  return refs;
};

interface Hold {
  id: string;
  projectRef: string;
  expiresAt: number;
  status: 'active' | 'released';
  memberships: Set<string>;
}
interface Store {
  holds: Map<string, Hold>;
  idem: Map<string, MdReservation>;
}
const stores = new Map<string, Store>();
const storeFor = (connectionId: string) => {
  let s = stores.get(connectionId);
  if (!s) stores.set(connectionId, (s = { holds: new Map(), idem: new Map() }));
  return s;
};

export class FixtureMadp implements AudienceSource {
  readonly mode = 'fixture' as const;
  constructor(private readonly connectionId: string) {}

  private get store() {
    return storeFor(this.connectionId);
  }

  async attributes(): Promise<MdAttributes> {
    return {
      categories: ['consumer', 'business_professional', 'healthcare_professional', 'patient', 'caregiver'],
      attributes: ATTRIBUTES.map((a) => ({ ...a, values: [...a.values] })),
    };
  }

  /** Memberships matching the criteria: AND across attribute filters, OR within one filter's values. */
  private hits(c: AudienceCriteria) {
    const known = new Set(ATTRIBUTES.map((a) => a.key));
    for (const f of c.attributes ?? [])
      if (!known.has(f.key)) throw new AudienceError(`MADP HTTP 404: Unknown attribute ${f.key}`, false, 404);
    const out: { p: Person; m: Membership }[] = [];
    for (const p of fixturePopulation()) {
      if (c.countries?.length && !c.countries.includes(p.country)) continue;
      if (c.verifiedEmailOnly && !p.verified) continue;
      if (c.attributes?.some((f) => !f.values.includes(p.attrs[f.key] ?? ''))) continue;
      for (const m of p.memberships) {
        if (c.panels?.length && !c.panels.includes(m.panel)) continue;
        if (c.categories?.length && !m.categories.some((x) => c.categories!.includes(x as never))) continue;
        out.push({ p, m });
      }
    }
    return out;
  }

  async counts(c: AudienceCriteria): Promise<MdCounts> {
    const hits = this.hits(c);
    const people = new Set(hits.map((h) => h.p.n));
    const group = (f: (h: (typeof hits)[number]) => string[]) => {
      const by = new Map<string, Set<number>>();
      for (const h of hits) for (const k of f(h)) (by.get(k) ?? by.set(k, new Set()).get(k)!).add(h.p.n);
      return [...by.entries()].map(([key, s]) => {
        const v = s.size;
        const suppressed = v > 0 && v < MIN_CELL;
        return { key, value: suppressed ? null : v, suppressed };
      });
    };
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
    const cats = new Set(
      hits.flatMap((h) =>
        h.m.categories
          .filter((x) => !c.categories?.length || c.categories.includes(x as never))
          .map((x) => `${h.p.n}:${x}`),
      ),
    );
    const synced = new Date(Date.now() - 3_600_000).toISOString();
    return {
      dataMode: 'demo',
      uniquePeople: people.size,
      panelMemberships: hits.length,
      categoryMemberships: cats.size,
      byPanel: group((h) => [h.m.panel]).sort(byKey),
      byCategory: group((h) => h.m.categories).sort(byKey),
      byCountry: group((h) => [h.p.country]).sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || byKey(a, b)),
      minimumCellSize: MIN_CELL,
      computedAt: new Date().toISOString(),
      freshestSourceSyncAt: synced,
      oldestSourceSyncAt: synced,
      ...(c.attributes?.length
        ? {
            attributeFilters: c.attributes.map((f) => ({
              key: f.key,
              sensitivity: ATTRIBUTES.find((a) => a.key === f.key)!.sensitivity,
              approvedMappings: 3,
              panels: [...PANELS],
            })),
          }
        : {}),
    };
  }

  private heldElsewhere(projectRef: string, now = Date.now()) {
    const held = new Set<string>();
    for (const h of this.store.holds.values())
      if (h.status === 'active' && h.expiresAt > now && h.projectRef !== projectRef)
        for (const m of h.memberships) held.add(m);
    return held;
  }

  async match(q: AudienceCriteria & { projectRef: string; limit: number }): Promise<MdMatch> {
    const held = this.heldElsewhere(q.projectRef);
    const excluded: Record<string, number> = {};
    const eligible: Membership[] = [];
    for (const { m } of this.hits(q)) {
      const reason = m.gate ?? (held.has(m.id) ? 'reserved_elsewhere' : null);
      if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
      else eligible.push(m);
    }
    // MADP orders by md5(membership || projectRef): stable for one project, different across projects.
    const order = new Map(
      eligible.map((m) => [
        m,
        createHash('md5')
          .update(m.id + q.projectRef)
          .digest('hex'),
      ]),
    );
    eligible.sort((a, b) => (order.get(a)! < order.get(b)! ? -1 : 1));
    const enough = eligible.length >= MIN_CELL;
    const picked = enough ? eligible.slice(0, q.limit) : [];
    const people = fixturePopulation();
    return {
      dataMode: 'demo',
      projectRef: q.projectRef,
      eligible: enough ? eligible.length : null,
      suppressed: !enough,
      minimumCellSize: MIN_CELL,
      returned: picked.length,
      excluded,
      members: picked.map((m) => ({
        ref: fixtureRef(m.id),
        panel: m.panel,
        categories: m.categories,
        country: people[m.person]!.country,
      })),
    };
  }

  async reserve(q: { projectRef: string; refs: string[]; expiresAt: string }, key: string): Promise<MdReservation> {
    const prior = this.store.idem.get(key);
    if (prior) return structuredClone(prior);
    const expiresAt = Date.parse(q.expiresAt);
    if (!(expiresAt > Date.now()) || expiresAt > Date.now() + MAX_RESERVATION_DAYS * 86_400_000)
      throw new AudienceError('MADP HTTP 400: expiresAt must be in the future and at most 14 days ahead', false, 400);
    const byRef = refIndex();
    const elsewhere = this.heldElsewhere(q.projectRef);
    const refused: MdReservation['refused'] = [];
    const memberships = new Set<string>();
    for (const ref of q.refs) {
      const m = byRef.get(ref);
      if (!m) refused.push({ ref, reason: 'unknown_ref' });
      else if (elsewhere.has(m)) refused.push({ ref, reason: 'reserved_elsewhere' });
      else memberships.add(m);
    }
    const id = randomUUID();
    this.store.holds.set(id, { id, projectRef: q.projectRef, expiresAt, status: 'active', memberships });
    const out: MdReservation = {
      reservationId: id,
      projectRef: q.projectRef,
      expiresAt: new Date(expiresAt).toISOString(),
      held: memberships.size,
      refused,
    };
    this.store.idem.set(key, out);
    return structuredClone(out);
  }

  async release(id: string) {
    const h = this.store.holds.get(id);
    if (!h) throw new AudienceError('MADP HTTP 404: No such reservation', false, 404);
    if (h.status !== 'active') throw new AudienceError(`MADP HTTP 409: This reservation is ${h.status}`, false, 409);
    h.status = 'released';
  }
}
