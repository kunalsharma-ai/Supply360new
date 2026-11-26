import { z } from 'zod';

/**
 * Phase 5: participation, live fieldwork, quality, reconciliation and rewards (spec §9).
 * Outcomes come only from verified sources: SampTrek's signed S2S callbacks and its sessions API. Nothing is
 * inferred: a click is not a start, and a redirect landing is not a complete.
 */
export const OUTCOMES = [
  'complete',
  'terminate',
  'quota_full',
  'quality_fail',
  'duplicate',
  'security_reject',
  'partial',
  'technical_error',
] as const;
export const Outcome = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof Outcome>;
export const OUTCOME_LABELS: Record<Outcome, string> = {
  complete: 'Complete',
  terminate: 'Terminate',
  quota_full: 'Quota full',
  quality_fail: 'Quality fail',
  duplicate: 'Duplicate',
  security_reject: 'Security reject',
  partial: 'Partial',
  technical_error: 'Technical error',
};

export const FLAG_LABELS: Record<string, string> = {
  speeder: 'Faster than the policy allows',
  conflicting_outcome: 'Sources disagree on the outcome',
  source_security: 'SampTrek flagged duplicate or security',
  approval_without_complete: 'Client decision on a session that is not a complete',
};

export const FlagReview = z.object({
  decision: z.enum(['accept', 'dismiss']),
  reason: z.string().trim().min(3).max(500),
});
export type FlagReview = z.infer<typeof FlagReview>;

export const CallbackSecret = z.object({ secret: z.string().min(16).max(200) });

/** FIXTURE only: play a respondent finishing a survey, through the real signed S2S path. */
export const FixtureOutcome = z.object({
  invitationId: z.uuid(),
  status: Outcome,
  loiMinutes: z.number().min(0.1).max(600).optional(),
});
/** FIXTURE only: play the client approving or rejecting completes at SampTrek. */
export const FixtureApproval = z.object({
  projectCode: z.string().min(1),
  decision: z.enum(['APPROVED', 'REJECTED']),
  count: z.number().int().min(1).max(100_000).optional(),
});

// ───────────── Recontact and reinvite ─────────────

/** When someone counts as having taken part: their latest verified outcome, else their survey start, else their click. */
export const PARTICIPATION_STATES = ['any', 'clicked', 'started', ...OUTCOMES] as const;
export const ParticipantQuery = z.object({
  /** Earlier project to recontact from; omitted means every project of the tenant. */
  fromProjectId: z.uuid().optional(),
  /** Took part on or after / before these times (week, month or year back, or a custom range). */
  participatedFrom: z.iso.datetime().optional(),
  participatedTo: z.iso.datetime().optional(),
  outcomes: z.array(Outcome).max(OUTCOMES.length).optional(),
  /** Only client-approved completes. */
  approvedOnly: z.boolean().optional(),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  panel: z.string().min(1).max(60).optional(),
});
export type ParticipantQuery = z.infer<typeof ParticipantQuery>;

/** Recontact past participants into a quota cell of a project. MADP re-checks every reference at reservation. */
export const RecontactRequest = z
  .object({
    /** People picked one by one (their earlier invitations). */
    invitationIds: z.array(z.uuid()).min(1).max(5000).optional(),
    /** Or everyone matching a filter ("select all matching"). */
    filter: ParticipantQuery.optional(),
    max: z.number().int().min(1).max(5000).default(5000),
    expiresInDays: z.number().int().min(1).max(14).default(7),
  })
  .refine((r) => !!r.invitationIds !== !!r.filter, { message: 'Give invitationIds or filter, not both' });
export type RecontactRequest = z.infer<typeof RecontactRequest>;

/** Who in a project can be invited again to finish the same survey. Final outcomes cannot. */
export const DROPOUT_KINDS = ['not_clicked', 'not_started', 'not_finished', 'partial', 'technical_error'] as const;
export type DropoutKind = (typeof DROPOUT_KINDS)[number];
export const DROPOUT_LABELS: Record<DropoutKind, string> = {
  not_clicked: 'Invited, never opened the link',
  not_started: 'Opened the link, survey never started',
  not_finished: 'Started, no outcome yet',
  partial: 'Left part way (partial)',
  technical_error: 'Hit a technical error',
};
export const MAX_REINVITES = 3;

export const ReinviteRequest = z
  .object({
    invitationIds: z.array(z.uuid()).min(1).max(5000).optional(),
    /** Or everyone in the project matching these dropout kinds ("select all matching"). */
    dropouts: z.array(z.enum(DROPOUT_KINDS)).min(1).optional(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .refine((r) => !!r.invitationIds !== !!r.dropouts, { message: 'Give invitationIds or dropouts, not both' });
export type ReinviteRequest = z.infer<typeof ReinviteRequest>;
