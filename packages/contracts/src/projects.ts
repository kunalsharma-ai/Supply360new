import { z } from 'zod';

/**
 * Phase 2: project sources (SampTrek first; SampCloud slots into the same interface once its repository is found),
 * the local project lifecycle, launch validation and redirect outcomes.
 */

export const SourceKind = z.enum(['samptrek', 'sampcloud']);
export type SourceKind = z.infer<typeof SourceKind>;

/** FIXTURE reads labelled sample data shaped exactly like the source's API; LIVE calls the real API. */
export const AdapterMode = z.enum(['fixture', 'live']);
export type AdapterMode = z.infer<typeof AdapterMode>;

/** SampTrek project statuses (public API `projectsQuery.status`). */
export const SampTrekProjectStatus = z.enum(['DRAFT', 'TEST', 'LIVE', 'HOLD', 'CLOSED', 'INVOICED']);
export type SampTrekProjectStatus = z.infer<typeof SampTrekProjectStatus>;

/** SampTrek's eight respondent outcome statuses (redirect engine `OUTCOME_STATUSES`). */
export const OutcomeStatus = z.enum([
  'COMPLETE',
  'TERMINATE',
  'QUOTA_FULL',
  'QUALITY_FAIL',
  'DUPLICATE',
  'SECURITY_REJECT',
  'PARTIAL',
  'TECHNICAL_ERROR',
]);
export type OutcomeStatus = z.infer<typeof OutcomeStatus>;
export const outcomeSlug = (s: OutcomeStatus) => s.toLowerCase().replaceAll('_', '-');
export const outcomeFromSlug = (slug: string): OutcomeStatus | null => {
  const s = slug.toUpperCase().replaceAll('-', '_');
  return OutcomeStatus.safeParse(s).success ? (s as OutcomeStatus) : null;
};

/**
 * Supply360's own lifecycle for a project. The source's status always wins over it: HOLD forces `source_hold`,
 * CLOSED or INVOICED forces `closed`, and a project only dispatches while it is `live` here and LIVE at the source.
 */
export const Lifecycle = z.enum(['imported', 'ready', 'live', 'paused', 'source_hold', 'closed']);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  imported: 'Imported',
  ready: 'Ready to launch',
  live: 'Live',
  paused: 'Paused',
  source_hold: 'On hold at source',
  closed: 'Closed',
};

/** Transitions a person may ask for. Source-driven transitions are applied by the ingestion code, not by people. */
export const LifecycleAction = z.enum(['mark_ready', 'launch', 'pause', 'resume', 'close']);
export type LifecycleAction = z.infer<typeof LifecycleAction>;

export const LifecycleRequest = z.object({
  action: LifecycleAction,
  reason: z.string().trim().min(3).max(500),
});

export const SourceConnectionCreate = z
  .object({
    kind: z.literal('samptrek'),
    name: z.string().trim().min(2).max(80),
    mode: AdapterMode,
    /** SampTrek base URL, e.g. https://samptrek.example.com. Required for LIVE. */
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .max(300)
      .optional(),
    /** `pjx_` key with projects:read sessions:read quotas:read. Sealed at rest, never returned. */
    apiKey: z
      .string()
      .regex(/^pjx_[A-Za-z0-9_-]{32}$/, 'A SampTrek key looks like pjx_ followed by 32 characters')
      .optional(),
    /** Supply360's vendor code inside SampTrek, used to find Supply360's own vendor link in each market. */
    vendorCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{2,40}$/),
  })
  .refine((v) => v.mode === 'fixture' || (v.baseUrl && v.apiKey), {
    message: 'LIVE needs a base URL and an API key',
    path: ['apiKey'],
  });
export type SourceConnectionCreate = z.infer<typeof SourceConnectionCreate>;

export const EntryLinkApproval = z.object({
  /**
   * The live entry link SampTrek gave Supply360 as a vendor, e.g. https://samptrek.example/s/Ab12Cd34?uid=[UID].
   * Supply360 fills the [UID] placeholder with its own opaque participation token (Phase 4).
   */
  entryUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .refine((u) => u.includes('[UID]'), 'The link must contain [UID] where the respondent reference goes'),
});

export interface LaunchCheck {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
  /** A check owned by a later phase: shown, never counted as passed. */
  pendingPhase?: number;
  /** 'launch': needed to launch or resume, not to mark a project ready (quota mapping and audience). */
  stage?: 'launch';
}
