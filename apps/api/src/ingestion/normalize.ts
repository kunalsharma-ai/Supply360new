import { createHash } from 'node:crypto';
import type { StProject } from './samptrek/types.js';

export interface NormalizedMarket {
  countryCode: string;
  language: string | null;
  targetGroup: string | null;
  sourceStatus: string;
  loiMinutes: number | null;
  irPercent: number | null;
  targetCompletes: number;
  completes: number;
  vendorLinkId: string | null;
  vendorLinkStatus: string | null;
  vendorTarget: number | null;
  vendorCompletes: number | null;
}

export interface NormalizedProject {
  sourceProjectId: string;
  projectCode: string;
  name: string;
  clientName: string | null;
  projectManagerName: string | null;
  projectType: string | null;
  category: string | null;
  sourceStatus: string;
  fieldStartAt: Date | null;
  fieldEndAt: Date | null;
  sourceUpdatedAt: Date;
  markets: NormalizedMarket[];
}

/**
 * Keeps only what Supply360 needs. Dropped on purpose: other vendors' links, every price (CPI, revenue, payout:
 * finance is out of scope), project manager e-mail, and per-status session counts (live counts arrive as events).
 */
export function normalize(p: StProject, vendorCode: string): NormalizedProject {
  const code = vendorCode.toUpperCase();
  return {
    sourceProjectId: p.id,
    projectCode: p.projectCode,
    name: p.name,
    clientName: p.client?.name ?? null,
    projectManagerName: p.projectManager?.name ?? null,
    projectType: p.type ?? null,
    category: p.category ?? null,
    sourceStatus: p.status,
    fieldStartAt: p.fieldStartAt ? new Date(p.fieldStartAt) : null,
    fieldEndAt: p.fieldEndAt ? new Date(p.fieldEndAt) : null,
    sourceUpdatedAt: new Date(p.updatedAt),
    markets: p.markets
      .map((m) => {
        const mine = m.vendorLinks.find((l) => (l.vendor.code ?? '').toUpperCase() === code);
        return {
          countryCode: m.countryCode,
          language: m.language ?? null,
          targetGroup: m.targetGroup ?? null,
          sourceStatus: m.status,
          loiMinutes: m.loiMinutes ?? null,
          irPercent: m.irPercent == null ? null : Math.round(m.irPercent),
          targetCompletes: m.targetCompletes,
          completes: m.completes,
          vendorLinkId: mine?.id ?? null,
          vendorLinkStatus: mine?.status ?? null,
          vendorTarget: mine?.targetCompletes ?? null,
          vendorCompletes: mine?.completes ?? null,
        };
      })
      .toSorted((a, b) => a.countryCode.localeCompare(b.countryCode)),
  };
}

/**
 * The content that makes a new version: what was agreed with the client. Progress counters (completes) change all
 * day and are updated in place without a new version.
 */
export function contentOf(n: NormalizedProject) {
  return {
    projectCode: n.projectCode,
    name: n.name,
    clientName: n.clientName,
    projectType: n.projectType,
    category: n.category,
    sourceStatus: n.sourceStatus,
    fieldStartAt: n.fieldStartAt?.toISOString() ?? null,
    fieldEndAt: n.fieldEndAt?.toISOString() ?? null,
    markets: n.markets.map(({ completes: _c, vendorCompletes: _v, ...m }) => m),
  };
}

/** Stable JSON (sorted keys) so the same content always hashes the same. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export const contentHash = (n: NormalizedProject) =>
  createHash('sha256')
    .update(stableJson(contentOf(n)))
    .digest('hex');
