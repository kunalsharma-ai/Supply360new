import type { AllocationMode, AudienceCriteria, LaunchCheck } from '@s360/contracts';
import { auditLogs, projectMarkets, quotaCells, reservedRefs, type Tx } from '@s360/db';
import { createHash } from 'node:crypto';
import { and, count, eq, gt, inArray } from 'drizzle-orm';
import type { NormalizedMarket } from '../ingestion/normalize.js';
import { stableJson } from '../ingestion/normalize.js';
import type { StQuotas } from '../ingestion/samptrek/types.js';

export const MARKET_CELL = '_market';
type CellRow = typeof quotaCells.$inferSelect;
type MarketRow = typeof projectMarkets.$inferSelect;

const hashOf = (v: unknown) => createHash('sha256').update(stableJson(v)).digest('hex');

/**
 * Brings a project's quota cells in line with SampTrek, inside the ingestion transaction. Only Supply360's own
 * vendor markets get cells. A market without cells at the source gets one whole-market cell. When a cell's
 * conditions change at the source, its MADP mapping is cleared: a person has to look at it again.
 */
export async function upsertCells(
  tx: Tx,
  tenantId: string,
  projectId: string,
  markets: NormalizedMarket[],
  quotas: StQuotas,
): Promise<{ cleared: string[] }> {
  const existing = await tx.select().from(quotaCells).where(eq(quotaCells.projectId, projectId));
  const desired = markets
    .filter((m) => m.vendorLinkId)
    .flatMap((m) => {
      const cells = quotas.markets.find((q) => q.countryCode === m.countryCode)?.cells ?? [];
      if (!cells.length)
        return [
          {
            countryCode: m.countryCode,
            sourceCellId: MARKET_CELL,
            groupName: '',
            name: 'Whole market',
            conditions: [] as unknown,
            sourceTarget: m.targetCompletes,
            sourceCompletes: m.completes,
            isOpen: true,
          },
        ];
      return cells.map((c) => ({
        countryCode: m.countryCode,
        sourceCellId: c.id,
        groupName: c.group ?? '',
        name: c.name,
        conditions: c.conditions ?? [],
        sourceTarget: c.target,
        sourceCompletes: c.completes,
        isOpen: c.isOpen,
      }));
    });

  const key = (c: { countryCode: string; sourceCellId: string }) => `${c.countryCode}/${c.sourceCellId}`;
  const before = new Map(existing.map((c) => [key(c), c]));
  const cleared: string[] = [];
  for (const d of desired) {
    const conditionsHash = hashOf(d.conditions);
    const prev = before.get(key(d));
    const changed = !!prev && prev.conditionsHash !== conditionsHash;
    if (changed && prev.criteria) cleared.push(prev.id);
    await tx
      .insert(quotaCells)
      .values({ tenantId, projectId, ...d, conditionsHash })
      .onConflictDoUpdate({
        target: [quotaCells.projectId, quotaCells.countryCode, quotaCells.sourceCellId],
        set: {
          groupName: d.groupName,
          name: d.name,
          conditions: d.conditions,
          conditionsHash,
          sourceTarget: d.sourceTarget,
          sourceCompletes: d.sourceCompletes,
          isOpen: d.isOpen,
          removed: false,
          ...(changed ? { criteria: null, mappedBy: null, mappedAt: null } : {}),
          updatedAt: new Date(),
        },
      });
  }
  const keep = new Set(desired.map(key));
  const gone = existing.filter((c) => !keep.has(key(c)) && !c.removed).map((c) => c.id);
  if (gone.length)
    await tx
      .update(quotaCells)
      .set({ removed: true, isOpen: false, updatedAt: new Date() })
      .where(inArray(quotaCells.id, gone));
  for (const id of cleared)
    await tx.insert(auditLogs).values({
      tenantId,
      actorId: null,
      actorEmail: 'system:samptrek',
      action: 'quota.mapping_cleared',
      targetType: 'quota_cell',
      targetId: id,
      reason: 'SampTrek changed the cell conditions',
      details: { projectId },
    });
  return { cleared };
}

export interface CellState extends CellRow {
  held: number;
  allocation: number;
  suggestedCap: number;
}

/** Largest-remainder split of `total` by `weights`, so the parts always add up to the total. */
export function split(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!weights.length) return [];
  if (sum <= 0)
    return split(
      total,
      weights.map(() => 1),
    );
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left-- <= 0) break;
    out[i]!++;
  }
  return out;
}

/**
 * Supply360 completes per cell. Cells in the same SampTrek group are alternatives that add up to the market, so
 * Supply360's market target is split within each group; cells in different groups overlap by design.
 */
