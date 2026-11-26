/**
 * Matching quota cells between two projects. SampTrek cell ids differ per project, so cells are matched by market
 * and by what a person sees: the group and cell name (case and spacing ignored). The whole-market cell matches the
 * whole-market cell of the same country. When names differ, identical SampTrek conditions still match.
 */

export interface CellKey {
  countryCode: string;
  group: string;
  name: string;
  isMarketCell: boolean;
  conditionsHash: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const cellKey = (c: CellKey) =>
  c.isMarketCell ? `${c.countryCode}|_market` : `${c.countryCode}|${norm(c.group)}|${norm(c.name)}`;

/** For each target cell, the source cell it takes its setup from, if any. Each source cell is used once at most. */
export function matchCells<S extends CellKey, T extends CellKey & { id: string }>(source: S[], target: T[]) {
  const byKey = new Map(source.map((s) => [cellKey(s), s]));
  const used = new Set<S>();
  const out = new Map<string, S>();
  for (const t of target) {
    const s = byKey.get(cellKey(t));
    if (s && !used.has(s)) {
      out.set(t.id, s);
      used.add(s);
    }
  }
  for (const t of target) {
    if (out.has(t.id)) continue;
    const s = source.find(
      (x) => !used.has(x) && x.countryCode === t.countryCode && x.conditionsHash === t.conditionsHash,
    );
    if (s) {
      out.set(t.id, s);
      used.add(s);
    }
  }
  return out;
}
