import type { AllocationMode, AudienceCriteria, CountsResult, LaunchCheck } from '@s360/contracts';

export interface Attribute {
  key: string;
  label: string;
  sensitivity: 'standard' | 'personal' | 'special_category';
  /** FIXTURE only: MADP does not list canonical values yet. */
  values?: string[];
}
export interface Catalogue {
  categories: string[];
  attributes: Attribute[];
  source: { name: string; mode: 'fixture' | 'live' };
}
export type Counts = CountsResult & { source?: { name: string; mode: 'fixture' | 'live' } };

export interface AudienceConnection {
  id: string;
  mode: 'fixture' | 'live';
  name: string;
  baseUrl: string | null;
  clientId: string | null;
  hasSecret: boolean;
  enabled: boolean;
  lastCheckAt: string | null;
  lastCheckResult: {
    ok: boolean;
    ms: number;
    attributes?: number;
    dataMode?: string;
    uniquePeople?: number;
    panelMemberships?: number;
    error?: string;
  } | null;
  createdAt: string;
}

export interface QuotaCell {
  id: string;
  countryCode: string;
  sourceCellId: string;
  isMarketCell: boolean;
  group: string;
  name: string;
  conditions: unknown;
  sourceTarget: number;
  sourceCompletes: number;
  isOpen: boolean;
  removed: boolean;
  criteria: AudienceCriteria | null;
  mappedAt: string | null;
  allocation: number;
  inviteCap: number | null;
  suggestedCap: number;
  held: number;
}
export interface Reservation {
  id: string;
  cellId: string;
  status: 'active' | 'released' | 'expired';
  requested: number;
  held: number;
  refused: number;
  expiresAt: string;
  createdAt: string;
  releasedAt: string | null;
}
export interface ProjectQuotas {
  projectId: string;
  projectCode: string;
  name: string;
  lifecycle: string;
  allocationMode: AllocationMode;
  panelInUse: string | null;
  source: { id: string; name: string; mode: 'fixture' | 'live' } | null;
  markets: { countryCode: string; vendorTarget: number; vendorCompletes: number; irPercent: number | null }[];
  cells: QuotaCell[];
  checks: LaunchCheck[];
  reservations: Reservation[];
}
export interface Segment {
  id: string;
  name: string;
  description: string | null;
  criteria: AudienceCriteria;
  createdAt: string;
}
export interface Selection {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  countryCode: string;
  cellName: string;
  dataMode: string;
  criteria: AudienceCriteria;
  eligible: number | null;
  returned: number;
  excluded: Record<string, number>;
  refs: number;
  createdAt: string;
}

export const cellLabel = (c: Pick<QuotaCell, 'countryCode' | 'name' | 'isMarketCell'>) =>
  c.isMarketCell ? `${c.countryCode} · whole market` : `${c.countryCode} · ${c.name}`;

const human = (s: string) => s.replaceAll('_', ' ');
/** One line describing criteria, e.g. "t2o · US · Gender: female". */
export function describeCriteria(c: AudienceCriteria | null, attrs: Attribute[] = []): string {
  if (!c) return 'Not mapped';
  const parts = [
    c.panels?.length ? c.panels.join(' + ') : 'All panels',
    ...(c.countries?.length ? [c.countries.join(', ')] : []),
    ...(c.categories?.length ? [c.categories.map(human).join(' or ')] : []),
    ...(c.verifiedEmailOnly ? ['verified e-mail'] : []),
    ...(c.attributes ?? []).map(
      (f) => `${attrs.find((a) => a.key === f.key)?.label ?? f.key}: ${f.values.map(human).join(' or ')}`,
    ),
  ];
  return parts.join(' · ');
}

/** SampTrek conditions as a readable line. They name question and option ids, which is all Supply360 sees. */
export function describeConditions(conditions: unknown): string {
  if (!Array.isArray(conditions) || !conditions.length) return 'Everyone in the market';
  return conditions
    .map((c: { source?: string; questionId?: string; values?: string[]; min?: number; max?: number }) => {
      const what = c.source === 'device' ? 'device' : (c.questionId ?? c.source ?? '?');
      const v = c.values?.length ? c.values.join(' or ') : `${c.min ?? '…'}–${c.max ?? '…'}`;
      return `${what} = ${v}`;
    })
    .join(' and ');
}

export const fmtN = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());
