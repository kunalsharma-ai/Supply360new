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
