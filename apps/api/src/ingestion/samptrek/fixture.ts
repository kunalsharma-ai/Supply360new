import type { SourceSession } from './types.js';
import type { ProjectSource } from '../adapter.js';
import { StProject, StQuotas, type StListItem } from './types.js';

/**
 * FIXTURE mode: labelled sample projects shaped exactly like SampTrek's public API, used until a live key is
 * verified. Nothing here is real client data. Each connection gets its own copy, so tests and demos can change a
 * project (for example put it on HOLD) and watch Supply360 react, the same way a live SampTrek change would arrive.
 */
const now = Date.now();
const day = 86_400_000;
const iso = (offsetDays: number) => new Date(now + offsetDays * day).toISOString();

export const FIXTURE_VENDOR_CODE = 'S360';

function link(id: string, status: string, target: number, completes: number) {
  return { id, status, targetCompletes: target, completes, vendor: { id: 'v-s360', name: 'Supply360', code: 'S360' } };
}
const other = (id: string) => ({
  id,
  status: 'ACTIVE',
  targetCompletes: 100,
  completes: 12,
  vendor: { id: 'v-other', name: 'Another vendor', code: 'OTH' },
});

export function fixtureProjects(): StProject[] {
  return [
    {
      id: 'fx-prj-10001',
      projectCode: 'PRX10001',
      name: 'FIXTURE · Grocery shopper tracker Q1',
      type: 'TRACKER',
      category: 'Retail',
      status: 'LIVE',
      fieldStartAt: iso(-3),
      fieldEndAt: iso(18),
      updatedAt: iso(-1),
      client: { name: 'FIXTURE Client A' },
      projectManager: { name: 'FIXTURE PM' },
      markets: [
        {
          countryCode: 'US',
          language: 'en',
          targetGroup: 'Adults 18+, main grocery shopper',
          status: 'LIVE',
          loiMinutes: 12,
          irPercent: 45,
          targetCompletes: 800,
          completes: 214,
          vendorLinks: [link('fx-vl-1', 'ACTIVE', 400, 96), other('fx-vl-2')],
        },
        {
          countryCode: 'GB',
          language: 'en',
          targetGroup: 'Adults 18+, main grocery shopper',
          status: 'LIVE',
          loiMinutes: 12,
          irPercent: 40,
          targetCompletes: 400,
          completes: 88,
          vendorLinks: [link('fx-vl-3', 'ACTIVE', 200, 41)],
        },
      ],
    },
    {
      id: 'fx-prj-10002',
      projectCode: 'PRX10002',
      name: 'FIXTURE · EV purchase intent',
      type: 'ADHOC',
      category: 'Automotive',
      status: 'TEST',
      fieldStartAt: iso(2),
      fieldEndAt: iso(20),
      updatedAt: iso(-2),
      client: { name: 'FIXTURE Client B' },
      projectManager: { name: 'FIXTURE PM' },
      markets: [
        {
          countryCode: 'DE',
          language: 'de',
          targetGroup: 'Car owners intending to buy in 12 months',
          status: 'TEST',
          loiMinutes: 18,
          irPercent: 22,
          targetCompletes: 300,
          completes: 0,
          vendorLinks: [link('fx-vl-4', 'ACTIVE', 300, 0)],
        },
      ],
    },
    {
      id: 'fx-prj-10003',
      projectCode: 'PRX10003',
      name: 'FIXTURE · Streaming habits (on hold)',
      type: 'ADHOC',
      category: 'Media',
      status: 'HOLD',
      fieldStartAt: iso(-10),
      fieldEndAt: iso(5),
      updatedAt: iso(-4),
      client: { name: 'FIXTURE Client C' },
      projectManager: { name: 'FIXTURE PM' },
      markets: [
        {
          countryCode: 'IN',
          language: 'en',
          targetGroup: 'Adults 18-45 with a streaming subscription',
          status: 'HOLD',
          loiMinutes: 10,
          irPercent: 60,
          targetCompletes: 1000,
          completes: 412,
          vendorLinks: [link('fx-vl-5', 'PAUSED', 500, 230)],
        },
      ],
    },
    {
      id: 'fx-prj-10004',
      projectCode: 'PRX10004',
      name: 'FIXTURE · Grocery shopper tracker Q2 (recontact wave)',
      type: 'TRACKER',
      category: 'Retail',
      status: 'TEST',
      fieldStartAt: iso(5),
      fieldEndAt: iso(30),
      updatedAt: iso(-5),
      client: { name: 'FIXTURE Client A' },
      projectManager: { name: 'FIXTURE PM' },
      markets: [
        {
          countryCode: 'US',
          language: 'en',
          targetGroup: 'Q1 participants, main grocery shopper',
          status: 'TEST',
          loiMinutes: 12,
          irPercent: 70,
          targetCompletes: 300,
          completes: 0,
          vendorLinks: [link('fx-vl-6', 'ACTIVE', 300, 0)],
        },
      ],
    },
  ].map((p) => StProject.parse(p));
}

