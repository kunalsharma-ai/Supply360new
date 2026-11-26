import { z } from 'zod';

/**
 * SampTrek public API shapes (samptrek apps/api/src/public-api/public-api.controller.ts and docs/PUBLIC_API.md).
 * Parsed loosely (unknown fields pass through and are dropped by normalize()), so a SampTrek addition never breaks
 * ingestion, while a missing or mistyped field we rely on fails loudly.
 */
const iso = z.iso.datetime({ offset: true });
const status = z.string().regex(/^[A-Z_]+$/);

export const StListItem = z.looseObject({
  id: z.string().min(1),
  projectCode: z.string().min(1),
  name: z.string(),
  status,
  updatedAt: iso,
});
export type StListItem = z.infer<typeof StListItem>;

export const StPage = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });

export const StVendorLink = z.looseObject({
  id: z.string().min(1),
  status,
  targetCompletes: z.number().int().nullable().optional(),
  completes: z.number().int().optional(),
  vendor: z.looseObject({ id: z.string(), name: z.string(), code: z.string().nullable().optional() }),
});

export const StMarket = z.looseObject({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  language: z.string().nullable().optional(),
  targetGroup: z.string().nullable().optional(),
  status,
  loiMinutes: z.number().int().nullable().optional(),
  irPercent: z.number().nullable().optional(),
  targetCompletes: z.number().int(),
  completes: z.number().int(),
  vendorLinks: z.array(StVendorLink).default([]),
});

export const StProject = z.looseObject({
  id: z.string().min(1),
  projectCode: z.string().min(1),
  name: z.string(),
  type: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  status,
  fieldStartAt: iso.nullable().optional(),
  fieldEndAt: iso.nullable().optional(),
  updatedAt: iso,
  client: z.looseObject({ name: z.string() }).nullable().optional(),
  projectManager: z.looseObject({ name: z.string() }).nullable().optional(),
  markets: z.array(StMarket),
});
export type StProject = z.infer<typeof StProject>;

/** Webhook envelope: `{ id, event, createdAt, data }`, signed with X-Projexa-* headers. */
export const StEnvelope = z.object({
  id: z.string().min(1).max(200),
  event: z.string().min(1).max(100),
  createdAt: iso,
  data: z.record(z.string(), z.unknown()),
});
export type StEnvelope = z.infer<typeof StEnvelope>;

export const StStatusChanged = z.looseObject({
  project: z.looseObject({ id: z.string().min(1), projectCode: z.string().optional(), name: z.string().optional() }),
  from: status.nullable().optional(),
  to: status,
});

/** `GET /projects/{ref}/quotas` (scope quotas:read): cells per market with SampTrek's own conditions. */
export const StQuotaCell = z.looseObject({
  id: z.string().min(1).max(60),
  group: z.string().nullable().optional(),
  name: z.string(),
  conditions: z.unknown(),
  target: z.number().int(),
  completes: z.number().int(),
  isOpen: z.boolean(),
});
export const StQuotas = z.looseObject({
  projectCode: z.string(),
  markets: z.array(
    z.looseObject({
      countryCode: z.string().regex(/^[A-Z]{2}$/),
      targetCompletes: z.number().int(),
      completes: z.number().int(),
      cells: z.array(StQuotaCell),
    }),
  ),
});
export type StQuotas = z.infer<typeof StQuotas>;

/** One respondent session from `GET /projects/{ref}/sessions`. Revenue, payout, device and geo are never kept. */
export const StSession = z.looseObject({
  id: z.string().min(1),
  status,
  approval: z
    .string()
    .regex(/^[A-Z_]+$/)
    .nullable()
    .optional(),
  outcomeVerified: z.boolean().nullable().optional(),
  vendorRespondentId: z.string().nullable().optional(),
  startedAt: iso.nullable().optional(),
  outcomeAt: iso.nullable().optional(),
  countryCode: z.string().optional(),
  vendor: z.looseObject({ code: z.string().nullable().optional() }).nullable().optional(),
});
export type StSession = z.infer<typeof StSession>;
/** What Supply360 keeps of a session: identifiers, status, approval and times only. */
export interface SourceSession {
  id: string;
  status: string;
  approval: string | null;
  verified: boolean;
  uid: string | null;
  startedAt: string | null;
  outcomeAt: string | null;
  countryCode: string | null;
}
export const toSourceSession = (s: StSession): SourceSession => ({
  id: s.id,
  status: s.status,
  approval: s.approval ?? null,
  verified: !!s.outcomeVerified,
  uid: s.vendorRespondentId ?? null,
  startedAt: s.startedAt ?? null,
  outcomeAt: s.outcomeAt ?? null,
  countryCode: s.countryCode ?? null,
});
