import { z } from 'zod';
import { AdapterMode } from './projects.js';

/**
 * Phase 3: audience from MADP (counts, match, reservations) and SampTrek quota cells mapped to MADP criteria.
 * Shapes follow MADP's service API (madp packages/contracts/src/supply360.ts). Supply360 receives aggregate counts
 * and pseudonymous references only: never names, e-mail addresses, answers or health data.
 */

export const PanelCode = z.enum(['t2o', 'mfr', 'mho']);
export type PanelCode = z.infer<typeof PanelCode>;
export const PANEL_LABELS: Record<PanelCode, string> = { t2o: 'Turn2Opinion', mfr: 'MFR', mho: 'MHO' };

export const AudienceCategory = z.enum([
  'consumer',
  'business_professional',
  'healthcare_professional',
  'patient',
  'caregiver',
]);
export type AudienceCategory = z.infer<typeof AudienceCategory>;
export const CATEGORY_LABELS: Record<AudienceCategory, string> = {
  consumer: 'Consumer',
  business_professional: 'Business professional',
  healthcare_professional: 'Healthcare professional',
  patient: 'Patient',
  caregiver: 'Caregiver',
};

/** MADP matches a person when any approved mapping holds one of the values. AND across filters, OR within one. */
export const AttributeFilter = z.object({
  key: z.string().min(1).max(100),
  values: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
});
export type AttributeFilter = z.infer<typeof AttributeFilter>;

export const AudienceCriteria = z.object({
  panels: z.array(PanelCode).max(3).optional(),
  categories: z.array(AudienceCategory).max(5).optional(),
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .max(50)
    .optional(),
  verifiedEmailOnly: z.boolean().optional(),
  attributes: z.array(AttributeFilter).max(10).optional(),
});
export type AudienceCriteria = z.infer<typeof AudienceCriteria>;

/**
 * A quota cell's mapping. The cell's market country is added by Supply360, and exactly one panel is required:
 * MADP issues one reference per panel membership, so two panels could put the same person in front of a project
 * twice. Within one panel, a reference is unique per project.
 */
export const CellMapping = z.object({
  criteria: AudienceCriteria.omit({ countries: true }).extend({ panels: z.array(PanelCode).length(1) }),
});
export type CellMapping = z.infer<typeof CellMapping>;

export const AllocationMode = z.enum(['proportional', 'equal', 'manual']);
export type AllocationMode = z.infer<typeof AllocationMode>;
export const ALLOCATION_LABELS: Record<AllocationMode, string> = {
  proportional: 'In proportion to SampTrek cell targets',
  equal: 'Equal across open cells',
  manual: 'Manual',
};

export const AllocationUpdate = z.object({
  mode: AllocationMode,
  /** Manual only: Supply360 completes needed per cell id. */
  targets: z.record(z.string().uuid(), z.number().int().min(0).max(1_000_000)).optional(),
  /** Most people Supply360 may hold for each cell at once. */
  caps: z.record(z.string().uuid(), z.number().int().min(0).max(100_000)),
});
export type AllocationUpdate = z.infer<typeof AllocationUpdate>;

export const ReserveRequest = z.object({
  count: z.number().int().min(1).max(5000),
  /** MADP holds references for at most 14 days. */
  expiresInDays: z.number().int().min(1).max(14).default(7),
});
export type ReserveRequest = z.infer<typeof ReserveRequest>;

export const AudienceConnectionCreate = z
  .object({
    name: z.string().trim().min(2).max(80),
    mode: AdapterMode,
    /** MADP base URL, e.g. https://madp.example.com. Required for LIVE. */
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .max(300)
      .optional(),
    /** The service client id MADP issued to Supply360. */
    clientId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{6,80}$/)
      .optional(),
    /** The client secret MADP showed once. Sealed at rest, never returned. */
    secret: z.string().min(24).max(200).optional(),
  })
  .refine((v) => v.mode === 'fixture' || (v.baseUrl && v.clientId && v.secret), {
    message: 'LIVE needs a base URL, a client id and a secret',
    path: ['secret'],
  });
export type AudienceConnectionCreate = z.infer<typeof AudienceConnectionCreate>;

export const SegmentCreate = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  criteria: AudienceCriteria,
});
export type SegmentCreate = z.infer<typeof SegmentCreate>;

export interface CountsBreakdown {
  key: string;
  value: number | null;
  suppressed: boolean;
}

export interface CountsResult {
  dataMode: 'demo' | 'live';
  /** Distinct people across the panels: the number to plan with. Memberships count a person once per panel. */
  uniquePeople: number;
  panelMemberships: number;
  categoryMemberships: number;
  byPanel: CountsBreakdown[];
  byCategory: CountsBreakdown[];
  byCountry: CountsBreakdown[];
  minimumCellSize: number;
  computedAt: string;
  freshestSourceSyncAt: string | null;
  oldestSourceSyncAt: string | null;
  attributeFilters?: { key: string; sensitivity: string; approvedMappings: number; panels: string[] }[];
}