/** Quota cells, shaped like SampTrek's `GET /projects/{ref}/quotas`. Markets without cells are listed empty. */
const FIXTURE_CELLS: Record<string, Record<string, StQuotas['markets'][number]['cells']>> = {
  PRX10001: {
    US: [
      {
        id: 'fx-q-us-f',
        group: 'Gender',
        name: 'Female',
        conditions: [{ source: 'gate', questionId: 'q_gender', values: ['female'] }],
        target: 400,
        completes: 110,
        isOpen: true,
      },
      {
        id: 'fx-q-us-m',
        group: 'Gender',
        name: 'Male',
        conditions: [{ source: 'gate', questionId: 'q_gender', values: ['male'] }],
        target: 400,
        completes: 104,
        isOpen: true,
      },
    ],
  },
};

const cellStores = new Map<string, typeof FIXTURE_CELLS>();
/** The mutable quota cells behind one connection, so tests and demos can change a cell like SampTrek would. */
export function fixtureCells(connectionId: string) {
  let s = cellStores.get(connectionId);
  if (!s) cellStores.set(connectionId, (s = structuredClone(FIXTURE_CELLS)));
  return s;
}

export function fixtureQuotas(p: StProject, cells = FIXTURE_CELLS): StQuotas {
  return StQuotas.parse({
    projectCode: p.projectCode,
    markets: p.markets.map((m) => ({
      countryCode: m.countryCode,
      targetCompletes: m.targetCompletes,
      completes: m.completes,
      cells: cells[p.projectCode]?.[m.countryCode] ?? [],
    })),
  });
}

const stores = new Map<string, StProject[]>();
const sessionStores = new Map<string, Map<string, SourceSession & { projectCode: string; vendorCode: string }>>();

/**
 * FIXTURE respondent sessions behind one connection, by session id. The simulator adds one when it plays a
 * respondent finishing a survey, and a person can play the client approving or rejecting completes.
 */
export function fixtureSessions(connectionId: string) {
  let s = sessionStores.get(connectionId);
  if (!s) sessionStores.set(connectionId, (s = new Map()));
  return s;
}

/** The mutable fixture copy behind one connection. */
export function fixtureStore(connectionId: string): StProject[] {
  let s = stores.get(connectionId);
  if (!s) stores.set(connectionId, (s = fixtureProjects()));
  return s;
}

export class FixtureSampTrek implements ProjectSource {
  readonly mode = 'fixture' as const;
  constructor(private readonly connectionId: string) {}

  async listProjects(q: { updatedSince?: Date; cursor?: string | null }) {
    const all = fixtureStore(this.connectionId)
      .filter((p) => !q.updatedSince || new Date(p.updatedAt) >= q.updatedSince)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const start = q.cursor ? all.findIndex((p) => p.id === q.cursor) + 1 : 0;
    const page = all.slice(start, start + 2);
    const data: StListItem[] = page.map(({ id, projectCode, name, status, updatedAt }) => ({
      id,
      projectCode,
      name,
      status,
      updatedAt,
    }));
    return { data, nextCursor: start + 2 < all.length ? page.at(-1)!.id : null };
  }

  async getProject(ref: string) {
    const p = fixtureStore(this.connectionId).find((x) => x.id === ref || x.projectCode === ref.toUpperCase());
    return p ? structuredClone(p) : null;
  }

  async getQuotas(ref: string) {
    const p = await this.getProject(ref);
    return p ? fixtureQuotas(p, fixtureCells(this.connectionId)) : null;
  }

  async getSessions(ref: string, vendorCode: string, since?: Date) {
    const p = await this.getProject(ref);
    if (!p) return null;
    return [...fixtureSessions(this.connectionId).values()]
      .filter((x) => x.projectCode === p.projectCode && x.vendorCode === vendorCode)
      .filter((x) => !since || (x.outcomeAt && new Date(x.outcomeAt) >= since))
      .map(({ projectCode: _p, vendorCode: _v, ...s }) => ({ ...s }));
  }
}
