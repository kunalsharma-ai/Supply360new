import { z } from 'zod';

/**
 * MADP service API responses (madp packages/contracts/src/supply360.ts and apps/api/src/supply360/*). Parsed
 * loosely: a MADP addition never breaks Supply360, a missing field we rely on fails loudly.
 */
const iso = z.iso.datetime({ offset: true });
const nullableIso = iso.nullable();
export const MADP_REF = /^ref_[A-Za-z0-9_-]{16,40}$/;

export const MdAttributes = z.looseObject({
  categories: z.array(z.string()),
  attributes: z.array(
    z.looseObject({
      key: z.string().min(1),
      label: z.string(),
      sensitivity: z.enum(['standard', 'personal', 'special_category']),
      /**
       * Not in MADP today: canonical values, which MADP does not list yet. FIXTURE fills it as a proposed addition
       * so the filter builder can offer choices; without it people type values.
       */
      values: z.array(z.string()).optional(),
    }),
  ),
});
export type MdAttributes = z.infer<typeof MdAttributes>;

const cell = z.looseObject({ key: z.string(), value: z.number().int().nullable(), suppressed: z.boolean() });
export const MdCounts = z.looseObject({
  dataMode: z.enum(['demo', 'live']),
  uniquePeople: z.number().int(),
  panelMemberships: z.number().int(),
  categoryMemberships: z.number().int(),
  byPanel: z.array(cell),
  byCategory: z.array(cell),
  byCountry: z.array(cell),
  minimumCellSize: z.number().int(),
  computedAt: iso,
  freshestSourceSyncAt: nullableIso,
  oldestSourceSyncAt: nullableIso,
  attributeFilters: z
    .array(
      z.looseObject({
        key: z.string(),
        sensitivity: z.string(),
        approvedMappings: z.number().int(),
        panels: z.array(z.string()),
      }),
    )
    .optional(),
});
export type MdCounts = z.infer<typeof MdCounts>;

export const MdMatch = z.looseObject({
  dataMode: z.enum(['demo', 'live']),
  projectRef: z.string(),
  eligible: z.number().int().nullable(),
  suppressed: z.boolean(),
  minimumCellSize: z.number().int(),
  returned: z.number().int(),
  excluded: z.record(z.string(), z.number().int()),
  members: z.array(
    z.looseObject({
      ref: z.string().regex(MADP_REF),
      panel: z.string(),
      categories: z.array(z.string()),
      country: z.string().nullable(),
    }),
  ),
});
export type MdMatch = z.infer<typeof MdMatch>;

export const MdReservation = z.looseObject({
  reservationId: z.string().min(1),
  projectRef: z.string(),
  expiresAt: iso,
  held: z.number().int(),
  refused: z.array(z.looseObject({ ref: z.string(), reason: z.string() })),
});
export type MdReservation = z.infer<typeof MdReservation>;

export const MdReservationState = z.looseObject({
  reservationId: z.string(),
  projectRef: z.string(),
  status: z.string(),
  expiresAt: iso,
  held: z.number().int(),
});

export const MdReleased = z.looseObject({ reservationId: z.string(), status: z.literal('released') });