export function allocate(
  mode: AllocationMode,
  cells: Pick<CellRow, 'id' | 'countryCode' | 'groupName' | 'sourceTarget' | 'isOpen' | 'removed'>[],
  marketTarget: (cc: string) => number,
  manual: Record<string, number> = {},
): Map<string, number> {
  const out = new Map<string, number>();
  const groups = new Map<string, typeof cells>();
  for (const c of cells) {
    if (c.removed || !c.isOpen) {
      out.set(c.id, 0);
      continue;
    }
    const k = `${c.countryCode}/${c.groupName}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  for (const g of groups.values()) {
    const total = marketTarget(g[0]!.countryCode);
    const parts =
      mode === 'manual'
        ? g.map((c) => manual[c.id] ?? 0)
        : split(
            total,
            g.map((c) => (mode === 'equal' ? 1 : c.sourceTarget)),
          );
    g.forEach((c, i) => out.set(c.id, parts[i]!));
  }
  return out;
}

/** A starting point only: three times the people needed after incidence. People set the real cap. */
export const suggestedCap = (allocation: number, irPercent: number | null) =>
  Math.ceil((allocation * 3 * 100) / Math.max(irPercent ?? 100, 1));

const vendorTarget = (ms: MarketRow[]) => (cc: string) => {
  const m = ms.find((x) => x.countryCode === cc);
  return m ? (m.vendorTarget ?? m.targetCompletes) : 0;
};

/** Cells of a project with what is held right now and the effective allocation. */
export async function cellStates(
  tx: Tx,
  projectId: string,
  markets: MarketRow[],
  now = new Date(),
): Promise<CellState[]> {
  const cells = await tx.select().from(quotaCells).where(eq(quotaCells.projectId, projectId));
  const held = await tx
    .select({ cellId: reservedRefs.cellId, n: count() })
    .from(reservedRefs)
    .where(and(eq(reservedRefs.projectId, projectId), gt(reservedRefs.expiresAt, now)))
    .groupBy(reservedRefs.cellId);
  const defaults = allocate('proportional', cells, vendorTarget(markets));
  return cells
    .map((c) => {
      const allocation = c.allocationTarget ?? defaults.get(c.id) ?? 0;
      const ir = markets.find((m) => m.countryCode === c.countryCode)?.irPercent ?? null;
      return {
        ...c,
        held: held.find((h) => h.cellId === c.id)?.n ?? 0,
        allocation,
        suggestedCap: suggestedCap(allocation, ir),
      };
    })
    .sort(
      (a, b) =>
        a.countryCode.localeCompare(b.countryCode) ||
        a.groupName.localeCompare(b.groupName) ||
        a.name.localeCompare(b.name),
    );
}

export { vendorTarget };

const label = (c: CellState) => (c.sourceCellId === MARKET_CELL ? c.countryCode : `${c.countryCode} ${c.name}`);

/** The two Phase 3 launch checks. Only needed to launch or resume, not to mark a project ready. */
export function audienceChecks(
  markets: Pick<MarketRow, 'countryCode' | 'vendorLinkId'>[],
  cells: CellState[],
): LaunchCheck[] {
  const mine = markets.filter((m) => m.vendorLinkId).map((m) => m.countryCode);
  const live = cells.filter((c) => !c.removed && c.isOpen && mine.includes(c.countryCode));
  const noCells = mine.filter((cc) => !cells.some((c) => c.countryCode === cc && !c.removed));
  const unmapped = live.filter((c) => !c.criteria);
  const mapDetail = noCells.length
    ? `Quota cells not imported yet for ${noCells.join(', ')}: run a sync`
    : unmapped.length
      ? `Not mapped: ${unmapped.map(label).join(', ')}`
      : undefined;
  const noCap = live.filter((c) => !c.inviteCap);
  const empty = live.filter((c) => c.held === 0);
  const audDetail = noCap.length
    ? `No cap set: ${noCap.map(label).join(', ')}`
    : empty.length
      ? `Nothing held for: ${empty.map(label).join(', ')}`
      : undefined;
  return [
    {
      key: 'quota_map',
      label: 'Every open quota cell is mapped to MADP criteria',
      ok: mine.length > 0 && !noCells.length && live.length > 0 && !unmapped.length,
      stage: 'launch',
      ...(mapDetail ? { detail: mapDetail } : {}),
    },
    {
      key: 'audience',
      label: 'Audience reserved in MADP for every open cell',
      ok: live.length > 0 && !noCap.length && !empty.length,
      stage: 'launch',
      ...(audDetail ? { detail: audDetail } : {}),
    },
  ];
}

export const criteriaFor = (c: Pick<CellRow, 'countryCode' | 'criteria'>): AudienceCriteria => ({
  ...(c.criteria as AudienceCriteria),
  countries: [c.countryCode],
});
