import type { ProjectSource } from '../adapter.js';
import { StProject, type StListItem } from './types.js';

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
  ].map((p) => StProject.parse(p));
}

const stores = new Map<string, StProject[]>();

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
}
