import { z } from 'zod';

/** Phase 7: delivery intelligence, Copilot and reports (spec §6 and §10). */

/** Cold-start assumptions, in percent. Used only while a rate has too little data, and always labelled. */
export const ForecastAssumptions = z.object({
  startRatePercent: z.number().min(0.1).max(100),
  qualificationRatePercent: z.number().min(0.1).max(100),
  qualifiedToCompletePercent: z.number().min(0.1).max(100),
  reason: z.string().trim().min(3).max(300),
});
export type ForecastAssumptions = z.infer<typeof ForecastAssumptions>;

export const RISK_LABELS: Record<string, string> = {
  reached: 'Target reached',
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  no_deadline: 'No field end date',
  not_enough_data: 'Not enough data yet',
};

export const CopilotAsk = z.object({ prompt: z.string().trim().min(2).max(500) });
export const CopilotDecision = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(3).max(300),
});
export type CopilotDecision = z.infer<typeof CopilotDecision>;
export type CopilotAsk = z.infer<typeof CopilotAsk>;

export const REPORT_KINDS = [
  'project_summary',
  'invitation_funnel',
  'participation',
  'quotas',
  'allocations',
  'audience_selections',
  'redirects',
  'ir_loi',
  'quality',
  'reconciliation',
  'reward_events',
  'delivery_forecast',
  'audit',
  'synthetic_qa',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_LABELS: Record<ReportKind, string> = {
  project_summary: 'Project summary',
  invitation_funnel: 'Invitation funnel',
  participation: 'Participation',
  quotas: 'Quotas',
  allocations: 'Allocations',
  audience_selections: 'Audience selections',
  redirects: 'Redirects',
  ir_loi: 'IR and LOI',
  quality: 'Quality flags',
  reconciliation: 'Reconciliation',
  reward_events: 'Reward event acknowledgments',
  delivery_forecast: 'Delivery forecast',
  audit: 'Audit log',
  synthetic_qa: 'Synthetic QA (separate, from SampIntel AI)',
};
export const REPORT_FORMATS = ['csv', 'xlsx', 'json'] as const;
export const ReportRequest = z
  .object({
    kind: z.enum(REPORT_KINDS),
    format: z.enum(REPORT_FORMATS),
    projectId: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    timezone: z.string().min(1).max(64).default('UTC'),
  })
  .refine((r) => !r.from || !r.to || r.from < r.to, { message: 'From must be before to', path: ['to'] })
  .refine((r) => (r.kind !== 'project_summary' && r.kind !== 'synthetic_qa') || !!r.projectId, {
    message: 'Pick a project for this report',
    path: ['projectId'],
  });
export type ReportRequest = z.infer<typeof ReportRequest>;
